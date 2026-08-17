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
// v2: the cache is keyed by the shared-library storage key (number+collection)
// instead of the bare cardNumber. The old keyPath collapsed two cards that share
// a number across collections into one, and mis-matched cards stored under a
// legacy number-only key. The cache is only a performance layer, so the upgrade
// simply drops the old store and lets everything re-download once.
const DB_VERSION = 2;
const STORE = "cards";
const CACHE_KEY_PATH = "__storageKey";

// ── IndexedDB cache ──────────────────────────────────────

function openCache() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            // Drop any prior store (old keyPath) and recreate on the new key.
            if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
            db.createObjectStore(STORE, { keyPath: CACHE_KEY_PATH });
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

// Firebase keys may not contain . # $ [ ] / (or control chars). Card numbers are
// usually clean but not guaranteed; collection slugs are already kebab-case.
// Scrub both so the compound key is always a legal path segment.
function sanitizeKeyPart(value) {
    return String(value ?? "").trim().replace(/[.#$/\[\]]/g, "-");
}

// The storage identity of a card. A card is unique by its NUMBER *and* its
// COLLECTION: the same set number can live in two different collections and both
// must survive (uploading "JJK1" to collection A then to collection B keeps
// both). Same number + same collection overwrites, which is the intended
// "replace this card" behaviour. Cards with no collection (legacy uploads,
// bundled cards from before collections existed) keep the plain number key so
// they still load and match their existing entries.
export function cardLibraryKey(card) {
    const number = sanitizeKeyPart(card?.cardNumber || card?.id || "");
    if (!number) return "";
    const collection = sanitizeKeyPart(card?.collection || "");
    return collection ? `${number}__${collection}` : number;
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

// Which collection a storage key belongs to. Keys are "number__collection"
// (see cardLibraryKey); a legacy number-only key has no collection.
function keyInCollection(key, sanitizedCollection) {
    return sanitizedCollection && key.endsWith(`__${sanitizedCollection}`);
}

// Fetch the shared library, downloading only what changed since the last visit.
// Returns { cards, fetched, cached } so callers can report what happened.
//
// options:
//   getPriority()  - optional, returns the collection slug the user is looking
//                    at RIGHT NOW (re-read before every batch). Its cards are
//                    downloaded first so an opened collection fills in fast even
//                    while the rest of the library is still syncing.
//   onProgress({cards, deleted}) - optional, called after each batch with every
//                    card resolved so far, so the pool can paint progressively
//                    instead of waiting for the whole download to finish.
export async function loadSharedCards(options = {}) {
    const { getPriority, onProgress } = options;
    await waitForUser();

    const indexSnapshot = await get(ref(database, INDEX_PATH));
    const index = indexSnapshot.val() || {};
    const wantedKeys = Object.keys(index);

    // Tombstoned entries carry `deleted: true` in the index itself, so they cost
    // no extra request and can't fail independently of the index read.
    const deleted = new Set(wantedKeys.filter(key => index[key]?.deleted === true));
    const liveKeys = wantedKeys.filter(key => !deleted.has(key));

    const cached = await readCachedCards();
    // Key by the EXACT storage key each card was cached under (its keyPath), not
    // a key recomputed from content - a legacy card stored at "JJK1" whose body
    // now carries a collection would otherwise recompute to "JJK1__collection",
    // miss its own index entry, and re-download on every single load.
    const cachedByKey = new Map(cached.map(card => [card[CACHE_KEY_PATH] || cardLibraryKey(card), card]));

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

    // Download stale bodies in PARALLEL batches. This used to be a plain
    // `for … await` loop - one sequential round-trip per card - so a cold cache
    // (e.g. right after a cache-format bump) meant waiting on hundreds of
    // requests back-to-back. Batching keeps it fast without opening an unbounded
    // number of sockets at once.
    // Build a partial "cards so far" snapshot from whatever's resolved in
    // cachedByKey, for streaming to the caller between batches.
    const snapshotCardsSoFar = () => liveKeys.map(key => {
        const card = cachedByKey.get(key);
        if (card) card.__storageKey = key;
        return card;
    }).filter(Boolean);

    const downloaded = [];
    const CONCURRENCY = 16;
    // A live queue (not a fixed-order loop) so we can re-sort by the collection
    // the user is currently viewing BEFORE each batch - open a collection while
    // this is running and its cards jump the queue.
    const remaining = stale.slice();

    // Cached cards are already in hand, so paint those immediately - the open
    // collection may be fully cached and can show before any download runs.
    if (onProgress && cached.length) {
        try { onProgress({ cards: snapshotCardsSoFar(), deleted }); } catch (_) {}
    }

    while (remaining.length) {
        const pri = getPriority ? sanitizeKeyPart(getPriority() || "") : "";
        if (pri) {
            // Matching-collection keys first; order among equals is preserved.
            remaining.sort((a, b) =>
                (keyInCollection(a, pri) ? 0 : 1) - (keyInCollection(b, pri) ? 0 : 1));
        }
        const batch = remaining.splice(0, CONCURRENCY);
        const results = await Promise.all(batch.map(key =>
            get(ref(database, `${CARDS_PATH}/${key}`))
                .then(snapshot => [key, snapshot.val()])
                .catch(() => [key, null])
        ));
        for (const [key, card] of results) {
            if (!card) continue;
            card.updatedAt = Number(index[key]?.updatedAt || 0);
            // Stamp the storage key so it's the cache keyPath and the load hint.
            card[CACHE_KEY_PATH] = key;
            downloaded.push(card);
            cachedByKey.set(key, card);
        }
        // Stream what we have so far so the grid fills in as cards land.
        if (onProgress) {
            try { onProgress({ cards: snapshotCardsSoFar(), deleted }); } catch (_) {}
        }
    }

    await writeCachedCards(downloaded, removed);
    removed.forEach(key => cachedByKey.delete(key));

    return {
        // Stamp each card with the EXACT index key it loaded from. A card stored
        // under a legacy number-only key ("JJK1") won't recompute to the same key
        // once it has a collection ("JJK1__collection"), so edit/delete rely on
        // this to remove the real entry instead of orphaning it.
        cards: liveKeys.map(key => {
            const card = cachedByKey.get(key);
            if (card) card.__storageKey = key;
            return card;
        }).filter(Boolean),
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

        const { __storageKey, ...clean } = card;
        const payload = { ...clean, cardNumber: clean.cardNumber || key, id: clean.id || key };
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
                const { __storageKey, ...card } = byKey.get(key);
                return { ...card, cardNumber: card.cardNumber || key, id: card.id || key,
                         [CACHE_KEY_PATH]: key,
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

    // The key is number+collection now, but cardNumber must stay the human number
    // (never the compound key), or the card would display "JJK1__collection".
    // __storageKey is a client-only load hint - never write it to the database.
    const { __storageKey, ...clean } = card;
    const payload = { ...clean, cardNumber: clean.cardNumber || key, id: clean.id || key };

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
    await writeCachedCards([{ ...payload, [CACHE_KEY_PATH]: key, updatedAt: Number(stamp.val() || 0) }]);

    return payload;
}

// Remove ONE card. Accepts either a raw storage key (legacy callers) or a whole
// card object. When given a card, its __storageKey (the exact key it loaded
// under) is used so a legacy number-only entry is removed instead of tombstoning
// a never-existed compound key and leaving the real body behind. This is the
// only path that deletes anything, so a bad read can never cascade into losing
// the library.
export async function deleteSharedCard(target) {
    await waitForUser();

    const key = (target && typeof target === "object")
        ? String(target.__storageKey || cardLibraryKey(target) || "").trim()
        : String(target || "").trim();
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
    // Delete by the cache keyPath (the exact stored key), not a recomputed one.
    await writeCachedCards([], cached.map(card => card[CACHE_KEY_PATH] || cardLibraryKey(card)).filter(Boolean));
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
        // Check the card's REAL stored key against the index. Recomputing the key
        // from content would flag every legacy number-only card as missing (its
        // content now yields a compound key the index doesn't have) and restore
        // it as a duplicate.
        const key = card[CACHE_KEY_PATH] || cardLibraryKey(card);
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
        // Restore to the SAME slot the card was cached under, and keep its human
        // card number intact.
        const key = card[CACHE_KEY_PATH] || cardLibraryKey(card);
        const { updatedAt, __storageKey, ...payload } = card;
        updates[`${CARDS_PATH}/${key}`] = { ...payload, cardNumber: payload.cardNumber || key, id: payload.id || key };
        // Replacing the whole entry clears any `deleted: true` marker, so a
        // restored card isn't still treated as tombstoned.
        updates[`${INDEX_PATH}/${key}`] = { updatedAt: serverTimestamp() };
    });

    await update(ref(database), updates);

    return { restored: missing.length, cards: missing.map(c => `${c[CACHE_KEY_PATH] || cardLibraryKey(c)} ${c.name || ""}`.trim()) };
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
        //
        // Also skip when the card already lives under its pre-collection
        // number-only key: bundled cards seeded before collections were part of
        // the key are already present, and re-seeding them under the new compound
        // key would just duplicate every shipped card in the database.
        const legacyKey = sanitizeKeyPart(card?.cardNumber || card?.id || "");
        if (!key || existing[key] || existing[legacyKey]) return;
        const { __storageKey, ...clean } = card;
        updates[`${CARDS_PATH}/${key}`] = { ...clean, cardNumber: clean.cardNumber || key, id: clean.id || key };
        updates[`${INDEX_PATH}/${key}/updatedAt`] = serverTimestamp();
        seeded++;
    });

    if (seeded) await update(ref(database), updates);
    return seeded;
}
