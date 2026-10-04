import { signInGuest, waitForUser } from "../firebase/firebaseApp.js";
import {
    createRoom,
    joinRoom,
    subscribeToMatch,
    subscribeToActiveGames,
    startMatch,
    setPlayerDeck,
    setPlayerReady,
    getMatch,
    clearMatchStartError
} from "../firebase/multiplayerService.js?v=draft-6";

// ── State ────────────────────────────────────────────
let currentUser = null;
let currentRoomCode = null;
let playerSlot = null;        // "p1" | "p2"
let unsubscribeMatch = null;
let unsubscribeLobbies = null;
let isReady = false;
let matchStartRequested = false;  // host has already asked to start
let isRedirecting = false;        // guards against double navigation
let startWatchdogTimer = null;    // fallback poll for missed "started" events

// ── Nickname (persisted) ─────────────────────────────
// Nickname is session-only — never saved, each tab starts fresh
function getNickname() { return nicknameInput ? nicknameInput.value.trim() : ""; }
function saveNickname(v) { /* intentionally no-op — no persistence */ }

// Prefill the nickname with the signed-in account's name, so your in-game name
// matches your account everywhere. Left editable so you can still override it.
function prefillNicknameFromAccount() {
    try {
        const name = window.ccAccount && window.ccAccount.user && window.ccAccount.user.displayName;
        if (name && nicknameInput && !nicknameInput.value.trim()) nicknameInput.value = name;
    } catch (e) {}
}
document.addEventListener("cc-account-change", prefillNicknameFromAccount);

// ── DOM refs ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// Views
const views = {
    landing: $("viewLanding"),
    create:  $("viewCreate"),
    lobby:   $("viewLobby"),
};

function showView(name) {
    Object.values(views).forEach(v => v.classList.remove("active"));
    views[name].classList.add("active");
}

// Landing
const mpConnStatus   = $("mpConnStatus");
const nicknameInput  = $("nicknameInput");
const btnCreate      = $("btnCreate");
const codeInput      = $("codeInput");
const btnJoinCode    = $("btnJoinCode");
const mpLandingError = $("mpLandingError");


// Create
const lobbyNameInput    = $("lobbyNameInput");
const createDeckSelect  = $("createDeckSelect");
const createDonDeckSelect = $("createDonDeckSelect");
const btnConfirmCreate  = $("btnConfirmCreate");
// Draft-mode create controls
const mpModeToggle      = $("mpModeToggle");
const regularOptions    = $("regularOptions");
const draftOptions      = $("draftOptions");
const draftCollectionSearch   = $("draftCollectionSearch");
const draftCollectionSelectMp = $("draftCollectionSelectMp");
let createMode = "regular";           // "regular" | "draft"
let draftCollectionList = [];         // [{slug, name}] for the searchable dropdown
const btnBackFromCreate = $("btnBackFromCreate");
const mpCreateError     = $("mpCreateError");

// Lobby
const lobbyTitle       = $("lobbyTitle");
const lobbyCodeBox     = $("lobbyCodeBox");
const lobbyCodeDisplay = $("lobbyCodeDisplay");
const btnCopyCode      = $("btnCopyCode");
const lobbyDeckSelect  = $("lobbyDeckSelect");
const lobbyDonDeckSelect = $("lobbyDonDeckSelect");
const btnReady         = $("btnReady");
const btnStart         = $("btnStart");
const lobbyRegularPanel = $("lobbyRegularPanel");
const lobbyDraftPanel  = $("lobbyDraftPanel");
const draftLobbyHint   = $("draftLobbyHint");
const btnEnterDraft    = $("btnEnterDraft");
let currentMatchMode   = "regular";     // "regular" | "draft" (from match data)
let currentDraftCollection = "";
const mpLobbyMsg       = $("mpLobbyMsg");
const mpLobbyError     = $("mpLobbyError");
const btnBackFromLobby = $("btnBackFromLobby");
const lobbyP1          = $("lobbyP1");
const lobbyP2          = $("lobbyP2");

// ── Helpers ───────────────────────────────────────────
function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
}
function clearError(el) {
    el.textContent = "";
    el.classList.add("hidden");
}
function setStatus(text, cls) {
    mpConnStatus.textContent = text;
    mpConnStatus.className = "mp-status " + cls;
}

