// Tournament alerts: red pop-ups in the corner of EVERY page (home, deck builder,
// multiplayer, tournaments, the game board) for the things a player or organiser
// mustn't miss - your round started, your match is due (1 day / 1 hour / 30%...
// 1% of the round left), the organiser has to pick a winner, the tournament ended.
// What to show is decided by ./core/tournamentAlertRules.js; this file draws it.
//
// A bell in the top bar keeps the last alerts (with an unread count), so one that was
// dismissed or missed isn't lost. Friend requests and game invites from the Players
// tab (the account's inbox) show up here the same way.
//
// While signed in it also: marks the account online (for friends lists), creates
// / renames the player profile, and adds tournament trophies to it.
//
// Loaded by auth-ui.js once someone is signed in (tournaments need an account).
// It also keeps the player's tournaments moving: rounds only advance when a
// participant's browser runs the rules (there is no server), so while the site is
// open anywhere it nudges any tournament that is due to start / settle / advance.

import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebase/firebaseApp.js";
import { BASE_PATH } from "./firebase/tournamentPaths.js?v=tour-3";
import { tick } from "./core/tournamentEngine.js?v=tab-1";
import { alertsFor, inboxAlertsFor, trophiesFor, INVITE_FRESH_MS } from "./core/tournamentAlertRules.js?v=tab-2";
import * as profiles from "./firebase/profileService.js?v=1";

const STORE_KEY = "cc_tn_alerts_v1";          // { dismissed: {key: ms}, announced: {key: ms}, history: [...] }
const SERVICE_URL = "./firebase/tournamentService.js?v=tab-1";
const HISTORY_MAX = 40;
const STICKY_SNOOZE_MS = 20 * 60 * 1000;       // a dismissed "you must decide" comes back after this
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;      // forget dismissals after a month
const MAX_SHOWN = 3;
const REFRESH_MS = 20 * 1000;                  // re-check deadlines
const NUDGE_MS = 60 * 1000;                    // keep tournaments moving

const onBoard = /\/self\.html$/i.test(location.pathname);
const appUrl = new URL("../index.html", import.meta.url);
// The Tournaments tab keeps its own tournaments moving while it's on screen.
const tournamentsTabVisible = () => Boolean(document.querySelector("#tournamentsView.view.active"));

// On the game board the alerts start folded into a small pill (unless something new
// arrives) so they never sit on top of the game.
const run = { uid: "", name: "", list: [], inbox: [], unsubInbox: null, confirmed: new Set(), trophies: null,
              unsub: null, refresh: null, nudge: null, expanded: false, minimized: onBoard,
              minimizeTimer: null, rendered: new Set(), nudgedAt: new Map(), nudging: false };

// ── remembered state (shared by every tab) ───────────────────────────────────

function readStore() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        return { dismissed: raw.dismissed || {}, announced: raw.announced || {}, history: Array.isArray(raw.history) ? raw.history : [] };
    } catch { return { dismissed: {}, announced: {}, history: [] }; }
}
function writeStore(store) {
    const cutoff = Date.now() - KEEP_MS;
    ["dismissed", "announced"].forEach(part => {
        Object.keys(store[part]).forEach(key => { if (store[part][key] < cutoff) delete store[part][key]; });
    });
    store.history = (store.history || []).filter(h => h && h.at >= cutoff).slice(0, HISTORY_MAX);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode: per page only */ }
}

function isDismissed(alert, store, now) {
    const at = store.dismissed[alert.key];
    if (!at) return false;
    return alert.sticky ? now - at < STICKY_SNOOZE_MS : true;
}

