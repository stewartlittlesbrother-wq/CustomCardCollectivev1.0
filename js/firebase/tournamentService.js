// Tournaments in Firebase. The rules themselves live in ../core/tournamentEngine.js
// (pure + unit tested); this file only stores the document, keeps it up to date and
// launches each pairing's match room.
//
// There is no server, so nothing "runs" the tournament: whenever a participant's
// browser looks at it (the tournaments page, or a game ending), it calls
// syncTournament / reportMatchResult, which feed the current time and any results
// into the engine inside a Firebase TRANSACTION. Several browsers doing that at once
// is safe - the transaction serialises them and the engine is deterministic.
// The organiser's tools (kick, change a result, edit settings...) go through the same
// transaction, so they can't collide with a game ending at the same moment.

import {
    ref,
    get,
    set,
    update,
    push,
    onValue,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database } from "./firebaseApp.js";
import { createRoom, joinRoom } from "./multiplayerService.js?v=draft-8";
import { BASE_PATH, DECKS_PATH, SECRETS_PATH, JOIN_PATH } from "./tournamentPaths.js?v=tour-3";
import { getSubmittedDeck } from "./tournamentDecks.js?v=tour-3";
import {
    tick,
    cleanSettings,
    applySettings,
    kickPlayer as engineKick,
    overrideResult,
    roomCodeFor,
    roundKey,
    getRound,
    pairingsOf,
    nextGameNo,
    collectionsOf,
    bannedOf,
    bestOfOf,
    deckRequired,
    draftSettingsOf,
    canJoin,
    isKicked,
    myStatus,
    playerCount,
    minPlayersOf
} from "../core/tournamentEngine.js?v=tour-3";

const basePath = BASE_PATH;
const tournamentRef = (id, ...parts) => ref(database, [basePath, id, ...parts].join("/"));

export function isPermissionError(error) {
    return /permission|denied/i.test(String((error && (error.code || error.message)) || ""));
}

function withIds(value) {
    return Object.entries(value || {})
        .map(([id, t]) => ({ ...t, id }))
        .filter(t => t && t.name && t.startAt);
}

// ── passwords ────────────────────────────────────────────────────────────────
// A tournament's password is never stored. A random salt is published with the
// tournament and the salted SHA-256 is stored where nobody can read it; the database
// rules compare it with the proof a joiner writes under their own id.