// DON!! deck dropdowns (create + lobby). Selecting one sets the active DON!! deck
// the game reads at match start, so there's no in-game DON!! pop-up. The two
// selects mirror each other since it's one per-device setting.
const DON_DECKS_KEY = "custom-don-decks-v1";
const DON_ACTIVE_DECK_KEY = "custom-don-active-deck-v1";
function populateDonDecks(select) {
    if (!select) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(DON_DECKS_KEY) || "[]"); } catch {}
    list = Array.isArray(list) ? list.filter(d => d && Array.isArray(d.cards) && d.cards.length) : [];
    let active = "";
    try { active = localStorage.getItem(DON_ACTIVE_DECK_KEY) || ""; } catch {}

    select.innerHTML = "";
    const std = document.createElement("option");
    std.value = "";
    std.textContent = "Standard DON!! (10)";
    select.appendChild(std);
    list.forEach(d => {
        const o = document.createElement("option");
        o.value = d.id;
        o.textContent = `${d.name || "DON!! deck"} (${d.cards.length})`;
        select.appendChild(o);
    });
    select.value = active;

    if (!select.dataset.wired) {
        select.dataset.wired = "1";
        select.addEventListener("change", () => {
            try {
                if (select.value) localStorage.setItem(DON_ACTIVE_DECK_KEY, select.value);
                else localStorage.removeItem(DON_ACTIVE_DECK_KEY);
            } catch {}
            [createDonDeckSelect, lobbyDonDeckSelect].forEach(s => { if (s && s !== select) s.value = select.value; });
        });
    }
}

function populateDecks(select) {
    const decks = window.getAvailableDecks?.() || [];
    select.innerHTML = "";
    if (decks.length === 0) {
        const o = document.createElement("option");
        o.textContent = "No decks saved";
        select.appendChild(o);
        return;
    }

    // Decks whose leader isn't in the card database can never start a match, so
    // show them disabled with the reason rather than letting both players ready
    // up only to hit "Leader not found".
    let firstPlayable = null;
    decks.forEach(deck => {
        const playable = window.isDeckLeaderAvailable?.(deck) !== false;
        const o = document.createElement("option");
        o.value = deck.id;
        o.textContent = playable ? deck.name : `${deck.name} — leader not in card pool`;
        o.disabled = !playable;
        if (playable && firstPlayable === null) firstPlayable = deck.id;
        select.appendChild(o);
    });

    if (firstPlayable !== null) {
        select.value = firstPlayable;
    } else {
        const o = document.createElement("option");
        o.textContent = "No playable decks — build and save one in the Deck Builder";
        o.disabled = true;
        o.selected = true;
        select.appendChild(o);
    }
}

// ── Dual Leader: choose the stats leader ──────────────
// A Dual Leader deck has two leaders; ONE supplies the life and power for both and
// the other rides along as a linked twin (see the board's leader twin). The lobby
// asks which before you ready up. The row only shows for a dual deck.
function leaderDisplayName(key) {
    const leaders = window.leaders || {};
    const found = leaders[key]
        || Object.values(leaders).find(l => l?.cardNumber === key || l?.id === key)
        || (window.cardDatabase || {})[key];
    return found?.name || key;
}

function refreshLobbyStatsRow() {
    const row = $("lobbyStatsRow");
    const select = $("lobbyStatsSelect");
    if (!row || !select) return;
    const deck = getLobbyDeck();
    if (!deck || !deck.leaderKey2) { row.hidden = true; select.innerHTML = ""; return; }

    const previous = select.value;
    select.innerHTML = "";
    [["1", deck.leaderKey], ["2", deck.leaderKey2]].forEach(([value, key]) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = leaderDisplayName(key);
        select.appendChild(o);
    });
    if (previous === "1" || previous === "2") select.value = previous;
    row.hidden = false;
}
lobbyDeckSelect.addEventListener("change", refreshLobbyStatsRow);

// The deck as it should be sent for this match: for a Dual Leader deck, leaderKey
// is the chosen STATS leader and leaderKey2 the twin (swapped if leader 2 was picked).
function deckWithChosenStatsLeader(deck) {
    if (!deck || !deck.leaderKey2) return { leaderKey: deck?.leaderKey, leaderKey2: "" };
    const stats2 = $("lobbyStatsSelect")?.value === "2";
    return stats2
        ? { leaderKey: deck.leaderKey2, leaderKey2: deck.leaderKey }
        : { leaderKey: deck.leaderKey, leaderKey2: deck.leaderKey2 };
}

function updateLobbyPlayerUI(slotEl, name, ready) {
    slotEl.querySelector(".lobby-player-name").textContent = name || "—";
    const statusEl = slotEl.querySelector(".lobby-player-status");
    if (!name) {
        statusEl.textContent = "Waiting…";
        statusEl.className = "lobby-player-status waiting";
    } else if (ready) {
        statusEl.textContent = "Ready ✓";
        statusEl.className = "lobby-player-status ready";
    } else {
        statusEl.textContent = "Not ready";
        statusEl.className = "lobby-player-status waiting";
    }
}

function escapeHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Join helpers ──────────────────────────────────────
// All rooms are private and joined by code - the public lobby browser was
// removed because the /lobbies listing was never usable.
async function joinWithCode(code) {
    clearError(mpLandingError);
    if (!currentUser) { showError(mpLandingError, "Not connected yet — wait a moment."); return; }
    const nickname = getNickname() || "Player 2";
    try {
        currentRoomCode = await joinRoom(code, currentUser, nickname);
        playerSlot = "p2";
        openLobbyView();
    } catch (e) {
        showError(mpLandingError, e.message);
    }
}

// ── Lobby view ────────────────────────────────────────
function openLobbyView(preferredDeckId = "") {
    populateDecks(lobbyDeckSelect);
    // Carry over the deck the player already picked (e.g. on the create screen)
    // so entering the lobby doesn't silently reset their choice back to the first
    // deck in the list.
    if (preferredDeckId
        && [...lobbyDeckSelect.options].some(o => o.value === preferredDeckId)) {
        lobbyDeckSelect.value = preferredDeckId;
    }
    refreshLobbyStatsRow();
    clearError(mpLobbyError);
    mpLobbyMsg.textContent = "Choose your deck and ready up.";
    isReady = false;
    matchStartRequested = false;
    isRedirecting = false;
    stopStartWatchdog();
    btnReady.disabled = false;
    btnReady.textContent = "Ready Up";
    btnStart.classList.add("hidden");

    // Show code box only for host (p1) and only if private
    lobbyCodeBox.classList.add("hidden");
    if (playerSlot === "p1") {
        lobbyCodeDisplay.textContent = currentRoomCode;
        lobbyTitle.textContent = "Your Room";
        // We'll determine public/private from match data when it loads
    } else {
        lobbyTitle.textContent = "Room — " + currentRoomCode;
    }

    // Subscribe to match updates
    if (unsubscribeMatch) { unsubscribeMatch(); }
    unsubscribeMatch = subscribeToMatch(currentRoomCode, handleMatchUpdate);

    showView("lobby");
}

// Switch the lobby between the regular deck-picker layout and the draft layout
// (no deck picker — both players open packs then build). Driven by match.mode,
// which arrives from the subscription (so the joiner learns it too).
function applyLobbyMode(mode, draftCollection) {
    currentMatchMode = mode === "draft" ? "draft" : "regular";
    currentDraftCollection = draftCollection || "";
    const draft = currentMatchMode === "draft";
    if (lobbyRegularPanel) lobbyRegularPanel.hidden = draft;
    if (lobbyDraftPanel) lobbyDraftPanel.hidden = !draft;
}

// ── Tournament matches ────────────────────────────────
// A room opened from the Tournaments page carries `match.tournament` (which
// tournament + round it belongs to, who may play, and the card pool decks are
// restricted to). Show it, and for regular matches check decks against the pool.
let tournamentMeta = null;
const lobbyTournamentBanner = $("lobbyTournamentBanner");

// Real collection names (e.g. "Pig's Deltarune") come from the shared registry; load
// them once so the banner doesn't have to guess from the slug.
let collectionNamesRequested = false;
async function loadCollectionNamesOnce() {
    if (collectionNamesRequested) return;
    collectionNamesRequested = true;
    try {
        const mod = await import("../firebase/cardLibraryService.js?v=draft-4");
        const registry = mod.loadSharedCollections ? await mod.loadSharedCollections() : [];
        (registry || []).forEach(c => { if (c && c.slug && c.name) sharedCollectionNames[c.slug] = c.name; });
        if (tournamentMeta) applyTournamentLobby(tournamentMeta);
    } catch { /* the slug-based fallback name is fine */ }
}

function applyTournamentLobby(meta) {
    tournamentMeta = meta;
    loadCollectionNamesOnce();
    const pool = Object.values(meta.collections || {});
    const bans = Object.values(meta.banned || {});
    const bestOf = Number(meta.bestOf) || 1;
    if (lobbyTournamentBanner) {
        lobbyTournamentBanner.hidden = false;
        lobbyTournamentBanner.innerHTML =
            `<strong>🏆 ${escapeHtml(meta.name || "Tournament")} — Round ${escapeHtml(meta.round)}${bestOf > 1 ? ` · Game ${escapeHtml(meta.game || 1)} of ${bestOf}` : ""}</strong>` +
            `<span>${meta.format === "swiss" ? "Swiss" : "Single elimination"} · ` +
            `${meta.matchType === "draft" ? "Draft battle" : "Regular match"} · ` +
            `Card pool: ${pool.length ? escapeHtml(pool.map(prettyCollectionName).join(", ")) : "all collections"}` +
            `${bans.length ? ` · ${bans.length} banned card${bans.length === 1 ? "" : "s"}` : ""}</span>`;
    }
    if (lobbyTitle) lobbyTitle.textContent = "Tournament match";
    if (btnBackFromLobby) btnBackFromLobby.textContent = "← Tournaments";
    if (meta.requireDeck && meta.matchType !== "draft") loadRequiredDeck(meta);
}