// ── drawing ──────────────────────────────────────────────────────────────────

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function injectStyles() {
    if (document.getElementById("cc-tn-alert-styles")) return;
    const style = document.createElement("style");
    style.id = "cc-tn-alert-styles";
    style.textContent = `
#ccTnAlerts { position: fixed; right: 14px; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); z-index: 100000;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px; width: min(360px, calc(100vw - 28px));
  font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: none; }
#ccTnAlerts > * { pointer-events: auto; }
.cc-tn-alert { width: 100%; box-sizing: border-box; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px;
  padding: 12px 12px 12px 14px; border-radius: 12px; color: #fff; text-align: left;
  background: linear-gradient(135deg, #c8313a, #8e1b23); border: 1px solid rgba(255, 255, 255, .22);
  box-shadow: 0 14px 34px rgba(0, 0, 0, .45), 0 0 0 1px rgba(0, 0, 0, .25); }
.cc-tn-alert.fresh { animation: ccTnIn .45s cubic-bezier(.2, .9, .3, 1.2) both; }
.cc-tn-alert.urgent { background: linear-gradient(135deg, #e0313c, #a1121d); box-shadow: 0 14px 34px rgba(0, 0, 0, .45), 0 0 0 2px rgba(255, 210, 210, .55); }
.cc-tn-alert .ico { grid-row: 1 / span 3; font-size: 22px; line-height: 1.1; }
.cc-tn-alert .ttl { font-weight: 800; font-size: 14.5px; line-height: 1.25; text-wrap: balance; min-width: 0; overflow-wrap: anywhere; }
.cc-tn-alert .msg { grid-column: 2 / span 2; color: rgba(255, 255, 255, .9); font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.cc-tn-alert .row { grid-column: 2 / span 2; display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.cc-tn-alert button { font: inherit; cursor: pointer; border-radius: 8px; }
.cc-tn-alert .go { background: #fff; color: #8e1b23; border: 0; font-weight: 800; padding: 6px 12px; }
.cc-tn-alert .go:hover { background: #ffe3e5; }
.cc-tn-alert .later { background: transparent; color: #fff; border: 1px solid rgba(255, 255, 255, .45); padding: 5px 10px; font-weight: 600; }
.cc-tn-alert .x { background: transparent; border: 0; color: rgba(255, 255, 255, .85); font-size: 18px; line-height: 1; padding: 0 2px; align-self: start; }
.cc-tn-alert .x:hover, .cc-tn-alert .later:hover { color: #fff; border-color: #fff; }
.cc-tn-more, .cc-tn-pill { background: #8e1b23; color: #fff; border: 1px solid rgba(255, 255, 255, .3); border-radius: 999px;
  padding: 6px 12px; font: 700 12.5px/1.2 inherit; cursor: pointer; box-shadow: 0 8px 20px rgba(0, 0, 0, .4); }
.cc-tn-pill { background: linear-gradient(135deg, #e0313c, #a1121d); padding: 8px 14px; font-size: 13px; }
.cc-tn-more:hover, .cc-tn-pill:hover { filter: brightness(1.12); }
@keyframes ccTnIn { from { opacity: 0; transform: translateY(16px) scale(.96); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .cc-tn-alert.fresh { animation: none; } }
@media (max-width: 480px) { #ccTnAlerts { right: 10px; left: 10px; width: auto; align-items: stretch; } }
.cc-tn-bell { position: relative; display: inline-flex; align-items: center; }
.cc-tn-bell .cc-tn-bell-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
  min-height: 0; padding: 0; border-radius: 9px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06);
  color: #dfe4ec; box-shadow: none; filter: none; cursor: pointer; }
.cc-tn-bell .cc-tn-bell-btn:hover { background: rgba(255, 255, 255, .14); box-shadow: none; filter: none; }
.cc-tn-bell .cc-tn-bell-btn[aria-expanded="true"] { border-color: rgba(77, 255, 158, .55); }
.cc-tn-bell-n { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: #e0313c; color: #fff; font: 800 11px/18px system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #0d0f12; }
.cc-tn-bell-panel { position: absolute; top: calc(100% + 10px); right: 0; z-index: 100001; width: min(360px, calc(100vw - 24px));
  max-height: min(70vh, 520px); overflow-y: auto; border-radius: 12px; border: 1px solid #263029; background: #101614; color: #f3f8f5;
  box-shadow: 0 20px 50px rgba(0, 0, 0, .55); font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left; }
.cc-tn-bell-head { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 11px 14px; background: #101614; border-bottom: 1px solid #263029; }
.cc-tn-bell .cc-tn-bell-clear { min-height: 0; padding: 0; border: 0; background: none; color: #9db1a8; font: 600 12.5px/1.2 inherit;
  text-decoration: underline; cursor: pointer; box-shadow: none; filter: none; }
.cc-tn-bell-list { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.cc-tn-bell .cc-tn-bell-item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; width: 100%; min-height: 0;
  padding: 9px 10px; border: 0; border-radius: 9px; background: none; color: inherit; text-align: left; font: inherit; font-weight: 400;
  cursor: pointer; box-shadow: none; filter: none; }
.cc-tn-bell .cc-tn-bell-item:hover:not(:disabled) { background: rgba(255, 255, 255, .06); box-shadow: none; filter: none; }
.cc-tn-bell .cc-tn-bell-item:disabled { cursor: default; opacity: 1; filter: none; }
.cc-tn-bell .cc-tn-bell-item.unread { background: rgba(224, 49, 60, .12); box-shadow: inset 3px 0 0 #e0313c; }
.cc-tn-bell-item .i { font-size: 18px; line-height: 1.2; }
.cc-tn-bell-item .t { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cc-tn-bell-item strong { font-size: 13.5px; font-weight: 750; overflow-wrap: anywhere; }
.cc-tn-bell-item small { color: #b7c7be; font-size: 12.5px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cc-tn-bell-item em { color: #8fa398; font-size: 11.5px; font-style: normal; }
.cc-tn-bell-empty { margin: 0; padding: 16px 14px; color: #9db1a8; font-size: 13px; }`;
    document.head.appendChild(style);
}

