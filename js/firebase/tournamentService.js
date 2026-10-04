// Tournaments in Firebase. The rules themselves live in ../core/tournamentEngine.js
// (pure + unit tested); this file only stores the document, keeps it up to date and
// launches each pairing's match room.
//
// There is no server, so nothing "runs" the tournament: whenever a participant's
// browser looks at it (the tournaments page, or a game ending), it calls
// syncTournament / reportMatchResult, which feed the current time and any results
// into the engine inside a Firebase TRANSACTION. Several browsers doing that at once
// is safe - the transaction serialises them and the engine is deterministic.

import {
    ref,
    get,
    set,
    update,
    remove,
    push,
    onValue,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database } from "./firebaseApp.js";
import { createRoom, joinRoom } from "./multiplayerService.js?v=draft-6";
import {
    tick,
    checkIn,
    roomCodeFor,
    roundKey,
    getRound,
    pairingsOf,
    collectionsOf,
    myStatus,
    playerCount,
    MIN_PLAYERS
} from "../core/tournamentEngine.js?v=tour-1";

// DEVELOPMENT ONLY - never active on the real site. On localhost, ?tbase=<db path>
// (remembered for the tab, so it survives going lobby -> game) points tournaments at
// a scratch database path, so the feature can be tested before the production
// database rules are published.
function devBasePath() {
    try {
        if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "";
        const fromUrl = new URLSearchParams(location.search).get("tbase");
        if (fromUrl) sessionStorage.setItem("cc_tbase", fromUrl);
        return (sessionStorage.getItem("cc_tbase") || "").replace(/^\/+|\/+$/g, "");
    } catch { return ""; }
}

let basePath = devBasePath() || "tournaments";

const tournamentRef = (id, ...parts) => ref(database, [basePath, id, ...parts].join("/"));

export function isPermissionError(error) {
    return /permission|denied/i.test(String((error && (error.code || error.message)) || ""));
}

function withIds(value) {
    return Object.entries(value || {})
        .map(([id, t]) => ({ ...t, id }))
        .filter(t => t && t.name && t.startAt);
}

// ── create / list ────────────────────────────────────────────────────────────

export async function createTournament(user, displayName, opts) {
    if (!user || !user.uid) throw new Error("Sign in to create a tournament.");

    const name = String(opts.name || "").trim().slice(0, 60);
    if (!name) throw new Error("Give the tournament a name.");

    const startAt = Number(opts.startAt);
    if (!Number.isFinite(startAt) || startAt < Date.now() + 60 * 1000) {
        throw new Error("Pick a start time at least a minute from now.");
    }

    const roundMinutes = Number(opts.roundMinutes);
    if (!Number.isFinite(roundMinutes) || roundMinutes < 5) throw new Error("Choose how long each round lasts.");

    const maxPlayers = Number(opts.maxPlayers);
    if (!Number.isFinite(maxPlayers) || maxPlayers < MIN_PLAYERS) throw new Error("Choose the maximum number of players.");

    const matchType = opts.matchType === "draft" ? "draft" : "regular";
    const format = opts.format === "swiss" ? "swiss" : "elimination";
    const collections = (opts.collections || []).map(String).filter(Boolean);
    const player = String(displayName || "Player").slice(0, 30);

    const doc = {
        name,
        createdBy: user.uid,
        createdByName: player,
        createdAt: Date.now(),
        matchType,
        format,
        startAt,
        roundMinutes,
        maxPlayers,
        status: "registration"
    };
    if (collections.length) doc.collections = collections;
    if (opts.join !== false) doc.players = { [user.uid]: { name: player, joinedAt: Date.now() } };

    const node = push(ref(database, basePath));
    await set(node, doc);
    return node.key;
}

export function watchTournaments(callback, onError) {
    return onValue(
        ref(database, basePath),
        (snapshot) => callback(withIds(snapshot.val())),
        (error) => { if (onError) onError(error); }
    );
}

// ── joining ──────────────────────────────────────────────────────────────────

export async function joinTournament(id, user, displayName) {
    if (!user || !user.uid) throw new Error("Sign in to join a tournament.");
    try {
        await set(tournamentRef(id, "players", user.uid), {
            name: String(displayName || "Player").slice(0, 30),
            joinedAt: Date.now()
        });
    } catch (error) {
        if (isPermissionError(error)) {
            throw new Error("Couldn't join - the tournament may be full or already started.");
        }
        throw error;
    }
}

