// Old game rooms clean-up.
//
// A room (matches/<code>) used to stay in the database for ever: nothing deleted
// it when a game ended, and each one holds up to a few MB (custom playmats, both
// decks, the board). By October 2026 that was most of the storage that wasn't
// card pictures, and the free plan caps storage at 1 GB.
//
// Browsers can't list `matches` (the rules only allow reading one room at a time),
// so rooms are found two ways:
//   - the public activeGames list: a game abandoned mid-way stays on it
//   - the rooms THIS browser played in, remembered locally (self.js writes
//     HISTORY_KEY) - the only trace of a finished or private room
// A room goes once nobody has connected to it for KEEP_DAYS.
//
// Its own module on purpose: nothing here is needed to play, so a problem in it
// can't affect a game.

import {
    ref,
    get,
    update,
    onValue
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database, waitForUser } from "./firebaseApp.js";

const HISTORY_KEY = "cc_mp_rooms_v1";        // { CODE: last time this browser was in it (ms) }
const SWEEP_KEY = "cc_mp_room_sweep_at";
const DAY = 24 * 60 * 60 * 1000;
const SWEEP_EVERY = 12 * 60 * 60 * 1000;

// Days without anyone connected before a room is removed. A finished game is only
// needed for "Play again" and for a tournament's top decks; an unfinished one
// might be resumed; tournament rounds can last days.
export const KEEP_DAYS = { finished: 3, unfinished: 14, tournament: 45 };

const cleanCode = (code) => String(code || "").trim().toUpperCase().replace(/[.#$/\[\]]/g, "");

export function readRoomHistory() {
    try {
        const map = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
        return map && typeof map === "object" ? map : {};
    } catch (_) {
        return {};
    }
}

function writeRoomHistory(map) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(map)); } catch (_) {}
}

// The server's clock, so a browser whose own clock is wrong can't make a fresh
// room look old. Resolves null when the server can't be asked - then nothing is
// removed (never fall back to this device's clock). (.info paths only work with a
// listener, not get().)
function serverTime() {
    return new Promise((resolve) => {
        let settled = false;
        let stop = null;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
            setTimeout(() => { try { if (stop) stop(); } catch (_) {} }, 0);
        };
        try {
            stop = onValue(ref(database, ".info/serverTimeOffset"),
                (snapshot) => finish(Date.now() + (Number(snapshot.val()) || 0)),
                () => finish(null));
        } catch (_) {
            finish(null);
        }
        setTimeout(() => finish(null), 5000);
    });
}

// What is known about a room without reading its (large) contents.
async function inspectRoom(code) {
    const base = `matches/${code}`;
    const [created, presence, phase, tournament] = await Promise.all([
        get(ref(database, `${base}/createdAt`)),
        get(ref(database, `${base}/presence`)),
        get(ref(database, `${base}/public/phase`)),
        get(ref(database, `${base}/tournament`))
    ]);
    const seats = Object.values(presence.val() || {}).filter(Boolean);
    const times = [Number(created.val()) || 0, ...seats.map(seat => Number(seat.at) || 0)];
    return {
        exists: created.exists() || presence.exists() || phase.exists(),
        online: seats.some(seat => seat.online === true),
        lastSeen: Math.max(...times),
        finished: phase.val() === "gameOver",
        tournament: tournament.exists()
    };
}

/**
 * Decide about one room. Returns "removed", "kept" or "missing".
 * Pure rule (exported for tests): shouldRemoveRoom(info, now).
 */
export function shouldRemoveRoom(info, now) {
    // (A seat still marked "online" from weeks ago is a stale flag, not a player:
    // connecting refreshes its time, which lastSeen already counts.)
    if (!info || !info.exists || !info.lastSeen) return false;
    const days = info.tournament ? KEEP_DAYS.tournament : info.finished ? KEEP_DAYS.finished : KEEP_DAYS.unfinished;
    return now - info.lastSeen > days * DAY;
}

