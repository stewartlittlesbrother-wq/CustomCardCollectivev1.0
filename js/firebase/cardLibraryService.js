// Shared card library backed by Firebase Realtime Database.
//
// Card uploads used to POST to /api/project-cards, which only exists when the
// bundled Node server is running - so on static hosting (GitHub Pages) nothing
// could be saved, and nothing was ever shared between players. This module puts
// the library in the same Realtime Database the multiplayer lobby already uses,
// so a card uploaded by anyone is permanent and visible to everyone.
//
// Cards carry base64 artwork and average ~100KB each, so downloading the whole
// library on every page load would burn through Firebase's free bandwidth quota
// fast. Two things keep that in check:
//
//   cardIndex/{cardNumber}  -> { updatedAt }   tiny, always fetched
//   cards/{cardNumber}      -> { ...card }     heavy, fetched only when changed
//
// Full card bodies are cached in IndexedDB (localStorage is ~5MB and would
// overflow after ~50 cards), so a repeat visitor downloads only the index plus
// whatever actually changed since last time.

import {
    ref,
    get,
    update,
    remove,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database, waitForUser } from "./firebaseApp.js";

const CARDS_PATH = "cards";
const INDEX_PATH = "cardIndex";

// Tombstones live in the INDEX, as `cardIndex/{key} = { updatedAt, deleted:true }`.
//
// Some cards also exist in the JSON file bundled with the repo, and that file is
// reloaded on every visit - so removing such a card from `cards` alone isn't
// enough, it just reappears from the file. A tombstone is what makes a deletion
// stick, for everyone, permanently.
//
// They deliberately go in cardIndex rather than a separate path: the index is
// already fetched on every load, it's tiny, and its rules carry no `.validate`
// constraint - so this works with the rules already published, with no console
// step required.

const DB_NAME = "custom-cards-library";
const DB_VERSION = 1;
const STORE = "cards";

// ── IndexedDB cache ──────────────────────────────────────

function openCache() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "cardNumber" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function cacheTransaction(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
}

