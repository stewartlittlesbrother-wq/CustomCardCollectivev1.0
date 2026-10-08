// Multiplayer tab, inside the main app (index.html). Replaces the separate
// html/multiplayer.html page, so opening Multiplayer is as instant as any other
// tab: same top bar, no page reload, no second card-library download.
//
// Two screens, both drawn into #mpxRoot:
//   home - Quick match ("Find a game": paired with the next player looking),
//          create a room (deck tiles with leader art, Regular / Draft Battle,
//          game clock), join by code or invite link, live games to watch, and a
//          "game in progress - Rejoin" banner.
//   room - the lobby: both players face off with their leaders and ready lights,
//          deck panel with the Ready button, lobby chat, code + invite link.
//
// This page doesn't load the game's card database, so it never deals: once both
// players are ready, both browsers go to the board and the board deals (the same
// way Draft Battle has always started).
//
// app.js loads this module the first time the Multiplayer tab opens and calls
// show() every time it does; window.ccMpHost (set by app.js) shares the card pool
// and its art helpers.

import { signInGuest, waitForUser, database } from "../firebase/firebaseApp.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
    createRoom,
    joinRoom,
    subscribeToMatch,
    subscribeToActiveGames,
    setPlayerDeck,
    setPlayerReady,
    clearMatchStartError,
    sendChatMessage,
    subscribeToChat,
    getMatchRecord,
    findQuickMatch,
    keepQuickMatchAlive,
    cancelQuickMatch,
    subscribeToQuickMatch
} from "../firebase/multiplayerService.js?v=quick-1";

const host = window.ccMpHost || {};

const KEYS = {
    name: "cc_mp_nickname",
    game: "cc_mp_current_game",     // the online game this browser is in (for Rejoin)
    deck: "cc_mp_last_deck",
    timer: "cc_mp_turn_timer",      // (old per-turn timer, no longer offered)
    clock: "cc_mp_game_clock"       // game clock minutes per player ("0" = off)
};
const DON_DECKS_KEY = "custom-don-decks-v1";
const DON_ACTIVE_DECK_KEY = "custom-don-active-deck-v1";
const ANY_SIZE_KEY = "custom-cards-allow-any-deck-size-v1";
const SFX_MUTED_KEY = "custom-cards-sim-sfx-muted-v1";
const CARD_BACK = "images/basic/card-back-custom.png";
// Game clock: each player's own time for the whole game (a chess clock - it only runs
// on your own turn, and whoever runs out loses). Minutes; 0 = no clock.
const CLOCK_OPTIONS = [[0, "Off"], [10, "10 min each"], [15, "15 min each"], [18, "18 min each"], [20, "20 min each"], [25, "25 min each"], [30, "30 min each"], [45, "45 min each"], [60, "60 min each"]];
const DEFAULT_CLOCK_MINUTES = 18;
function savedClockMinutes() {
    const raw = lsGet(KEYS.clock);
    if (raw === null || raw === undefined || raw === "") return DEFAULT_CLOCK_MINUTES;
    const n = Number(raw);
    return CLOCK_OPTIONS.some(([m]) => m === n) ? n : DEFAULT_CLOCK_MINUTES;
}
const REJOIN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const ICON = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>',
    link: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"></path><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"></path></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"></path><path d="M12 10v4"></path><path d="M12 17h.01"></path></svg>'
};

// ── Small helpers ────────────────────────────────────────────────────────────
const $ = (selector, scope = document) => scope.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not saved */ } };
const lsRemove = (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } };
const lsJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
const cleanCode = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
const artPrefKey = (value) => String(value).replace(/[.#$/\[\]]/g, "-");
const prettySlug = (slug) => String(slug || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function extractCode(raw) {
    const text = String(raw || "").trim();
    const fromLink = text.match(/[?&](?:join|room)=([A-Za-z0-9_-]+)/);
    return cleanCode(fromLink ? fromLink[1] : text);
}

function inviteLink(code) {
    return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
}

function accountName() {
    try { return (window.ccAccount && window.ccAccount.user && window.ccAccount.user.displayName) || ""; } catch { return ""; }
}
function nickname() {
    return String(lsGet(KEYS.name) || accountName() || "Player").trim().slice(0, 24) || "Player";
}

function poolLoaded() {
    return Boolean(host.state && !host.state.cardsLoading);
}

// ── State ────────────────────────────────────────────────────────────────────
let root = null;
let started = false;
let user = null;
let connState = "connecting";
let screen = "home";
let createMode = "regular";
let selectedDeckId = lsGet(KEYS.deck) || "";
let liveGames = [];
let liveError = "";
let unsubLive = null;
let record = null;
let rejoinCode = "";       // the game in the Rejoin banner (not repeated under Live games)

// Room
let room = null;          // { code, slot }
let match = null;         // latest lobby snapshot (status, players, mode, tournament, ...)
let unsubMatch = null;
let unsubChat = null;
let chatSeen = new Set();
let tournamentMeta = null;
let lockedDeck = null;
let lockedDeckRequested = false;
let panelKind = "";
let startTimer = null;
let navigating = false;
let busy = false;
let prevFoe = { known: false, present: false, ready: false };
let handledStartError = "";
// Quick match: { code, waiting, since, opponent } while in a Quick match room.
let quick = null;
let quickTicker = null;     // 1 s: the "looking for…" timer
let quickHeartbeat = null;  // 25 s: keeps our waiting spot fresh
let quickLive = { waiting: false };
let unsubQuick = null;

// ── Entry point ──────────────────────────────────────────────────────────────
// Open a room from elsewhere in the app (the Tournaments tab's "Play" button).
// The host has already put ?room=&slot= in the URL, which boot() reads the first time.
export function enterRoom(code, slot) {
    const clean = cleanCode(code);
    if (!clean) return;
    if (!started) { show(); return; }
    root = document.getElementById("mpxRoot");
    openRoom(clean, slot === "p2" ? "p2" : "p1");
}

export function show() {
    root = document.getElementById("mpxRoot");
    if (!root) return;
    if (!started) {
        started = true;
        boot();
        return;
    }
    refreshArt();
}

async function boot() {
    document.addEventListener("cc-account-change", () => {
        user = null;
        record = null;
        renderWhoami();
        ensureUser().then(() => refreshRecord());
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) stopTitleFlash(); });
    // Back from the board with the browser's Back button: the page can come back
    // from the browser's cache mid-navigation, with the room disconnected.
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted || !navigating || !room) return;
        navigating = false;
        openRoom(room.code, room.slot);
    });

    const params = new URLSearchParams(location.search);
    const joinCode = cleanCode(params.get("join"));
    const roomCode = cleanCode(params.get("room"));

    renderHome();
    waitForCardPool();
    const signedIn = await ensureUser();
    refreshRecord();
    if (!signedIn) return;

    // A room from the URL: a tournament match, a "back to the room" link from the
    // board, or this page reloaded while in a room. An invite link (?join=).
    if (roomCode) await joinByCode(roomCode);
    else if (joinCode) await joinByCode(joinCode);
}

async function ensureUser() {
    if (user) return user;
    setConn("connecting");
    try {
        await signInGuest();
        user = await waitForUser();
        setConn("ok");
        return user;
    } catch (error) {
        console.warn("Multiplayer sign-in failed:", error);
        setConn("bad");
        return null;
    }
}

function setConn(next) {
    connState = next;
    renderWhoami();
}