// A tournament that asked for deck lists: you play the deck you submitted, nothing else.
let tournamentLockedDeck = null;
let lockedDeckRequested = false;
async function loadRequiredDeck(meta) {
    if (lockedDeckRequested || !currentUser) return;
    lockedDeckRequested = true;
    try {
        const decks = await import("../firebase/tournamentDecks.js?v=tour-2");
        const submitted = await decks.getSubmittedDeck(meta.id, currentUser.uid);
        if (!submitted || !submitted.deck) {
            showError(mpLobbyError, "You haven't submitted a deck list for this tournament, so you can't play yet. Go back and submit one.");
            return;
        }
        tournamentLockedDeck = { ...submitted.deck };
        lobbyDeckSelect.innerHTML = "";
        const option = document.createElement("option");
        option.value = "__tournament__";
        option.textContent = `🔒 ${submitted.name || "Submitted deck"} (your tournament deck list)`;
        lobbyDeckSelect.appendChild(option);
        lobbyDeckSelect.disabled = true;
        refreshLobbyStatsRow();
        mpLobbyMsg.textContent = "This tournament uses your submitted deck list — ready up when you're set.";
    } catch (error) {
        lockedDeckRequested = false;
        showError(mpLobbyError, "Couldn't load your submitted deck list. Check your connection and refresh.");
    }
}

// The deck the player will use: their submitted list in a deck-list tournament,
// otherwise whatever is chosen in the picker.
function getLobbyDeck() {
    if (tournamentLockedDeck) return tournamentLockedDeck;
    return window.getDeckById?.(lobbyDeckSelect.value);
}

// A tournament can change the draft's pack count and build time; show the real numbers.
function draftMinutes() {
    return Number(tournamentMeta && tournamentMeta.draft && tournamentMeta.draft.minutes) || 15;
}
function draftSettingsText() {
    const packs = Number(tournamentMeta && tournamentMeta.draft && tournamentMeta.draft.packs);
    return packs ? `${packs} pack${packs === 1 ? "" : "s"}` : "packs";
}

// Cards in a deck that aren't from the tournament's collections ("" = no problem).
//
// The in-game card database does NOT record which collection a card belongs to, so
// this asks the shared card library instead, for just the deck's card numbers. A deck
// only stores card NUMBERS, and the same number can exist in more than one collection,
// so a card is accepted if ANY card with that number is in the tournament's pool.
async function tournamentDeckProblem(deck) {
    const pool = Object.values((tournamentMeta && tournamentMeta.collections) || {});
    const banned = Object.values((tournamentMeta && tournamentMeta.banned) || {});
    if (!pool.length && !banned.length) return "";
    try {
        const decks = await import("../firebase/tournamentDecks.js?v=tour-2");
        const result = await decks.checkDeck(deck, { collections: pool, banned, collectionName: prettyCollectionName });
        return result.problems.join(" ");
    } catch {
        return "Couldn't check your deck against the tournament rules right now. Check your connection and try again.";
    }
}

function goToDraft() {
    if (!currentRoomCode || !playerSlot) return;
    isRedirecting = true;
    if (unsubscribeMatch) { unsubscribeMatch(); unsubscribeMatch = null; }
    stopStartWatchdog();
    const params = new URLSearchParams({
        draft: "1",
        room: currentRoomCode,
        player: playerSlot,
        pool: currentDraftCollection || ""
    });
    window.location.href = `../index.html?${params.toString()}`;
}

if (btnEnterDraft) btnEnterDraft.addEventListener("click", goToDraft);

