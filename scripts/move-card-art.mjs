#!/usr/bin/env node
// Moves card pictures that were uploaded INTO the database out to files in art/.
//
// Why: the Realtime Database's free plan allows 1 GB stored and 10 GB downloaded a
// month, and card pictures (~100 KB each, read by everyone who looks at a card)
// blew through both. Since v272 every card's picture is a file served with the
// site, and the card just holds a link. But a card that is added or edited still
// arrives with its picture embedded - this script is what turns that into a file.
// .github/workflows/card-art.yml runs it every half hour.
//
//   node scripts/move-card-art.mjs collect [--dry]
//       Finds cards changed since the last run whose picture (or alt arts) are
//       embedded, writes the picture files into art/, and saves a plan.
//       Sets the GitHub outputs: deploy (new files must be published first),
//       apply (there are cards to update), count.
//   node scripts/move-card-art.mjs apply [--dry]
//       Once the files are live: points each card at its file(s).
//
// It costs the database almost nothing: two tiny reads when nothing changed; when
// something did, the index (~0.4 MB) plus the new cards themselves, once.
//
// It signs in the way the site does for a guest (the web API key in
// js/firebase/firebaseConfig.js is public by design) - no secret is needed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "art");
// Where art/ is published. Card links are absolute, so they work from every page.
const ART_BASE = (process.env.ART_BASE_URL || "https://stewartlittlesbrother-wq.github.io/CustomCardCollectivev1.0/art").replace(/\/$/, "");
const PLAN_FILE = process.env.ART_PLAN || path.join(os.tmpdir(), "card-art-plan.json");
const DRY = process.argv.includes("--dry");
const MODE = process.argv[2];

const EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/avif": "avif" };
const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
const SERVER_TIME = { ".sv": "timestamp" };
const INDEX = "cardIndex";
const CARDS = "cards";
const STAMP = "~stamp";   // bumped by every card write (see cardLibraryService.js)
const MOVER = "~mover";   // the stamp this script last finished with

// ── pure helpers (exported for the tests) ────────────────────────────────────

export const isDataUrl = (value) => typeof value === "string" && value.startsWith("data:");

export function altArtList(card) {
    const raw = Array.isArray(card?.altArts) ? card.altArts
        : (card?.altArts && typeof card.altArts === "object") ? Object.values(card.altArts)
        : (card?.altArt ? [card.altArt] : []);
    return raw.filter(art => typeof art === "string" && art);
}

// Same chunk rule as catalogChunkOf in cardLibraryService.js.
export function catalogChunkOf(key) {
    const text = String(key);
    const at = text.indexOf("__");
    return "~cat~" + (at >= 0 ? text.slice(at + 2) : "_none");
}

/** A data: URL as { rel, buffer }, named by its content - or null if it can't be a file. */
export function pictureFile(dataUrl) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ""));
    if (!match) return null;
    const ext = EXT[match[1].toLowerCase()];
    if (!ext) return null;
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length < 200 || buffer.length > MAX_PICTURE_BYTES) return null;
    const hash = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 24);
    return { rel: `${hash.slice(0, 2)}/${hash}.${ext}`, buffer };
}

/** Which index keys changed since `done` (never bookkeeping keys or deleted cards). */
export function changedKeys(index, done) {
    return Object.keys(index || {}).filter(key => !key.startsWith("~")
        && index[key] && index[key].deleted !== true
        && Number(index[key].updatedAt || 0) > Number(done || 0));
}

/**
 * Which of a card's alt arts are embedded, and what they become.
 * `store(dataUrl)` returns the link for a picture (or null if it can't be a file).
 * Returns null when nothing is embedded or one can't be moved, else
 * { altWrites: { "<place in the stored list>": link }, altArt?: link, alts: [every alt as a link] }.
 * Each embedded alt is written at its OWN place: the database rules let the mover
 * turn one embedded picture into a link, never replace a whole list.
 */
export function planAlts(card, store) {
    const stored = card?.altArts;
    if (stored && typeof stored === "object") {
        const altWrites = {};
        const after = Array.isArray(stored) ? [...stored] : { ...stored };
        for (const [place, art] of Object.entries(stored)) {
            if (!isDataUrl(art)) continue;
            const link = store(art);
            if (!link) return null;
            altWrites[place] = link;
            after[place] = link;
        }
        if (!Object.keys(altWrites).length) return null;
        return { altWrites, alts: altArtList({ altArts: after }) };
    }
    // Older cards kept a single alt in `altArt`.
    if (isDataUrl(card?.altArt)) {
        const link = store(card.altArt);
        return link ? { altWrites: {}, altArt: link, alts: [link] } : null;
    }
    return null;
}

