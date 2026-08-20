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
} from "../firebase/multiplayerService.js?v=reveal-10";

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
const btnConfirmCreate  = $("btnConfirmCreate");
const btnBackFromCreate = $("btnBackFromCreate");
const mpCreateError     = $("mpCreateError");

// Lobby
const lobbyTitle       = $("lobbyTitle");
const lobbyCodeBox     = $("lobbyCodeBox");
const lobbyCodeDisplay = $("lobbyCodeDisplay");
const btnCopyCode      = $("btnCopyCode");
const lobbyDeckSelect  = $("lobbyDeckSelect");
const btnReady         = $("btnReady");
const btnStart         = $("btnStart");
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

function handleMatchUpdate(match) {
    if (!match) return;
    if (isRedirecting) return; // already heading into the game

    const p1 = match.players?.p1;
    const p2 = match.players?.p2;

    updateLobbyPlayerUI(lobbyP1, p1?.name, p1?.ready);
    updateLobbyPlayerUI(lobbyP2, p2?.name, p2?.ready);

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

    // Firebase auth
    try {
        setStatus("Connecting…", "connecting");
        await signInGuest();
        currentUser = await waitForUser();
        setStatus("Connected", "connected");
        watchActiveGames();
    } catch (e) {
        setStatus("Connection failed", "error");
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

// Create room
btnConfirmCreate.addEventListener("click", async () => {
    clearError(mpCreateError);
    if (!currentUser) { showError(mpCreateError, "Not connected yet."); return; }

    const nickname = getNickname() || "Player 1";
    const lobbyName = lobbyNameInput.value.trim() || nickname + "'s Game";
    const isPublic  = false; // rooms are always private, joined by code

    btnConfirmCreate.disabled = true;
    btnConfirmCreate.textContent = "Creating…";

    try {
        const created = await createRoom(currentUser, { isPublic, lobbyName, nickname });
        currentRoomCode = created.roomCode;
        playerSlot = "p1";

        // Carry the deck chosen on the create screen into the lobby's picker.
        openLobbyView(createDeckSelect.value);

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

    const selectedDeck = window.getDeckById?.(lobbyDeckSelect.value);
    if (!selectedDeck) { showError(mpLobbyError, "Choose a deck first."); return; }

    btnReady.disabled = true;
    btnReady.textContent = "Saving…";
    isReady = true;

    try {
        // Clear any previous failure so readying up with a different deck can retry.
        await clearMatchStartError(currentRoomCode).catch(() => {});
        matchStartRequested = false;
        await setPlayerDeck(currentRoomCode, playerSlot, {
            id: selectedDeck.id,
            name: selectedDeck.name,
            leaderKey: selectedDeck.leaderKey,
            deckText: selectedDeck.deckText
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
