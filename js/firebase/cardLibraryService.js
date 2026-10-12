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
// overflow after ~50 cards).
//
// NOTHING DOWNLOADS THE WHOLE LIBRARY ANY MORE (v270). It had grown to ~500MB of
// artwork, every first-time visitor pulled all of it, and that alone blew through
// the database's monthly download allowance. Now:
//
//   cards/~cat~{collection}/cards/{key} -> the card WITHOUT its artwork (~1KB).
//       The "catalog". The deck builder's whole pool comes from this (~4MB).
//   cards/{key}/image, cards/{key}/altArts -> read one picture at a time, when a
//       card is actually shown (getCachedArt).
//   cards/{key} -> the full body, only for cards a game or the edit form needs.
//   cardIndex/~stamp -> bumped on every write, so a visitor whose copy of the
//       index is still current does not download it again.

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

// On localhost, ?coldcache=NAME points the on-device caches at fresh empty
// databases - a way to see exactly what a first-time visitor downloads without
// wiping the real cache.
const COLD_SUFFIX = (() => {
    try {
        if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "";
        const fromUrl = new URLSearchParams(location.search).get("coldcache");
        if (fromUrl !== null) sessionStorage.setItem("cc_coldcache", fromUrl);
        const name = sessionStorage.getItem("cc_coldcache") || "";
        return name ? `-cold-${name.replace(/[^a-z0-9]/gi, "")}` : "";
    } catch (_) { return ""; }
})();
const DB_NAME = "custom-cards-library" + COLD_SUFFIX;
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

// A card is unique by number+collection; the number part of a storage key.
function keyNumberOf(key) {
    return String(key).split("__")[0];
}

// A LIGHT copy of a cached card: everything EXCEPT the heavy base64 artwork
// (a single card's image can be several MB; the whole cache is often hundreds of
// MB). The deck builder only needs metadata to browse/filter; each tile's art is
// fetched on demand from the cache (getCachedImage) when it scrolls into view.
// A plain URL image is tiny, so it's kept as-is. `__cachedImg` marks that a
// base64 image lives in the cache under __storageKey, so the UI knows to lazy it.
function lightCachedCard(card, key) {
    const dataImg = typeof card.image === "string" && card.image.startsWith("data:");
    const rawAlts = Array.isArray(card.altArts) ? card.altArts
        : (card.altArts && typeof card.altArts === "object") ? Object.values(card.altArts)
        : (card.altArt ? [card.altArt] : []);
    const altCount = rawAlts.filter(Boolean).length;   // how many alt arts (excl. main)
    const { altArts, altArt, ...rest } = card;
    return {
        ...rest,
        __storageKey: key,
        image: dataImg ? "" : (card.image || ""),
        altArt: "",
        altArts: [],
        __cachedImg: dataImg,
        __altCount: altCount        // so the grid can still show the alt-art cycle button
    };
}

// Read the cache with a CURSOR (one record at a time) instead of getAll(), so the
// entire multi-hundred-MB library is never held in memory at once - that getAll
// was what crashed phones on load. When `wantNums` is given (the game board only
// needs the decks' cards) keep the FULL card (with art) for just those numbers;
// otherwise (the deck builder) keep a LIGHT copy of every card.
function readCachedForLoad(wantNums) {
    return new Promise((resolve) => {
        openCache().then(db => {
            const out = [];
            const req = cacheTransaction(db, "readonly").openCursor();
            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) { resolve(out); return; }
                const value = cursor.value;
                const key = value[CACHE_KEY_PATH] || cardLibraryKey(value);
                if (wantNums) {
                    // By number (the storage key) OR by the card's own id - a deck
                    // may list an imported card by an id that isn't its number.
                    const byId = value.id && wantNums.has(sanitizeKeyPart(value.id));
                    if (wantNums.has(keyNumberOf(key)) || byId) { value.__storageKey = key; out.push(value); }
                } else {
                    out.push(lightCachedCard(value, key));
                }
                cursor.continue();
            };
            req.onerror = () => resolve(out);
        }).catch(() => resolve([]));
    });
}