/**
 * The database writes that point one card at its files. `item` is a plan entry:
 * { key, image?, altWrites?, altArt?, alts?, catalog } - catalog says the card's
 * catalog copy was current, in which case it is patched too (otherwise a visitor's
 * browser rebuilds it from the card, which is tiny now).
 */
export function cardUpdates(item) {
    const updates = {};
    const key = item.key;
    const entry = `${CARDS}/${catalogChunkOf(key)}/cards/${key}`;
    if (item.image) {
        updates[`${CARDS}/${key}/image`] = item.image;
        if (item.catalog) { updates[`${entry}/image`] = item.image; updates[`${entry}/__img`] = null; }
    }
    if (Array.isArray(item.alts)) {
        Object.entries(item.altWrites || {}).forEach(([place, link]) => { updates[`${CARDS}/${key}/altArts/${place}`] = link; });
        if (item.altArt) updates[`${CARDS}/${key}/altArt`] = item.altArt;
        // Every alt is a link now, so the catalog can carry the list itself.
        if (item.catalog && item.alts.every(art => !isDataUrl(art))) { updates[`${entry}/altArts`] = item.alts; updates[`${entry}/__alts`] = null; }
    }
    // Only the time on the index entry changes, so a type guess stored there stays.
    updates[`${INDEX}/${key}/updatedAt`] = SERVER_TIME;
    if (item.catalog) updates[`${entry}/updatedAt`] = SERVER_TIME;
    return updates;
}

// ── database access (REST) ───────────────────────────────────────────────────

let DB = "";
let token = "";
let apiKeyInUse = "";

function readConfig() {
    const text = fs.readFileSync(path.join(ROOT, "js/firebase/firebaseConfig.js"), "utf8");
    const pick = (name) => (new RegExp(`${name}:\\s*"([^"]+)"`).exec(text) || [])[1] || "";
    const apiKey = pick("apiKey"), databaseURL = pick("databaseURL");
    if (!apiKey || !databaseURL) throw new Error("Couldn't read apiKey / databaseURL from js/firebase/firebaseConfig.js");
    return { apiKey, databaseURL: databaseURL.replace(/\/$/, "") };
}

async function signIn() {
    const { apiKey, databaseURL } = readConfig();
    DB = databaseURL;
    apiKeyInUse = apiKey;
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.idToken) throw new Error(`Guest sign-in failed (${response.status}): ${body?.error?.message || "no token"}`);
    token = body.idToken;
}

// Each run signs in as a brand-new guest; remove it again so they don't pile up
// in the project's user list.
async function signOut() {
    if (!token) return;
    try {
        await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKeyInUse}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken: token })
        });
    } catch { /* not worth failing a run over */ }
}

const dbPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");

