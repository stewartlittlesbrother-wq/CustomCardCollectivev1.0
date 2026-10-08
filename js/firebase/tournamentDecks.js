// Deck lists and card rules for tournaments: checking a deck against a tournament's
// card pool and ban list, submitting a deck list, and reading submitted lists back.
//
// A deck only stores card NUMBERS, and the same number can exist in more than one
// collection, so a card counts as "in the pool" if ANY card with that number is in one
// of the tournament's collections. The in-game card database has no collection field,
// so the shared card library is asked (for just this deck's numbers).

import { ref, get, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebaseApp.js";
import { BASE_PATH, DECKS_PATH } from "./tournamentPaths.js?v=tour-3";

const LIBRARY_URL = "./cardLibraryService.js?v=collections-14";
const norm = (value) => String(value || "").trim().toLowerCase();

// ── reading a deck ───────────────────────────────────────────────────────────

/** The player's saved decks (Deck Builder), in the shape the multiplayer lobby uses. */
export function savedDecks() {
    try { return (window.getAvailableDecks && window.getAvailableDecks()) || []; }
    catch { return []; }
}

/** { number -> copies } for the main deck, plus the leader number(s). */
export function deckContents(deck) {
    const counts = new Map();
    String((deck && deck.deckText) || "").split(/\n+/).forEach(line => {
        const m = line.trim().match(/^(\d+)x(.+)$/i);
        if (!m) return;
        const id = m[2].trim();
        counts.set(id, (counts.get(id) || 0) + Number(m[1]));
    });
    const leaders = [deck && deck.leaderKey, deck && deck.leaderKey2].filter(Boolean);
    return { counts, leaders };
}

let bundledPromise = null;
function bundledCards() {
    if (!bundledPromise) {
        bundledPromise = fetch(new URL("../../data/cards/custom-project-cards.json", import.meta.url))
            .then(r => (r.ok ? r.json() : []))
            .then(payload => (Array.isArray(payload) ? payload : Object.values(payload || {})))
            .catch(() => []);
    }
    return bundledPromise;
}

/**
 * Look up card numbers: Map(number -> { name, collections:Set, imageUrl }).
 * Library cards win; cards that only exist in the bundled JSON count as the default
 * collection.
 */
export async function lookupCards(numbers, { withImages = false } = {}) {
    const wanted = new Set([...numbers].filter(Boolean));
    const found = new Map();
    if (!wanted.size) return found;
    const fallback = window.COLLECTION_DEFAULT || "golds-bleach";

    const add = (key, card, collection) => {
        if (!wanted.has(key)) return;
        let entry = found.get(key);
        if (!entry) { entry = { name: "", collections: new Set(), imageUrl: "" }; found.set(key, entry); }
        if (card.name && !entry.name) entry.name = card.name;
        entry.collections.add(collection);
        if (withImages && !entry.imageUrl && (card.imageUrl || card.image)) entry.imageUrl = card.imageUrl || card.image;
    };

    try {
        const library = await import(LIBRARY_URL);
        const { cards } = await library.loadSharedCards({ onlyNumbers: wanted });
        (cards || []).forEach(card => {
            [card.cardNumber, card.id].filter(Boolean).forEach(key => add(key, card, card.collection || fallback));
        });
    } catch (error) {
        const failure = new Error("Couldn't load the card library. Check your connection and try again.");
        failure.cause = error;
        throw failure;
    }

    // Anything the library doesn't know may be a bundled card.
    const missing = [...wanted].filter(id => !found.has(id));
    if (missing.length) {
        const bundled = await bundledCards();
        bundled.forEach(card => {
            [card.cardNumber, card.id].filter(Boolean).forEach(key => {
                if (missing.includes(key)) add(key, card, card.collection || fallback);
            });
        });
    }
    return found;
}

// ── checking a deck against the rules ────────────────────────────────────────

/**
 * Check a deck against a tournament's card pool and ban list.
 * rules = { collections: [slug...], banned: [number...], collectionName?: fn(slug) }
 * Returns { problems: [string], entries: [{ number, name, qty, leader }] }.
 */
export async function checkDeck(deck, rules = {}) {
    const { counts, leaders } = deckContents(deck);
    const ids = new Set([...counts.keys(), ...leaders]);
    const pool = new Set((rules.collections || []).filter(Boolean));
    const banned = new Set((rules.banned || []).map(norm).filter(Boolean));
    const problems = [];

    const entries = [];
    if (!ids.size) return { problems: ["This deck is empty."], entries };

    const info = await lookupCards(ids);
    const nameOf = (id) => (info.get(id) && info.get(id).name) || "";
    leaders.forEach(id => entries.push({ number: id, name: nameOf(id), qty: 1, leader: true }));
    [...counts.entries()].forEach(([id, qty]) => entries.push({ number: id, name: nameOf(id), qty, leader: false }));

    if (pool.size) {
        const fallback = window.COLLECTION_DEFAULT || "golds-bleach";
        const outside = [];
        ids.forEach(id => {
            const entry = info.get(id);
            // Unknown everywhere: only the default collection can vouch for it.
            const allowed = entry ? [...entry.collections].some(c => pool.has(c)) : pool.has(fallback);
            if (!allowed) outside.push(nameOf(id) || id);
        });
        if (outside.length) {
            const label = rules.collectionName || ((slug) => slug);
            const shown = outside.slice(0, 6).join(", ") + (outside.length > 6 ? `, and ${outside.length - 6} more` : "");
            problems.push(`This deck has cards outside the tournament's card pool (${[...pool].map(label).join(", ")}): ${shown}.`);
        }
    }

    if (banned.size) {
        const hit = [...ids].filter(id => banned.has(norm(id)));
        if (hit.length) {
            problems.push(`This deck has banned cards: ${hit.map(id => nameOf(id) ? `${nameOf(id)} (${id})` : id).join(", ")}.`);
        }
    }
    return { problems, entries };
}

// ── submitting / reading deck lists ──────────────────────────────────────────

/** The plain-text form of a submitted list: "1 Leader", "4x OP01-001 Name"... */
export function deckListText(submission) {
    if (!submission) return "";
    const entries = Array.isArray(submission.cards) ? submission.cards : Object.values(submission.cards || {});
    const lines = [];
    entries.filter(c => c.leader).forEach(c => lines.push(`Leader: ${c.number}${c.name ? ` ${c.name}` : ""}`));
    entries.filter(c => !c.leader).forEach(c => lines.push(`${c.qty}x ${c.number}${c.name ? ` ${c.name}` : ""}`));
    return lines.join("\n");
}

/** Hand in a deck list. The caller has already run checkDeck(); `entries` come from it. */
export async function submitDeck(tournamentId, user, playerName, deck, entries) {
    if (!user || !user.uid) throw new Error("Sign in to submit a deck list.");
    const payload = {
        name: String(deck.name || "Deck").slice(0, 60),
        playerName: String(playerName || "Player").slice(0, 30),
        submittedAt: Date.now(),
        cards: entries.map(e => ({
            number: String(e.number),
            name: String(e.name || "").slice(0, 80),
            qty: Number(e.qty) || 1,
            leader: Boolean(e.leader)
        })),
        // Exactly what the multiplayer lobby needs to play this deck.
        deck: {
            id: String(deck.id || "submitted"),
            name: String(deck.name || "Deck").slice(0, 60),
            leaderKey: deck.leaderKey || "",
            leaderKey2: deck.leaderKey2 || "",
            deckText: deck.deckText || "",
            startingCards: Array.isArray(deck.startingCards) ? deck.startingCards : [],
            tokens: Array.isArray(deck.tokens) ? deck.tokens : []
        }
    };
    // One atomic write: the list itself and the "has a deck" marker on the player.
    await update(ref(database), {
        [`${DECKS_PATH}/${tournamentId}/${user.uid}`]: payload,
        [`${BASE_PATH}/${tournamentId}/players/${user.uid}/deckAt`]: payload.submittedAt
    });
    return payload;
}

export async function getSubmittedDeck(tournamentId, uid) {
    const snapshot = await get(ref(database, `${DECKS_PATH}/${tournamentId}/${uid}`));
    return snapshot.val();
}

/** Organiser only: every submitted list, live. callback(map of uid -> submission). */
export function watchDecks(tournamentId, callback, onError) {
    return onValue(
        ref(database, `${DECKS_PATH}/${tournamentId}`),
        (snapshot) => callback(snapshot.val() || {}),
        (error) => { if (onError) onError(error); }
    );
}

export async function removeSubmittedDeck(tournamentId, uid) {
    await remove(ref(database, `${DECKS_PATH}/${tournamentId}/${uid}`));
}