// ONE full card (with base64 art + altArts) by storage key: from the device if
// it is there and current, otherwise that one card from the server (then kept).
// Used to recover the heavy fields the light pool dropped - e.g. when EDITING a
// card, so the form shows the real image + alt arts and saving preserves them.
async function readFullCacheCard(storageKey) {
    try {
        const db = await openCache();
        return await new Promise((resolve) => {
            const req = cacheTransaction(db, "readonly").get(storageKey);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (_) {
        return null;
    }
}

const cardInFlight = new Map();
export async function getCachedCard(storageKey) {
    if (!storageKey) return null;
    const index = await knownIndex();
    const want = Number(index?.[storageKey]?.updatedAt || 0);
    const cached = await readFullCacheCard(storageKey);
    if (cached && (!want || Number(cached.updatedAt || 0) === want)) return cached;
    if (cardInFlight.has(storageKey)) return cardInFlight.get(storageKey);
    const job = (async () => {
        try {
            const card = sized("bodyReads", (await get(ref(database, `${CARDS_PATH}/${storageKey}`))).val());
            if (!card) return cached;
            card.updatedAt = want;
            card[CACHE_KEY_PATH] = storageKey;
            await writeCachedCards([card]);
            return card;
        } catch (_) {
            return cached;   // offline: an older copy beats nothing
        }
    })();
    cardInFlight.set(storageKey, job);
    try { return await job; } finally { cardInFlight.delete(storageKey); }
}

function artFromCard(card, index) {
    const main = typeof card.image === "string" ? card.image : "";
    if (!index) return main;
    // Alts can be an array, a Firebase object ({0:…,1:…}), or a single legacy
    // `altArt` string. Normalize to a filtered list so index N resolves for every
    // shape - that's why "only some alts came back".
    return altArtList(card)[index - 1] || main;
}

// ONE art of a card: index 0 = the main image, index N = the Nth alt art. Used to
// lazy-load whichever art a tile is currently showing. Comes from the device when
// it has a current copy; otherwise just that picture is read from the server.
const artInFlight = new Map();
export async function getCachedArt(storageKey, index = 0) {
    if (!storageKey) return "";
    const known = await knownIndex();
    const want = Number(known?.[storageKey]?.updatedAt || 0);
    const current = (record) => record && (!want || Number(record.updatedAt || 0) === want);

    const cached = await readFullCacheCard(storageKey);
    if (current(cached)) return artFromCard(cached, index);
    const artKey = `${storageKey}#${index || 0}`;
    const saved = await catalogGet(ART_STORE, artKey);
    if (current(saved) && saved.url) return saved.url;

    if (artInFlight.has(artKey)) return artInFlight.get(artKey);
    const job = (async () => {
        try {
            let url = "";
            if (index) {
                const alts = altArtList({ altArts: sized("artReads", (await get(ref(database, `${CARDS_PATH}/${storageKey}/altArts`))).val()) });
                url = alts[index - 1] || "";
            }
            if (!url) url = sized("artReads", (await get(ref(database, `${CARDS_PATH}/${storageKey}/image`))).val()) || "";
            if (typeof url !== "string") url = "";
            if (url) await catalogWrite(ART_STORE, [{ k: artKey, url, updatedAt: want }]);
            return url || (saved && saved.url) || (cached ? artFromCard(cached, index) : "");
        } catch (_) {
            // Offline: an older picture beats a blank card.
            return (saved && saved.url) || (cached ? artFromCard(cached, index) : "");
        }
    })();
    artInFlight.set(artKey, job);
    try { return await job; } finally { artInFlight.delete(artKey); }
}

// Fetch ONE card's MAIN artwork by storage key (lazy-load a tile's image).
export async function getCachedImage(storageKey) {
    return getCachedArt(storageKey, 0);
}

// The set of tombstoned (deleted) storage keys from the last successful sync.
// Kept in localStorage - it's just a small list of strings - so the offline-first
// paint (getCachedLibrary / the fast path in loadSharedCards) can hide cards that
// were deleted on a previous visit WITHOUT first waiting on the server index.
const LS_DELETED_KEYS = "cc-shared-deleted-keys-v1";

function readCachedDeletedSet() {
    try {
        const arr = JSON.parse(localStorage.getItem(LS_DELETED_KEYS) || "[]");
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function writeCachedDeletedSet(deleted) {
    try {
        localStorage.setItem(LS_DELETED_KEYS, JSON.stringify([...deleted]));
    } catch (_) { /* private mode / quota - the paint just falls back to none */ }
}

// ── Catalog, index cache and on-demand artwork ───────────────────────────────

// Keys starting with "~" are bookkeeping, never cards. Clients from before v270
// skip them too: the stamp is written as a tombstone, and the catalog lives under
// keys the index never lists.
const CATALOG_PREFIX = "~cat~";
const STAMP_KEY = "~stamp";
const isSpecialKey = (key) => String(key).startsWith("~");

// Which catalog chunk a card's light copy lives in: one per collection, so a
// first-time visitor reads ~30 chunks instead of thousands of cards.
function catalogChunkOf(key) {
    const text = String(key);
    const at = text.indexOf("__");
    return CATALOG_PREFIX + (at >= 0 ? text.slice(at + 2) : "_none");
}

const isDataUrl = (value) => typeof value === "string" && value.startsWith("data:");

function altArtList(card) {
    const raw = Array.isArray(card?.altArts) ? card.altArts
        : (card?.altArts && typeof card.altArts === "object") ? Object.values(card.altArts)
        : (card?.altArt ? [card.altArt] : []);
    return raw.filter(art => typeof art === "string" && art);
}

// The catalog copy of a card: everything except its artwork and the preserved
// import source (the two heavy parts). `updatedAt` must equal the card's index
// entry - that is how a reader knows the copy is current.
function catalogEntry(card, updatedAt) {
    const { image, altArts, altArt, importSource, updatedAt: _old, __storageKey, __cachedImg, __altCount, typeGuess, ...rest } = card || {};
    const entry = { ...rest, updatedAt };
    if (isDataUrl(image)) entry.__img = 1;
    else if (image) entry.image = image;            // a plain link is tiny
    const alts = altArtList(card);
    if (alts.length && !alts.some(isDataUrl)) entry.altArts = alts;   // plain links: tiny, keep
    else if (alts.length) entry.__alts = alts.length;                 // embedded: fetched when shown
    Object.keys(entry).forEach(key => { if (entry[key] === undefined) delete entry[key]; });
    return entry;
}

// A catalog entry in the shape the deck builder's pool expects (the same shape
// lightCachedCard gives a cached card).
function lightFromCatalog(entry, key) {
    const { __img, __alts, ...rest } = entry;
    const alts = altArtList(rest);
    return {
        ...rest,
        __storageKey: key,
        image: rest.image || "",
        altArt: alts[0] || "",
        altArts: alts,
        __cachedImg: Boolean(__img),
        __altCount: Number(__alts) || 0
    };
}

// What every write adds so readers can tell the index changed.
function stampUpdate(updates) {
    updates[`${INDEX_PATH}/${STAMP_KEY}`] = { deleted: true, updatedAt: serverTimestamp() };
}

// Add (or with a null card, remove) one card's catalog copy in a multi-path write.
function catalogUpdate(updates, key, card, updatedAt) {
    const chunk = catalogChunkOf(key);
    if (card) {
        // The chunk is stored under `cards`, whose rule wants these two fields.
        updates[`${CARDS_PATH}/${chunk}/cardNumber`] = "~cat";
        updates[`${CARDS_PATH}/${chunk}/name`] = "~cat";
        updates[`${CARDS_PATH}/${chunk}/cards/${key}`] = catalogEntry(card, updatedAt);
    } else {
        updates[`${CARDS_PATH}/${chunk}/cards/${key}`] = null;
    }
}

// Rough counts of what this page has downloaded, for checking the numbers
// (window.ccLibraryStats in the console).
const stats = { indexReads: 0, stampReads: 0, chunkReads: 0, entryReads: 0, bodyReads: 0, artReads: 0, bytes: 0 };
const sized = (kind, value) => {
    stats[kind] += 1;
    try { stats.bytes += value == null ? 0 : JSON.stringify(value).length; } catch (_) {}
    return value;
};
try { if (typeof window !== "undefined") window.ccLibraryStats = stats; } catch (_) {}
export function libraryStats() { return { ...stats }; }

// A second small database for the catalog, single pictures and the index copy.
// Separate from the card cache above so adding it can never disturb that one.
const CATALOG_DB = "custom-cards-catalog" + COLD_SUFFIX;
const LIGHT_STORE = "light";   // key -> light card (keyPath __storageKey)
const ART_STORE = "art";       // "<key>#<n>" -> { k, url, updatedAt }
const META_STORE = "meta";     // "index" -> { k, stamp, fetchedAt, index }

function openCatalog() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CATALOG_DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(LIGHT_STORE)) db.createObjectStore(LIGHT_STORE, { keyPath: CACHE_KEY_PATH });
            if (!db.objectStoreNames.contains(ART_STORE)) db.createObjectStore(ART_STORE, { keyPath: "k" });
            if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "k" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function catalogGet(store, key) {
    try {
        const db = await openCatalog();
        return await new Promise((resolve) => {
            const request = db.transaction(store, "readonly").objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
        });
    } catch (_) { return null; }
}

async function catalogGetAll(store) {
    try {
        const db = await openCatalog();
        return await new Promise((resolve) => {
            const request = db.transaction(store, "readonly").objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });
    } catch (_) { return []; }
}

async function catalogWrite(store, records = [], removedKeys = []) {
    if (!records.length && !removedKeys.length) return;
    try {
        const db = await openCatalog();
        await new Promise((resolve, reject) => {
            const os = db.transaction(store, "readwrite").objectStore(store);
            records.forEach(record => os.put(record));
            removedKeys.forEach(key => os.delete(key));
            os.transaction.oncomplete = () => resolve();
            os.transaction.onerror = () => reject(os.transaction.error);
        });
    } catch (error) {
        console.warn("Could not write the card catalog cache:", error);
    }
}

// ── The index, without re-downloading it on every page ──
// It is ~0.5MB and every page used to fetch it. Now a copy is kept on the device
// and reused while the server's stamp still matches (one tiny read). The copy is
// also refreshed after INDEX_MAX_AGE regardless, which covers a write made by a
// browser still running pre-v270 code (it does not bump the stamp).
const INDEX_MAX_AGE = 2 * 60 * 60 * 1000;
let latestIndex = null;
let indexInFlight = null;

async function fetchIndex() {
    const index = sized("indexReads", (await get(ref(database, INDEX_PATH))).val()) || {};
    latestIndex = index;
    await catalogWrite(META_STORE, [{ k: "index", stamp: Number(index[STAMP_KEY]?.updatedAt || 0), fetchedAt: Date.now(), index }]);
    return index;
}

// options.force: always read the server (anything that DECIDES what to write).
async function getIndex(options = {}) {
    if (options.force) return fetchIndex();
    if (indexInFlight) return indexInFlight;
    indexInFlight = (async () => {
        const saved = await catalogGet(META_STORE, "index");
        if (saved && saved.index && saved.stamp && Date.now() - Number(saved.fetchedAt || 0) < INDEX_MAX_AGE) {
            try {
                const stamp = Number(sized("stampReads", (await get(ref(database, `${INDEX_PATH}/${STAMP_KEY}/updatedAt`))).val()) || 0);
                if (stamp && stamp === saved.stamp) { latestIndex = saved.index; return saved.index; }
            } catch (_) { /* fall through to a full read */ }
        }
        return fetchIndex();
    })();
    try { return await indexInFlight; } finally { indexInFlight = null; }
}

// After this browser writes, its saved copy of the index is out of date.
async function forgetIndex() {
    latestIndex = null;
    await catalogWrite(META_STORE, [], ["index"]);
}

// The index as last seen on this page (no network if we already have it).
async function knownIndex() {
    if (latestIndex) return latestIndex;
    try { return await getIndex(); } catch (_) { return null; }
}

// ── The deck builder's pool: catalog only, never card bodies ──
async function loadLightLibrary({ getPriority, onProgress }) {
    const report = (cards, deleted) => { if (onProgress) { try { onProgress({ cards, deleted }); } catch (_) {} } };

    // Instant paint from the device. A visitor from before v270 has the old full
    // cache but no catalog yet: build it from that once (no network).
    const local = new Map((await catalogGetAll(LIGHT_STORE)).map(card => [card[CACHE_KEY_PATH], card]));
    if (!local.size) {
        const seeded = (await readCachedForLoad(null)).map(card => { const { importSource, ...rest } = card; return rest; });
        seeded.forEach(card => local.set(card[CACHE_KEY_PATH], card));
        await catalogWrite(LIGHT_STORE, seeded);
    }
    const knownDeleted = readCachedDeletedSet();
    if (local.size) report([...local.values()].filter(card => !knownDeleted.has(card[CACHE_KEY_PATH])), knownDeleted);

    await waitForUser();
    const index = await getIndex();
    const keys = Object.keys(index).filter(key => !isSpecialKey(key));
    const deleted = new Set(keys.filter(key => index[key]?.deleted === true));
    writeCachedDeletedSet(deleted);
    const liveKeys = keys.filter(key => !deleted.has(key));
    const stampOf = (key) => Number(index[key]?.updatedAt || 0);
    const isFresh = (key) => { const mine = local.get(key); return Boolean(mine) && Number(mine.updatedAt || 0) === stampOf(key); };
    const snapshot = () => liveKeys.map(key => {
        const card = local.get(key);
        if (card) stampFromIndex(card, key, index);
        return card;
    }).filter(Boolean);
    if (local.size) report(snapshot(), deleted);

    // What changed since last visit (everything, on a first visit), by chunk.
    const stale = liveKeys.filter(key => !isFresh(key));
    const byChunk = new Map();
    stale.forEach(key => { const chunk = catalogChunkOf(key); (byChunk.get(chunk) || byChunk.set(chunk, []).get(chunk)).push(key); });
    const priority = getPriority ? CATALOG_PREFIX + sanitizeKeyPart(getPriority() || "") : "";
    const chunks = [...byChunk.keys()].sort((a, b) => (a === priority ? 0 : 1) - (b === priority ? 0 : 1));

    let fetched = 0;
    const uncovered = [];   // keys the catalog has no current copy of
    const takeEntries = async (chunk, wanted, entries) => {
        const records = [];
        wanted.forEach(key => {
            const entry = entries[key];
            if (entry && Number(entry.updatedAt || 0) === stampOf(key)) {
                const card = lightFromCatalog(entry, key);
                local.set(key, card);
                records.push(card);
            } else uncovered.push(key);
        });
        fetched += records.length;
        await catalogWrite(LIGHT_STORE, records);
    };
    const readChunk = async (chunk) => {
        const wanted = byChunk.get(chunk);
        const entries = {};
        try {
            if (wanted.length > 12) {
                // Many changed: one read of the whole collection's catalog.
                Object.assign(entries, sized("chunkReads", (await get(ref(database, `${CARDS_PATH}/${chunk}/cards`))).val()) || {});
            } else {
                // A few changed: read just those entries.
                await Promise.all(wanted.map(key => get(ref(database, `${CARDS_PATH}/${chunk}/cards/${key}`))
                    .then(snapshot => { const value = sized("entryReads", snapshot.val()); if (value) entries[key] = value; })
                    .catch(() => {})));
            }
        } catch (error) {
            console.warn("Catalog read failed for", chunk, error);
        }
        await takeEntries(chunk, wanted, entries);
    };
    for (let i = 0; i < chunks.length; i += 6) {
        await Promise.all(chunks.slice(i, i + 6).map(readChunk));
        report(snapshot(), deleted);
    }

    // Cards saved by a browser still on pre-v270 code have no current catalog
    // copy. Read those few in full, and write the missing copy so the next visitor
    // doesn't have to. Capped: this path must never turn back into "download
    // everything" (if the catalog were ever lost, backfillCatalog rebuilds it).
    const BODY_FALLBACK_LIMIT = 150;
    const todo = uncovered.slice(0, BODY_FALLBACK_LIMIT);
    for (let i = 0; i < todo.length; i += 8) {
        const batch = todo.slice(i, i + 8);
        const bodies = await Promise.all(batch.map(key => get(ref(database, `${CARDS_PATH}/${key}`))
            .then(snapshot => [key, sized("bodyReads", snapshot.val())]).catch(() => [key, null])));
        const full = [], light = [], heal = {};
        bodies.forEach(([key, card]) => {
            if (!card) return;
            card.updatedAt = stampOf(key);
            card[CACHE_KEY_PATH] = key;
            full.push(card);
            const lightCard = lightFromCatalog(catalogEntry(card, stampOf(key)), key);
            local.set(key, lightCard);
            light.push(lightCard);
            catalogUpdate(heal, key, card, stampOf(key));
        });
        fetched += light.length;
        await writeCachedCards(full);
        await catalogWrite(LIGHT_STORE, light);
        if (Object.keys(heal).length) update(ref(database), heal).catch(() => {});
        report(snapshot(), deleted);
    }
    if (uncovered.length > todo.length) {
        console.warn(`Card catalog is missing ${uncovered.length - todo.length} more cards than one visit will repair.`);
    }

    // Drop what was deleted (explicit tombstones only, as before).
    const removed = [...local.keys()].filter(key => deleted.has(key));
    if (removed.length) {
        removed.forEach(key => local.delete(key));
        await catalogWrite(LIGHT_STORE, [], removed);
        await writeCachedCards([], removed);
    }

    const cards = snapshot();
    return { cards, deleted, fetched, cached: cards.length - fetched };
}

// ── Public API ───────────────────────────────────────────

// Instant, offline-first snapshot of the library straight from the on-device
// IndexedDB cache - NO Firebase auth, NO network, NO waiting. Callers (the game
// board especially) build from this first so a repeat visitor opens with zero
// delay, then call loadSharedCards() in the BACKGROUND to reconcile any changes.
// Shape matches loadSharedCards()'s return: { cards, deleted }.
export async function getCachedLibrary(options = {}) {
    const { onlyNumbers } = options;
    const wantNums = (onlyNumbers && (onlyNumbers.size || onlyNumbers.length))
        ? new Set([...onlyNumbers].map(n => sanitizeKeyPart(n)))
        : null;
    const deleted = readCachedDeletedSet();

    // With wantNums (practice: just the two decks' cards) read ONLY those via a
    // cursor - never getAll() the whole multi-hundred-MB library into memory,
    // which is what crashed phones. Without it (online instant paint) fall back
    // to the full read, since any opponent card might need resolving.
    if (wantNums) {
        const cards = (await readCachedForLoad(wantNums))
            .filter(card => !deleted.has(card.__storageKey));
        return { cards, deleted };
    }

    const cached = await readCachedCards();
    const cards = cached
        .map(card => {
            const key = card[CACHE_KEY_PATH] || cardLibraryKey(card);
            card.__storageKey = key;
            return card;
        })
        .filter(card => !deleted.has(card.__storageKey));
    return { cards, deleted };
}

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
    const { getPriority, onProgress, onlyNumbers, light } = options;

    // onlyNumbers (a Set/array of card NUMBERS): restrict the whole operation to
    // just those cards. The game board only needs the cards in the two decks, so
    // passing them here avoids downloading the ENTIRE custom library (hundreds of
    // base64-image cards) on a phone - which is what made the board take forever.
    const wantNums = (onlyNumbers && (onlyNumbers.size || onlyNumbers.length))
        ? new Set([...onlyNumbers].map(n => sanitizeKeyPart(n)))
        : null;
    // The number part of a storage key ("JJK1-001__collection" -> "JJK1-001").
    const keyNumber = key => String(key).split("__")[0];
    // Keys of cached cards that were wanted by their id rather than their number.
    const wantedById = new Set();
    const keyWanted = key => !wantNums || wantNums.has(keyNumber(key)) || wantedById.has(key);

    // The deck builder's pool (and any other listing): the catalog, never bodies.
    if (light && !wantNums) return loadLightLibrary({ getPriority, onProgress });

    // `light` (the deck builder): keep only metadata in memory, not the base64
    // artwork - the whole library's art is hundreds of MB and loading it all via
    // getAll() crashed phones on open. Each tile lazy-loads its own image later
    // (getCachedImage). The game board keeps FULL cards, but only for the decks'
    // cards (wantNums), which is a tiny bounded set. Only the online board (no
    // wantNums, not light) still reads everything, since it must resolve any
    // opponent card. A `light` copy of a downloaded card is used for the returned
    // pool too, so a fresh download doesn't sneak base64 back into memory.
    const lightMode = Boolean(light) && !wantNums;
    const forReturn = (card, key) => lightMode ? lightCachedCard(card, key) : card;

    // ── Instant, offline-first paint ─────────────────────────────────────────
    // Read the on-device IndexedDB cache and hand it to the caller BEFORE we
    // touch Firebase auth or the network. A repeat visitor sees the library with
    // zero wait; the reconcile below then quietly patches whatever changed. Auth
    // (a network round-trip) used to sit at the very top of this function and
    // blocked even this cache read - that was the wait on every page load.
    const cached = (lightMode || wantNums)
        ? await readCachedForLoad(wantNums)   // cursor: light (builder) or deck-only (game)
        : await readCachedCards();            // full library (online board)
    // Key by the EXACT storage key each card was cached under (its keyPath), not
    // a key recomputed from content - a legacy card stored at "JJK1" whose body
    // now carries a collection would otherwise recompute to "JJK1__collection",
    // miss its own index entry, and re-download on every single load.
    const cachedByKey = new Map(cached.map(card => [card[CACHE_KEY_PATH] || cardLibraryKey(card), card]));
    if (wantNums) {
        cachedByKey.forEach((card, key) => {
            if (card && card.id && wantNums.has(sanitizeKeyPart(card.id))) wantedById.add(key);
        });
    }

    if (onProgress && cachedByKey.size) {
        // Use the LAST-KNOWN tombstone set (persisted locally) so this first
        // paint doesn't resurrect a card that was already deleted.
        const knownDeleted = readCachedDeletedSet();
        const fast = [...cachedByKey.entries()]
            .filter(([key]) => keyWanted(key) && !knownDeleted.has(key))
            .map(([key, card]) => { card.__storageKey = key; return card; });
        try { onProgress({ cards: fast, deleted: knownDeleted }); } catch (_) {}
    }

    // ── Reconcile with the server (now we need auth + the tiny index) ─────────
    await waitForUser();

    const index = await getIndex();
    const wantedKeys = Object.keys(index).filter(key => !isSpecialKey(key));

    // Tombstoned entries carry `deleted: true` in the index itself, so they cost
    // no extra request and can't fail independently of the index read.
    const deleted = new Set(wantedKeys.filter(key => index[key]?.deleted === true));
    // Persist the fresh tombstone set so the NEXT visit's instant paint is right.
    writeCachedDeletedSet(deleted);
    const liveKeys = wantedKeys.filter(key => !deleted.has(key));

    // A card needs downloading if we've never seen it, or the server copy is
    // newer than ours. Tombstoned keys have no body to fetch.
    const stale = liveKeys.filter(key => {
        if (!keyWanted(key)) return false;   // not one of the decks' cards - skip it
        const mine = cachedByKey.get(key);
        // Asked for specific cards (a game's decks): fetch the ones we lack. With
        // no list, only keep what is already on this device current - never pull
        // the rest of the library (one failed save used to trigger that, ~500MB).
        if (!mine) return Boolean(wantNums);
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
        if (card) stampFromIndex(card, key, index);
        return card;
    }).filter(Boolean);

    // Full card bodies (base64 art) are written to the cache PER BATCH and dropped
    // from memory immediately — never accumulated into one giant array. A cold
    // full-library sync is hundreds of MB of art; holding it all in RAM at once
    // OOM-crashed iOS Safari on the online board ("a problem repeatedly occurred").
    // The in-memory pool keeps only LIGHT copies (forReturn), so RAM stays bounded.
    let fetchedCount = 0;
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
                .then(snapshot => [key, sized("bodyReads", snapshot.val())])
                .catch(() => [key, null])
        ));
        const batchFull = [];   // this batch's heavy cards, flushed below then GC'd
        for (const [key, card] of results) {
            if (!card) continue;
            card.updatedAt = Number(index[key]?.updatedAt || 0);
            // Stamp the storage key so it's the cache keyPath and the load hint.
            card[CACHE_KEY_PATH] = key;
            batchFull.push(card);                       // full card -> written to cache (keeps art)
            cachedByKey.set(key, forReturn(card, key)); // light in the in-memory pool
        }
        // Persist this batch NOW and let the base64 art be collected, so peak RAM is
        // ~CONCURRENCY cards instead of the whole library.
        if (batchFull.length) { await writeCachedCards(batchFull); fetchedCount += batchFull.length; }
        // Stream what we have so far so the grid fills in as cards land.
        if (onProgress) {
            try { onProgress({ cards: snapshotCardsSoFar(), deleted }); } catch (_) {}
        }
    }

    // Apply tombstone removals once (no card bodies involved).
    if (removed.length) await writeCachedCards([], removed);
    removed.forEach(key => cachedByKey.delete(key));

    return {
        // Stamp each card with the EXACT index key it loaded from. A card stored
        // under a legacy number-only key ("JJK1") won't recompute to the same key
        // once it has a collection ("JJK1__collection"), so edit/delete rely on
        // this to remove the real entry instead of orphaning it.
        cards: liveKeys.filter(keyWanted).map(key => {
            const card = cachedByKey.get(key);
            if (card) stampFromIndex(card, key, index);
            return card;
        }).filter(Boolean),
        // Callers merge the repo's bundled JSON with this library; they need the
        // tombstones so a deleted bundled card doesn't come back from the file.
        deleted,
        fetched: fetchedCount,
        cached: liveKeys.filter(keyWanted).length - fetchedCount
    };
}