export async function hashPassword(salt, password) {
    const bytes = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── create / list ────────────────────────────────────────────────────────────

/**
 * `opts` holds the create form's values (see cleanSettings) plus `join` (is the
 * organiser playing too?) and `password` (optional).
 */
export async function createTournament(user, displayName, opts) {
    if (!user || !user.uid) throw new Error("Sign in to create a tournament.");

    const cleaned = cleanSettings(opts, { now: Date.now() });
    if (cleaned.error) throw new Error(cleaned.error);

    const player = String(displayName || "Player").slice(0, 30);
    const doc = {
        ...cleaned.fields,
        createdBy: user.uid,
        createdByName: player,
        createdAt: Date.now(),
        status: "registration"
    };
    // Firebase doesn't store empty values; keep the document tidy.
    ["description", "collections", "banned"].forEach(key => {
        const v = doc[key];
        if (v === "" || (Array.isArray(v) && !v.length)) delete doc[key];
    });
    if (opts.join !== false) doc.players = { [user.uid]: { name: player, joinedAt: Date.now() } };

    const password = String(opts.password || "");
    let hash = "";
    if (password) {
        doc.pwSalt = randomSalt();
        doc.hasPassword = true;
        hash = await hashPassword(doc.pwSalt, password);
    }

    const id = push(ref(database, basePath)).key;
    await set(tournamentRef(id), doc);
    if (hash) await set(ref(database, `${SECRETS_PATH}/${id}/pwHash`), hash);
    return id;
}

export function watchTournaments(callback, onError) {
    return onValue(
        ref(database, basePath),
        (snapshot) => callback(withIds(snapshot.val())),
        (error) => { if (onError) onError(error); }
    );
}

// ── joining ──────────────────────────────────────────────────────────────────

export async function joinTournament(id, user, displayName, t, password = "") {
    if (!user || !user.uid) throw new Error("Sign in to join a tournament.");
    if (t) {
        if (isKicked(t, user.uid)) throw new Error("You've been removed from this tournament.");
        if (!canJoin(t, user.uid)) throw new Error("This tournament is full or no longer open for sign-up.");
    }

    if (t && t.hasPassword) {
        if (!password) throw new Error("Enter the tournament password.");
        const proof = await hashPassword(t.pwSalt, password);
        await set(ref(database, `${JOIN_PATH}/${id}/${user.uid}`), proof);
    }

    try {
        await set(tournamentRef(id, "players", user.uid), {
            name: String(displayName || "Player").slice(0, 30),
            joinedAt: Date.now()
        });
    } catch (error) {
        if (isPermissionError(error)) {
            throw new Error(t && t.hasPassword
                ? "Couldn't join - that password is wrong, or the tournament is full or already started."
                : "Couldn't join - the tournament may be full or no longer open.");
        }
        throw error;
    }

    // Joined after the start (late joining)? Get seated right away.
    if (t && t.status === "running") await syncTournament(id, user.uid).catch(() => {});
}

export async function leaveTournament(id, uid) {
    await set(tournamentRef(id, "players", uid), null);
}

export async function cancelTournament(id) {
    await update(tournamentRef(id), {
        status: "cancelled",
        cancelReason: "Cancelled by the organiser"
    });
}

/** Organiser: remove a finished or cancelled tournament (and its deck lists) for good. */
export async function deleteTournament(id) {
    await update(ref(database), {
        [`${basePath}/${id}`]: null,
        [`${SECRETS_PATH}/${id}`]: null,
        [`${DECKS_PATH}/${id}`]: null,
        [`${JOIN_PATH}/${id}`]: null
    });
}

// ── keeping it up to date ────────────────────────────────────────────────────

// For the signed-in player's OWN unfinished match(es) in the current round, look at
// the match room of the game that is up next to see whether a winner has been
// decided. (The game page also reports results itself; this is the safety net for
// when it couldn't.)
async function collectResults(id, t, uid) {
    const results = {};
    if (t.status !== "running" || !uid) return results;
    const round = getRound(t, t.currentRound);

    await Promise.all(pairingsOf(round).map(async (p) => {
        if (p.result || p.bye || (p.a !== uid && p.b !== uid)) return;
        const game = nextGameNo(p);
        const code = roomCodeFor(id, t.currentRound, p.id, game);
        try {
            const [winnerSnap, p1Snap, p2Snap] = await Promise.all([
                get(ref(database, `matches/${code}/public/winner`)),
                get(ref(database, `matches/${code}/players/p1/uid`)),
                get(ref(database, `matches/${code}/players/p2/uid`))
            ]);
            const slot = winnerSnap.val();
            if (slot !== "p1" && slot !== "p2") return;
            const winnerUid = slot === "p1" ? p1Snap.val() : p2Snap.val();
            if (winnerUid === p.a || winnerUid === p.b) results[`${t.currentRound}/${p.id}/${game}`] = winnerUid;
        } catch { /* room doesn't exist yet / unreadable - nothing to report */ }
    }));
    return results;
}

async function applyTick(id, results) {
    let latest = null;
    const outcome = await runTransaction(tournamentRef(id), (current) => {
        if (!current) return current;
        const { tournament, changed } = tick(current, Date.now(), results, id);
        latest = tournament;
        return changed ? tournament : undefined;   // undefined = nothing to write
    });
    const doc = outcome.snapshot && outcome.snapshot.val();
    return doc || latest;
}

/**
 * Bring one tournament up to date (start it, settle timers, advance rounds) and
 * return the fresh document, or null if it no longer exists. Never throws on a
 * permission error: a viewer who isn't in the tournament just sees the stored state.
 */
export async function syncTournament(id, uid) {
    const snapshot = await get(tournamentRef(id));
    const current = snapshot.val();
    if (!current) return null;

    // Nothing to do for a finished tournament, or one that hasn't reached its start.
    const waiting = current.status === "registration" && Date.now() < Number(current.startAt);
    if (current.status === "complete" || current.status === "cancelled" || waiting) {
        return { ...current, id };
    }

    const results = await collectResults(id, current, uid);
    try {
        const fresh = await applyTick(id, results);
        return { ...(fresh || current), id };
    } catch (error) {
        if (isPermissionError(error)) return { ...current, id, readOnly: true };
        throw error;
    }
}

/** Called from the game page the moment a tournament game ends. */
export async function reportMatchResult(meta, winnerUid) {
    if (!meta || !meta.id || !winnerUid) return null;
    const results = { [`${meta.round}/${meta.pairingId}/${meta.game || 1}`]: winnerUid };
    return applyTick(meta.id, results);
}

// ── organiser tools ──────────────────────────────────────────────────────────

/** Run a change through the engine inside a transaction, then let the tournament
 *  catch up (a kicked player's match is awarded, a settled round advances...).
 *  `change(current, now)` returns { tournament, changed, error? }. */
async function mutate(id, change) {
    let failure = null;
    let latest = null;
    const outcome = await runTransaction(tournamentRef(id), (current) => {
        failure = null;
        if (!current) return current;
        const now = Date.now();
        const step = change(current, now);
        if (step.error) { failure = step.error; return undefined; }
        const settled = tick(step.tournament, now, {}, id);
        latest = settled.tournament;
        return (step.changed || settled.changed) ? settled.tournament : undefined;
    });
    if (failure) throw new Error(failure);
    return { ...((outcome.snapshot && outcome.snapshot.val()) || latest), id };
}

/** Change the settings. `opts` is the edit form's values; `password`: a new password,
 *  `clearPassword`: remove it. */
export async function updateTournament(id, opts, { password = "", clearPassword = false } = {}) {
    const result = await mutate(id, (current, now) => applySettings(current, opts, now));

    if (password || clearPassword) {
        const updates = {};
        if (password) {
            const salt = randomSalt();
            updates[`${basePath}/${id}/hasPassword`] = true;
            updates[`${basePath}/${id}/pwSalt`] = salt;
            updates[`${SECRETS_PATH}/${id}/pwHash`] = await hashPassword(salt, password);
        } else {
            updates[`${basePath}/${id}/hasPassword`] = null;
            updates[`${basePath}/${id}/pwSalt`] = null;
            updates[`${SECRETS_PATH}/${id}`] = null;
        }
        // Players already in stay in; the new password only affects people joining from now on.
        await update(ref(database), updates);
        result.hasPassword = Boolean(password);
    }
    return result;
}

/** Remove a player at any time. Their current match goes to their opponent. */
export async function kickFromTournament(id, uid, reason = "") {
    const result = await mutate(id, (current, now) => engineKick(current, uid, now, reason));
    // Their deck list isn't needed any more (the organiser may delete it).
    await update(ref(database), { [`${DECKS_PATH}/${id}/${uid}`]: null }).catch(() => {});
    return result;
}

/** The organiser decides a match: winner = a player's uid, "none" (a Swiss draw) or
 *  null to clear the result and let them play it again. */
export function setMatchResult(id, round, pairingId, winner) {
    return mutate(id, (current, now) => overrideResult(current, round, pairingId, winner, now, id));
}

/** Start now instead of waiting for the start time. */
export function startNow(id) {
    return mutate(id, (current, now) => {
        if (current.status !== "registration") return { tournament: current, changed: false, error: "It has already started." };
        const have = playerCount(current);
        if (have < minPlayersOf(current)) {
            return { tournament: current, changed: false, error: `You need at least ${minPlayersOf(current)} players to start (${have} so far).` };
        }
        return { tournament: { ...current, startAt: now }, changed: true };
    });
}

// ── playing a match ──────────────────────────────────────────────────────────

/** Who may play, which game this is and which rules apply - stored on the room itself. */
function matchMetadata(id, t, round, pairing, game) {
    const players = { [pairing.a]: true };
    if (pairing.b) players[pairing.b] = true;
    const meta = {
        id,
        name: t.name,
        round,
        pairingId: pairing.id,
        game,
        bestOf: bestOfOf(t),
        matchType: t.matchType,
        format: t.format,
        collections: collectionsOf(t),
        banned: bannedOf(t),
        requireDeck: deckRequired(t),
        players
    };
    if (t.matchType === "draft") meta.draft = draftSettingsOf(t);
    return meta;
}

/**
 * Check the player in for their current game and make sure its room exists.
 * Returns { code, slot } - then send them to the multiplayer lobby for that room.
 * Whoever presses Play first creates the room; the opponent joins it.
 */
export async function enterMatch(id, t, user, displayName) {
    const status = myStatus(t, user.uid);
    if (status.state !== "play") throw new Error("You don't have a match to play right now.");

    const round = status.round;
    const pairing = pairingsOf(getRound(t, round)).find(p => p.id === status.pairingId);
    if (!pairing) throw new Error("Couldn't find your match.");

    // A required deck list has to be on file before playing.
    if (deckRequired(t)) {
        const submitted = await getSubmittedDeck(id, user.uid).catch(() => null);
        if (!submitted) throw new Error("You haven't submitted a deck list for this tournament, so you can't play yet.");
    }

    // Showing up is recorded, because it decides a forfeit if the round times out.
    await set(tournamentRef(id, "rounds", roundKey(round), "pairings", pairing.id, "checkedIn", user.uid), Date.now());

    const game = status.game;
    const code = roomCodeFor(id, round, pairing.id, game);
    const name = String(displayName || "Player").slice(0, 30);
    const roomPlayers = async () => {
        const [p1, p2] = await Promise.all([
            get(ref(database, `matches/${code}/players/p1/uid`)),
            get(ref(database, `matches/${code}/players/p2/uid`))
        ]);
        return { p1: p1.val(), p2: p2.val() };
    };

    // Already in this room (coming back to a game in progress)?
    let seats = await roomPlayers();
    if (seats.p1 === user.uid) return { code, slot: "p1" };
    if (seats.p2 === user.uid) return { code, slot: "p2" };

    if (!seats.p1) {
        try {
            await createRoom(user, {
                roomCode: code,
                nickname: name,
                lobbyName: `${t.name} - Round ${round}${bestOfOf(t) > 1 ? ` · Game ${game}` : ""}`,
                mode: t.matchType,
                draftCollection: t.matchType === "draft" ? collectionsOf(t).join(",") : "",
                tournament: matchMetadata(id, t, round, pairing, game)
            });
            return { code, slot: "p1" };
        } catch (error) {
            if (!error || error.code !== "ROOM_EXISTS") throw error;
            // The opponent got there first - fall through and join their room.
            seats = await roomPlayers();
            if (seats.p1 === user.uid) return { code, slot: "p1" };
        }
    }

    await joinRoom(code, user, name);
    return { code, slot: "p2" };
}

export { playerCount };
