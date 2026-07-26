// decks.js

// No bundled decks. The old "Red Luffy Starter Deck (ST01)" referenced official
// One Piece cards that aren't part of this app's custom card pool, so it could
// never actually start a game - it only cluttered the deck picker and spammed
// "Card not found in database" errors. Decks now come purely from what the
// player builds and saves in the Deck Builder.
const availableDecks = [];

// Deck Builder saves named decks here as { name, leaderId, deck: {cardNumber: qty} }.
// Note: named to avoid colliding with app.js's own SAVED_DECKS_KEY const, since
// both scripts share the global scope on index.html.
const MP_SAVED_DECKS_KEY = "custom-cards-sim-luffy-only-saved-decks-v1";

function deckMapToText(deckMap) {
    return Object.entries(deckMap || {})
        .filter(([, qty]) => Number(qty) > 0)
        .map(([cardNumber, qty]) => `${qty}x${cardNumber}`)
        .join("\n");
}

// Read the player's saved decks and convert them to the multiplayer deck shape
// { id, name, leaderKey, deckText }. A deck needs a leader to be selectable.
function getSavedMultiplayerDecks() {
    try {
        const raw = JSON.parse(localStorage.getItem(MP_SAVED_DECKS_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
            .map((deck, index) => ({
                id: `saved-${index}`,
                name: deck.name || `Saved Deck ${index + 1}`,
                leaderKey: deck.leaderId || "",
                deckText: deckMapToText(deck.deck),
                // Token types this deck makes available in game (may be empty).
                tokens: Array.isArray(deck.tokens) ? deck.tokens : []
            }))
            .filter(deck => deck.leaderKey);
    } catch {
        return [];
    }
}

// A deck can only start a match if its leader actually exists in the loaded card
// database. The bundled ST01 starter deck references a real One Piece leader that
// isn't part of this app's custom card pool, so it would always fail at match
// start - surfacing that here is far clearer than an error after both players
// ready up. Mirrors the lookup order used by createInitialPrivateState().
function isDeckLeaderAvailable(deck) {
    const key = deck?.leaderKey;
    if (!key) return false;

    const leaders = window.leaders || {};
    if (leaders[key]) return true;

    // Read the card map directly rather than via getCardById, which logs a
    // console error on every miss - this is a existence check, not a fetch.
    if ((window.cardDatabase || {})[key]) return true;

    const wanted = String(key).toLowerCase();
    return Object.entries(leaders).some(([leaderKey, value]) =>
        leaderKey.toLowerCase() === wanted ||
        String(value?.cardNumber || "").toLowerCase() === wanted ||
        String(value?.id || "").toLowerCase() === wanted);
}

function getAvailableDecks() {
    // Saved decks first, with the built-in starter deck kept as a fallback option.
    return [...getSavedMultiplayerDecks(), ...availableDecks];
}

function getDeckById(deckId) {
    const all = getAvailableDecks();
    return all.find(deck => deck.id === deckId) || all[0] || null;
}

window.availableDecks = availableDecks;
window.getAvailableDecks = getAvailableDecks;
window.getDeckById = getDeckById;
window.isDeckLeaderAvailable = isDeckLeaderAvailable;