// The card pool (leader art) finishes loading in the background; repaint once it has.
// (The shared library arrives after the bundled cards, so wait for both - it is
// where most leaders and the Draft Battle card pools come from.)
function waitForCardPool() {
    const settled = () => poolLoaded() && !host.state?.sharedSyncing;
    if (settled()) return;
    let tries = 0;
    const timer = setInterval(() => {
        tries += 1;
        if (!settled() && tries < 120) return;
        clearInterval(timer);
        refreshArt();
    }, 500);
}

function refreshArt() {
    if (!root) return;
    if (screen === "home") {
        renderCreateBody();
        renderLive();
        renderWhoami();
    } else {
        renderVersus();
        renderRoomCheck();
    }
}

// ── Decks (this device's saved decks) ────────────────────────────────────────
function lobbyDecks() {
    const all = typeof window.getAvailableDecks === "function" ? window.getAvailableDecks() : [];
    return all.filter((deck) => String(deck.id).startsWith("saved-"));
}

function findDeck(id) {
    return lobbyDecks().find((deck) => deck.id === id) || null;
}

function leaderCard(key) {
    if (!key || typeof host.getCard !== "function") return null;
    return host.getCard(key) || (host.state?.cards || []).find((card) => card.cardNumber === key) || null;
}

function deckStats(deck) {
    let count = 0;
    let missing = 0;
    String(deck?.deckText || "").split("\n").forEach((line) => {
        const m = line.trim().match(/^(\d+)x(.+)$/i);
        if (!m) return;
        const qty = Number(m[1]) || 0;
        count += qty;
        if (poolLoaded() && !leaderCard(m[2].trim())) missing += qty;
    });
    const leader = leaderCard(deck?.leaderKey);
    const leader2 = deck?.leaderKey2 ? leaderCard(deck.leaderKey2) : null;
    const anySize = lsGet(ANY_SIZE_KEY) === "1";
    let problem = "";
    let blocking = false;
    if (!deck?.leaderKey) { problem = "No leader"; blocking = true; }
    else if (poolLoaded() && !leader) { problem = "Leader not found"; blocking = true; }
    else if (!anySize && count !== 50) problem = count < 50 ? `${count}/50 - ${50 - count} short` : `${count}/50 - ${count - 50} too many`;
    else if (missing) problem = `${missing} card${missing === 1 ? "" : "s"} not found`;
    return {
        count,
        anySize,
        leader,
        leader2,
        problem,
        blocking,
        starters: Array.isArray(deck?.startingCards) ? deck.startingCards.length : 0,
        tokens: Array.isArray(deck?.tokens) ? deck.tokens.length : 0
    };
}

function checkLine(stats) {
    if (stats.blocking) return `<div class="mpx-check bad-text">${ICON.warn}<span>${esc(stats.problem)} - fix it in the Deck Builder</span></div>`;
    if (stats.problem) return `<div class="mpx-check warn-text">${ICON.warn}<span>${esc(stats.problem)}</span></div>`;
    return `<div class="mpx-check ok-text">${ICON.check}<span>Deck check passed - ready to play</span></div>`;
}

function deckChips(stats) {
    return `<div class="mpx-chips">
        <span class="mpx-chip">${stats.count}${stats.anySize ? "" : "/50"} cards</span>
        <span class="mpx-chip">${stats.starters ? `${stats.starters} start in play` : "No start-in-play cards"}</span>
        <span class="mpx-chip">${stats.tokens ? `${stats.tokens} token type${stats.tokens === 1 ? "" : "s"}` : "No tokens"}</span>
    </div>`;
}

// Leader art. `artPrefs` = the OWNER's alt-art picks (another player's leader);
// without it the card shows in this device's own pick.
function artHtml(card, artPrefs) {
    if (!card) return `<img src="${CARD_BACK}" alt="">`;
    if (artPrefs && typeof host.cardArtList === "function") {
        const list = host.cardArtList(card);
        const idx = Number(artPrefs[artPrefKey(card.cardNumber || card.id)]) || 0;
        if (list[idx]) return `<img src="${esc(list[idx])}" alt="${esc(card.name)}">`;
    }
    if (typeof host.cardVisual === "function") return host.cardVisual(card);
    return `<img src="${esc(card.imageUrl || card.image || CARD_BACK)}" alt="${esc(card.name)}">`;
}

function paintLazy(scope) {
    if (typeof host.observeLazyImages === "function") host.observeLazyImages(scope);
}

function donOptions() {
    let list = [];
    try { list = JSON.parse(lsGet(DON_DECKS_KEY) || "[]"); } catch { list = []; }
    list = Array.isArray(list) ? list.filter((d) => d && Array.isArray(d.cards) && d.cards.length) : [];
    const active = lsGet(DON_ACTIVE_DECK_KEY) || "";
    return [`<option value="">Standard DON!! (10)</option>`]
        .concat(list.map((d) => `<option value="${esc(d.id)}"${d.id === active ? " selected" : ""}>${esc(d.name || "DON!! deck")} (${d.cards.length})</option>`))
        .join("");
}

function wireDonSelects(scope) {
    scope.querySelectorAll("select[data-don]").forEach((select) => {
        select.addEventListener("change", () => {
            if (select.value) lsSet(DON_ACTIVE_DECK_KEY, select.value);
            else lsRemove(DON_ACTIVE_DECK_KEY);
            window.ccSyncPush?.(DON_ACTIVE_DECK_KEY);
        });
    });
}