function container() {
    let box = document.getElementById("ccTnAlerts");
    if (!box) {
        box = document.createElement("div");
        box.id = "ccTnAlerts";
        box.setAttribute("role", "region");
        box.setAttribute("aria-label", "Tournament alerts");
        box.setAttribute("aria-live", "polite");
        box.addEventListener("click", onClick);
        document.body.appendChild(box);
    }
    return box;
}

function linkFor(action) {
    const url = new URL(appUrl);
    url.searchParams.set("view", "tournaments");
    if (action && action.tid) url.searchParams.set("t", action.tid);
    if (action && action.manage) url.searchParams.set("manage", action.manage);
    return url.href;
}

// Go to what an alert is about. In the app it's the Tournaments tab (no reload); on
// the game board a new browser tab, so the game in progress is never left.
function openAction(action) {
    if (!action) return;
    if (action.kind === "players") {
        const url = new URL(appUrl);
        url.searchParams.set("view", "players");
        if (onBoard) window.open(url.href, "_blank", "noopener");
        else if (typeof window.ccShowView === "function") window.ccShowView("players");
        else location.href = url.href;
        return;
    }
    if (action.kind === "join") {
        const url = new URL(appUrl);
        url.searchParams.set("join", action.room);
        if (onBoard) window.open(url.href, "_blank", "noopener");
        else if (typeof window.ccJoinRoom === "function") window.ccJoinRoom(action.room);
        else location.href = url.href;
        return;
    }
    if (onBoard) { window.open(linkFor(action), "_blank", "noopener"); return; }
    if (typeof window.ccOpenTournament === "function") { window.ccOpenTournament(action.tid || "", action.manage || ""); return; }
    location.href = linkFor(action);
}

let current = [];   // the alerts being shown, in order

function visibleAlerts(now = Date.now()) {
    const store = readStore();
    return [...alertsFor(run.list, run.uid, now), ...inboxAlertsFor(run.inbox, now)]
        .filter(a => !isDismissed(a, store, now))
        .sort((a, b) => b.at - a.at);
}