export async function leaveTournament(id, uid) {
    await remove(tournamentRef(id, "players", uid));
}

export async function cancelTournament(id) {
    await update(tournamentRef(id), {
        status: "cancelled",
        cancelReason: "Cancelled by the organiser"
    });
}

// ── keeping it up to date ────────────────────────────────────────────────────

// For the signed-in player's OWN unfinished match(es) in the current round, look at
// the match room to see whether a winner has been decided. (The game page also
// reports results itself; this is the safety net for when it couldn't.)
async function collectResults(id, t, uid) {
    const results = {};
    if (t.status !== "running" || !uid) return results;
    const round = getRound(t, t.currentRound);

    await Promise.all(pairingsOf(round).map(async (p) => {
        if (p.result || p.bye || (p.a !== uid && p.b !== uid)) return;
        const code = roomCodeFor(id, t.currentRound, p.id);
        try {
            const [winnerSnap, p1Snap, p2Snap] = await Promise.all([
                get(ref(database, `matches/${code}/public/winner`)),
                get(ref(database, `matches/${code}/players/p1/uid`)),
                get(ref(database, `matches/${code}/players/p2/uid`))
            ]);
            const slot = winnerSnap.val();
            if (slot !== "p1" && slot !== "p2") return;
            const winnerUid = slot === "p1" ? p1Snap.val() : p2Snap.val();
            if (winnerUid === p.a || winnerUid === p.b) results[`${t.currentRound}/${p.id}`] = winnerUid;
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

/** Called from the game page the moment a tournament match ends. */
export async function reportMatchResult(meta, winnerUid) {
    if (!meta || !meta.id || !winnerUid) return null;
    const results = { [`${meta.round}/${meta.pairingId}`]: winnerUid };
    return applyTick(meta.id, results);
}

// ── playing a match ──────────────────────────────────────────────────────────

/** Who may play and where the result goes - stored on the match room itself. */
function matchMetadata(id, t, round, pairing) {
    const players = { [pairing.a]: true };
    if (pairing.b) players[pairing.b] = true;
    return {
        id,
        name: t.name,
        round,
        pairingId: pairing.id,
        matchType: t.matchType,
        format: t.format,
        collections: collectionsOf(t),
        players
    };
}

/**
 * Check the player in for their current match and make sure its room exists.
 * Returns { code, slot } - then send them to the multiplayer lobby for that room.
 * Whoever presses Play first creates the room; the opponent joins it.
 */
export async function enterMatch(id, t, user, displayName) {
    const status = myStatus(t, user.uid);
    if (status.state !== "play") throw new Error("You don't have a match to play right now.");

    const round = status.round;
    const pairing = pairingsOf(getRound(t, round)).find(p => p.id === status.pairingId);
    if (!pairing) throw new Error("Couldn't find your match.");

    // Showing up is recorded, because it decides a forfeit if the round times out.
    await set(tournamentRef(id, "rounds", roundKey(round), "pairings", pairing.id, "checkedIn", user.uid), Date.now());

    const code = roomCodeFor(id, round, pairing.id);
    const name = String(displayName || "Player").slice(0, 30);
    const roomPlayers = async () => {
        const [p1, p2] = await Promise.all([
            get(ref(database, `matches/${code}/players/p1/uid`)),
            get(ref(database, `matches/${code}/players/p2/uid`))
        ]);
        return { p1: p1.val(), p2: p2.val() };
    };

    // Already in this room (coming back to a match in progress)?
    let seats = await roomPlayers();
    if (seats.p1 === user.uid) return { code, slot: "p1" };
    if (seats.p2 === user.uid) return { code, slot: "p2" };

    if (!seats.p1) {
        try {
            await createRoom(user, {
                roomCode: code,
                nickname: name,
                lobbyName: `${t.name} - Round ${round}`,
                mode: t.matchType,
                draftCollection: t.matchType === "draft" ? collectionsOf(t).join(",") : "",
                tournament: matchMetadata(id, t, round, pairing)
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