function handleMatchUpdate(match) {
    if (!match) return;
    if (isRedirecting) return; // already heading into the game

    // Learn the room's mode from match data (the joiner didn't set it locally).
    if (match.mode !== undefined) applyLobbyMode(match.mode, match.draftCollection);
    if (match.tournament) applyTournamentLobby(match.tournament);

    const p1 = match.players?.p1;
    const p2 = match.players?.p2;

    updateLobbyPlayerUI(lobbyP1, p1?.name, p1?.ready);
    updateLobbyPlayerUI(lobbyP2, p2?.name, p2?.ready);

    // ── Draft rooms: skip the ready/deck flow; route both players to the draft ──
    if (currentMatchMode === "draft") {
        // The game may already be running (both drafted + startMatch fired from the
        // draft page) — if we somehow land back here, still honour a started match.
        if (match.status === "started") { enterMatch(); return; }
        const bothHere = Boolean(p1 && p2);
        if (btnEnterDraft) btnEnterDraft.disabled = !bothHere;
        if (draftLobbyHint) {
            draftLobbyHint.textContent = bothHere
                ? `Opponent's here! Open your ${draftSettingsText()} when ready — you'll build on a shared ${draftMinutes()}-minute timer.`
                : "Waiting for an opponent to join…";
        }
        mpLobbyMsg.textContent = bothHere
            ? "Both players connected."
            : "Share the room code with your opponent.";
        return;
    }

    // Show code box for host if room is private
    if (playerSlot === "p1" && match.isPublic === false) {
        lobbyCodeBox.classList.remove("hidden");
    } else if (playerSlot === "p1" && match.isPublic) {
        lobbyCodeBox.classList.add("hidden");
    }

    // Always show code for private rooms (even for p2 to reshare)
    if (!match.isPublic) {
        lobbyCodeBox.classList.remove("hidden");
        lobbyCodeDisplay.textContent = currentRoomCode;
    }

    const bothReady = p1?.ready && p2?.ready;

    if (match.status === "started") {
        enterMatch();
        return;
    }

    // A failed start is published onto the match so BOTH players see it rather
    // than the non-host waiting on "Ready" forever.
    if (match.startError) {
        showError(mpLobbyError, match.startError);
        mpLobbyMsg.textContent = "Match could not start. Pick a different deck and ready up again.";
        matchStartRequested = false; // allow a retry
        stopStartWatchdog();
        return;
    }

    // Auto-start when both are ready. EITHER client may trigger it - the start is
    // claimed atomically server-side (ready -> starting), so this is safe and no
    // longer depends on the host's client firing the event.
    if (bothReady) {
        mpLobbyMsg.textContent = "Both ready! Starting match…";
        if (!matchStartRequested) {
            matchStartRequested = true;
            startMatch(currentRoomCode).catch(e => {
                matchStartRequested = false;
                showError(mpLobbyError, e.message);
            });
        }
        startStartWatchdog();
    } else if (!p2) {
        stopStartWatchdog();
        mpLobbyMsg.textContent = "Waiting for opponent to join…";
    } else {
        stopStartWatchdog();
        mpLobbyMsg.textContent = "Waiting for both players to ready up.";
    }
}

// Single place to leave the lobby for the game, guarded so duplicate/late
// match updates can't trigger a second navigation.
function enterMatch() {
    if (isRedirecting) return;
    isRedirecting = true;
    stopStartWatchdog();
    if (unsubscribeMatch) { unsubscribeMatch(); unsubscribeMatch = null; }
    window.location.href =
        `../html/self.html?mode=online&room=${currentRoomCode}&player=${playerSlot}`;
}

// Safety net for dropped/delayed realtime events and reconnects: while both
// players are ready we poll the match directly. If it already started we join;
// if it somehow never started, the host retries. This guarantees neither client
// can sit on the Ready screen because a single update went missing.
function startStartWatchdog() {
    if (startWatchdogTimer || isRedirecting) return;
    startWatchdogTimer = setInterval(async () => {
        if (isRedirecting || !currentRoomCode) return;
        try {
            const match = await getMatch(currentRoomCode);
            if (!match) return;

            if (match.status === "started") {
                enterMatch();
                return;
            }
            if (match.startError) {
                showError(mpLobbyError, match.startError);
                matchStartRequested = false;
                stopStartWatchdog();
                return;
            }

            // Either client can drive the start; the server-side claim keeps it
            // to a single initialisation. This is what rescues a match when the
            // other player's client never fired its own start.
            const ready = match.players?.p1?.ready && match.players?.p2?.ready;
            if (ready && match.status !== "started") {
                matchStartRequested = true;
                startMatch(currentRoomCode).catch(e => {
                    matchStartRequested = false;
                    showError(mpLobbyError, e.message);
                });
            }
        } catch {
            // transient network/permission error - try again on the next tick
        }
    }, 2500);
}

function stopStartWatchdog() {
    if (startWatchdogTimer) {
        clearInterval(startWatchdogTimer);
        startWatchdogTimer = null;
    }
}

