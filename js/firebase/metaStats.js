// Play stats: which cards decks with a given leader actually run.
//
// Every online game, each player's browser adds the deck it brought to the
// totals of that deck's leader (draft games are left out - those decks are
// random). The Deck Builder's "Popular cards" view reads them back: of all the
// decks played with this leader, what share ran each card, and how many copies.
//
//   meta/leaders/<leader>        { id, decks, cards: { <card>: { id, d, c } } }
//       decks = decks played with this leader, d = how many of them ran the card,
//       c = copies of it across those decks (c / d = average copies)
//   meta/leaderTotals/<leader>   { id, decks, at }   a small list of every leader
//
// Only counters that go UP are written (database.rules.json checks that), with
// the database's own increment, so two games ending at once can't lose a count.
// Reading one leader is a few KB; nothing here touches the card library.

import {
    ref,
    get,
    update,
    increment,
    serverTimestamp,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database, waitForUser } from "./firebaseApp.js";

const META = "meta";

// Card ids are usually clean, but a database key can't hold . # $ / [ ]
export const statKey = (id) => String(id || "").trim().replace(/[.#$\/\[\]]/g, "-").slice(0, 200);

/** "4xJBA2-001" lines -> Map(card id -> copies). Leader lines and comments are skipped. */
export function deckCounts(deckText) {
    const counts = new Map();
    String(deckText || "").split(/\r?\n/).forEach(line => {
        const match = line.trim().match(/^(\d+)\s*x\s*(.+)$/i);
        if (!match) return;
        const qty = Number(match[1]) || 0;
        const id = match[2].trim();
        if (qty > 0 && id) counts.set(id, (counts.get(id) || 0) + qty);
    });
    return counts;
}

/** The writes that add one deck to its leader's totals (exported for the tests). */
export function deckUpdates(leaderId, counts) {
    const leader = statKey(leaderId);
    if (!leader || !counts || !counts.size) return null;
    const base = `${META}/leaders/${leader}`;
    const updates = {
        [`${base}/id`]: String(leaderId),
        [`${base}/decks`]: increment(1),
        [`${META}/leaderTotals/${leader}/id`]: String(leaderId),
        [`${META}/leaderTotals/${leader}/decks`]: increment(1),
        [`${META}/leaderTotals/${leader}/at`]: serverTimestamp()
    };
    // One entry per card, however the deck text spelled it.
    const merged = new Map();
    counts.forEach((qty, id) => {
        const key = statKey(id);
        if (!key) return;
        const prev = merged.get(key) || { id, qty: 0 };
        prev.qty += qty;
        merged.set(key, prev);
    });
    merged.forEach(({ id, qty }, key) => {
        updates[`${base}/cards/${key}/id`] = String(id);
        updates[`${base}/cards/${key}/d`] = increment(1);
        updates[`${base}/cards/${key}/c`] = increment(Math.min(qty, 60));
    });
    return updates;
}

/**
 * Add the deck a player brought to a game. Counted once per game and seat even if
 * the page is reloaded mid-game (a marker in the room decides who got there first).
 * Resolves true when this call counted it.
 */
export async function recordDeckPlayed({ roomCode, gameId, slot, leaderId, deckText }) {
    if (!roomCode || !gameId || !slot || !leaderId) return false;
    const updates = deckUpdates(leaderId, deckCounts(deckText));
    if (!updates) return false;
    await waitForUser();
    const marker = ref(database, `matches/${roomCode}/statsRecorded/${String(gameId).replace(/[.#$\/\[\]]/g, "-")}/${slot}`);
    const claim = await runTransaction(marker, (current) => (current ? undefined : true), { applyLocally: false });
    if (!claim.committed) return false;
    await update(ref(database), updates);
    return true;
}

/** One leader's numbers: { decks, cards: [{ id, decks, copies }] } (biggest share first). */
export async function loadLeaderStats(leaderId) {
    const leader = statKey(leaderId);
    if (!leader) return { decks: 0, cards: [] };
    const value = (await get(ref(database, `${META}/leaders/${leader}`))).val() || {};
    const cards = Object.values(value.cards || {})
        .filter(entry => entry && entry.id && Number(entry.d) > 0)
        .map(entry => ({ id: String(entry.id), decks: Number(entry.d) || 0, copies: Number(entry.c) || 0 }))
        .sort((a, b) => b.decks - a.decks || b.copies - a.copies);
    return { decks: Number(value.decks) || 0, cards };
}

/** Every leader that has been played: [{ id, decks, at }] (most played first). */
export async function loadLeaderTotals() {
    const value = (await get(ref(database, `${META}/leaderTotals`))).val() || {};
    return Object.values(value)
        .filter(entry => entry && entry.id && Number(entry.decks) > 0)
        .map(entry => ({ id: String(entry.id), decks: Number(entry.decks) || 0, at: Number(entry.at) || 0 }))
        .sort((a, b) => b.decks - a.decks);
}
