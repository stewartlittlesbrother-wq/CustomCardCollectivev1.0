// Per-account cloud sync of a device's localStorage data (saved decks, DON!!
// decks, the working draft, settings, hotkeys, art prefs, and any local-only
// custom cards). Signed-in players see the same decks/settings on every device.
//
// Storage: users/<uid>/userdata/<sanitized key> = { at:<ms>, json:"<value>" }.
// The `users/<uid>` subtree is already owner-only in the database rules, so no
// rules change is needed. Created cards themselves live in the SHARED library
// (keyed by number+collection, with ownerUid) and so already cross devices; this
// only carries the small local fallback stores + personal prefs.
//
// The merge is deliberately LOSSLESS for decks/cards: entries union by name/key
// and the newer copy wins, so signing in on a second device can only ADD or
// UPDATE - it never deletes a deck that exists on just one device.

import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebaseApp.js";

const BASE = (uid) => `users/${uid}/userdata`;

// Firebase keys can't contain . # $ / [ ]. localStorage keys use dashes/dots.
export function sanitizeSyncKey(key) {
    return String(key).replace(/[.#$/\[\]]/g, "_");
}

// Read every synced blob for this user: { sanitizedKey: { at, json } }.
export async function pullUserData(uid) {
    if (!uid) return {};
    try {
        const snap = await get(ref(database, BASE(uid)));
        return snap.val() || {};
    } catch (error) {
        console.warn("Could not pull account data:", error);
        return {};
    }
}

// Write a batch of blobs: entries = { sanitizedKey: { at, json } }.
export async function pushUserData(uid, entries) {
    if (!uid || !entries) return;
    const keys = Object.keys(entries);
    if (!keys.length) return;
    const updates = {};
    keys.forEach(k => { updates[`${BASE(uid)}/${k}`] = entries[k]; });
    try {
        await update(ref(database), updates);
    } catch (error) {
        console.warn("Could not push account data:", error);
    }
}
