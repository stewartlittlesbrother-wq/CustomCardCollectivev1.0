// Player profiles, the ranked ladder, friends and the inbox (friend requests, game
// invites). Accounts only - a guest's id changes every visit, so it can't keep a
// profile.
//
//   profiles/<uid>   public profile (everyone signed in can read it; only you write it)
//     { name, nameLower, since, updatedAt,
//       wins, losses, lastGameId,                 every online game you finish
//       leaders: { <key>: { key, name, n } },     most-played leaders
//       recent: { <gameId>: { at, won, opp, oppUid, leader, leaderName, oppLeader, oppLeaderName, quick, delta } },
//       ladder (opted in?), rating, ladderElo (= rating while opted in - the leaderboard index),
//       ladderGames, ladderWins, ladderLosses, ladderPeak, lastLadderGame,
//       trophies: { <tournamentId>: { name, place, label, players, at } }, tournamentWins }
//   friends/<uid>/<friendUid>  { name, status: "friend" | "sent", since }   (only you)
//   inbox/<uid>/<id>  { type: friendRequest | friendAccept | invite, fromUid, fromName, at, room? }
//                     anyone signed in can drop a message in; only you read / delete
//   status/<uid>      { online, at, name }  - online now? (cleared when the tab closes)
//
// Ladder: Elo, everyone starts at 1000. Only Quick match games count, and only when
// both players are on the ladder. Each player's browser updates its own rating from
// the two ratings both players wrote into the room when the game was dealt
// (matches/<room>/ladder/<gameId>/<slot>), so both sides compute the same change.

