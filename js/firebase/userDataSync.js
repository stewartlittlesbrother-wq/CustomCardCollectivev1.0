// Per-account cloud sync of a device's localStorage data — so EVERYTHING crosses
// over between devices on the same account: saved decks, DON!! decks, the working
// draft, all game/board settings, hotkeys, art prefs, custom board images
// (playmat / card back / DON!! back), and any local-only custom cards.
//
// This is the shared CONTROLLER: it runs from auth-ui.js, which loads on the home
// page, the game board AND the multiplayer lobby — so a change made on ANY page
// pushes, and opening ANY page signed in pulls. (Created cards themselves live in
// the shared library keyed by number+collection with ownerUid, so they already
// cross devices; this carries the small local fallback stores + all prefs.)
//
// Storage: users/<uid>/userdata/<sanitized key> = { at:<ms>, json:"<value>" }.
// The users/<uid> subtree is already owner-only in the DB rules, so no rules
// change is needed. The merge is LOSSLESS for decks/cards (union by name/key,
// newer wins) so signing in on a second device can only ADD/UPDATE, never delete.

import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebaseApp.js";

const BASE = (uid) => `users/${uid}/userdata`;

// Firebase keys can't contain . # $ / [ ]. localStorage keys use dashes/dots.
export function sanitizeSyncKey(key) {
    return String(key).replace(/[.#$/\[\]]/g, "_");
}

// Which localStorage keys follow the account, and how to reconcile each.
//   decks - array of { name, savedAt, ... }: union by name, newer savedAt wins.
//   cards - array of cards: union by number+collection (or id), newer edit wins.
//   lww   - any value: last write wins, by a per-key timestamp.
// Deliberately EXCLUDED: device-layout ergonomics (cc_builder_deck_h/locked/set/
// large - screen-size specific), the guest-ack flag, and debug/session keys.
const SYNC_SPECS = [
    { key: "custom-cards-sim-luffy-only-saved-decks-v1", mode: "decks" },
    { key: "custom-don-decks-v1",                        mode: "decks" },
    { key: "custom-cards-sim-imported-cards-v1",         mode: "cards" },
    { key: "custom-cards-sim-local-project-cards-v1",    mode: "cards" },
    { key: "custom-cards-sim-luffy-only-v1",             mode: "lww" },   // working draft
    { key: "custom-cards-allow-any-deck-size-v1",        mode: "lww" },
    { key: "gameSettings",                               mode: "lww" },
    { key: "manualPlaySettings",                         mode: "lww" },
    { key: "cc_hotkeys_v1",                              mode: "lww" },
    { key: "custom-cards-alt-art-prefs-v1",              mode: "lww" },
    { key: "custom-don-active-deck-v1",                  mode: "lww" },   // active DON!! deck
    { key: "optcgPlayCardRestOnly",                      mode: "lww" },
    { key: "optcgPlayCardNoCost",                        mode: "lww" },
    { key: "optcgExtraSlots",                            mode: "lww" },
    { key: "optcgFlatHand",                              mode: "lww" },
    { key: "optcgTurnAutomation",                        mode: "lww" },
    { key: "optcgOcrEnabled",                            mode: "lww" },
    { key: "custom-cards-sim-sfx-muted-v1",              mode: "lww" },
    { key: "custom-img-playmat-v1",                      mode: "lww" },   // playmat
    { key: "custom-img-cardback-v1",                     mode: "lww" },
    { key: "custom-img-donback-v1",                      mode: "lww" },
    { key: "cc_builder_cards_big",                       mode: "lww" },
    { key: "cc_spectator_name",                          mode: "lww" }
];
const SYNC_KEYS = new Set(SYNC_SPECS.map(s => s.key));
const META_KEY = "cc_sync_meta_v1";   // { key: lastPushedAtMs }

let currentUid = null;
const pushTimers = {};

// ── localStorage helpers ─────────────────────────────────
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch { return false; } }
function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {}; } catch { return {}; } }
function writeMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (_) {} }

// ── Firebase read/write ──────────────────────────────────
async function pull(uid) {
    try {
        const snap = await get(ref(database, BASE(uid)));
        return snap.val() || {};
    } catch (error) {
        console.warn("Could not pull account data:", error);
        return {};
    }
}
async function pushEntries(uid, entries) {
    const keys = Object.keys(entries || {});
    if (!uid || !keys.length) return;
    const updates = {};
    keys.forEach(k => { updates[`${BASE(uid)}/${k}`] = entries[k]; });
    try { await update(ref(database), updates); }
    catch (error) { console.warn("Could not push account data:", error); }
}