async function removeRoomIfStale(code, now) {
    const info = await inspectRoom(code);
    if (!info.exists) {
        // Already gone: just drop a leftover list entry.
        await update(ref(database), { [`activeGames/${code}`]: null }).catch(() => {});
        return "missing";
    }
    if (!shouldRemoveRoom(info, now)) return "kept";
    await update(ref(database), { [`matches/${code}`]: null, [`activeGames/${code}`]: null });
    return "removed";
}

/**
 * Look for old rooms and remove them. Runs at most twice a day per browser and
 * checks a limited number of rooms each time (a few tiny reads per room).
 * options.force: ignore the once-per-12-hours limit. options.limit: rooms per run.
 */
export { serverTime as roomServerTime, inspectRoom };

// Every room in the database - for the site owner only. The rules let nobody else
// list `matches` (see database.rules.json), so this is how the backlog of rooms
// that no browser remembers gets found. Keys only (shallow), so it is a small
// read however much the rooms hold. Returns null when it isn't allowed: not the
// owner, or the rule hasn't been published yet.
async function listAllRoomCodes() {
    const user = await waitForUser();
    if (!user || user.isAnonymous) return null;
    const token = await user.getIdToken();
    const base = String(database.app.options.databaseURL || "").replace(/\/$/, "");
    const response = await fetch(`${base}/matches.json?shallow=true&auth=${token}`);
    if (!response.ok) return null;
    return Object.keys((await response.json()) || {});
}

/**
 * Owner only: go through EVERY room and remove the old ones (same KEEP_DAYS rule
 * as everywhere else - a room someone used recently is never touched).
 * Resolves { allowed, total, checked, removed, kept, missing, failed }.
 */
export async function sweepAllRoomsAsOwner(onProgress) {
    const summary = { allowed: false, total: 0, checked: 0, removed: 0, kept: 0, missing: 0, failed: 0 };
    const codes = await listAllRoomCodes();
    if (!codes) return summary;
    summary.allowed = true;
    summary.total = codes.length;
    const now = await serverTime();
    if (!now) return summary;   // can't be sure what time it is: remove nothing
    let next = 0;
    const lane = async () => {
        while (next < codes.length) {
            const code = codes[next++];
            try { summary[await removeRoomIfStale(code, now)] += 1; } catch (_) { summary.failed += 1; }
            summary.checked += 1;
            if (onProgress && summary.checked % 25 === 0) { try { onProgress({ ...summary }); } catch (_) {} }
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, codes.length) }, lane));
    return summary;
}

export async function sweepStaleRooms(options = {}) {
    const { force = false, limit = 30 } = options;
    const summary = { checked: 0, removed: 0, kept: 0, missing: 0 };
    try {
        if (!force && Date.now() - Number(localStorage.getItem(SWEEP_KEY) || 0) < SWEEP_EVERY) return summary;
        localStorage.setItem(SWEEP_KEY, String(Date.now()));
    } catch (_) { /* no storage: carry on, it is harmless to run again */ }

    await waitForUser();
    const now = await serverTime();
    if (!now) return summary;   // can't be sure what time it is: remove nothing
    const history = readRoomHistory();

    // Rooms this browser played in, once the shortest keep time has passed.
    const mine = Object.entries(history)
        .filter(([, at]) => now - Number(at || 0) > KEEP_DAYS.finished * DAY)
        .map(([code]) => cleanCode(code));
    // Abandoned games still on the public list.
    let listed = [];
    try {
        const games = (await get(ref(database, "activeGames"))).val() || {};
        listed = Object.entries(games)
            .filter(([, game]) => now - Number(game?.updatedAt || 0) > KEEP_DAYS.unfinished * DAY)
            .map(([code]) => cleanCode(code));
    } catch (_) { /* the list is optional */ }

    const codes = [...new Set([...mine, ...listed])].filter(Boolean).slice(0, limit);
    for (const code of codes) {
        try {
            const outcome = await removeRoomIfStale(code, now);
            summary.checked += 1;
            summary[outcome] += 1;
            if (outcome !== "kept") delete history[code];
        } catch (error) {
            console.warn("Room clean-up skipped", code, error);
        }
    }
    writeRoomHistory(history);
    return summary;
}
