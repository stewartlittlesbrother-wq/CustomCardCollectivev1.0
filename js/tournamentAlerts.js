// Tournament alerts: red pop-ups in the corner of EVERY page (home, deck builder,
// multiplayer, tournaments, the game board) for the things a player or organiser
// mustn't miss - your round started, your match is due (1 day / 1 hour / 30%...
// 1% of the round left), the organiser has to pick a winner, the tournament ended.
// What to show is decided by ./core/tournamentAlertRules.js; this file draws it.
//
// Loaded by auth-ui.js once someone is signed in (tournaments need an account).
// It also keeps the player's tournaments moving: rounds only advance when a
// participant's browser runs the rules (there is no server), so while the site is
// open anywhere it nudges any tournament that is due to start / settle / advance.

import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { database } from "./firebase/firebaseApp.js";
import { BASE_PATH } from "./firebase/tournamentPaths.js?v=tour-3";
import { tick } from "./core/tournamentEngine.js?v=tour-8";
import { alertsFor } from "./core/tournamentAlertRules.js?v=tour-8";

const STORE_KEY = "cc_tn_alerts_v1";          // { dismissed: {key: ms}, announced: {key: ms} }
const STICKY_SNOOZE_MS = 20 * 60 * 1000;       // a dismissed "you must decide" comes back after this
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;      // forget dismissals after a month
const MAX_SHOWN = 3;
const REFRESH_MS = 20 * 1000;                  // re-check deadlines
const NUDGE_MS = 60 * 1000;                    // keep tournaments moving

const onBoard = /\/self\.html$/i.test(location.pathname);
const onTournamentsPage = /\/tournaments\.html$/i.test(location.pathname);
const tournamentsUrl = new URL("../html/tournaments.html", import.meta.url);

// On the game board the alerts start folded into a small pill (unless something new
// arrives) so they never sit on top of the game.
const run = { uid: "", list: [], unsub: null, refresh: null, nudge: null, expanded: false, minimized: onBoard,
              minimizeTimer: null, rendered: new Set(), nudgedAt: new Map(), nudging: false };

// ── remembered state (shared by every tab) ───────────────────────────────────

function readStore() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        return { dismissed: raw.dismissed || {}, announced: raw.announced || {} };
    } catch { return { dismissed: {}, announced: {} }; }
}
function writeStore(store) {
    const cutoff = Date.now() - KEEP_MS;
    ["dismissed", "announced"].forEach(part => {
        Object.keys(store[part]).forEach(key => { if (store[part][key] < cutoff) delete store[part][key]; });
    });
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
@media (max-width: 480px) { #ccTnAlerts { right: 10px; left: 10px; width: auto; align-items: stretch; } }`;
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
    const url = new URL(tournamentsUrl);
    if (action && action.tid) url.searchParams.set("t", action.tid);
    if (action && action.manage) url.searchParams.set("manage", action.manage);
    return url.href;
}

let current = [];   // the alerts being shown, in order

function visibleAlerts(now = Date.now()) {
    const store = readStore();
    return alertsFor(run.list, run.uid, now).filter(a => !isDismissed(a, store, now));
}

function render() {
    if (!run.uid || !document.body) return;
    injectStyles();
    const box = container();
    const now = Date.now();
    current = visibleAlerts(now);
    if (!current.length) { box.innerHTML = ""; run.rendered.clear(); return; }

    // Brand-new alerts (never seen in any tab): a chime, and on the game board they
    // stay open a little before folding away so they don't cover the game.
    const store = readStore();
    const brandNew = current.filter(a => !store.announced[a.key]);
    if (brandNew.length) {
        brandNew.forEach(a => { store.announced[a.key] = now; });
        writeStore(store);
        chime();
        if (onBoard) { run.minimized = false; scheduleMinimize(); }
    }

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
            // Never navigate away from a game in progress: open the tournament in a new tab.
            if (onBoard) window.open(linkFor(alert.action), "_blank", "noopener");
            else location.href = linkFor(alert.action);
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

// ── keeping tournaments moving ───────────────────────────────────────────────

async function nudge() {
    if (!run.uid || run.nudging || onTournamentsPage) return;   // that page does its own
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
        const service = await import("./firebase/tournamentService.js?v=tour-8");
        for (const t of due) {
            run.nudgedAt.set(t.id, Date.now());
            try { await service.syncTournament(t.id, run.uid); }
            catch (error) { console.warn("Tournament update failed:", error); }
        }
    } finally { run.nudging = false; }
}

// ── start / stop ─────────────────────────────────────────────────────────────

export function startTournamentAlerts(uid) {
    if (!uid) { stopTournamentAlerts(); return; }
    if (run.uid === uid && run.unsub) return;
    stopTournamentAlerts();
    run.uid = uid;
    run.unsub = onValue(ref(database, BASE_PATH), (snapshot) => {
        run.list = Object.entries(snapshot.val() || {})
            .map(([id, t]) => ({ ...t, id }))
            .filter(t => t && t.name);
        render();
        nudge();
    }, (error) => console.warn("Tournament alerts unavailable:", error));
    run.refresh = setInterval(render, REFRESH_MS);
    run.nudge = setInterval(nudge, NUDGE_MS);
}

export function stopTournamentAlerts() {
    if (run.unsub) { try { run.unsub(); } catch { /* already gone */ } }
    clearInterval(run.refresh);
    clearInterval(run.nudge);
    clearTimeout(run.minimizeTimer);
    run.uid = "";
    run.list = [];
    run.unsub = null;
    const box = document.getElementById("ccTnAlerts");
    if (box) box.innerHTML = "";
}

// Dismissed in another tab -> gone here too.
window.addEventListener("storage", (event) => { if (event.key === STORE_KEY) render(); });
// Back on the tab after a while: deadlines may have passed.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); nudge(); } });