function render() {
    if (!run.uid || !document.body) return;
    injectStyles();
    const box = container();
    const now = Date.now();
    current = visibleAlerts(now);

    // Brand-new alerts (never seen in any tab): a chime, a line in the bell's history,
    // and on the game board they stay open a little before folding away.
    const store = readStore();
    const brandNew = current.filter(a => !store.announced[a.key]);
    if (brandNew.length) {
        brandNew.forEach(a => {
            store.announced[a.key] = now;
            store.history = store.history.filter(h => h.key !== a.key);
            store.history.unshift({ key: a.key, icon: a.icon, title: a.title, body: a.body, action: a.action || null, at: now, read: false });
        });
        writeStore(store);
        chime();
        if (onBoard) { run.minimized = false; scheduleMinimize(); }
    }

    renderBell();
    if (!current.length) { box.innerHTML = ""; run.rendered.clear(); return; }

    if (run.minimized || (dialogOpen() && !run.forceOpen)) {
        box.innerHTML = `<button type="button" class="cc-tn-pill" data-tn="expand" aria-label="Show tournament alerts">🔔 ${current.length} tournament alert${current.length === 1 ? "" : "s"}</button>`;
        return;
    }

    const shown = run.expanded ? current : current.slice(0, MAX_SHOWN);
    const html = shown.map(a => `
        <div class="cc-tn-alert ${esc(a.tone)}${run.rendered.has(a.key) ? "" : " fresh"}" data-key="${esc(a.key)}"${run.rendered.has(a.key) ? "" : ' role="alert"'}>
          <span class="ico" aria-hidden="true">${esc(a.icon)}</span>
          <span class="ttl">${esc(a.title)}</span>
          <button type="button" class="x" data-tn="dismiss" data-key="${esc(a.key)}" aria-label="Dismiss">×</button>
          <span class="msg">${esc(a.body)}</span>
          <span class="row">
            ${a.action ? `<button type="button" class="go" data-tn="go" data-key="${esc(a.key)}">${esc(a.action.label)}</button>` : ""}
            ${a.sticky ? `<button type="button" class="later" data-tn="dismiss" data-key="${esc(a.key)}">Remind me later</button>` : ""}
          </span>
        </div>`).join("");
    const more = current.length > shown.length
        ? `<button type="button" class="cc-tn-more" data-tn="more">+${current.length - shown.length} more tournament alert${current.length - shown.length === 1 ? "" : "s"}</button>` : "";
    const fold = onBoard ? `<button type="button" class="cc-tn-more" data-tn="minimize">Hide alerts</button>` : "";
    box.innerHTML = html + more + fold;
    run.rendered = new Set(current.map(a => a.key));
}

// While a dialog is open (e.g. the organiser's "pick the winner" panel) the alerts fold
// into the pill so they don't sit on top of its buttons.
const DIALOG_SELECTOR = ".tn-overlay:not([hidden]), .cc-auth-overlay, #gameOverOverlay:not([hidden])";
function dialogOpen() {
    try { return Boolean(document.querySelector(DIALOG_SELECTOR)); } catch { return false; }
}
let lastDialogOpen = false;
setInterval(() => {
    const open = dialogOpen();
    if (open !== lastDialogOpen) { lastDialogOpen = open; run.forceOpen = false; if (run.uid) render(); }
}, 700);

function scheduleMinimize() {
    clearTimeout(run.minimizeTimer);
    run.minimizeTimer = setTimeout(() => { run.minimized = true; render(); }, 12000);
}

function dismiss(key) {
    const store = readStore();
    store.dismissed[key] = Date.now();
    writeStore(store);
    // Accepted requests and invites are done with once seen: clear them from the inbox.
    const alert = current.find(a => a.key === key);
    if (alert && alert.inbox && alert.deleteOnDismiss && run.uid) profiles.deleteInbox(run.uid, alert.inbox).catch(() => {});
    render();
}

function onClick(event) {
    const button = event.target.closest("[data-tn]");
    if (!button) return;
    const key = button.dataset.key;
    switch (button.dataset.tn) {
        case "dismiss": dismiss(key); break;
        case "more": run.expanded = true; render(); break;
        case "minimize": run.minimized = true; clearTimeout(run.minimizeTimer); render(); break;
        case "expand":
            // Opened from the pill while a dialog is up: close nothing, just show them.
            run.minimized = false; run.forceOpen = dialogOpen(); clearTimeout(run.minimizeTimer); render(); break;
        case "go": {
            const alert = current.find(a => a.key === key);
            if (!alert) return;
            if (!alert.sticky) dismiss(key);
            markRead(key);
            openAction(alert.action);
            break;
        }
    }
}

// A short two-note chime. Browsers only allow sound after the visitor has clicked or
// typed on the page, so it's silently skipped before that.
let audio = null;
function chime() {
    try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === "suspended") return;
        const t0 = audio.currentTime;
        [[880, 0], [660, 0.16]].forEach(([freq, delay]) => {
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, t0 + delay);
            gain.gain.exponentialRampToValueAtTime(0.12, t0 + delay + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.28);
            osc.connect(gain).connect(audio.destination);
            osc.start(t0 + delay);
            osc.stop(t0 + delay + 0.3);
        });
    } catch { /* no sound - the pop-up still shows */ }
}
["pointerdown", "keydown"].forEach(type => document.addEventListener(type, () => {
    try { if (audio && audio.state === "suspended") audio.resume(); } catch { /* ignore */ }
}, { passive: true }));