async function dbGet(p) {
    const response = await fetch(`${DB}/${dbPath(p)}.json?auth=${token}`);
    if (!response.ok) throw new Error(`Read ${p} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
}

async function dbPatch(updates) {
    if (DRY) { console.log(`[dry] would write ${Object.keys(updates).length} paths`); return; }
    const response = await fetch(`${DB}/.json?auth=${token}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates)
    });
    if (!response.ok) throw new Error(`Write failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

async function isLive(url) {
    try { return (await fetch(url, { method: "HEAD", cache: "no-store" })).ok; } catch { return false; }
}

function setOutputs(values) {
    const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);
    console.log(lines.join("  "));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}

const finishRun = (stamp) => dbPatch({ [`${INDEX}/${MOVER}`]: { deleted: true, updatedAt: stamp } });

// ── collect ──────────────────────────────────────────────────────────────────

async function collect() {
    await signIn();
    const stamp = Number(await dbGet(`${INDEX}/${STAMP}/updatedAt`)) || 0;
    const done = Number(await dbGet(`${INDEX}/${MOVER}/updatedAt`)) || 0;
    if (stamp && stamp === done) {
        console.log("Nothing has changed since the last run.");
        return setOutputs({ deploy: false, apply: false, count: 0 });
    }

    const index = (await dbGet(INDEX)) || {};
    const keys = changedKeys(index, done);
    console.log(`${keys.length} card(s) changed since the last run.`);

    // The catalog copy says whether a card still has embedded pictures, without
    // reading the card. Many changed in one collection: read that catalog once.
    const byChunk = new Map();
    keys.forEach(key => { const chunk = catalogChunkOf(key); (byChunk.get(chunk) || byChunk.set(chunk, []).get(chunk)).push(key); });
    const entries = {};
    for (const [chunk, wanted] of byChunk) {
        if (wanted.length > 15) Object.assign(entries, (await dbGet(`${CARDS}/${chunk}/cards`)) || {});
        else for (const key of wanted) { const entry = await dbGet(`${CARDS}/${chunk}/cards/${key}`); if (entry) entries[key] = entry; }
    }

    const plan = [];
    const newFiles = [];
    const store = (dataUrl) => {
        const file = pictureFile(dataUrl);
        if (!file) return null;
        const target = path.join(ART_DIR, file.rel);
        if (!fs.existsSync(target)) {
            if (!DRY) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.buffer); }
            newFiles.push(file.rel);
        }
        return `${ART_BASE}/${file.rel}`;
    };

    for (const key of keys) {
        const at = Number(index[key].updatedAt || 0);
        const entry = entries[key];
        const catalog = Boolean(entry) && Number(entry.updatedAt || 0) === at;
        if (catalog && !entry.__img && !entry.__alts) continue;   // nothing embedded
        const card = await dbGet(`${CARDS}/${key}`);
        if (!card) continue;
        const item = { key, at, catalog };
        if (isDataUrl(card.image)) {
            const url = store(card.image);
            if (url) item.image = url;
            else console.log(`Skipped ${key}: its picture can't be turned into a file.`);
        }
        if (altArtList(card).some(isDataUrl)) {
            const alts = planAlts(card, store);
            if (alts) Object.assign(item, alts);
            else console.log(`Skipped the alt arts of ${key}: one can't be turned into a file.`);
        }
        if (item.image || item.alts) plan.push(item);
    }

    if (!plan.length) {
        console.log("No embedded pictures to move.");
        await finishRun(stamp);
        return setOutputs({ deploy: false, apply: false, count: 0 });
    }

    // Files that are not on the site yet have to be published before any card
    // may point at them.
    const links = [...new Set(plan.flatMap(item => [item.image, ...(item.alts || [])]).filter(link => link && link.startsWith(ART_BASE)))];
    const live = await Promise.all(links.map(isLive));
    const deploy = live.some(ok => !ok);
    fs.writeFileSync(PLAN_FILE, JSON.stringify({ stamp, madeAt: new Date().toISOString(), cards: plan }));
    console.log(`${plan.length} card(s) to move, ${newFiles.length} new file(s)${deploy ? ", publishing needed" : ", files already live"}.`);
    plan.forEach(item => console.log(`  ${item.key}${item.image ? " picture" : ""}${item.alts ? ` +${item.alts.length} alt(s)` : ""}`));
    setOutputs({ deploy, apply: true, count: newFiles.length });
}

// ── apply ────────────────────────────────────────────────────────────────────

async function apply() {
    if (!fs.existsSync(PLAN_FILE)) { console.log("No plan to apply."); return; }
    const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    await signIn();

    // A fresh deploy can take a little while to reach every edge server.
    const links = [...new Set(plan.cards.flatMap(item => [item.image, ...(item.alts || [])]).filter(link => link && link.startsWith(ART_BASE)))];
    const waitUntil = Date.now() + 6 * 60 * 1000;
    let missing = links;
    while (missing.length) {
        const live = await Promise.all(missing.map(isLive));
        missing = missing.filter((_, i) => !live[i]);
        if (!missing.length || Date.now() > waitUntil) break;
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    const dead = new Set(missing);
    if (dead.size) console.log(`${dead.size} file(s) are still not live; the cards using them wait for the next run.`);

    let moved = 0, skipped = 0;
    for (let i = 0; i < plan.cards.length; i += 20) {
        const updates = {};
        for (const item of plan.cards.slice(i, i + 20)) {
            if ([item.image, ...(item.alts || [])].some(link => dead.has(link))) { skipped++; continue; }
            // Edited again since the files were made? Leave it for the next run.
            const now = Number(await dbGet(`${INDEX}/${item.key}/updatedAt`)) || 0;
            if (now !== Number(item.at)) { skipped++; continue; }
            Object.assign(updates, cardUpdates(item));
            moved++;
        }
        if (Object.keys(updates).length) {
            updates[`${INDEX}/${STAMP}`] = { deleted: true, updatedAt: SERVER_TIME };
            await dbPatch(updates);
        }
    }
    console.log(`${moved} card(s) now use picture files${skipped ? `, ${skipped} left for the next run` : ""}.`);
    // Remember the stamp from when the plan was made: anything saved after that is
    // newer and gets looked at next time. (Only when nothing was left behind.)
    if (!skipped) await finishRun(plan.stamp);
}

// ── entry point (not when imported by the tests) ─────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const run = MODE === "collect" ? collect : MODE === "apply" ? apply : null;
    if (!run) {
        console.error("usage: node scripts/move-card-art.mjs collect|apply [--dry]");
        process.exit(2);
    }
    run()
        .catch(error => { console.error(error.message || error); process.exitCode = 1; })
        .finally(signOut);
}