// ── Init ──────────────────────────────────────────────
async function init() {
    // Load cards
    if (typeof loadCardDatabase === "function") await loadCardDatabase().catch(() => {});
    populateDecks(createDeckSelect);
    populateDecks(lobbyDeckSelect);
    populateDonDecks(createDonDeckSelect);
    populateDonDecks(lobbyDonDeckSelect);

    // Firebase auth
    try {
        setStatus("Connecting…", "connecting");
        await signInGuest();
        currentUser = await waitForUser();
        setStatus("Connected", "connected");
        prefillNicknameFromAccount();
        watchActiveGames();
    } catch (e) {
        setStatus("Connection failed", "error");
    }

    // Sent here from the Tournaments page: the room already exists (or was just
    // created) for this player, so go straight to its lobby.
    const params = new URLSearchParams(window.location.search);
    const roomParam = (params.get("room") || "").trim().toUpperCase();
    if (currentUser && roomParam) {
        currentRoomCode = roomParam;
        playerSlot = params.get("slot") === "p2" ? "p2" : "p1";
        openLobbyView();
    }
}

// ── Spectate list ─────────────────────────────────────
// Live listing of in-progress games. Each game writes a lightweight entry to
// /activeGames while it runs; anyone can pick one and open it as a read-only
// spectator (self.html?...&spectate=1).
const spectateList  = $("spectateList");
const spectateCount = $("spectateCount");
let unsubscribeActiveGames = null;

function watchActiveGames() {
    if (!spectateList || unsubscribeActiveGames) return;
    unsubscribeActiveGames = subscribeToActiveGames(renderActiveGames, (error) => {
        const denied = /permission|denied/i.test(error?.message || "");
        spectateList.innerHTML = `<div class="mp-spectate-empty">${
            denied
                ? "Can't load live games — the database rules for spectating haven't been published yet."
                : "Couldn't load live games right now."
        }</div>`;
        if (spectateCount) spectateCount.textContent = "0";
    });
}

function renderActiveGames(games) {
    if (!spectateList) return;

    // Don't offer to spectate your OWN game (you're already in it).
    const others = (games || []).filter(g => g.roomCode !== currentRoomCode);

    if (spectateCount) spectateCount.textContent = String(others.length);

    if (!others.length) {
        spectateList.innerHTML = `<div class="mp-spectate-empty">No games in progress right now.</div>`;
        return;
    }

    spectateList.innerHTML = "";
    others.forEach(game => {
        const row = document.createElement("div");
        row.className = "mp-spectate-row";

        const turnLabel = Number(game.turnNumber) > 0 ? `Turn ${game.turnNumber}` : "Starting…";
        row.innerHTML =
            `<div class="mp-spectate-info">` +
                `<span class="mp-spectate-players">` +
                    `${escapeHtml(game.p1Name || "Player 1")} ` +
                    `<span class="mp-spectate-vs">vs</span> ` +
                    `${escapeHtml(game.p2Name || "Player 2")}` +
                `</span>` +
                `<span class="mp-spectate-meta">${escapeHtml(turnLabel)}</span>` +
            `</div>`;

        const watchBtn = document.createElement("button");
        watchBtn.className = "mp-btn-tiny mp-spectate-watch";
        watchBtn.textContent = "Watch";
        watchBtn.addEventListener("click", () => {
            window.location.href = `../html/self.html?mode=online&room=${encodeURIComponent(game.roomCode)}&spectate=1`;
        });

        row.appendChild(watchBtn);
        spectateList.appendChild(row);
    });
}

// ── Event listeners ───────────────────────────────────

// Landing → create
btnCreate.addEventListener("click", () => {
    clearError(mpLandingError);
    const nick = getNickname() || "Player";
    lobbyNameInput.value = nick + "'s Game";
    populateDecks(createDeckSelect);
    showView("create");
});

btnBackFromCreate.addEventListener("click", () => showView("landing"));

// Landing → join by code
btnJoinCode.addEventListener("click", async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) { showError(mpLandingError, "Enter a room code first."); return; }
    await joinWithCode(code);
});

codeInput.addEventListener("keydown", e => {
    if (e.key === "Enter") btnJoinCode.click();
});