// ── the bell (alert history) ─────────────────────────────────────────────────
// Lives in the top bar's right-hand slot (next to the account chip) on pages that
// have one. Opening it marks everything read; items stay highlighted while open.

let bellOpen = false;
let bellUnreadAtOpen = new Set();

function markRead(key) {
    const store = readStore();
    let changed = false;
    store.history.forEach(h => { if (h.key === key && !h.read) { h.read = true; changed = true; } });
    if (changed) { writeStore(store); renderBell(); }
}

function ago(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}

function bellHost() {
    const slot = document.querySelector(".top-nav .nav-actions");
    if (!slot) return null;
    let bell = slot.querySelector(".cc-tn-bell");
    if (!bell) {
        bell = document.createElement("div");
        bell.className = "cc-tn-bell";
        bell.addEventListener("click", onBellClick);
        slot.prepend(bell);
    }
    return bell;
}

function renderBell() {
    if (!run.uid) return;
    const bell = bellHost();
    if (!bell) return;
    const history = readStore().history;
    const unread = history.filter(h => !h.read).length;
    const items = history.map(h => {
        const fresh = bellUnreadAtOpen.has(h.key) || !h.read;
        return `<li><button type="button" class="cc-tn-bell-item${fresh ? " unread" : ""}" data-bell="open" data-key="${esc(h.key)}"${h.action ? "" : " disabled"}>
            <span class="i" aria-hidden="true">${esc(h.icon || "🏆")}</span>
            <span class="t"><strong>${esc(h.title)}</strong><small>${esc(h.body)}</small><em>${esc(ago(h.at))}</em></span>
        </button></li>`;
    }).join("");
    const html = `
        <button type="button" class="cc-tn-bell-btn" data-bell="toggle" aria-expanded="${bellOpen}" aria-haspopup="dialog"
            aria-label="Tournament alerts${unread ? ` (${unread} new)` : ""}" title="Tournament alerts">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>
            ${unread ? `<span class="cc-tn-bell-n">${unread > 9 ? "9+" : unread}</span>` : ""}
        </button>
        <div class="cc-tn-bell-panel" role="dialog" aria-label="Tournament alerts"${bellOpen ? "" : " hidden"}>
            <div class="cc-tn-bell-head"><strong>Tournament alerts</strong>
                ${history.length ? `<button type="button" class="cc-tn-bell-clear" data-bell="clear">Clear</button>` : ""}</div>
            ${history.length ? `<ul class="cc-tn-bell-list">${items}</ul>`
                : `<p class="cc-tn-bell-empty">Nothing yet — alerts about your tournaments (your round starting, a match due, results) show up here.</p>`}
        </div>`;
    // Only redraw when something changed (keeps the list's scroll position).
    if (bell.__html !== html) { bell.__html = html; bell.innerHTML = html; }
}

function setBellOpen(open) {
    bellOpen = open;
    if (open) {
        const store = readStore();
        bellUnreadAtOpen = new Set(store.history.filter(h => !h.read).map(h => h.key));
        if (bellUnreadAtOpen.size) { store.history.forEach(h => { h.read = true; }); writeStore(store); }
    } else {
        bellUnreadAtOpen = new Set();
    }
    renderBell();
}

function onBellClick(event) {
    const button = event.target.closest("[data-bell]");
    if (!button) return;
    event.stopPropagation();
    switch (button.dataset.bell) {
        case "toggle": setBellOpen(!bellOpen); break;
        case "clear": {
            const store = readStore();
            store.history = [];
            writeStore(store);
            bellUnreadAtOpen = new Set();
            renderBell();
            break;
        }
        case "open": {
            const item = readStore().history.find(h => h.key === button.dataset.key);
            setBellOpen(false);
            if (item && item.action) openAction(item.action);
            break;
        }
    }
}
document.addEventListener("click", (event) => {
    if (bellOpen && !event.target.closest(".cc-tn-bell")) setBellOpen(false);
});
document.addEventListener("keydown", (event) => {
    if (bellOpen && event.key === "Escape") setBellOpen(false);
});

// ── keeping tournaments moving ───────────────────────────────────────────────