// ── Merge helpers ────────────────────────────────────────
function parseArr(json) {
    try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}
function deckTime(d) { return Date.parse(d && d.savedAt) || 0; }
function cardKeyOf(c) {
    const num = String(c?.cardNumber || c?.id || "").toLowerCase();
    const col = String(c?.collection || "").toLowerCase();
    return num ? `${num}__${col}` : "";
}
function cardTime(c) { return Date.parse(c?.lastEditedAt || c?.addedAt || c?.importedAt) || 0; }

// Union two arrays keyed by keyFn, keeping the entry with the larger timeFn.
function unionBy(localArr, cloudArr, keyFn, timeFn) {
    const byKey = new Map();
    const take = (arr) => arr.forEach(item => {
        const k = keyFn(item);
        if (!k) return;
        const prev = byKey.get(k);
        if (!prev || timeFn(item) >= timeFn(prev)) byKey.set(k, item);
    });
    take(localArr);
    take(cloudArr);
    return [...byKey.values()];
}

// Reconcile one key against its cloud blob. Returns { localValue, pushValue,
// adoptedAt } — localValue/pushValue null when nothing needs writing that side.
function reconcile(spec, cloudEntry, meta) {
    const localRaw = lsGet(spec.key);
    const cloudJson = cloudEntry && typeof cloudEntry.json === "string" ? cloudEntry.json : null;

    if (spec.mode === "decks" || spec.mode === "cards") {
        if (cloudJson == null) return { localValue: null, pushValue: localRaw };
        const isCards = spec.mode === "cards";
        const merged = unionBy(
            parseArr(localRaw), parseArr(cloudJson),
            isCards ? cardKeyOf : (d => String(d?.name || "").toLowerCase()),
            isCards ? cardTime : deckTime
        );
        const mergedJson = JSON.stringify(merged);
        return {
            localValue: mergedJson !== localRaw ? mergedJson : null,
            pushValue: mergedJson !== cloudJson ? mergedJson : null
        };
    }

    // lww
    const localAt = Number(meta[spec.key] || 0);
    const cloudAt = Number(cloudEntry && cloudEntry.at || 0);
    if (cloudJson != null && cloudAt > localAt && cloudJson !== localRaw) {
        return { localValue: cloudJson, pushValue: null, adoptedAt: cloudAt };
    }
    if (localRaw != null && (cloudJson == null || localAt >= cloudAt)) {
        return { localValue: null, pushValue: localRaw };
    }
    return { localValue: null, pushValue: null };
}

// ── Public controller ────────────────────────────────────

// Pull the account's data, merge it into this device, push the merge back so all
// devices converge. `onApplied(changedKeys)` fires when local data actually
// changed, so the page can refresh its UI.
export async function startAccountSync(uid, options = {}) {
    currentUid = uid || null;
    if (!uid) return;

    const cloud = await pull(uid);
    const meta = readMeta();
    const now = Date.now();
    const toPush = {};
    const changedKeys = [];

    SYNC_SPECS.forEach(spec => {
        const sk = sanitizeSyncKey(spec.key);
        const res = reconcile(spec, cloud[sk], meta);
        if (res.localValue != null) {
            if (lsSet(spec.key, res.localValue)) changedKeys.push(spec.key);
        }
        if (res.adoptedAt) meta[spec.key] = res.adoptedAt;
        if (res.pushValue != null) {
            const at = Math.max(now, Number(meta[spec.key] || 0) + 1);
            meta[spec.key] = at;
            toPush[sk] = { at, json: res.pushValue };
        }
    });

    writeMeta(meta);
    if (Object.keys(toPush).length) pushEntries(uid, toPush);
    if (changedKeys.length && typeof options.onApplied === "function") {
        try { options.onApplied(changedKeys); } catch (_) {}
    }
}

export function stopAccountSync() { currentUid = null; }

// Push ONE key's current value to the account (debounced). Called after any save
// on any page (via window.ccSyncPush). No-op when signed out or key isn't synced.
export function pushKey(key) {
    if (!currentUid || !SYNC_KEYS.has(key)) return;
    clearTimeout(pushTimers[key]);
    pushTimers[key] = setTimeout(() => {
        if (!currentUid) return;
        const json = lsGet(key);
        if (json == null) return;
        const meta = readMeta();
        const at = Date.now();
        meta[key] = at;
        writeMeta(meta);
        pushEntries(currentUid, { [sanitizeSyncKey(key)]: { at, json } });
    }, 800);
}

// Back-compat exports (older callers).
export async function pullUserData(uid) { return pull(uid); }
export async function pushUserData(uid, entries) { return pushEntries(uid, entries); }