async function readCachedCards() {
    try {
        const db = await openCache();
        return await new Promise((resolve, reject) => {
            const request = cacheTransaction(db, "readonly").getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.warn("Card cache unavailable:", error);
        return [];
    }
}

async function writeCachedCards(cards, removedKeys = []) {
    if (!cards.length && !removedKeys.length) return;
    try {
        const db = await openCache();
        await new Promise((resolve, reject) => {
            const store = cacheTransaction(db, "readwrite");
            cards.forEach(card => store.put(card));
            removedKeys.forEach(key => store.delete(key));
            store.transaction.oncomplete = () => resolve();
            store.transaction.onerror = () => reject(store.transaction.error);
        });
    } catch (error) {
        console.warn("Could not cache cards:", error);
    }
}

// ── Public API ───────────────────────────────────────────

export function cardLibraryKey(card) {
    return String(card?.cardNumber || card?.id || "").trim();
}

// Card numbers present in the JSON file bundled with the repo. Needed so a
// deletion can tombstone a card that lives only in that file.
let bundledKeysPromise = null;
function bundledCardKeys() {
    if (!bundledKeysPromise) {
        bundledKeysPromise = fetch("data/cards/custom-project-cards.json")
            .then(response => (response.ok ? response.json() : []))
            .then(payload => {
                const list = Array.isArray(payload) ? payload : Object.values(payload || {});
                return list.map(cardLibraryKey).filter(Boolean);
            })
            .catch(() => []);
    }
    return bundledKeysPromise;
}

// Fetch the shared library, downloading only what changed since the last visit.
// Returns { cards, fetched, cached } so callers can report what happened.
export async function loadSharedCards() {
    await waitForUser();

    const indexSnapshot = await get(ref(database, INDEX_PATH));
    const index = indexSnapshot.val() || {};
    const wantedKeys = Object.keys(index);

    // Tombstoned entries carry `deleted: true` in the index itself, so they cost
    // no extra request and can't fail independently of the index read.
    const deleted = new Set(wantedKeys.filter(key => index[key]?.deleted === true));
    const liveKeys = wantedKeys.filter(key => !deleted.has(key));

    const cached = await readCachedCards();
    const cachedByKey = new Map(cached.map(card => [cardLibraryKey(card), card]));

    // A card needs downloading if we've never seen it, or the server copy is
    // newer than ours. Tombstoned keys have no body to fetch.
    const stale = liveKeys.filter(key => {
        const mine = cachedByKey.get(key);
        if (!mine) return true;
        return Number(mine.updatedAt || 0) !== Number(index[key]?.updatedAt || 0);
    });

    // Only drop cards that were EXPLICITLY tombstoned.
    //
    // This used to drop anything merely absent from the index, which made the
    // cache worthless as a safety net: one incomplete index read and the last
    // local copy of every uploaded card was destroyed. Keeping unlisted cards
    // cached costs nothing (they're filtered out of the returned set below) and
    // means the cache can be used to restore the library.
    const removed = [...cachedByKey.keys()].filter(key => deleted.has(key));

    const downloaded = [];
    for (const key of stale) {
        const snapshot = await get(ref(database, `${CARDS_PATH}/${key}`));
        const card = snapshot.val();
        if (card) {
            card.updatedAt = Number(index[key]?.updatedAt || 0);
            downloaded.push(card);
            cachedByKey.set(key, card);
        }
    }

    await writeCachedCards(downloaded, removed);
    removed.forEach(key => cachedByKey.delete(key));

    return {
        cards: liveKeys.map(key => cachedByKey.get(key)).filter(Boolean),
        // Callers merge the repo's bundled JSON with this library; they need the
        // tombstones so a deleted bundled card doesn't come back from the file.
        deleted,
        fetched: downloaded.length,
        cached: liveKeys.length - downloaded.length
    };
}

// Compare two cards ignoring bookkeeping fields, so re-saving an unchanged card
// doesn't re-upload ~100KB of artwork.
function sameCard(a, b) {
    const strip = (card) => {
        const { updatedAt, ...rest } = card || {};
        return JSON.stringify(rest, Object.keys(rest).sort());
    };
    return strip(a) === strip(b);
}

// Reconcile the whole library against a desired set of cards: upload anything
// new or changed, delete anything no longer present. The card-creation UI hands
// over the full list on every save, so this keeps that call shape while only
// putting the actual delta on the wire.
export async function syncSharedCards(cards) {
    await waitForUser();

    const indexSnapshot = await get(ref(database, INDEX_PATH));
    const index = indexSnapshot.val() || {};

    const cached = await readCachedCards();
    const cachedByKey = new Map(cached.map(card => [cardLibraryKey(card), card]));

    const updates = {};
    const changedKeys = [];
    const desired = new Set();
    let uploaded = 0;
    let deleted = 0;

    cards.forEach(card => {
        const key = cardLibraryKey(card);
        if (!key) return;
        desired.add(key);

        const payload = { ...card, cardNumber: key, id: card.id || key };
        const mine = cachedByKey.get(key);

        // Upload when it's new to the server, its content differs from the copy
        // we last saw, or it was previously deleted (re-adding lifts the
        // tombstone by overwriting the whole index entry).
        const tombstoned = index[key]?.deleted === true;
        if (!index[key] || tombstoned || !mine || !sameCard(mine, payload)) {
            updates[`${CARDS_PATH}/${key}`] = payload;
            // Replace the entry outright rather than only setting updatedAt, so
            // a lingering `deleted: true` is cleared.
            updates[`${INDEX_PATH}/${key}`] = { updatedAt: serverTimestamp() };
            changedKeys.push(key);
            uploaded++;
        }
    });

    // Deliberately does NOT delete cards missing from `cards`.
    //
    // It used to: anything in the library but absent from the caller's list was
    // removed. That made a single failed read catastrophic - if loadSharedCards
    // threw, the caller passed only the bundled cards and every uploaded card
    // was wiped. Deletion is now explicit (deleteSharedCard), so an incomplete
    // list can only ever fail to add, never destroy.
    const removedKeys = [];

    if (!Object.keys(updates).length) return { uploaded: 0, deleted: 0 };

    await update(ref(database), updates);

    // Refresh the cache with the server-resolved timestamps so none of these
    // cards look stale on the next load.
    if (changedKeys.length) {
        const freshIndex = (await get(ref(database, INDEX_PATH))).val() || {};
        const byKey = new Map(cards.map(card => [cardLibraryKey(card), card]));
        await writeCachedCards(
            changedKeys.map(key => {
                const card = byKey.get(key);
                return { ...card, cardNumber: key, id: card.id || key,
                         updatedAt: Number(freshIndex[key]?.updatedAt || 0) };
            }),
            removedKeys
        );
    } else if (removedKeys.length) {
        await writeCachedCards([], removedKeys);
    }

    return { uploaded, deleted, tombstonesWritten };
}

// Publish one card for everyone. Writing the card and its index entry in a
// single multi-path update keeps the two from drifting apart if the write is
// interrupted.
export async function saveSharedCard(card) {
    await waitForUser();

    const key = cardLibraryKey(card);
    if (!key) throw new Error("A card needs a card number before it can be shared.");

    const payload = { ...card, cardNumber: key, id: card.id || key };

    await update(ref(database), {
        [`${CARDS_PATH}/${key}`]: payload,
        // Replace the WHOLE index entry, don't just set updatedAt underneath it.
        // A deleted card keeps a `deleted: true` tombstone here; writing only the
        // timestamp left that flag in place, so re-adding a card you'd previously
        // deleted uploaded it fine and then filtered it straight back out - it
        // simply never reappeared, with no error.
        [`${INDEX_PATH}/${key}`]: { updatedAt: serverTimestamp() }
    });

    // Re-read the resolved server timestamp so the local cache matches the index
    // and this card isn't re-downloaded on the next load.
    const stamp = await get(ref(database, `${INDEX_PATH}/${key}/updatedAt`));
    await writeCachedCards([{ ...payload, updatedAt: Number(stamp.val() || 0) }]);

    return payload;
}

// Remove ONE card, by key. This is the only path that deletes anything, so a
// bad read can never cascade into losing the library.
export async function deleteSharedCard(cardNumber) {
    await waitForUser();

    const key = String(cardNumber || "").trim();
    if (!key) return { tombstoned: false };

    // Drop the card body, and mark the index entry as a tombstone so the card
    // can't come back from the bundled JSON file. Bumping updatedAt makes other
    // clients notice the change on their next load.
    await update(ref(database), {
        [`${CARDS_PATH}/${key}`]: null,
        [`${INDEX_PATH}/${key}`]: { deleted: true, updatedAt: serverTimestamp() }
    });

    await writeCachedCards([], [key]);
    return { tombstoned: true };
}

// ── Shared collections ───────────────────────────────────
// User-created card collections (name + optional cover image), shared with every
// player through the same database. Small records, so we just fetch them all on
// load - no index/cache dance like the heavy card bodies need.
const COLLECTIONS_PATH = "collections";

export async function loadSharedCollections() {
    try {
        const snap = await get(ref(database, COLLECTIONS_PATH));
        const val = snap.val() || {};
        return Object.entries(val)
            .filter(([, entry]) => entry && !entry.deleted)
            .map(([slug, entry]) => ({
                slug,
                name: entry.name || slug,
                image: entry.image || ""
            }));
    } catch (error) {
        console.warn("Shared collections not loaded:", error);
        return [];
    }
}

export async function saveSharedCollection(collection) {
    await waitForUser();
    const slug = String(collection?.slug || "").trim();
    if (!slug) throw new Error("A collection needs a slug.");

    await update(ref(database), {
        [`${COLLECTIONS_PATH}/${slug}`]: {
            name: String(collection.name || slug),
            image: String(collection.image || ""),
            updatedAt: serverTimestamp()
        }
    });
    return { slug, name: collection.name || slug, image: collection.image || "" };
}

export async function deleteSharedCollection(slug) {
    await waitForUser();
    const key = String(slug || "").trim();
    if (!key) return;
    await remove(ref(database, `${COLLECTIONS_PATH}/${key}`));
}

// Used by the "clear editable cards" action.
export async function clearSharedCards() {
    await waitForUser();
    await Promise.all([
        remove(ref(database, CARDS_PATH)),
        remove(ref(database, INDEX_PATH))
    ]);

    const cached = await readCachedCards();
    await writeCachedCards([], cached.map(cardLibraryKey).filter(Boolean));
}

// Cards this browser has cached that the shared library no longer contains.
// The cache holds full card bodies including artwork, so it doubles as a local
// backup - this is what makes recovering an accidentally emptied library possible.
export async function findRecoverableCards() {
    const cached = await readCachedCards();
    if (!cached.length) return [];

    let index = {};
    try {
        index = (await get(ref(database, INDEX_PATH))).val() || {};
    } catch {
        return [];   // can't tell what's missing; don't guess
    }

    return cached.filter(card => {
        const key = cardLibraryKey(card);
        return key && !index[key];
    });
}

// Push cached-but-missing cards back into the shared library.
export async function restoreCardsFromCache() {
    await waitForUser();

    const missing = await findRecoverableCards();
    if (!missing.length) return { restored: 0, cards: [] };

    const updates = {};
    missing.forEach(card => {
        const key = cardLibraryKey(card);
        const { updatedAt, ...payload } = card;
        updates[`${CARDS_PATH}/${key}`] = { ...payload, cardNumber: key, id: card.id || key };
        // Replacing the whole entry clears any `deleted: true` marker, so a
        // restored card isn't still treated as tombstoned.
        updates[`${INDEX_PATH}/${key}`] = { updatedAt: serverTimestamp() };
    });

    await update(ref(database), updates);

    return { restored: missing.length, cards: missing.map(c => `${cardLibraryKey(c)} ${c.name || ""}`.trim()) };
}

// Seed the shared library from the JSON file that ships with the repo. Existing
// shared cards are left alone, so this is safe to run more than once.
export async function seedSharedCardsFrom(cards) {
    await waitForUser();

    const indexSnapshot = await get(ref(database, INDEX_PATH));
    const existing = indexSnapshot.val() || {};

    const updates = {};
    let seeded = 0;

    cards.forEach(card => {
        const key = cardLibraryKey(card);
        // Skip cards already shared, AND cards someone deliberately deleted -
        // an index entry exists in both cases (a tombstone carries deleted:true),
        // so seeding can never resurrect a deletion.
        if (!key || existing[key]) return;
        updates[`${CARDS_PATH}/${key}`] = { ...card, cardNumber: key, id: card.id || key };
        updates[`${INDEX_PATH}/${key}/updatedAt`] = serverTimestamp();
        seeded++;
    });

    if (seeded) await update(ref(database), updates);
    return seeded;
}