// ── Home screen ──────────────────────────────────────────────────────────────
function renderHome() {
    screen = "home";
    const clock = savedClockMinutes();
    root.innerHTML = `
    <div class="mpx-page">
      <div class="mpx-head">
        <div>
          <h1>Multiplayer</h1>
          <p>Play a live match with a friend, or watch one.</p>
        </div>
        <div class="mpx-whoami" id="mpxWho"></div>
      </div>

      <section class="mpx-rejoin" id="mpxRejoin" aria-label="Game in progress" hidden></section>

      <section class="mpx-card green mpx-quick" aria-labelledby="mpxQuickTitle">
        <div class="mpx-quick-text">
          <h2 id="mpxQuickTitle"><span aria-hidden="true">⚡</span> Quick match</h2>
          <p>Get paired with the next player looking for a game — no code needed. You play the deck picked below, with an 18-minute game clock each.</p>
          <p class="mpx-quick-live" id="mpxQuickLive" hidden></p>
          <p class="mpx-error" id="mpxQuickError" hidden></p>
        </div>
        <button type="button" class="mpx-btn primary big" id="mpxQuick">Find a game</button>
      </section>

      <div class="mpx-cols">
        <section class="mpx-card green mpx-main" aria-labelledby="mpxCreateTitle">
          <div class="mpx-cardhead">
            <h2 id="mpxCreateTitle">Create a room</h2>
            <div class="mpx-seg" role="group" aria-label="Match type">
              <button type="button" data-mode="regular">Regular match</button>
              <button type="button" data-mode="draft">Draft Battle</button>
            </div>
          </div>
          <div id="mpxCreateBody" style="display:flex;flex-direction:column;gap:14px"></div>
          <p class="mpx-error" id="mpxCreateError" hidden></p>
          <div class="mpx-foot">
            <div class="mpx-row" style="flex:1 1 380px">
              <label class="mpx-field">Room name<input id="mpxRoomName" type="text" maxlength="40" value="${esc(`${nickname()}'s game`)}"></label>
              <label class="mpx-field" style="max-width:200px" title="Each player gets this much time for the whole game. It only runs on your own turn - run out and you lose.">Game clock
                <select id="mpxClock">${CLOCK_OPTIONS.map(([min, label]) => `<option value="${min}"${min === clock ? " selected" : ""}>${label}</option>`).join("")}</select>
              </label>
            </div>
            <button type="button" class="mpx-btn primary big" id="mpxCreate">Create room</button>
          </div>
        </section>

        <div class="mpx-side">
          <section class="mpx-card green" aria-labelledby="mpxJoinTitle">
            <h2 id="mpxJoinTitle">Join a room</h2>
            <form class="mpx-joinrow" id="mpxJoinForm">
              <input class="mpx-input mpx-codeinput" id="mpxCode" placeholder="e.g. 7B3XG1" autocomplete="off" aria-label="Room code or invite link">
              <button type="submit" class="mpx-btn outline">Join</button>
            </form>
            <p class="mpx-error" id="mpxJoinError" hidden></p>
            <p class="mpx-hint">Type the room code, or paste the invite link your friend sent. Opening an invite link joins you straight away.</p>
          </section>

          <section class="mpx-card" aria-labelledby="mpxLiveTitle">
            <div class="mpx-cardhead">
              <h2 id="mpxLiveTitle">Live games</h2>
              <span class="mpx-count" id="mpxLiveCount">0</span>
            </div>
            <div class="mpx-live" id="mpxLive"><p class="mpx-hint">Loading…</p></div>
          </section>
        </div>
      </div>
    </div>`;

    root.querySelectorAll(".mpx-seg [data-mode]").forEach((button) => {
        button.addEventListener("click", () => {
            createMode = button.dataset.mode;
            renderCreateBody();
        });
    });
    $("#mpxCreate", root).addEventListener("click", onCreate);
    $("#mpxQuick", root).addEventListener("click", onQuickMatch);
    watchQuick();
    renderQuickLive();
    $("#mpxJoinForm", root).addEventListener("submit", (event) => {
        event.preventDefault();
        joinByCode($("#mpxCode", root).value);
    });

    renderWhoami();
    renderCreateBody();
    watchLive();
    renderLive();
    checkRejoin();
}

function renderWhoami() {
    const box = root && $("#mpxWho", root);
    if (!box) return;
    const conn = connState === "ok"
        ? `<span class="mpx-pill ok"><span class="mpx-dot"></span>Connected</span>`
        : connState === "bad"
            ? `<span class="mpx-pill bad"><span class="mpx-dot"></span>Can't connect</span>`
            : `<span class="mpx-pill"><span class="mpx-dot"></span>Connecting…</span>`;
    const rec = record && (record.wins || record.losses)
        ? `<span class="mpx-pill record" title="Your online record on this account">Record ${Number(record.wins || 0)}W - ${Number(record.losses || 0)}L</span>`
        : "";
    box.innerHTML = `
        <span>Playing as <strong>${esc(nickname())}</strong></span>
        <button type="button" class="mpx-link" id="mpxRename">Change</button>
        ${rec}${conn}`;
    $("#mpxRename", box).addEventListener("click", () => {
        box.innerHTML = `<form class="mpx-rename" id="mpxRenameForm">
            <input class="mpx-input" id="mpxNameInput" maxlength="24" value="${esc(nickname())}" aria-label="Your name in games">
            <button type="submit" class="mpx-btn outline">Save</button></form>`;
        const input = $("#mpxNameInput", box);
        input.focus();
        input.select();
        $("#mpxRenameForm", box).addEventListener("submit", (event) => {
            event.preventDefault();
            const value = input.value.trim().slice(0, 24);
            if (value) lsSet(KEYS.name, value);
            const roomName = root && $("#mpxRoomName", root);
            if (roomName && /'s game$/.test(roomName.value)) roomName.value = `${nickname()}'s game`;
            renderWhoami();
        });
    });
}

async function refreshRecord() {
    const u = user;
    if (!u || u.isAnonymous) { record = null; renderWhoami(); return; }
    record = await getMatchRecord(u.uid);
    renderWhoami();
}

function renderCreateBody() {
    const body = root && $("#mpxCreateBody", root);
    if (!body) return;
    root.querySelectorAll(".mpx-seg [data-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.mode === createMode));
    });

    if (createMode === "draft") {
        const previousPool = $("#mpxPool", root)?.value || "";
        body.innerHTML = `
          <p class="mpx-hint" style="font-size:.92rem;color:var(--mpx-soft)">Both players open packs from the same card pool, then race to build a deck on a shared timer.</p>
          <div class="mpx-row">
            <label class="mpx-field">Card pool<select id="mpxPool">${poolOptions()}</select></label>
          </div>
          <div class="mpx-chips">
            <span class="mpx-chip">10 packs each</span>
            <span class="mpx-chip">15 minutes to build</span>
            <span class="mpx-chip">40-card decks</span>
          </div>`;
        const pool = $("#mpxPool", body);
        if (pool && previousPool) pool.value = previousPool;
        return;
    }

    const decks = lobbyDecks();
    if (!decks.length) {
        body.innerHTML = `
          <div class="mpx-empty">
            <b>You don't have a saved deck yet.</b>
            <span>Build one in the Deck Builder, give it a name and press Save.</span>
            <button type="button" class="mpx-btn outline" data-goto-builder>Open the Deck Builder</button>
          </div>`;
        wireBuilderLinks(body);
        return;
    }

    if (!decks.some((deck) => deck.id === selectedDeckId)) {
        const firstPlayable = decks.find((deck) => !deckStats(deck).blocking) || decks[0];
        selectedDeckId = firstPlayable.id;
    }
    const selected = findDeck(selectedDeckId);
    body.innerHTML = `
      <div class="mpx-cardhead">
        <h3>Pick a deck</h3>
        <button type="button" class="mpx-link" data-goto-builder>Open the Deck Builder</button>
      </div>
      <div class="mpx-decks">${decks.map(tileHtml).join("")}</div>
      <div class="mpx-summary">${summaryHtml(selected)}</div>`;

    body.querySelectorAll("[data-deck]").forEach((tile) => {
        tile.addEventListener("click", () => {
            selectedDeckId = tile.dataset.deck;
            lsSet(KEYS.deck, selectedDeckId);
            renderCreateBody();
        });
    });
    wireBuilderLinks(body);
    wireDonSelects(body);
    paintLazy(body);
}

function tileHtml(deck) {
    const stats = deckStats(deck);
    const cls = stats.blocking ? "bad-text" : (stats.problem ? "warn-text" : "ok-text");
    return `<button type="button" class="mpx-deck" data-deck="${esc(deck.id)}" aria-pressed="${deck.id === selectedDeckId}">
        <div class="mpx-art">${artHtml(stats.leader)}</div>
        <b>${esc(deck.name)}</b>
        <small class="${cls}">${esc(stats.problem || "Ready to play")}</small>
    </button>`;
}

function summaryHtml(deck) {
    if (!deck) return "";
    const stats = deckStats(deck);
    const leaderName = stats.leader ? stats.leader.name : (deck.leaderKey || "No leader");
    const leader2 = deck.leaderKey2 ? ` + ${stats.leader2 ? stats.leader2.name : deck.leaderKey2}` : "";
    return `
        <div class="mpx-art">${artHtml(stats.leader)}</div>
        <div class="mpx-summary-body">
          <div>
            <div class="mpx-summary-title">${esc(deck.name)}</div>
            <div class="mpx-summary-sub">Leader: ${esc(leaderName)}${esc(leader2)}</div>
          </div>
          ${deckChips(stats)}
          ${checkLine(stats)}
          <div class="mpx-row">
            <label class="mpx-field" style="max-width:260px">DON!! deck<select data-don>${donOptions()}</select></label>
          </div>
        </div>`;
}

function poolOptions() {
    const list = typeof host.collections === "function" ? host.collections() : [];
    return `<option value="">All cards</option>` +
        list.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}${c.count ? ` (${c.count})` : ""}</option>`).join("");
}

function collectionName(slug) {
    const list = typeof host.collections === "function" ? host.collections() : [];
    const hit = list.find((c) => c.slug === slug);
    return hit ? hit.name : prettySlug(slug);
}

function wireBuilderLinks(scope) {
    scope.querySelectorAll("[data-goto-builder]").forEach((button) => {
        button.addEventListener("click", () => host.showView?.("builder"));
    });
}

function showError(id, message) {
    const box = root && $(id, root);
    if (!box) return;
    box.textContent = message || "";
    box.hidden = !message;
}

async function onCreate() {
    showError("#mpxCreateError", "");
    const button = $("#mpxCreate", root);
    let deck = null;
    if (createMode === "regular") {
        deck = findDeck(selectedDeckId);
        if (!deck) { showError("#mpxCreateError", "Pick a deck first - or build and save one in the Deck Builder."); return; }
        const stats = deckStats(deck);
        if (stats.blocking) { showError("#mpxCreateError", `${deck.name}: ${stats.problem}. Fix it in the Deck Builder, or pick another deck.`); return; }
    }
    const u = await ensureUser();
    if (!u) { showError("#mpxCreateError", "Couldn't connect. Check your internet connection and try again."); return; }

    button.disabled = true;
    button.textContent = "Creating…";
    try {
        const clockMinutes = Number($("#mpxClock", root)?.value) || 0;
        lsSet(KEYS.clock, String(clockMinutes));
        const lobbyName = ($("#mpxRoomName", root)?.value || "").trim().slice(0, 40) || `${nickname()}'s game`;
        const created = await createRoom(u, {
            isPublic: false,
            lobbyName,
            nickname: nickname(),
            mode: createMode,
            draftCollection: createMode === "draft" ? ($("#mpxPool", root)?.value || "") : "",
            settings: clockMinutes ? { clockSeconds: clockMinutes * 60 } : null
        });
        openRoom(created.roomCode, "p1");
    } catch (error) {
        showError("#mpxCreateError", error?.message || "Couldn't create the room.");
        button.disabled = false;
        button.textContent = "Create room";
    }
}

// ── Quick match ──────────────────────────────────────────────────────────────
// Reading the waiting spot needs a signed-in player, so wait for sign-in first (a
// listener refused for not being signed in never comes back).
let quickWatchStarting = false;
async function watchQuick() {
    if (unsubQuick || quickWatchStarting) return;
    quickWatchStarting = true;
    try {
        if (!(await ensureUser())) return;
        unsubQuick = subscribeToQuickMatch((info) => {
            quickLive = info || { waiting: false };
            if (screen === "home") renderQuickLive();
        });
    } finally { quickWatchStarting = false; }
}

function renderQuickLive() {
    const line = root && $("#mpxQuickLive", root);
    if (!line) return;
    const someone = quickLive.waiting && (!user || quickLive.uid !== user.uid);
    line.hidden = !someone;
    if (someone) line.innerHTML = `<span class="mpx-dot"></span> ${esc(quickLive.name || "Someone")} is looking for a game right now — press Find a game to play them.`;
}

async function onQuickMatch() {
    showError("#mpxQuickError", "");
    const button = $("#mpxQuick", root);
    const deck = findDeck(selectedDeckId);
    if (!deck) {
        if (createMode !== "regular") { createMode = "regular"; renderCreateBody(); }
        showError("#mpxQuickError", "Pick a deck below first - or build and save one in the Deck Builder.");
        return;
    }
    const stats = deckStats(deck);
    if (stats.blocking) { showError("#mpxQuickError", `${deck.name}: ${stats.problem}. Fix it in the Deck Builder, or pick another deck below.`); return; }
    const u = await ensureUser();
    if (!u) { showError("#mpxQuickError", "Couldn't connect. Check your internet connection and try again."); return; }

    button.disabled = true;
    button.textContent = "Finding a game…";
    try {
        const found = await findQuickMatch(u, nickname());
        quick = { code: found.code, waiting: found.waiting, since: Date.now(), opponent: found.opponent || "" };
        openRoom(found.code, found.slot);
    } catch (error) {
        showError("#mpxQuickError", /permission|denied/i.test(error?.message || "")
            ? "Quick match isn't available right now - make a room and share the code instead."
            : (error?.message || "Couldn't find a game right now - try again."));
        button.disabled = false;
        button.textContent = "Find a game";
    }
}

function stopQuickTimers() {
    clearInterval(quickTicker);
    clearInterval(quickHeartbeat);
    quickTicker = null;
    quickHeartbeat = null;
}

// The banner at the top of a Quick match room: "looking for an opponent" with a
// timer and Cancel, then "paired with …" once someone has joined.
function renderQuickBanner() {
    const banner = root && $("#mpxQuickBanner", root);
    if (!banner) return;
    if (!quick || !room || quick.code !== room.code) { banner.hidden = true; stopQuickTimers(); return; }
    banner.hidden = false;
    const foe = foePlayer();
    if (quick.waiting && !foe) {
        const secs = Math.max(0, Math.floor((Date.now() - quick.since) / 1000));
        const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
        banner.className = "mpx-banner mpx-quickbanner searching";
        banner.innerHTML = `<div><strong><span class="mpx-spinner" aria-hidden="true"></span> Looking for an opponent… <span class="mpx-quicktime">${clock}</span></strong>
            <span>You'll be paired with the next player who presses Find a game. Keep this tab open - pick your deck and press Ready while you wait.</span></div>
            <button type="button" class="mpx-btn" id="mpxQuickCancel">Cancel</button>`;
        $("#mpxQuickCancel", banner).addEventListener("click", cancelQuick);
        if (!quickTicker) quickTicker = setInterval(() => {
            const time = root && $(".mpx-quicktime", root);
            if (!time || !quick) return;
            const s2 = Math.max(0, Math.floor((Date.now() - quick.since) / 1000));
            time.textContent = `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`;
        }, 1000);
        if (!quickHeartbeat) quickHeartbeat = setInterval(() => {
            if (quick && quick.waiting && user) keepQuickMatchAlive(user, quick.code).catch(() => {});
        }, 25000);
        return;
    }
    stopQuickTimers();
    if (quick.waiting) quick.waiting = false;
    const name = (foe && foe.name) || quick.opponent || "your opponent";
    banner.className = "mpx-banner mpx-quickbanner found";
    banner.innerHTML = `<div><strong>⚡ Quick match — you're playing ${esc(name)}</strong>
        <span>Pick your deck and press Ready. 18-minute game clock each.</span></div>`;
}

async function cancelQuick() {
    const leaving = quick;
    quick = null;
    stopQuickTimers();
    if (leaving && leaving.waiting && user) await cancelQuickMatch(user, leaving.code).catch(() => {});
    leaveRoomQuietly();
    room = null;
    match = null;
    setRoomUrl(null);
    renderHome();
}

async function joinByCode(raw) {
    const code = extractCode(raw);
    if (screen !== "home") renderHome();
    showError("#mpxJoinError", "");
    if (!code) { showError("#mpxJoinError", "Enter a room code first."); return; }
    const u = await ensureUser();
    if (!u) { showError("#mpxJoinError", "Couldn't connect. Check your internet connection and try again."); return; }
    try {
        // Already in this room? You just get your seat back.
        const joined = await joinRoom(code, u, nickname());
        openRoom(joined.code, joined.slot);
    } catch (error) {
        setRoomUrl(null);
        if (screen !== "home") renderHome();
        const input = $("#mpxCode", root);
        if (input) input.value = code;
        showError("#mpxJoinError", error?.message || "Couldn't join that room.");
    }
}

// ── Live games ───────────────────────────────────────────────────────────────
function watchLive() {
    if (unsubLive) return;
    unsubLive = subscribeToActiveGames((games) => {
        liveGames = games || [];
        liveError = "";
        if (screen === "home") renderLive();
    }, (error) => {
        liveError = /permission|denied/i.test(error?.message || "")
            ? "Live games can't be listed until the database rules are published."
            : "Couldn't load live games right now.";
        if (screen === "home") renderLive();
    });
}

function gameMeta(game) {
    const phase = game.phase || "";
    if (phase === "gameOver") return "Just finished";
    if (phase === "diceRoll" || phase === "mulligan" || phase === "waiting" || !Number(game.turnNumber)) return "Setting up";
    return `Turn ${Number(game.turnNumber)}`;
}

function renderLive() {
    const list = root && $("#mpxLive", root);
    if (!list) return;
    const others = liveGames.filter((game) => game.roomCode !== room?.code && game.roomCode !== rejoinCode);
    const count = $("#mpxLiveCount", root);
    if (count) count.textContent = String(others.length);
    if (liveError) { list.innerHTML = `<p class="mpx-hint">${esc(liveError)}</p>`; return; }
    if (!others.length) { list.innerHTML = `<p class="mpx-hint">No games in progress right now.</p>`; return; }
    list.innerHTML = others.map((game) => `
        <div class="mpx-game">
          <div class="mpx-pair">
            <div class="mpx-art">${artHtml(leaderCard(game.p1Leader))}</div>
            <div class="mpx-art">${artHtml(leaderCard(game.p2Leader))}</div>
          </div>
          <div class="mpx-game-text">
            <b>${esc(game.p1Name || "Player 1")} vs ${esc(game.p2Name || "Player 2")}</b>
            <span>${esc(gameMeta(game))}</span>
          </div>
          <a class="mpx-btn" style="text-decoration:none" href="html/self.html?mode=online&room=${encodeURIComponent(game.roomCode)}&spectate=1">${ICON.eye} Watch</a>
        </div>`).join("");
    paintLazy(list);
}

// ── "Game in progress - Rejoin" ──────────────────────────────────────────────
async function checkRejoin() {
    const saved = lsJson(KEYS.game);
    if (!saved || !saved.code || (saved.slot !== "p1" && saved.slot !== "p2")) return;
    if (Date.now() - Number(saved.at || 0) > REJOIN_MAX_AGE_MS) { lsRemove(KEYS.game); return; }
    const u = await ensureUser();
    if (!u) return;
    try {
        const base = `matches/${saved.code}`;
        const [playersSnap, statusSnap, phaseSnap, turnSnap] = await Promise.all([
            get(ref(database, `${base}/players`)),
            get(ref(database, `${base}/status`)),
            get(ref(database, `${base}/public/phase`)),
            get(ref(database, `${base}/public/turnNumber`))
        ]);
        const players = playersSnap.val() || {};
        const me = players[saved.slot];
        const foe = players[saved.slot === "p1" ? "p2" : "p1"];
        const phase = phaseSnap.val();
        if (!statusSnap.exists() || phase === "gameOver") { lsRemove(KEYS.game); return; }
        if (!me || me.uid !== u.uid || statusSnap.val() !== "started" || !phase) return;

        const box = root && $("#mpxRejoin", root);
        if (screen !== "home" || !box) return;
        const turn = Number(turnSnap.val()) || 0;
        const where = phase === "main" && turn ? `Turn ${turn}` : "Setting up";
        box.innerHTML = `
          <div class="mpx-pair">
            <div class="mpx-art">${artHtml(leaderCard(me.deck?.leaderKey))}</div>
            <div class="mpx-art">${artHtml(leaderCard(foe?.deck?.leaderKey), foe?.artPrefs || {})}</div>
          </div>
          <div class="mpx-rejoin-text">
            <strong>You have a game in progress</strong>
            <span>vs ${esc(foe?.name || "your opponent")} · ${esc(where)} · Room ${esc(saved.code)}</span>
          </div>
          <a class="mpx-btn gold" style="text-decoration:none" href="html/self.html?mode=online&room=${encodeURIComponent(saved.code)}&player=${saved.slot}">Rejoin game</a>`;
        box.hidden = false;
        paintLazy(box);
        rejoinCode = saved.code;
        renderLive();
    } catch (error) {
        console.warn("Couldn't check for a game in progress:", error);
    }
}

// ── Room lobby ───────────────────────────────────────────────────────────────
function openRoom(code, slot) {
    if (quick && quick.code !== code) { quick = null; stopQuickTimers(); }
    leaveRoomQuietly();
    room = { code, slot };
    match = null;
    chatSeen = new Set();
    tournamentMeta = null;
    lockedDeck = null;
    lockedDeckRequested = false;
    panelKind = "";
    navigating = false;
    busy = false;
    prevFoe = { known: false, present: false, ready: false };
    handledStartError = "";
    setRoomUrl(code, slot);
    renderRoom();
    unsubMatch = subscribeToMatch(code, onMatch);
    unsubChat = subscribeToChat(code, onChat);
}

function leaveRoomQuietly() {
    unsubMatch?.();
    unsubChat?.();
    unsubMatch = null;
    unsubChat = null;
    clearTimeout(startTimer);
    startTimer = null;
}

function setRoomUrl(code, slot) {
    try {
        const url = new URL(location.href);
        url.searchParams.delete("join");
        url.searchParams.set("view", "multiplayer");
        if (code) {
            url.searchParams.set("room", code);
            url.searchParams.set("slot", slot);
        } else {
            url.searchParams.delete("room");
            url.searchParams.delete("slot");
        }
        history.replaceState(null, "", url.toString());
    } catch { /* cosmetic */ }
}

const otherSlot = () => (room?.slot === "p1" ? "p2" : "p1");
const myPlayer = () => match?.players?.[room?.slot] || null;
const foePlayer = () => match?.players?.[otherSlot()] || null;
const isDraftRoom = () => match?.mode === "draft" || tournamentMeta?.matchType === "draft";

function renderRoom() {
    screen = "room";
    root.innerHTML = `
    <div class="mpx-page">
      <div class="mpx-roomhead">
        <div class="mpx-roomtitle">
          <button type="button" class="mpx-link mpx-back" id="mpxLeave">← Leave room</button>
          <h1 id="mpxRoomTitle">Room ${esc(room.code)}</h1>
          <div class="mpx-chips" id="mpxRoomChips"></div>
        </div>
        <div class="mpx-codebox">
          <div><span class="mpx-codelabel">Room code</span><b class="mpx-codevalue">${esc(room.code)}</b></div>
          <div class="mpx-codebox-actions">
            <button type="button" class="mpx-btn" id="mpxCopyCode">${ICON.copy}<span>Copy code</span></button>
            <button type="button" class="mpx-btn primary" id="mpxCopyLink">${ICON.link}<span>Copy invite link</span></button>
          </div>
        </div>
      </div>

      <div class="mpx-banner mpx-quickbanner" id="mpxQuickBanner" hidden></div>
      <div class="mpx-banner" id="mpxTourBanner" hidden></div>
      <div class="mpx-starting" id="mpxStarting" role="status" hidden>
        <strong>Both players are ready - starting the game…</strong>
        <div class="mpx-bar"><i></i></div>
      </div>
      <p class="mpx-error" id="mpxRoomError" hidden></p>

      <section class="mpx-versus" id="mpxVersus" aria-label="Players"></section>

      <div class="mpx-cols2">
        <section class="mpx-card green" id="mpxDeckPanel" aria-labelledby="mpxDeckTitle"></section>
        <section class="mpx-card" aria-labelledby="mpxChatTitle">
          <h2 id="mpxChatTitle">Lobby chat</h2>
          <div class="mpx-chatlog" id="mpxChatLog" aria-live="polite"><div class="sys">Messages here carry on into the game.</div></div>
          <form class="mpx-chatform" id="mpxChatForm">
            <input class="mpx-input" id="mpxChatInput" maxlength="300" placeholder="Say something…" aria-label="Chat message" autocomplete="off">
            <button type="submit" class="mpx-btn">Send</button>
          </form>
        </section>
      </div>
    </div>`;

    $("#mpxLeave", root).addEventListener("click", leaveRoom);
    $("#mpxCopyCode", root).addEventListener("click", (event) => copyText(room.code, event.currentTarget));
    $("#mpxCopyLink", root).addEventListener("click", (event) => copyText(inviteLink(room.code), event.currentTarget));
    $("#mpxChatForm", root).addEventListener("submit", onChatSubmit);

    renderDeckPanel();
    renderVersus();
    renderQuickBanner();
}

async function leaveRoom() {
    const leaving = room;
    const wasReady = Boolean(myPlayer()?.ready);
    const toTournament = Boolean(tournamentMeta);
    // Leaving a Quick match room while still looking gives up the waiting spot.
    if (quick && quick.waiting && leaving && quick.code === leaving.code && user) {
        cancelQuickMatch(user, quick.code).catch(() => {});
    }
    quick = null;
    stopQuickTimers();
    leaveRoomQuietly();
    room = null;
    match = null;
    if (leaving && wasReady) setPlayerReady(leaving.code, leaving.slot, false).catch(() => {});
    setRoomUrl(null);
    renderHome();
    // A tournament match: back to the Tournaments tab (same page, no reload).
    if (toTournament && window.ccMpHost?.showView) window.ccMpHost.showView("tournaments");
}

function onMatch(next) {
    if (!room || screen !== "room" || navigating) return;
    if (!next) {
        showError("#mpxRoomError", "This room doesn't exist any more. Go back and create a new one.");
        return;
    }
    match = next;
    if (match.status === "started") { enterGame(); return; }
    if (match.tournament && !tournamentMeta) applyTournament(match.tournament);

    renderRoomHead();
    renderDeckPanel();
    renderVersus();
    renderReadyState();
    renderQuickBanner();
    notifyFoeChanges();
    handleStartState();
}

function renderRoomHead() {
    const title = $("#mpxRoomTitle", root);
    if (title && match?.lobbyName) title.textContent = match.lobbyName;
    const chips = $("#mpxRoomChips", root);
    if (!chips) return;
    const items = [isDraftRoom() ? "Draft Battle" : "Regular match", match?.quickMatch ? "Quick match" : "Private room"];
    const clockSeconds = Number(match?.settings?.clockSeconds) || 0;
    if (clockSeconds) items.push(`Game clock: ${Math.round(clockSeconds / 60)} min each`);
    if (tournamentMeta) items.push("Tournament");
    chips.innerHTML = items.map((text) => `<span class="mpx-chip">${esc(text)}</span>`).join("");
}

function applyTournament(meta) {
    tournamentMeta = meta;
    const banner = $("#mpxTourBanner", root);
    if (banner) {
        const bestOf = Number(meta.bestOf) || 1;
        const pool = Object.values(meta.collections || {});
        const bans = Object.values(meta.banned || {});
        banner.innerHTML = `<strong>${esc(meta.name || "Tournament")} - Round ${esc(meta.round)}${bestOf > 1 ? ` · Game ${esc(meta.game || 1)} of ${bestOf}` : ""}</strong>
            <span>${meta.format === "swiss" ? "Swiss" : "Single elimination"} · ${meta.matchType === "draft" ? "Draft battle" : "Regular match"} · Card pool: ${esc(pool.length ? pool.map(collectionName).join(", ") : "all collections")}${bans.length ? ` · ${bans.length} banned card${bans.length === 1 ? "" : "s"}` : ""}</span>`;
        banner.hidden = false;
    }
    const leave = $("#mpxLeave", root);
    if (leave) leave.textContent = "← Back to the tournament";
    if (meta.requireDeck && meta.matchType !== "draft") loadRequiredDeck(meta);
}

// A tournament that asked for deck lists: you play the list you submitted.
async function loadRequiredDeck(meta) {
    if (lockedDeckRequested || !user) return;
    lockedDeckRequested = true;
    try {
        const decks = await import("../firebase/tournamentDecks.js?v=tab-1");
        const submitted = await decks.getSubmittedDeck(meta.id, user.uid);
        if (!submitted || !submitted.deck) {
            showError("#mpxRoomError", "You haven't submitted a deck list for this tournament, so you can't play yet. Go back and submit one.");
            return;
        }
        lockedDeck = { ...submitted.deck, name: submitted.name || submitted.deck.name || "Submitted deck" };
        panelKind = "";
        renderDeckPanel();
        pushPreviewDeck();
    } catch (error) {
        lockedDeckRequested = false;
        showError("#mpxRoomError", "Couldn't load your submitted deck list. Check your connection and refresh.");
    }
}

// Cards in a deck that aren't allowed by the tournament ("" = fine).
async function tournamentDeckProblem(deck) {
    const pool = Object.values(tournamentMeta?.collections || {});
    const banned = Object.values(tournamentMeta?.banned || {});
    if (!pool.length && !banned.length) return "";
    try {
        const decks = await import("../firebase/tournamentDecks.js?v=tab-1");
        const result = await decks.checkDeck(deck, { collections: pool, banned, collectionName });
        return result.problems.join(" ");
    } catch {
        return "Couldn't check your deck against the tournament rules right now. Check your connection and try again.";
    }
}

function roomDeck() {
    return lockedDeck || findDeck(selectedDeckId);
}

// For a Dual Leader deck: which of the two leaders sets life and power.
function withStatsLeader(deck) {
    if (!deck || !deck.leaderKey2) return { leaderKey: deck?.leaderKey, leaderKey2: "" };
    const second = $("#mpxStats", root)?.value === "2";
    return second
        ? { leaderKey: deck.leaderKey2, leaderKey2: deck.leaderKey }
        : { leaderKey: deck.leaderKey, leaderKey2: deck.leaderKey2 };
}

function deckPayload(deck) {
    const chosen = withStatsLeader(deck);
    return {
        id: deck.id || "",
        name: deck.name || "Deck",
        leaderKey: chosen.leaderKey || "",
        leaderKey2: chosen.leaderKey2 || "",
        deckText: deck.deckText || "",
        // The deck's "start in play" placements and token types travel with it.
        startingCards: Array.isArray(deck.startingCards) ? deck.startingCards : [],
        tokens: Array.isArray(deck.tokens) ? deck.tokens : []
    };
}

// Your chosen deck goes on the room straight away (not just on Ready), so your
// opponent sees your leader while you're both still picking.
let previewTimer = null;
function pushPreviewDeck() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        if (!room || !match || isDraftRoom()) return;
        // A deck-list tournament only ever shows the submitted list.
        if (tournamentMeta?.requireDeck && !lockedDeck) return;
        const deck = roomDeck();
        if (!deck) return;
        setPlayerDeck(room.code, room.slot, deckPayload(deck)).catch((error) => console.warn("Couldn't share your deck choice:", error));
    }, 250);
}

function renderDeckPanel() {
    const panel = root && $("#mpxDeckPanel", root);
    if (!panel || !room) return;
    // Until the room has loaded we don't know if it's a draft or tournament room.
    if (!match) {
        panel.innerHTML = `<h2 id="mpxDeckTitle">Your deck</h2><p class="mpx-hint">Loading the room…</p>`;
        return;
    }
    const kind = isDraftRoom() ? "draft" : (lockedDeck ? "locked" : "regular");
    if (kind === panelKind) { renderDraftState(); return; }
    panelKind = kind;

    if (kind === "draft") {
        const packs = Number(tournamentMeta?.draft?.packs) || 10;
        const minutes = Number(tournamentMeta?.draft?.minutes) || 15;
        panel.innerHTML = `
          <h2 id="mpxDeckTitle">Draft Battle</h2>
          <p class="mpx-hint" style="font-size:.92rem;color:var(--mpx-soft)">You'll each open ${packs} packs, then build a deck on a shared ${minutes}-minute timer. The game starts when you've both locked in.</p>
          <button type="button" class="mpx-btn primary big" id="mpxEnterDraft" disabled>Open your packs</button>
          <span class="mpx-readyhint" id="mpxDraftHint">Waiting for an opponent to join…</span>`;
        $("#mpxEnterDraft", panel).addEventListener("click", goToDraft);
        renderDraftState();
        return;
    }

    const decks = lobbyDecks();
    if (kind === "regular" && !decks.some((deck) => deck.id === selectedDeckId) && decks.length) {
        selectedDeckId = (decks.find((deck) => !deckStats(deck).blocking) || decks[0]).id;
    }
    const deckField = kind === "locked"
        ? `<div class="mpx-field">Deck<div class="mpx-input" style="display:flex;align-items:center">Locked: ${esc(lockedDeck.name)} (your submitted list)</div></div>`
        : decks.length
            ? `<label class="mpx-field">Deck<select id="mpxRoomDeck">${decks.map((deck) => `<option value="${esc(deck.id)}"${deck.id === selectedDeckId ? " selected" : ""}>${esc(deck.name)}</option>`).join("")}</select></label>`
            : `<div class="mpx-empty" style="flex:1 1 100%"><b>No saved decks yet.</b><button type="button" class="mpx-btn outline" data-goto-builder>Open the Deck Builder</button></div>`;

    panel.innerHTML = `
      <h2 id="mpxDeckTitle">Your deck</h2>
      <div class="mpx-row">
        ${deckField}
        <label class="mpx-field" id="mpxStatsWrap" hidden>Leader for life &amp; power<select id="mpxStats"></select></label>
        <label class="mpx-field">DON!! deck<select data-don>${donOptions()}</select></label>
      </div>
      <div id="mpxRoomCheck"></div>
      <button type="button" class="mpx-btn primary big" id="mpxReady">Ready up</button>
      <span class="mpx-readyhint">The game starts by itself once you're both ready.</span>`;

    const select = $("#mpxRoomDeck", panel);
    if (select) {
        select.addEventListener("change", () => {
            selectedDeckId = select.value;
            lsSet(KEYS.deck, selectedDeckId);
            refreshStatsSelect();
            renderRoomCheck();
            renderVersus();
            pushPreviewDeck();
            if (myPlayer()?.ready) setPlayerReady(room.code, room.slot, false).catch(() => {});
        });
    }
    $("#mpxStats", panel).addEventListener("change", () => {
        pushPreviewDeck();
        if (myPlayer()?.ready) setPlayerReady(room.code, room.slot, false).catch(() => {});
    });
    $("#mpxReady", panel).addEventListener("click", toggleReady);
    wireDonSelects(panel);
    wireBuilderLinks(panel);
    refreshStatsSelect();
    renderRoomCheck();
    renderReadyState();
    if (kind === "regular") pushPreviewDeck();
}

function refreshStatsSelect() {
    const wrap = $("#mpxStatsWrap", root);
    const select = $("#mpxStats", root);
    if (!wrap || !select) return;
    const deck = roomDeck();
    if (!deck || !deck.leaderKey2) { wrap.hidden = true; select.innerHTML = ""; return; }
    const previous = select.value;
    const name = (key) => leaderCard(key)?.name || key;
    select.innerHTML = `<option value="1">${esc(name(deck.leaderKey))}</option><option value="2">${esc(name(deck.leaderKey2))}</option>`;
    if (previous === "1" || previous === "2") select.value = previous;
    wrap.hidden = false;
}

function renderRoomCheck() {
    const box = root && $("#mpxRoomCheck", root);
    if (!box) return;
    const deck = roomDeck();
    box.innerHTML = deck ? checkLine(deckStats(deck)) : "";
}

function renderReadyState() {
    const button = root && $("#mpxReady", root);
    if (!button) return;
    const ready = Boolean(myPlayer()?.ready);
    button.disabled = busy || (!roomDeck() && !lockedDeck);
    button.className = ready ? "mpx-btn outline big" : "mpx-btn primary big";
    button.textContent = busy ? "Saving…" : (ready ? "Ready - click to cancel" : "Ready up");
}

function renderDraftState() {
    const button = root && $("#mpxEnterDraft", root);
    const hint = root && $("#mpxDraftHint", root);
    if (!button || !hint) return;
    const bothHere = Boolean(myPlayer() && foePlayer());
    button.disabled = !bothHere;
    hint.textContent = bothHere
        ? "Your opponent is here - open your packs when you're ready."
        : "Waiting for an opponent to join…";
}

function goToDraft() {
    if (!room) return;
    navigating = true;
    leaveRoomQuietly();
    const params = new URLSearchParams({
        draft: "1",
        room: room.code,
        player: room.slot,
        pool: match?.draftCollection || ""
    });
    location.href = `index.html?${params.toString()}`;
}

async function toggleReady() {
    if (!room || busy) return;
    showError("#mpxRoomError", "");
    if (myPlayer()?.ready) {
        busy = true;
        renderReadyState();
        try { await setPlayerReady(room.code, room.slot, false); }
        catch (error) { showError("#mpxRoomError", error?.message || "Couldn't update."); }
        finally { busy = false; renderReadyState(); }
        return;
    }

    if (tournamentMeta?.requireDeck && tournamentMeta.matchType !== "draft" && !lockedDeck) {
        showError("#mpxRoomError", "Your submitted deck list hasn't loaded yet - wait a moment, or go back and submit one.");
        return;
    }
    const deck = roomDeck();
    if (!deck) { showError("#mpxRoomError", "Choose a deck first."); return; }
    const stats = deckStats(deck);
    if (stats.blocking) { showError("#mpxRoomError", `${deck.name}: ${stats.problem}. Pick another deck or fix it in the Deck Builder.`); return; }

    busy = true;
    renderReadyState();
    try {
        if (tournamentMeta && tournamentMeta.matchType !== "draft") {
            const problem = await tournamentDeckProblem(deck);
            if (problem) { showError("#mpxRoomError", problem); return; }
        }
        await clearMatchStartError(room.code).catch(() => {});
        handledStartError = "";
        await setPlayerDeck(room.code, room.slot, deckPayload(deck));
        await setPlayerReady(room.code, room.slot, true);
    } catch (error) {
        showError("#mpxRoomError", error?.message || "Couldn't ready up.");
    } finally {
        busy = false;
        renderReadyState();
    }
}

function sidePanel(player, label, isMe) {
    const draft = isDraftRoom();
    const deck = player.deck || (isMe && !draft ? roomDeck() : null);
    const stats = deck && !draft ? deckStats(deck) : null;
    const leader = deck && !draft ? leaderCard(deck.leaderKey) : null;
    const ready = Boolean(player.ready);
    const deckLine = draft
        ? "Draft Battle - decks are built after opening packs"
        : deck
            ? `${esc(deck.name || "Deck")}${leader ? ` · ${esc(leader.name)}` : ""}`
            : "Choosing a deck…";
    const chips = stats
        ? `<div class="mpx-chips"><span class="mpx-chip">${stats.count}${stats.anySize ? "" : "/50"} cards</span>${stats.starters ? `<span class="mpx-chip">${stats.starters} start in play</span>` : ""}${stats.tokens ? `<span class="mpx-chip">${stats.tokens} token type${stats.tokens === 1 ? "" : "s"}</span>` : ""}</div>`
        : "";
    return `
      <div class="mpx-side-panel${ready ? " ready" : ""}">
        <div class="mpx-art">${artHtml(leader, isMe ? null : (player.artPrefs || {}))}</div>
        <div class="mpx-side-body">
          <div>
            <div class="mpx-who">${label}</div>
            <div class="mpx-name">${esc(player.name || label)}</div>
            <div class="mpx-deckline">${deckLine}</div>
          </div>
          ${chips}
          <div class="mpx-light${ready ? " on" : ""}">${ready ? "Ready" : (draft ? "In the lobby" : "Not ready yet")}</div>
        </div>
      </div>`;
}

function waitingPanel() {
    return `
      <div class="mpx-side-panel waiting">
        <div class="mpx-art"><img src="${CARD_BACK}" alt=""></div>
        <div class="mpx-side-body">
          <div class="mpx-name">Waiting for your opponent</div>
          <p class="mpx-hint" style="font-size:.88rem;color:var(--mpx-soft)">Send them the invite link - one click and they're in. Or tell them the code <b>${esc(room.code)}</b>.</p>
          <div class="mpx-invite">
            <input class="mpx-input" readonly value="${esc(inviteLink(room.code))}" aria-label="Invite link" id="mpxInviteInput">
            <button type="button" class="mpx-btn primary" id="mpxInviteCopy">Copy</button>
          </div>
        </div>
      </div>`;
}

function renderVersus() {
    const box = root && $("#mpxVersus", root);
    if (!box || !room) return;
    const me = myPlayer() || { name: nickname(), ready: false };
    const foe = foePlayer();
    box.innerHTML = sidePanel(me, "You", true) +
        `<div class="mpx-vs" aria-hidden="true">VS</div>` +
        (foe ? sidePanel(foe, "Opponent", false) : waitingPanel());
    const copy = $("#mpxInviteCopy", box);
    if (copy) copy.addEventListener("click", (event) => copyText(inviteLink(room.code), event.currentTarget));
    const input = $("#mpxInviteInput", box);
    if (input) input.addEventListener("focus", () => input.select());
    paintLazy(box);
}

function handleStartState() {
    const me = myPlayer();
    const foe = foePlayer();
    const starting = $("#mpxStarting", root);

    if (match?.startError) {
        showError("#mpxRoomError", `The game couldn't start: ${match.startError} Pick a deck and ready up again.`);
        if (starting) starting.hidden = true;
        clearTimeout(startTimer);
        startTimer = null;
        // Both players re-ready after a failed start, so it doesn't just fail again.
        if (me?.ready && handledStartError !== match.startError) {
            handledStartError = match.startError;
            setPlayerReady(room.code, room.slot, false).catch(() => {});
        }
        return;
    }

    if (!isDraftRoom() && me?.ready && foe?.ready) {
        if (starting && starting.hidden) {
            starting.hidden = false;
            notify("Starting the game");
        }
        if (!startTimer) startTimer = setTimeout(enterGame, 1600);
    } else {
        if (starting) starting.hidden = true;
        clearTimeout(startTimer);
        startTimer = null;
    }
}

function enterGame() {
    if (!room || navigating) return;
    navigating = true;
    lsSet(KEYS.game, JSON.stringify({ code: room.code, slot: room.slot, at: Date.now() }));
    const target = `html/self.html?mode=online&room=${encodeURIComponent(room.code)}&player=${room.slot}`;
    leaveRoomQuietly();
    location.href = target;
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function onChat(messages) {
    const log = root && $("#mpxChatLog", root);
    if (!log || screen !== "room") return;
    let added = false;
    (messages || []).forEach((message) => {
        if (!message || chatSeen.has(message.id)) return;
        chatSeen.add(message.id);
        const row = document.createElement("div");
        const who = document.createElement("strong");
        who.className = `who-${message.role === "p2" ? "p2" : message.role === "spectator" ? "spectator" : "p1"}`;
        who.textContent = `${message.sender}: `;
        row.append(who, document.createTextNode(String(message.text || "")));
        log.append(row);
        added = true;
    });
    if (added) log.scrollTop = log.scrollHeight;
}

async function onChatSubmit(event) {
    event.preventDefault();
    const input = $("#mpxChatInput", root);
    const text = input.value.trim();
    if (!text || !room) return;
    input.value = "";
    try {
        await sendChatMessage(room.code, nickname(), text, room.slot);
    } catch (error) {
        input.value = text;
        showError("#mpxRoomError", "Couldn't send that message.");
    }
}

function addSystemLine(text) {
    const log = root && $("#mpxChatLog", root);
    if (!log) return;
    const row = document.createElement("div");
    row.className = "sys";
    row.textContent = text;
    log.append(row);
    log.scrollTop = log.scrollHeight;
}

// ── Notifications (opponent joined / ready) ──────────────────────────────────
function notifyFoeChanges() {
    const foe = foePlayer();
    const present = Boolean(foe);
    const ready = Boolean(foe?.ready);
    if (prevFoe.known) {
        if (present && !prevFoe.present) {
            const text = `${foe.name || "Your opponent"} joined the room`;
            addSystemLine(text);
            notify(text);
        } else if (present && ready && !prevFoe.ready) {
            const text = `${foe.name || "Your opponent"} is ready`;
            addSystemLine(text);
            notify(text);
        }
    }
    prevFoe = { known: true, present, ready };
}

let audioContext = null;
function chime() {
    if (lsGet(SFX_MUTED_KEY) === "1") return;
    try {
        audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        const now = audioContext.currentTime;
        [660, 880].forEach((frequency, i) => {
            const at = now + i * 0.12;
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.type = "sine";
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
            osc.connect(gain).connect(audioContext.destination);
            osc.start(at);
            osc.stop(at + 0.3);
        });
    } catch { /* no sound available */ }
}

let baseTitle = null;
function notify(text) {
    chime();
    // Waiting on another tab? Say so in this tab's title until you come back.
    if (document.hidden) {
        if (baseTitle === null) baseTitle = document.title;
        document.title = `● ${text}`;
    }
}
function stopTitleFlash() {
    if (baseTitle !== null) {
        document.title = baseTitle;
        baseTitle = null;
    }
}

// ── Clipboard ────────────────────────────────────────────────────────────────
async function copyText(text, button) {
    const label = button && $("span", button);
    try {
        await navigator.clipboard.writeText(text);
        if (label) {
            const before = label.textContent;
            label.textContent = "Copied!";
            setTimeout(() => { label.textContent = before; }, 1600);
        } else if (button) {
            const before = button.textContent;
            button.textContent = "Copied!";
            setTimeout(() => { button.textContent = before; }, 1600);
        }
    } catch {
        window.prompt("Copy this:", text);
    }
}