// Stamp a loaded card with the EXACT index key it came from, and the guessed
// types stored on that index entry (see saveTypeGuesses).
function stampFromIndex(card, key, index) {
    card.__storageKey = key;
    const guess = index[key]?.tg;
    if (guess) card.typeGuess = String(guess);
    else delete card.typeGuess;
}

// Guessed types for cards that have none, read off the card picture by
// js/cardTypeScanner.js. Used for SEARCH only, never shown as the card's types.
//
// They sit on the card's INDEX entry (`cardIndex/{key}/tg`) rather than in the card
// body: the index is already fetched on every load and has no .validate rule, so
// this needs no rules change, and adding a guess doesn't make every visitor
// re-download the heavy card (updatedAt is left alone). Re-saving a card replaces
// its index entry, which drops the guess - fine, the card was just edited.
//
// guesses: { storageKey: "Type A/Type B" | null }. Only pass keys of cards that
// loaded from the shared library (card.__storageKey) - writing under a key with
// no index entry would create a phantom entry.
export async function saveTypeGuesses(guesses) {
    await waitForUser();
    const updates = {};
    // (No stamp bump: a guess reaching other players a couple of hours later is
    // fine, and bumping would make everyone re-read the index for each batch.)
    Object.entries(guesses || {}).forEach(([key, value]) => {
        const clean = sanitizeKeyPart(key) === key ? key : "";
        if (!clean) return;
        updates[`${INDEX_PATH}/${clean}/tg`] = value ? String(value).replace(/s+/g, " ").trim().slice(0, 160) : null;
    });
    if (Object.keys(updates).length) {
        await update(ref(database), updates);
        await forgetIndex();
    }
    return Object.keys(updates).length;
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

    const index = await getIndex({ force: true });

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

        const { __storageKey, typeGuess, ...clean } = card;
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
            catalogUpdate(updates, key, payload, serverTimestamp());
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

    stampUpdate(updates);
    await update(ref(database), updates);
    await forgetIndex();

    // Refresh the cache with the server-resolved timestamps so none of these
    // cards look stale on the next load.
    if (changedKeys.length) {
        const freshIndex = await getIndex({ force: true });
        const byKey = new Map(cards.map(card => [cardLibraryKey(card), card]));
        await writeCachedCards(
            changedKeys.map(key => {
                const { __storageKey, typeGuess, ...card } = byKey.get(key);
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
    const { __storageKey, typeGuess, ...clean } = card;
    const payload = { ...clean, cardNumber: clean.cardNumber || key, id: clean.id || key };

    const updates = {};
    catalogUpdate(updates, key, payload, serverTimestamp());
    stampUpdate(updates);
    await update(ref(database), {
        ...updates,
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
    const savedAt = Number(stamp.val() || 0);
    await writeCachedCards([{ ...payload, [CACHE_KEY_PATH]: key, updatedAt: savedAt }]);
    await catalogWrite(LIGHT_STORE, [lightFromCatalog(catalogEntry(payload, savedAt), key)]);
    await catalogWrite(ART_STORE, [], [0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `${key}#${n}`));
    await forgetIndex();

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
    const updates = {};
    catalogUpdate(updates, key, null);
    stampUpdate(updates);
    await update(ref(database), {
        ...updates,
        [`${CARDS_PATH}/${key}`]: null,
        [`${INDEX_PATH}/${key}`]: { deleted: true, updatedAt: serverTimestamp() }
    });

    await writeCachedCards([], [key]);
    await catalogWrite(LIGHT_STORE, [], [key]);
    await forgetIndex();
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
                image: entry.image || "",
                // Owner + per-collection editor allowlist (usernames). Firebase
                // may return the list as an object; normalise back to an array.
                ownerUid: entry.ownerUid || "",
                editors: Array.isArray(entry.editors)
                    ? entry.editors
                    : (entry.editors && typeof entry.editors === "object" ? Object.values(entry.editors) : []),
                coOwners: Array.isArray(entry.coOwners)
                    ? entry.coOwners
                    : (entry.coOwners && typeof entry.coOwners === "object" ? Object.values(entry.coOwners) : [])
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

    const editors = Array.isArray(collection.editors)
        ? collection.editors.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        : [];
    const coOwners = Array.isArray(collection.coOwners)
        ? collection.coOwners.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        : [];
    await update(ref(database), {
        [`${COLLECTIONS_PATH}/${slug}`]: {
            name: String(collection.name || slug),
            image: String(collection.image || ""),
            ownerUid: String(collection.ownerUid || ""),
            editors,
            coOwners,
            updatedAt: serverTimestamp()
        }
    });
    return { slug, name: collection.name || slug, image: collection.image || "", ownerUid: collection.ownerUid || "", editors, coOwners };
}

export async function deleteSharedCollection(slug) {
    await waitForUser();
    const key = String(slug || "").trim();
    if (!key) return;
    await remove(ref(database, `${COLLECTIONS_PATH}/${key}`));
}

// Every registered account username (lowercased), for the admin's collection
// editor picker. Read from the shared `usernames` node (any signed-in user may
// read it). Accounts that never set a username - e.g. Google-only sign-ins that
// haven't added one - won't appear, since editor access is matched by username.
export async function listAllUsernames() {
    try {
        await waitForUser();
        const snap = await get(ref(database, "usernames"));
        const val = snap.val() || {};
        return Object.keys(val).map(u => String(u).toLowerCase()).sort();
    } catch (error) {
        console.warn("Could not list usernames:", error);
        return [];
    }
}

// Registered accounts as { username, uid } pairs, for transfer-ownership (which
// needs the target's uid, not just their username). Same source as above.
export async function listAllAccounts() {
    try {
        await waitForUser();
        const snap = await get(ref(database, "usernames"));
        const val = snap.val() || {};
        return Object.entries(val)
            .map(([username, uid]) => ({ username: String(username).toLowerCase(), uid: String(uid || "") }))
            .filter(a => a.username && a.uid)
            .sort((a, b) => a.username.localeCompare(b.username));
    } catch (error) {
        console.warn("Could not list accounts:", error);
        return [];
    }
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
    await catalogWrite(LIGHT_STORE, [], (await catalogGetAll(LIGHT_STORE)).map(card => card[CACHE_KEY_PATH]));
    await forgetIndex();
}

// Cards this browser has cached that the shared library no longer contains.
// The cache holds full card bodies including artwork, so it doubles as a local
// backup - this is what makes recovering an accidentally emptied library possible.
export async function findRecoverableCards() {
    const cached = await readCachedCards();
    if (!cached.length) return [];

    let index = {};
    try {
        index = await getIndex({ force: true });
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
        catalogUpdate(updates, key, payload, serverTimestamp());
    });

    stampUpdate(updates);
    await update(ref(database), updates);
    await forgetIndex();

    return { restored: missing.length, cards: missing.map(c => `${c[CACHE_KEY_PATH] || cardLibraryKey(c)} ${c.name || ""}`.trim()) };
}

// Seed the shared library from the JSON file that ships with the repo. Existing
// shared cards are left alone, so this is safe to run more than once.
export async function seedSharedCardsFrom(cards) {
    await waitForUser();

    const existing = await getIndex({ force: true });

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
        const { __storageKey, typeGuess, ...clean } = card;
        updates[`${CARDS_PATH}/${key}`] = { ...clean, cardNumber: clean.cardNumber || key, id: clean.id || key };
        updates[`${INDEX_PATH}/${key}/updatedAt`] = serverTimestamp();
        catalogUpdate(updates, key, clean, serverTimestamp());
        seeded++;
    });

    if (seeded) {
        stampUpdate(updates);
        await update(ref(database), updates);
        await forgetIndex();
    }
    return seeded;
}

// Point cards at picture FILES instead of pictures embedded in the database.
// entries: { storageKey: { image?: url, alts?: [url, ...] } } for pictures that
// have been published as files (see scripts/art in the repo history / the art
// folder). Only cards that are unchanged since `unchangedSince[key]` (the index
// time when the files were made) are touched, each link is checked to be live
// first, and the card's type guess and everything else is left alone. The card
// body keeps its shape - `image` simply becomes a link, which every part of the
// app already supports. Returns counts.
export async function applyArtUrls(entries, unchangedSince, onProgress) {
    await waitForUser();
    const index = await getIndex({ force: true });
    const keys = Object.keys(entries || {});
    const summary = { total: keys.length, moved: 0, changedSince: 0, gone: 0, deadLink: 0, alreadyDone: 0, failed: 0 };
    const live = async (url) => {
        try { return (await fetch(url, { method: "HEAD", cache: "no-store" })).ok; } catch (_) { return false; }
    };
    for (let i = 0; i < keys.length; i += 25) {
        const updates = {};
        const local = [];
        await Promise.all(keys.slice(i, i + 25).map(async (key) => {
            const entry = entries[key];
            const at = Number(index[key]?.updatedAt || 0);
            if (!index[key] || index[key].deleted === true) { summary.gone++; return; }
            if (unchangedSince && Number(unchangedSince[key] || 0) !== at) { summary.changedSince++; return; }
            const card = await getCachedCard(key);
            if (!card) { summary.gone++; return; }
            const wantsImage = entry.image && isDataUrl(card.image);
            const wantsAlts = Array.isArray(entry.alts) && altArtList(card).some(isDataUrl);
            if (!wantsImage && !wantsAlts) { summary.alreadyDone++; return; }
            const links = [wantsImage ? entry.image : null, ...(wantsAlts ? entry.alts : [])].filter(Boolean);
            if (!(await Promise.all(links.map(live))).every(Boolean)) { summary.deadLink++; return; }

            const next = { ...card };
            delete next[CACHE_KEY_PATH];
            delete next.updatedAt;
            if (wantsImage) { next.image = entry.image; updates[`${CARDS_PATH}/${key}/image`] = entry.image; }
            if (wantsAlts) {
                next.altArts = entry.alts;
                delete next.altArt;
                updates[`${CARDS_PATH}/${key}/altArts`] = entry.alts;
                updates[`${CARDS_PATH}/${key}/altArt`] = null;
            }
            // Only the time changes on the index entry, so its type guess stays.
            updates[`${INDEX_PATH}/${key}/updatedAt`] = serverTimestamp();
            catalogUpdate(updates, key, next, serverTimestamp());
            local.push([key, next]);
        }));
        if (Object.keys(updates).length) {
            try {
                stampUpdate(updates);
                await update(ref(database), updates);
                summary.moved += local.length;
                // This device's copies are now out of date; drop them so they are
                // read again (small now) instead of trusted.
                await writeCachedCards([], local.map(([key]) => key));
                await catalogWrite(LIGHT_STORE, [], local.map(([key]) => key));
            } catch (error) {
                console.warn("Could not update a batch of cards:", error);
                summary.failed += local.length;
            }
        }
        if (onProgress) { try { onProgress({ done: Math.min(i + 25, keys.length), ...summary }); } catch (_) {} }
    }
    await forgetIndex();
    return summary;
}

// (Re)build the catalog for every card in the library. Uses the copies already on
// this device and only downloads a card it doesn't have. Safe to run again: it
// writes the same thing. Run from the console of a browser that has the library
// cached:  (await import("./js/firebase/cardLibraryService.js?v=collections-17")).backfillCatalog(console.log)
export async function backfillCatalog(onProgress) {
    await waitForUser();
    const index = await getIndex({ force: true });
    const liveKeys = Object.keys(index).filter(key => !isSpecialKey(key) && index[key]?.deleted !== true);
    const stampOf = (key) => Number(index[key]?.updatedAt || 0);
    let written = 0, downloaded = 0, missing = 0;
    for (let i = 0; i < liveKeys.length; i += 60) {
        const updates = {};
        for (const key of liveKeys.slice(i, i + 60)) {
            let card = await readFullCacheCard(key);
            if (!card || Number(card.updatedAt || 0) !== stampOf(key)) {
                card = sized("bodyReads", (await get(ref(database, `${CARDS_PATH}/${key}`))).val());
                if (card) downloaded++;
            }
            if (!card) { missing++; continue; }
            catalogUpdate(updates, key, card, stampOf(key));
            written++;
        }
        if (Object.keys(updates).length) await update(ref(database), updates);
        if (onProgress) { try { onProgress({ done: Math.min(i + 60, liveKeys.length), total: liveKeys.length, written, downloaded, missing }); } catch (_) {} }
    }
    const stamp = {};
    stampUpdate(stamp);
    await update(ref(database), stamp);
    await forgetIndex();
    return { total: liveKeys.length, written, downloaded, missing };
}