async function nudge() {
    if (!run.uid || run.nudging || tournamentsTabVisible()) return;   // that tab does its own
    const now = Date.now();
    const due = run.list.filter(t => {
        const involved = (t.players && t.players[run.uid]) || t.createdBy === run.uid;
        if (!involved) return false;
        if (t.status !== "running" && !(t.status === "registration" && now >= Number(t.startAt))) return false;
        if (now - (run.nudgedAt.get(t.id) || 0) < 30000) return false;
        try { return tick(t, now, {}, t.id).changed; } catch { return false; }
    });
    if (!due.length) return;
    run.nudging = true;
    try {
        const service = await import(SERVICE_URL);
        for (const t of due) {
            run.nudgedAt.set(t.id, Date.now());
            try { await service.syncTournament(t.id, run.uid); }
            catch (error) { console.warn("Tournament update failed:", error); }
        }
    } finally { run.nudging = false; }
}

// ── start / stop ─────────────────────────────────────────────────────────────

export function startTournamentAlerts(uid, name = "") {
    if (!uid) { stopTournamentAlerts(); return; }
    if (run.uid === uid && run.unsub) {
        // Same account, new name (the saved name can arrive just after sign-in).
        if (name && name !== run.name) {
            run.name = name;
            profiles.ensureProfile(uid, name).catch(() => {});
            profiles.startPresence(uid, name);
        }
        return;
    }
    stopTournamentAlerts();
    run.uid = uid;
    run.name = name || "Player";
    run.unsub = onValue(ref(database, BASE_PATH), (snapshot) => {
        run.list = Object.entries(snapshot.val() || {})
            .map(([id, t]) => ({ ...t, id }))
            .filter(t => t && t.name);
        render();
        nudge();
        syncTrophies();
    }, (error) => console.warn("Tournament alerts unavailable:", error));
    startSocial();
    run.refresh = setInterval(render, REFRESH_MS);
    run.nudge = setInterval(nudge, NUDGE_MS);
}

// ── profile, online status, inbox ────────────────────────────────────────────
// (All of this needs the database rules published; until then it quietly does
// nothing.)

function startSocial() {
    const uid = run.uid;
    profiles.ensureProfile(uid, run.name)
        .then((profile) => { if (run.uid === uid) { run.trophies = new Set(Object.keys((profile && profile.trophies) || {})); syncTrophies(); } })
        .catch(() => {});
    profiles.startPresence(uid, run.name);
    run.unsubInbox = profiles.watchInbox(uid, (items) => {
        if (run.uid !== uid) return;
        run.inbox = items;
        const now = Date.now();
        items.forEach(item => {
            // They accepted my request: they're my friend now too.
            if (item.type === "friendAccept" && !run.confirmed.has(item.id)) {
                run.confirmed.add(item.id);
                profiles.confirmAccepted(uid, item.fromUid, item.fromName, null).catch(() => {});
            }
            // An invite to a room that's long gone: tidy it away.
            if (item.type === "invite" && now - Number(item.at || 0) > INVITE_FRESH_MS * 4) profiles.deleteInbox(uid, item.id).catch(() => {});
        });
        render();
    }, () => {});
}

// Tournament trophies on my profile: any top finish not on it yet.
function syncTrophies() {
    if (!run.uid || !run.trophies) return;
    const mine = trophiesFor(run.list, run.uid);
    const missing = Object.fromEntries(Object.entries(mine).filter(([tid]) => !run.trophies.has(tid)));
    if (!Object.keys(missing).length) return;
    Object.keys(missing).forEach(tid => run.trophies.add(tid));
    profiles.addTrophies(run.uid, missing).catch(() => {});
}

export function stopTournamentAlerts() {
    if (run.unsubInbox) { try { run.unsubInbox(); } catch { /* already gone */ } }
    run.unsubInbox = null;
    run.inbox = [];
    run.trophies = null;
    profiles.stopPresence();
    if (run.unsub) { try { run.unsub(); } catch { /* already gone */ } }
    clearInterval(run.refresh);
    clearInterval(run.nudge);
    clearTimeout(run.minimizeTimer);
    run.uid = "";
    run.list = [];
    run.unsub = null;
    const box = document.getElementById("ccTnAlerts");
    if (box) box.innerHTML = "";
    document.querySelector(".cc-tn-bell")?.remove();
}

// Dismissed in another tab -> gone here too.
window.addEventListener("storage", (event) => { if (event.key === STORE_KEY) render(); });
// Back on the tab after a while: deadlines may have passed.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); nudge(); } });