// ── Draft create options: match-type toggle + searchable collection pool ─────
// Display names: prefer the shared-collections registry (the authoritative list
// of every custom collection), then the built-in catalog, then a prettified slug.
let sharedCollectionNames = {};   // slug -> display name, from loadSharedCollections()
function prettyCollectionName(slug) {
    if (!slug) return "All cards";
    if (sharedCollectionNames[slug]) return sharedCollectionNames[slug];
    const hit = (window.BUILTIN_COLLECTIONS || []).find(c => c.slug === slug);
    if (hit && hit.name) return hit.name;
    return String(slug).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
function renderDraftCollectionOptions(query) {
    if (!draftCollectionSelectMp) return;
    const q = String(query || "").toLowerCase();
    const items = [{ slug: "", name: "All cards" },
        ...draftCollectionList.filter(o => o.name.toLowerCase().includes(q) || o.slug.includes(q))];
    draftCollectionSelectMp.innerHTML = items
        .map((o, i) => `<option value="${o.slug}"${i === 0 ? " selected" : ""}>${o.name}</option>`).join("");
}
async function ensureDraftCollections() {
    if (draftCollectionList.length || !draftCollectionSelectMp) return;
    try {
        if (window.loadCardDatabase && (!window.cardDatabase || !Object.keys(window.cardDatabase).length)) {
            await window.loadCardDatabase();
        }
    } catch (e) {}
    const packable = (c) => c && !c.donCard && !c.omniLeader
        && String(c.category || c.cardType).toLowerCase() !== "leader";
    const slugs = new Set();
    // Seed with the built-in catalog so the known sets always appear (the static
    // cardDatabase cards carry no collection field — they belong to the default).
    (window.BUILTIN_COLLECTIONS || []).forEach(c => { if (c.slug) slugs.add(c.slug); });
    if (window.COLLECTION_DEFAULT) slugs.add(window.COLLECTION_DEFAULT);
    Object.values(window.cardDatabase || {}).forEach(c => {
        if (packable(c) && c.collection) slugs.add(c.collection);
    });
    try {
        const mod = await import("../firebase/cardLibraryService.js?v=draft-4");
        // The AUTHORITATIVE list of every collection (built-ins were only a partial
        // hardcoded catalog, which is why newer collections were missing). Also
        // capture their real display names.
        if (mod.loadSharedCollections) {
            const registry = await mod.loadSharedCollections();
            (registry || []).forEach(c => {
                if (!c || !c.slug) return;
                slugs.add(c.slug);
                if (c.name) sharedCollectionNames[c.slug] = c.name;
            });
        }
        // Plus any collection that actually has packable cards in the cache, in case
        // a collection has cards but isn't in the registry.
        const lib = mod.getCachedLibrary ? await mod.getCachedLibrary() : null;
        const arr = Array.isArray(lib) ? lib : (lib && lib.cards ? lib.cards : (lib ? Object.values(lib) : []));
        arr.forEach(c => { if (packable(c) && c.collection) slugs.add(c.collection); });
    } catch (e) {}
    // Never offer the special all-access virtual view as a draft pool.
    slugs.delete("all-access");
    // Keep the "everything-else" bucket last; sort the rest by display name.
    draftCollectionList = [...slugs]
        .map(s => ({ slug: s, name: prettyCollectionName(s) }))
        .sort((a, b) => (a.slug === "everything-else") - (b.slug === "everything-else")
            || a.name.localeCompare(b.name));
    renderDraftCollectionOptions("");
}
if (mpModeToggle) {
    mpModeToggle.addEventListener("click", (e) => {
        const btn = e.target.closest(".mp-mode-btn");
        if (!btn) return;
        createMode = btn.dataset.mode === "draft" ? "draft" : "regular";
        [...mpModeToggle.querySelectorAll(".mp-mode-btn")].forEach(b => b.classList.toggle("active", b === btn));
        const draft = createMode === "draft";
        if (regularOptions) regularOptions.hidden = draft;
        if (draftOptions) draftOptions.hidden = !draft;
        if (draft) ensureDraftCollections();
    });
}
if (draftCollectionSearch) {
    draftCollectionSearch.addEventListener("input", () => renderDraftCollectionOptions(draftCollectionSearch.value));
}

// Create room
btnConfirmCreate.addEventListener("click", async () => {
    clearError(mpCreateError);
    if (!currentUser) { showError(mpCreateError, "Not connected yet."); return; }

    const nickname = getNickname() || "Player 1";
    const lobbyName = lobbyNameInput.value.trim() || nickname + "'s Game";
    const isPublic  = false; // rooms are always private, joined by code
    const mode = createMode;
    const draftCollection = mode === "draft" ? (draftCollectionSelectMp?.value || "") : "";

    btnConfirmCreate.disabled = true;
    btnConfirmCreate.textContent = "Creating…";

    try {
        const created = await createRoom(currentUser, { isPublic, lobbyName, nickname, mode, draftCollection });
        currentRoomCode = created.roomCode;
        playerSlot = "p1";

        // Carry the deck chosen on the create screen into the lobby's picker.
        openLobbyView(createDeckSelect.value);
        // Apply the chosen mode right away so the host doesn't see the regular
        // deck-picker flash before the first match update arrives.
        applyLobbyMode(mode, draftCollection);
        if (mode === "draft") mpLobbyMsg.textContent = "Share the room code — your opponent joins, then you both draft.";

        // Private rooms are joined by code, so always surface it to the host.
        lobbyCodeBox.classList.remove("hidden");
        lobbyCodeDisplay.textContent = currentRoomCode;
    } catch (e) {
        showError(mpCreateError, e.message);
    } finally {
        btnConfirmCreate.disabled = false;
        btnConfirmCreate.textContent = "Create Room";
    }
});

// Lobby — copy code
btnCopyCode.addEventListener("click", () => {
    navigator.clipboard?.writeText(currentRoomCode).then(() => {
        btnCopyCode.textContent = "Copied!";
        setTimeout(() => { btnCopyCode.textContent = "Copy"; }, 1800);
    });
});

// Lobby — ready up
btnReady.addEventListener("click", async () => {
    clearError(mpLobbyError);
    if (!currentRoomCode || !currentUser) { showError(mpLobbyError, "Not in a room."); return; }

    if (tournamentMeta && tournamentMeta.requireDeck && tournamentMeta.matchType !== "draft" && !tournamentLockedDeck) {
        showError(mpLobbyError, "Your submitted deck list hasn't loaded yet — wait a moment, or go back and submit one.");
        return;
    }
    const selectedDeck = getLobbyDeck();
    if (!selectedDeck) { showError(mpLobbyError, "Choose a deck first."); return; }

    // Tournament with a card pool: the deck must stay inside it.
    if (tournamentMeta && tournamentMeta.matchType !== "draft") {
        btnReady.disabled = true;
        btnReady.textContent = "Checking deck…";
        const problem = await tournamentDeckProblem(selectedDeck);
        btnReady.disabled = false;
        btnReady.textContent = "Ready Up";
        if (problem) { showError(mpLobbyError, problem); return; }
    }

    btnReady.disabled = true;
    btnReady.textContent = "Saving…";
    isReady = true;

    try {
        // Clear any previous failure so readying up with a different deck can retry.
        await clearMatchStartError(currentRoomCode).catch(() => {});
        matchStartRequested = false;
        const chosenLeaders = deckWithChosenStatsLeader(selectedDeck);
        await setPlayerDeck(currentRoomCode, playerSlot, {
            id: selectedDeck.id,
            name: selectedDeck.name,
            leaderKey: chosenLeaders.leaderKey,
            // Dual Leader twin ("" for a normal deck).
            leaderKey2: chosenLeaders.leaderKey2 || "",
            deckText: selectedDeck.deckText,
            // Carry the deck's "start in play" placements and token types into the
            // match, or multiplayer silently ignores them (createInitialPrivateState
            // reads selectedDeck.startingCards/tokens). Without these two lines,
            // cards set to start on the board only worked on the practice board.
            startingCards: Array.isArray(selectedDeck.startingCards) ? selectedDeck.startingCards : [],
            tokens: Array.isArray(selectedDeck.tokens) ? selectedDeck.tokens : []
        });
        await setPlayerReady(currentRoomCode, playerSlot, true);
        btnReady.textContent = "Ready ✓";
        mpLobbyMsg.textContent = "You're ready — waiting for opponent.";
    } catch (e) {
        showError(mpLobbyError, e.message);
        btnReady.disabled = false;
        btnReady.textContent = "Ready Up";
        isReady = false;
    }
});

// Lobby — start match (host only)
btnStart.addEventListener("click", async () => {
    clearError(mpLobbyError);
    btnStart.disabled = true;
    btnStart.textContent = "Starting…";
    try {
        await startMatch(currentRoomCode);
        // Redirect handled by handleMatchUpdate when status === "started"
    } catch (e) {
        showError(mpLobbyError, e.message);
        btnStart.disabled = false;
        btnStart.textContent = "Start Match";
    }
});

// Lobby — leave
btnBackFromLobby.addEventListener("click", () => {
    // A tournament match has nowhere to go but back to the tournament.
    if (tournamentMeta) { window.location.href = "tournaments.html"; return; }
    if (unsubscribeMatch) { unsubscribeMatch(); unsubscribeMatch = null; }
    stopStartWatchdog();
    currentRoomCode = null;
    playerSlot = null;
    isReady = false;
    matchStartRequested = false;
    isRedirecting = false;
    showView("landing");
});

// ── Bootstrap ─────────────────────────────────────────
init();