import {
    ref, get, set, update, push, remove, onValue, runTransaction, query,
    orderByChild, startAt, endAt, limitToLast, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebaseApp.js";

import { START_RATING, K_FACTOR, expectedScore, eloAfter } from "../core/ladder.js?v=1";
export { START_RATING, K_FACTOR, expectedScore, eloAfter };

// DEVELOPMENT ONLY - never active on the real site. On localhost, ?pbase=<db path>
// (remembered for the tab) keeps profiles / friends / inbox / status under a scratch
// path so the features can be tested before the database rules are published.
const DEV_BASE = (() => {
    try {
        if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "";
        const fromUrl = new URLSearchParams(location.search).get("pbase");
        if (fromUrl) sessionStorage.setItem("cc_pbase", fromUrl);
        return (sessionStorage.getItem("cc_pbase") || "").replace(/^\/+|\/+$/g, "");
    } catch { return ""; }
})();
const P = (path) => (DEV_BASE ? `${DEV_BASE}/${path}` : path);
const RECENT_KEEP = 10;
const INVITE_MAX_AGE_MS = 30 * 60 * 1000;

const safeKey = (value) => String(value || "").replace(/[.#$/\[\]]/g, "_").slice(0, 120) || "_";
const cleanName = (value) => String(value || "Player").trim().slice(0, 30) || "Player";

export function isPermissionError(error) {
    return /permission|denied/i.test(String((error && (error.code || error.message)) || ""));
}

// ── profile ──────────────────────────────────────────────────────────────────

const profileRef = (uid) => ref(database, P(`profiles/${uid}`));

/** Create the profile the first time (carrying over the old online record), and
 *  keep the name in step with the account. */
export async function ensureProfile(uid, name) {
    if (!uid) return null;
    const clean = cleanName(name);
    const snap = await get(profileRef(uid));
    const current = snap.val();
    if (!current) {
        let wins = 0, losses = 0;
        try {
            const rec = (await get(ref(database, `users/${uid}/mpRecord`))).val();
            if (rec) { wins = Number(rec.wins) || 0; losses = Number(rec.losses) || 0; }
        } catch { /* start from zero */ }
        const doc = { name: clean, nameLower: clean.toLowerCase(), since: Date.now(), updatedAt: Date.now(), wins, losses };
        await set(profileRef(uid), doc);
        return doc;
    }
    if (current.name !== clean) {
        await update(profileRef(uid), { name: clean, nameLower: clean.toLowerCase(), updatedAt: Date.now() });
    }
    return { ...current, name: clean };
}

export async function getProfile(uid) {
    if (!uid) return null;
    return (await get(profileRef(uid))).val();
}

export function watchProfile(uid, callback, onError) {
    return onValue(profileRef(uid), (snap) => callback(snap.val()), (error) => onError && onError(error));
}

/** Join or leave the ranked ladder. Your rating is kept while you're off it. */
export async function setLadderOptIn(uid, name, on) {
    await runTransaction(profileRef(uid), (current) => {
        const doc = current || { name: cleanName(name), nameLower: cleanName(name).toLowerCase(), since: Date.now(), wins: 0, losses: 0 };
        const rating = Number(doc.rating) || START_RATING;
        return { ...doc, ladder: Boolean(on), rating, ladderElo: on ? rating : null, updatedAt: Date.now() };
    });
}

/**
 * Record a finished online game on my profile (once per gameId):
 * info = { gameId, won, myName, opp, oppUid, leader, leaderName, oppLeader, oppLeaderName,
 *          quick, ladder: { mine, theirs } | null }
 * Returns the rating change (or null when the game wasn't rated).
 */
export async function recordGame(uid, info) {
    if (!uid || !info || !info.gameId) return null;
    let delta = null;
    await runTransaction(profileRef(uid), (current) => {
        delta = null;
        const doc = current || { name: cleanName(info.myName), nameLower: cleanName(info.myName).toLowerCase(), since: Date.now(), wins: 0, losses: 0 };
        if (doc.lastGameId === info.gameId) return;   // already counted (reload of the game-over screen)
        const next = { ...doc, lastGameId: info.gameId, updatedAt: Date.now() };
        next.wins = (Number(doc.wins) || 0) + (info.won ? 1 : 0);
        next.losses = (Number(doc.losses) || 0) + (info.won ? 0 : 1);

        if (info.leader) {
            const key = safeKey(info.leader);
            const leaders = { ...(doc.leaders || {}) };
            const prev = leaders[key] || { key: info.leader, name: info.leaderName || info.leader, n: 0 };
            leaders[key] = { ...prev, name: info.leaderName || prev.name, n: (Number(prev.n) || 0) + 1 };
            next.leaders = leaders;
        }

        // Rated: a Quick match where both players were on the ladder when it was dealt.
        if (info.quick && info.ladder && doc.ladder && doc.lastLadderGame !== info.gameId
            && Number.isFinite(Number(info.ladder.mine)) && Number.isFinite(Number(info.ladder.theirs))) {
            const before = Number(info.ladder.mine);
            const after = eloAfter(before, Number(info.ladder.theirs), info.won);
            delta = after - before;
            next.rating = (Number(doc.rating) || START_RATING) + delta;
            next.ladderElo = next.rating;
            next.ladderGames = (Number(doc.ladderGames) || 0) + 1;
            next.ladderWins = (Number(doc.ladderWins) || 0) + (info.won ? 1 : 0);
            next.ladderLosses = (Number(doc.ladderLosses) || 0) + (info.won ? 0 : 1);
            next.ladderPeak = Math.max(Number(doc.ladderPeak) || START_RATING, next.rating);
            next.lastLadderGame = info.gameId;
        }

        const recent = { ...(doc.recent || {}) };
        recent[safeKey(info.gameId)] = {
            at: Date.now(), won: Boolean(info.won), opp: cleanName(info.opp), oppUid: info.oppUid || "",
            leader: info.leader || "", leaderName: info.leaderName || "", oppLeader: info.oppLeader || "",
            oppLeaderName: info.oppLeaderName || "", quick: Boolean(info.quick), ...(delta !== null ? { delta } : {})
        };
        const keep = Object.entries(recent).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, RECENT_KEEP);
        next.recent = Object.fromEntries(keep);
        return next;
    });
    return delta;
}

/** Tournament trophies: add the ones this player earned that aren't on the profile. */
export async function addTrophies(uid, trophies) {
    const entries = Object.entries(trophies || {});
    if (!uid || !entries.length) return;
    const updates = {};
    entries.forEach(([tid, trophy]) => { updates[P(`profiles/${uid}/trophies/${safeKey(tid)}`)] = trophy; });
    const wins = entries.filter(([, t]) => t.place === 1).length;
    await update(ref(database), updates);
    if (wins) {
        await runTransaction(ref(database, P(`profiles/${uid}/tournamentWins`)), (n) => (Number(n) || 0) + wins);
    }
}

// ── leaderboard & search ─────────────────────────────────────────────────────

/** The top `limit` players on the ladder, best first: [{ uid, ...profile }]. */
// Rules published without the ".indexOn" refuse ordered queries: then read the whole
// list and sort / filter here instead.
const noIndex = (error) => /index not defined/i.test(String(error && error.message));

export async function leaderboard(limit = 50) {
    const rows = [];
    try {
        const snap = await get(query(ref(database, P("profiles")), orderByChild("ladderElo"), startAt(0), limitToLast(limit)));
        snap.forEach((child) => { rows.push({ uid: child.key, ...child.val() }); });
    } catch (error) {
        if (!noIndex(error)) throw error;
        const snap = await get(ref(database, P("profiles")));
        snap.forEach((child) => { rows.push({ uid: child.key, ...child.val() }); });
    }
    return rows.filter(r => r.ladderElo !== undefined && r.ladderElo !== null && Number.isFinite(Number(r.ladderElo)))
        .sort((a, b) => b.ladderElo - a.ladderElo).slice(0, limit);
}

/** Find players: an exact username, plus profile names starting with the text. */
export async function searchPlayers(text) {
    const q = String(text || "").trim().toLowerCase();
    if (q.length < 2) return [];
    const found = new Map();
    try {
        const byUsername = (await get(ref(database, `usernames/${safeKey(q)}`))).val();
        if (typeof byUsername === "string") {
            const profile = await getProfile(byUsername).catch(() => null);
            if (profile) found.set(byUsername, { uid: byUsername, ...profile, username: q });
        }
    } catch { /* names only */ }
    const add = (child) => { if (!found.has(child.key)) found.set(child.key, { uid: child.key, ...child.val() }); };
    try {
        // "\uf8ff" is the highest character: "rin" .. "rin\uf8ff" = every name starting with "rin".
        const snap = await get(query(ref(database, P("profiles")), orderByChild("nameLower"), startAt(q), endAt(`${q}\uf8ff`), limitToLast(20)));
        snap.forEach(add);
    } catch (error) {
        if (!noIndex(error)) throw error;
        const snap = await get(ref(database, P("profiles")));
        snap.forEach((child) => { if (String((child.val() || {}).nameLower || "").startsWith(q)) add(child); });
    }
    return [...found.values()].slice(0, 20);
}

// ── online status ────────────────────────────────────────────────────────────

let presenceUnsub = null;
/** Mark this account online while the page is open (cleared when it closes). */
export function startPresence(uid, name) {
    stopPresence();
    if (!uid) return;
    const statusRef = ref(database, P(`status/${uid}`));
    presenceUnsub = onValue(ref(database, ".info/connected"), (snap) => {
        if (snap.val() !== true) return;
        onDisconnect(statusRef).set({ online: false, at: serverTimestamp(), name: cleanName(name) })
            .then(() => set(statusRef, { online: true, at: serverTimestamp(), name: cleanName(name) }))
            .catch(() => { /* rules not published yet */ });
    });
}
export function stopPresence() {
    if (presenceUnsub) { try { presenceUnsub(); } catch { /* gone */ } }
    presenceUnsub = null;
}

/** Online state for a set of players: callback({ uid: { online, at } }). */
export function watchStatuses(uids, callback) {
    const states = {};
    const unsubs = [...new Set(uids)].map(uid => onValue(ref(database, P(`status/${uid}`)), (snap) => {
        states[uid] = snap.val() || { online: false };
        callback({ ...states });
    }, () => {}));
    return () => unsubs.forEach(u => { try { u(); } catch { /* gone */ } });
}

// ── friends ──────────────────────────────────────────────────────────────────

export function watchFriends(uid, callback, onError) {
    return onValue(ref(database, P(`friends/${uid}`)), (snap) => callback(snap.val() || {}), (error) => onError && onError(error));
}

/** My entry for one player (or null): { name, status, since }. */
export async function getFriend(me, them) {
    return (await get(ref(database, P(`friends/${me}/${them}`)))).val();
}

export async function sendFriendRequest(me, myName, them, theirName) {
    if (!me || !them || me === them) throw new Error("Pick someone else.");
    await set(ref(database, P(`friends/${me}/${them}`)), { name: cleanName(theirName), status: "sent", since: Date.now() });
    await set(push(ref(database, P(`inbox/${them}`))), { type: "friendRequest", fromUid: me, fromName: cleanName(myName), at: Date.now() });
}

export async function acceptFriend(me, myName, them, theirName, inboxId) {
    await set(ref(database, P(`friends/${me}/${them}`)), { name: cleanName(theirName), status: "friend", since: Date.now() });
    await set(push(ref(database, P(`inbox/${them}`))), { type: "friendAccept", fromUid: me, fromName: cleanName(myName), at: Date.now() });
    if (inboxId) await remove(ref(database, P(`inbox/${me}/${inboxId}`))).catch(() => {});
}

/** They accepted my request: they're my friend too (then the message can go). */
export async function confirmAccepted(me, them, theirName, inboxId) {
    await update(ref(database, P(`friends/${me}/${them}`)), { name: cleanName(theirName), status: "friend", since: Date.now() });
    if (inboxId) await remove(ref(database, P(`inbox/${me}/${inboxId}`))).catch(() => {});
}

export async function removeFriend(me, them) {
    await remove(ref(database, P(`friends/${me}/${them}`)));
}

export async function sendInvite(me, myName, them, room) {
    await set(push(ref(database, P(`inbox/${them}`))), { type: "invite", fromUid: me, fromName: cleanName(myName), room: String(room), at: Date.now() });
}

// ── inbox ────────────────────────────────────────────────────────────────────

export function watchInbox(uid, callback, onError) {
    return onValue(ref(database, P(`inbox/${uid}`)), (snap) => {
        const items = [];
        snap.forEach((child) => { items.push({ id: child.key, ...child.val() }); });
        callback(items);
    }, (error) => onError && onError(error));
}

export async function deleteInbox(uid, id) {
    await remove(ref(database, P(`inbox/${uid}/${id}`)));
}

/** Old game invites (the room is long gone) aren't worth showing. */
export const inviteIsFresh = (item, now = Date.now()) => item && item.type === "invite" && now - Number(item.at || 0) < INVITE_MAX_AGE_MS;

// ── ladder snapshots in the match room ───────────────────────────────────────

/** At deal time: my rating for this game (only when I'm on the ladder). */
export async function writeLadderSnapshot(roomCode, gameId, slot, uid) {
    const profile = await getProfile(uid).catch(() => null);
    if (!profile || !profile.ladder) return false;
    await set(ref(database, `matches/${roomCode}/ladder/${safeKey(gameId)}/${slot}`),
        { uid, elo: Number(profile.rating) || START_RATING });
    return true;
}

export async function readLadderSnapshot(roomCode, gameId) {
    return (await get(ref(database, `matches/${roomCode}/ladder/${safeKey(gameId)}`))).val() || {};
}
