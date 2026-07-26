// self.js

// =========================
// Image Paths
// =========================

const cardBackImage = "../images/basic/card-back-normal.jpg";

// A card must never render as a blank/broken image. If artwork is missing - for
// example an opponent played a custom card that isn't in this client's card
// pool - fall back to the card back so the card is still clearly visible on the
// board. Callers that show a face-down card pass the back directly.
function cardArtSrc(card) {
    const src = card && typeof card.image === "string" ? card.image.trim() : "";
    return src || cardBackImage;
}
const donBackImage = "../images/basic/card-back-don.webp";
const donImage = "../images/basic/card-front-don.webp";

// =========================
// Stub Functions for Removed Game Mechanics
// =========================

// These stub functions replace the game mechanic functions that were removed.
// All game logic has been disabled to make the board fully manual.

window.CardEffects = {
    getAvailableBlockers: () => [],
    canBlock: () => false,
    hasCardName: () => false,
    canAttackOnTurnPlayed: () => false,
    canAttackCharactersOnTurnPlayed: () => false,
    hasKeyword: () => false,
    normalizeKeyword: (kw) => kw
};

function createCardInstance(card) {
    return { ...card, instanceId: `card-${Math.random()}` };
}

function getCardPlayCost(card) {
    return Number(card.cost ?? card.playCost ?? 0);
}

function getCardEffectiveCost(card) {
    return getCardPlayCost(card);
}

// =========================
// Online Stuff
// =========================

const urlParams = new URLSearchParams(window.location.search);

const gameMode = urlParams.get("mode") || "local";
const roomCode = urlParams.get("room");
const playerSlot = urlParams.get("player");

const isOnlineMatch = gameMode === "online";
const onlinePlayerLabels = {
    p1: "Player 1",
    p2: "Player 2"
};

let onlineMultiplayerService = null;
let onlineFirebaseApp = null;
let onlineMatchUnsubscribe = null;
let onlinePrivateUnsubscribe = null;
let onlineUser = null;
let onlinePublicState = null;
let onlinePrivateState = null;
let lastOnlineTurnKey = null;
let onlineProcessedTurnKey = null;
let onlineLastRevealKey = null;
let onlineLastAttackKey = null;
let onlineActiveAttackId = null;
let onlineProcessedDefenderAttackEffectId = null;
let onlineShownGameOverKey = null;
let onlinePendingWinnerSlot = null;

if (isOnlineMatch) {
    console.log("Online match loaded.");
    console.log("Room code:", roomCode);
    console.log("Player slot:", playerSlot);
}

const onlineMatchInfo = document.getElementById("onlineMatchInfo");

if (isOnlineMatch) {
    updateOnlineMatchInfo();
}

function getPlayerKeyFromOnlineSlot(slot) {
    if (slot === "p1") return "player1";
    if (slot === "p2") return "player2";

    return null;
}

function getPlayerKey(player) {
    if (!player || !gameState) return null;
    if (player === gameState.player1) return "player1";
    if (player === gameState.player2) return "player2";
    return null;
}

function getOnlineSlotFromPlayerKey(playerKey) {
    if (playerKey === "player1") return "p1";
    if (playerKey === "player2") return "p2";

    return null;
}

function isCurrentOnlinePlayer() {
    return Boolean(onlinePublicState?.currentPlayer && onlinePublicState.currentPlayer === playerSlot);
}

function getOwnOnlinePlayerKey() {
    return getPlayerKeyFromOnlineSlot(playerSlot);
}

function isOwnOnlinePlayer(player) {
    return isOnlineMatch && player && getOwnOnlinePlayerKey() && player === gameState?.[getOwnOnlinePlayerKey()];
}

function getOnlinePublicPlayerKey(playerKey) {
    return playerKey === "player1" ? "player1" : "player2";
}

function createHiddenCards(count) {
    return Array.from({ length: Number(count || 0) }, (_, index) => ({
        instanceId: `hidden-${index}`,
        hidden: true
    }));
}

function createPublicCardSnapshot(card) {
    if (!card) return null;

    return {
        name: card.name,
        image: card.image,
        cardNumber: card.cardNumber,
        cardType: card.cardType,
        type: card.type,
        color: card.color,
        cost: card.cost,
        power: card.power,
        counter: card.counter,
        attribute: card.attribute,
        keywords: card.keywords || [],
        effects: card.effects || [],
        instanceId: card.instanceId,
        state: card.state || "active",
        faceUp: Boolean(card.faceUp)
    };
}

function getOnlinePlayerSnapshot(playerKey) {
    return onlinePublicState?.[getOnlinePublicPlayerKey(playerKey)] || null;
}

// Setup phases where the server is still authoritative over the own player's
// zones (dealing, mulligan). Once the game reaches "main" we hand authority to
// the local client so it behaves exactly like solo play.
const ONLINE_SETUP_PHASES = new Set(["waiting", "diceRoll", "mulligan"]);

// True once the own player's zones have been locked to local authority. After
// this we NEVER overwrite the own player from an incoming Firebase update - the
// local client is the single source of truth for its own side and just pushes
// changes out. This is what stops the "echo of my previous action reverts my
// current action" race (e.g. playing a second character was undone by the echo
// of the first, or life edits snapping back).
let ownStateLockedToLocal = false;

function applyBoardToPlayer(player, boardJson) {
    const board = safeParseJson(boardJson, null);
    if (!board) return;
    // Rebuild artwork locally - it is intentionally not transmitted.
    player.leader = hydrateCard(board.leader || null);
    player.characters = hydrateCards(board.characters || []);
    player.stage = hydrateCard(board.stage || null);
    player.trash = hydrateCards(board.trash || []);
    player.extraFaceUp = hydrateCards(board.extraFaceUp || []);
    player.extraFaceDown = hydrateCards(board.extraFaceDown || []);
    player.tokens = hydrateCards(board.tokens || []);
    // Annotations carry no card data, so they need no hydration - just keep them
    // on the player so renderOnlineGameState can hand the opponent's to
    // manual-play for drawing.
    player.annotations = board.annotations || null;

    // tokenTypes is STATIC per-deck configuration, not live board state: it is
    // the menu of tokens a deck can make, and it never changes during a match.
    // A match document written before tokens existed (or by a client that hasn't
    // pushed its board yet) reports an empty list, and blindly assigning that
    // wiped the token zone a split second after every page load - the tokens
    // "flashed then vanished". So an empty remote list is treated as "no
    // information" and never clobbers a list we already know.
    const remoteTokenTypes = hydrateCards(board.tokenTypes || []);
    if (remoteTokenTypes.length > 0 || !Array.isArray(player.tokenTypes)) {
        player.tokenTypes = remoteTokenTypes;
    }
    player.floatingDon = Array.isArray(board.floatingDon) ? board.floatingDon : [];
    player.don = Number(board.don || 0);
    player.restedDon = Number(board.restedDon || 0);
    // Rebuilt from the counts by getDonSlots if absent or inconsistent.
    player.donOrder = Array.isArray(board.donOrder) ? board.donOrder : null;
}

function applyOnlinePlayerState(playerKey) {
    const publicPlayer = getOnlinePlayerSnapshot(playerKey);
    const player = gameState?.[playerKey];

    if (!publicPlayer || !player) return;

    const isOwnPlayer = playerKey === getOwnOnlinePlayerKey();
    player.name = playerKey === "player1" ? "Player 1" : "Player 2";
    player.donDeck = Number(publicPlayer.tokenDeckCount ?? 10);
    player.turns = Number(publicPlayer.turns || 0);

    if (isOwnPlayer) {
        const phase = onlinePublicState?.phase;
        const inSetup = ONLINE_SETUP_PHASES.has(phase);

        // Locked to local authority: ignore this echo entirely.
        if (ownStateLockedToLocal && !inSetup) return;

        // Bootstrap (and, during setup, keep re-applying) the own player's state
        // from the server so the initial deal and mulligan land correctly.
        const zones = safeParseJson(onlinePrivateState?.zonesJson, null)
            || (onlinePrivateState && (onlinePrivateState.hand || onlinePrivateState.deck || onlinePrivateState.life)
                ? { hand: onlinePrivateState.hand, deck: onlinePrivateState.deck, life: onlinePrivateState.life }
                : null);

        // Don't lock until the private zones have actually arrived - otherwise
        // we'd freeze an empty hand/deck/life.
        if (!zones) return;

        applyBoardToPlayer(player, publicPlayer.boardJson);
        player.hand = hydrateCards(zones.hand || []);
        player.deck = hydrateCards(zones.deck || []);
        player.life = hydrateCards(zones.life || []);

        // Self-heal the token menu for matches whose document was written before
        // tokens existed: rebuild it from the deck this player actually chose.
        // The next board sync pushes it up, so the opponent sees it too.
        if (!player.tokenTypes?.length) {
            const deckTokens = onlinePrivateState?.selectedDeck?.tokens;
            if (Array.isArray(deckTokens) && deckTokens.length) {
                player.tokenTypes = resolveTokenTypes(deckTokens);
            }
        }

        if (!inSetup) {
            ownStateLockedToLocal = true;
        }
        return;
    }

    // Opponent: always apply their authoritative snapshot. Their hand/deck/life
    // stay hidden (counts only), with any revealed life cards shown.
    applyBoardToPlayer(player, publicPlayer.boardJson);

    player.hand = createHiddenCards(publicPlayer.handCount);
    player.deck = createHiddenCards(publicPlayer.deckCount);
    player.life = createHiddenCards(publicPlayer.lifeCount);

    (publicPlayer.faceUpLifeCards || []).forEach(entry => {
        const index = Number(entry.index);
        if (index >= 0 && index < player.life.length && entry.card) {
            player.life[index] = hydrateCard({ ...entry.card, faceUp: true });
        }
    });
}

function renderOnlineGameState() {
    if (!gameState) return;

    clearHandSelection();
    clearBoardSelection();
    clearSelectedCardActions();
    clearSelectedBoardActions();

    updateDonDisplay();
    renderDecks();
    renderDonDecks();
    renderLifeCards();
    renderLeaders();
    renderHands();
    renderCharacters();
    renderTrash();
    renderStages();
    renderExtraPiles();
    window.renderFloatingDon?.();

    // Draw whatever the opponent has drawn. Must come after the zone renders,
    // since annotations anchor to card elements those renders rebuild.
    const foeKey = getOwnOnlinePlayerKey() === "player1" ? "player2" : "player1";
    window.manualPlay?.setRemoteAnnotations?.(gameState[foeKey]?.annotations || null);
}

function applyOnlineStateToGame() {
    if (!isOnlineMatch || !gameState || !onlinePublicState?.player1 || !onlinePublicState?.player2) {
        return;
    }

    const currentPlayerKey = getPlayerKeyFromOnlineSlot(onlinePublicState.currentPlayer);

    applyOnlinePlayerState("player1");
    applyOnlinePlayerState("player2");

    gameState.currentPlayer = currentPlayerKey ? gameState[currentPlayerKey] : null;
    gameState.currentPhase = onlinePublicState.phase || "main";
    gameState.turnNumber = Number(onlinePublicState.turnNumber || 1);

    renderOnlineGameState();
    updateOnlinePhaseButton();
}

function updateOnlineMatchInfo() {
    if (!onlineMatchInfo) return;

    onlineMatchInfo.classList.remove("hidden");

    const currentPlayer = onlinePublicState?.currentPlayer;
    const currentPlayerText = currentPlayer
        ? onlinePlayerLabels[currentPlayer] || currentPlayer.toUpperCase()
        : "Waiting";
    const phaseText = onlinePublicState?.phase || "Waiting";
    const turnText = onlinePublicState?.turnNumber ?? "-";
    const dice = onlinePublicState?.setup?.dice || {};
    const firstPlayer = onlinePublicState?.firstPlayer ||
        onlinePublicState?.setup?.turnChoice?.firstPlayer ||
        null;
    const secondPlayer = onlinePublicState?.secondPlayer ||
        onlinePublicState?.setup?.turnChoice?.secondPlayer ||
        null;
    const turnOrderText = firstPlayer && secondPlayer
        ? `Order: ${onlinePlayerLabels[firstPlayer] || firstPlayer.toUpperCase()} first, ${onlinePlayerLabels[secondPlayer] || secondPlayer.toUpperCase()} second`
        : "Order: Not chosen";
    const setupText = onlinePublicState?.phase === "diceRoll"
        ? `Rolls: P1 ${dice.p1Roll || "-"} / P2 ${dice.p2Roll || "-"}${dice.tie ? " (tie)" : ""}`
        : `Turn #: ${turnText}`;

    onlineMatchInfo.textContent = [
        `Online Room: ${roomCode || "Unknown"}`,
        `You are ${(playerSlot || "unknown").toUpperCase()}`,
        `Turn: ${currentPlayerText}`,
        `Phase: ${phaseText}`,
        turnOrderText,
        setupText
    ].join(" | ");
}

function applyOnlinePublicState(publicState = {}) {
    if (!isOnlineMatch) return;

    onlinePublicState = {
        phase: publicState.phase || "main",
        currentPlayer: publicState.currentPlayer || null,
        turnNumber: Number(publicState.turnNumber || 1),
        winner: publicState.winner || null,
        gameOverReasonTitle: publicState.gameOverReasonTitle || null,
        gameOverReasonText: publicState.gameOverReasonText || null,
        firstPlayer: publicState.firstPlayer || null,
        secondPlayer: publicState.secondPlayer || null,
        playerTurns: publicState.playerTurns || { p1: 0, p2: 0 },
        setup: publicState.setup || {},
        revealedCards: publicState.revealedCards || [],
        currentAttack: publicState.currentAttack || null,
        player1: publicState.player1 || null,
        player2: publicState.player2 || null
    };

    const turnKey = `${onlinePublicState.currentPlayer}:${onlinePublicState.turnNumber}:${onlinePublicState.phase}`;
    const turnStartKey = `${onlinePublicState.currentPlayer}:${onlinePublicState.turnNumber}`;

    if (lastOnlineTurnKey && turnKey !== lastOnlineTurnKey) {
        addGameLog(
            `Online state updated: ${onlinePlayerLabels[onlinePublicState.currentPlayer] || "Waiting"} ` +
            `- ${onlinePublicState.phase}, turn ${onlinePublicState.turnNumber}.`
        );
    }

    lastOnlineTurnKey = turnKey;

    // A rematch re-deals the match: the phase drops back to diceRoll with the
    // winner cleared. Every zone, hand and deck is new, so reload rather than
    // trying to unpick the finished game's local state in place.
    if (onlineShownGameOverKey &&
        onlinePublicState.phase === "diceRoll" &&
        !onlinePublicState.winner) {
        stopRematchWatch();
        window.location.reload();
        return;
    }

    applyOnlineStateToGame();
    updateOnlineMatchInfo();
    renderOnlineSetupOverlay();
    // Nothing used to call this, so a finished match (including a concede) was
    // written to the match document and then ignored by both clients.
    handleOnlineGameOver();
    maybeRunOnlineTurnStart(turnStartKey);
    showOnlineRevealedCards();
    maybeAnnounceOwnTurn();
}

function removeOnlineTurnChoiceButtons() {
    document.getElementById("onlineTurnChoiceButtons")?.remove();
}

function removeOnlineMulliganButtons() {
    document.getElementById("onlineMulliganButtons")?.remove();
}

// ── Online setup overlay ─────────────────────────────────
// Every pre-game step (dice roll, turn choice, mulligan) used to render into a
// ".phase-controls" element that does not exist anywhere in self.html, so each
// of those builders silently returned and a match sat on "Phase: diceRoll |
// Turn: Waiting" forever with no way to advance. This overlay owns its own DOM
// and is rebuilt from the live public state every time it changes, so it can
// never fall out of sync with the match.

function removeOnlineSetupOverlay() {
    document.getElementById("onlineSetupOverlay")?.remove();
}

function buildSetupButton(label, onClick, variant = "primary") {
    const button = document.createElement("button");
    button.className = `setup-overlay-btn ${variant}`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
}

function renderOnlineSetupOverlay() {
    if (!isOnlineMatch || !onlinePublicState) {
        removeOnlineSetupOverlay();
        return;
    }

    const phase = onlinePublicState.phase;

    // Setup is over once the match reaches normal play.
    if (phase !== "diceRoll" && phase !== "mulligan") {
        removeOnlineSetupOverlay();
        return;
    }

    removeOnlineSetupOverlay();

    const overlay = document.createElement("div");
    overlay.id = "onlineSetupOverlay";
    overlay.className = "setup-overlay";

    const card = document.createElement("div");
    card.className = "setup-overlay-card";

    const heading = document.createElement("h2");
    const body = document.createElement("div");
    body.className = "setup-overlay-body";
    const actions = document.createElement("div");
    actions.className = "setup-overlay-actions";

    if (phase === "diceRoll") {
        renderDiceRollStep(heading, body, actions);
    } else {
        renderMulliganStep(heading, body, actions);
    }

    card.appendChild(heading);
    card.appendChild(body);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

function renderDiceRollStep(heading, body, actions) {
    const dice = onlinePublicState?.setup?.dice || {};
    const ownRoll = dice[`${playerSlot}Roll`];
    const foeSlot = playerSlot === "p1" ? "p2" : "p1";
    const foeRoll = dice[`${foeSlot}Roll`];
    const winner = dice.winner;

    heading.textContent = "Roll for turn order";

    const rolls = document.createElement("div");
    rolls.className = "setup-dice-rolls";
    rolls.innerHTML = `
        <div class="setup-die"><span>You</span><strong>${ownRoll ?? "–"}</strong></div>
        <div class="setup-die"><span>Opponent</span><strong>${foeRoll ?? "–"}</strong></div>
    `;
    body.appendChild(rolls);

    const status = document.createElement("p");
    status.className = "setup-overlay-status";

    // A tie wipes both rolls so each player rolls again.
    if (dice.tie) {
        status.textContent = `Tied on ${ownRoll ?? "?"} — both players roll again.`;
        body.appendChild(status);
        actions.appendChild(buildSetupButton("Roll D12", handleOnlineDiceRoll));
        return;
    }

    if (!winner) {
        status.textContent = ownRoll
            ? "Waiting for your opponent to roll…"
            : "Roll a D12. The higher roll chooses who goes first.";
        body.appendChild(status);

        if (!ownRoll) {
            actions.appendChild(buildSetupButton("Roll D12", handleOnlineDiceRoll));
        }
        return;
    }

    if (winner === playerSlot) {
        status.textContent = `You won the roll ${ownRoll}–${foeRoll}. Choose your turn order.`;
        body.appendChild(status);
        actions.appendChild(buildSetupButton("Go 1st", () => handleOnlineTurnChoice("first")));
        actions.appendChild(buildSetupButton("Go 2nd", () => handleOnlineTurnChoice("second"), "secondary"));
        return;
    }

    status.textContent = `Opponent won the roll ${foeRoll}–${ownRoll}. Waiting for them to choose…`;
    body.appendChild(status);
}

function renderMulliganStep(heading, body, actions) {
    const mulligan = onlinePublicState?.setup?.mulligan || {};
    const ownDone = Boolean(mulligan[playerSlot]?.done);

    heading.textContent = "Mulligan";

    const status = document.createElement("p");
    status.className = "setup-overlay-status";

    if (ownDone) {
        status.textContent = "Waiting for your opponent to decide…";
        body.appendChild(status);
        return;
    }

    status.textContent = "Keep your opening hand, or shuffle it back and draw a new one.";
    body.appendChild(status);
    actions.appendChild(buildSetupButton("Keep Hand", () => handleOnlineMulligan(false)));
    actions.appendChild(buildSetupButton("Mulligan", () => handleOnlineMulligan(true), "secondary"));
}

function showOnlineRevealedCards() {
    const revealedCards = onlinePublicState?.revealedCards || [];

    if (!revealedCards.length) return;

    const latestReveal = revealedCards[revealedCards.length - 1];
    const cards = latestReveal.cards || [];

    const revealKey = latestReveal.id || `${latestReveal.player}:${cards.map(card => card.instanceId || card.cardNumber || card.name).join(",")}`;

    if (!cards.length || onlineLastRevealKey === revealKey) return;

    onlineLastRevealKey = revealKey;

    addGameLog(
        `${onlinePlayerLabels[latestReveal.player] || "Player"} revealed: ` +
        cards.map(card => card.name).join(", ")
    );
}

function handleOnlineGameOver() {
    if (!isOnlineMatch || !gameState || onlinePublicState?.phase !== "gameOver" || !onlinePublicState?.winner) {
        return;
    }

    const gameOverKey = `${onlinePublicState.winner}:${onlinePublicState.phase}`;

    if (onlineShownGameOverKey === gameOverKey) {
        return;
    }

    const winnerPlayerKey = getPlayerKeyFromOnlineSlot(onlinePublicState.winner);
    const winnerPlayer = winnerPlayerKey ? gameState[winnerPlayerKey] : null;

    if (!winnerPlayer) {
        return;
    }

    onlineShownGameOverKey = gameOverKey;
    onlinePendingWinnerSlot = onlinePublicState.winner;
    gameState.currentPhase = "gameOver";

    pendingAttack = null;
    currentAttack = null;
    pendingBlock = null;
    pendingTrashChoice = null;
    pendingReplacePlay = null;

    clearAttackTargets();
    clearBlockerTargets();
    clearBattleControls();
    clearHandSelection();
    clearBoardSelection();
    clearReplaceTargets();
    clearTrashChoiceTargets();
    clearCancelAttackButton();
    clearAttackArrow();

    // Show the result from THIS player's seat rather than naming the winner, so
    // each side reads "You Won" or "You Lost" on their own screen.
    const youWon = onlinePublicState.winner === playerSlot;

    showGameOverPopup(
        winnerPlayer,
        onlinePublicState.gameOverReasonTitle || "Victory",
        onlinePublicState.gameOverReasonText || `${winnerPlayer.name} won the online match.`,
        youWon ? "You Won" : "You Lost"
    );
}

async function publishOnlineReveal(cards) {
    if (!isOnlineMatch || !onlineMultiplayerService || !cards?.length) return;

    const revealedCards = onlinePublicState?.revealedCards || [];

    await onlineMultiplayerService.updatePublicState(roomCode, {
        revealedCards: [
            ...revealedCards,
            {
                id: crypto.randomUUID(),
                player: playerSlot,
                cards: cards.map(card => ({
                    name: card.name,
                    image: card.image,
                    cardNumber: card.cardNumber,
                    cardType: card.cardType,
                    type: card.type
                }))
            }
        ]
    });
}

async function syncOnlineCurrentAttack(attackState) {
    if (!isOnlineMatch || !onlineMultiplayerService) return;

    await onlineMultiplayerService.updateCurrentAttack(roomCode, attackState);
}

function applyOnlinePrivateState(privateState = {}) {
    if (!isOnlineMatch) return;

    // New format stores the three private zones as a single JSON string; keep
    // reading the old field shape too for backward compatibility.
    const zones = safeParseJson(privateState.zonesJson, null) || {
        hand: privateState.hand || [],
        deck: privateState.deck || [],
        life: privateState.life || []
    };

    onlinePrivateState = {
        selectedDeck: privateState.selectedDeck || null,
        zonesJson: privateState.zonesJson || null,
        // Rebuild artwork locally - it's intentionally not transmitted.
        hand: hydrateCards(zones.hand || []),
        deck: hydrateCards(zones.deck || []),
        life: hydrateCards(zones.life || [])
    };

    applyOnlineStateToGame();
    updateOnlinePhaseButton();

    if (onlinePublicState) {
        maybeRunOnlineTurnStart(
            `${onlinePublicState.currentPlayer}:${onlinePublicState.turnNumber}`
        );
    }
}

// Artwork is never sent over the wire (see stripCardForSync) - it's rebuilt from
// the local card database on read. This keeps a match document a few KB instead
// of several MB, which is what made online play so slow.
function stripCard(card) {
    return card && onlineMultiplayerService?.stripCardForSync
        ? onlineMultiplayerService.stripCardForSync(card)
        : card;
}

function stripCards(cards) {
    return Array.isArray(cards) ? cards.map(card => (card ? stripCard(card) : card)) : cards;
}

function hydrateCards(cards) {
    return Array.isArray(cards) && onlineMultiplayerService?.hydrateSyncedCards
        ? onlineMultiplayerService.hydrateSyncedCards(cards)
        : cards;
}

function hydrateCard(card) {
    return card && onlineMultiplayerService?.hydrateSyncedCard
        ? onlineMultiplayerService.hydrateSyncedCard(card)
        : card;
}

// The visible board is serialized as a single JSON STRING. Firebase Realtime
// Database does not store arrays natively - it drops null values and turns
// sparse/hole-y arrays into objects, which silently corrupted the fixed 5-slot
// character array (a card in slot 2 would come back reindexed or as an object,
// making it render as a card back and blocking the next play). A JSON string
// round-trips byte-for-byte, so the exact structure survives.
function createPublicPlayerStateFromLocal(player) {
    const board = {
        leader: stripCard(player.leader || null),
        characters: stripCards(player.characters || []),
        stage: stripCard(player.stage || null),
        trash: stripCards(player.trash || []),
        extraFaceUp: stripCards(player.extraFaceUp || []),
        extraFaceDown: stripCards(player.extraFaceDown || []),
        tokens: stripCards(player.tokens || []),
        // Which DON!! are rested, left to right (see getDonSlots).
        donOrder: Array.isArray(player.donOrder) ? player.donOrder : null,
        // Arrows and notes drawn by THIS client. Attached to the own player only
        // - they belong to whoever drew them, and serialising them onto the
        // opponent's board too would echo our drawings straight back at us.
        annotations: isOwnOnlinePlayer(player)
            ? (window.manualPlay?.getLocalAnnotations?.() || null)
            : (player.annotations || null),
        // Static per-deck info, but cheap and it lets the opponent see that this
        // player has a token zone at all.
        tokenTypes: stripCards(player.tokenTypes || []),
        floatingDon: player.floatingDon || [],
        don: Number(player.don || 0),
        restedDon: Number(player.restedDon || 0)
    };

    return {
        boardJson: JSON.stringify(board),
        handCount: player.hand?.length || 0,
        deckCount: player.deck?.length || 0,
        lifeCount: player.life?.length || 0,
        activeTokens: Number(player.don || 0),
        restedTokens: Number(player.restedDon || 0),
        tokenDeckCount: Math.max(0, 10 - getDonOnField(player)),
        turns: Number(player.turns || 0),
        faceUpLifeCards: (player.life || [])
            .map((card, index) => card?.faceUp ? { index, card: createPublicCardSnapshot(card) } : null)
            .filter(Boolean)
    };
}

function createOwnPrivateStateFromLocal(player) {
    const zones = {
        hand: stripCards(player.hand || []),
        deck: stripCards(player.deck || []),
        life: stripCards(player.life || [])
    };
    return {
        selectedDeck: onlinePrivateState?.selectedDeck || null,
        // JSON string for the same lossless round-trip reason as the board.
        zonesJson: JSON.stringify(zones)
    };
}

function safeParseJson(value, fallback) {
    if (typeof value !== "string") return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function syncOnlineStateFromLocal() {
    if (!isOnlineMatch || !onlineMultiplayerService || !onlineUser || !gameState) return;

    const ownPlayerKey = getOwnOnlinePlayerKey();
    const ownPlayer = ownPlayerKey ? gameState[ownPlayerKey] : null;

    if (!ownPlayer) return;

    const publicKey = getOnlinePublicPlayerKey(ownPlayerKey);

    const publicState = {
        playerTurns: {
            ...(onlinePublicState?.playerTurns || {}),
            [playerSlot]: Number(ownPlayer.turns || 0)
        },
        [publicKey]: createPublicPlayerStateFromLocal(ownPlayer)
    };

    if (gameState.currentPhase === "gameOver") {
        publicState.phase = "gameOver";
        publicState.winner = onlinePublicState?.winner || onlinePendingWinnerSlot || null;
    }

    const privateState = createOwnPrivateStateFromLocal(ownPlayer);

    onlinePrivateState = privateState;

    await onlineMultiplayerService.sendMultiplayerAction(
        roomCode,
        onlineUser,
        "updateState",
        {
            publicState,
            privateState
        }
    );
}

// Exposed so the manual-play board handlers (drag/drop, rest, DON attach) can
// push the local player's state to the opponent after a user action. Debounced
// so a single interaction that re-renders several zones results in one push.
// No-ops entirely in local (non-online) play.
let onlineBoardSyncTimer = null;
function scheduleOnlineBoardSync() {
    if (!isOnlineMatch || !onlineMultiplayerService || !onlineUser) return;
    clearTimeout(onlineBoardSyncTimer);
    onlineBoardSyncTimer = setTimeout(() => {
        syncOnlineStateFromLocal().catch(error => console.error("Online board sync failed:", error));
    }, 80);
}
window.scheduleOnlineBoardSync = scheduleOnlineBoardSync;

async function syncOnlinePublicBoardFromLocal(extraState = {}) {
    if (!isOnlineMatch || !onlineMultiplayerService || !gameState) return;

    const ownPlayerKey = getOwnOnlinePlayerKey();
    const ownPlayer = ownPlayerKey ? gameState[ownPlayerKey] : null;
    const publicKey = ownPlayerKey ? getOnlinePublicPlayerKey(ownPlayerKey) : null;

    if (!ownPlayer || !publicKey) return;

    await onlineMultiplayerService.updatePublicState(roomCode, {
        [publicKey]: createPublicPlayerStateFromLocal(ownPlayer),
        ...extraState
    });
}

async function syncOnlineAllPublicBoardsFromLocal(extraState = {}) {
    if (!isOnlineMatch || !onlineMultiplayerService || !gameState) return;

    await onlineMultiplayerService.updatePublicState(roomCode, {
        player1: createPublicPlayerStateFromLocal(gameState.player1),
        player2: createPublicPlayerStateFromLocal(gameState.player2),
        ...extraState
    });
}

// Make sure the match is actually initialised once we're on the game page.
// Retries past the server-side stale-claim window so an abandoned start claim
// (client navigated away mid-init) is reclaimed instead of deadlocking.
async function ensureOnlineMatchStarted(attempts = 4, delayMs = 4000) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const match = await onlineMultiplayerService.getMatch(roomCode);
            if (!match) return;
            if (match.status === "started") return;

            if (match.startError) {
                addGameLog(`Match could not start: ${match.startError}`);
                return;
            }

            if (attempt === 0) addGameLog("Finishing match setup…");
            await onlineMultiplayerService.startMatch(roomCode);

            const after = await onlineMultiplayerService.getMatch(roomCode);
            if (after?.status === "started") {
                addGameLog("Match setup complete.");
                return;
            }
        } catch (error) {
            console.warn("Online match setup attempt failed:", error);
            if (attempt === attempts - 1) {
                addGameLog(`Could not finish match setup: ${error.message}`);
                return;
            }
        }

        // Wait long enough that an abandoned claim goes stale and can be retaken.
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

async function maybeRunOnlineTurnStart(turnKey) {
    if (!isOnlineMatch || !onlinePrivateState || !gameState || !isCurrentOnlinePlayer()) {
        return;
    }

    if (onlinePublicState?.phase !== "main" || onlinePublicState?.currentAttack) {
        return;
    }

    const player = gameState[getOwnOnlinePlayerKey()];

    if (!player) return;

    const expectedTurns = Number(onlinePublicState?.turnNumber || 1);
    const publicTurns = Number(
        onlinePublicState?.playerTurns?.[playerSlot] ??
        onlinePublicState?.[getOnlinePublicPlayerKey(getOwnOnlinePlayerKey())]?.turns ??
        player.turns ??
        0
    );

    if (publicTurns >= expectedTurns || onlineProcessedTurnKey === turnKey) {
        return;
    }

    onlineProcessedTurnKey = turnKey;

    player.turns = expectedTurns;
    player.leaderAttacksThisTurn = 0;

    // Standard OPTCG opening: the player going first takes 1 DON!! and skips
    // their draw on turn 1; the player going second takes the usual 2 and draws.
    // Every turn after that is 2 DON!! for both.
    const isOwnFirstTurn = expectedTurns === 1;
    const firstSlot = onlinePublicState?.firstPlayer ||
        onlinePublicState?.setup?.turnChoice?.firstPlayer ||
        null;
    const goesFirst = Boolean(firstSlot) && firstSlot === playerSlot;
    const donGain = (isOwnFirstTurn && goesFirst) ? 1 : 2;

    // Runs the exact same primitives as the solo path (startPlayerTurn). This
    // used to call runRefreshPhase/runDrawPhase/runDonPhase from phases.js,
    // whose helpers (refreshPlayerCards/drawCard/addDon) do not exist in this
    // build - so the very first online turn threw and the player silently got
    // no restand, no draw and no DON!!. That's why multiplayer behaved nothing
    // like vs-self.
    applyTurnStartToPlayer(player, {
        isFirstTurn: isOwnFirstTurn,
        skipDraw: isOwnFirstTurn && goesFirst,
        donGain
    });

    gameState.currentPhase = "main";

    renderOnlineGameState();

    await syncOnlineStateFromLocal();
    updateOnlinePhaseButton();
}

// Shared start-of-turn behaviour for BOTH solo and online play, so the two can
// never drift apart again: restand, detach DON!!, draw, then gain DON!!.
function applyTurnStartToPlayer(player, { isFirstTurn, skipDraw, donGain }) {
    const settings = getTurnAutomationSettings();
    const label = player?.name || "Player";

    // Nothing on the board to refresh on your opening turn.
    if (!isFirstTurn) {
        if (settings.autoRestand) {
            restandPlayerCards(player);
            addGameLog(`${label} restands all cards and DON!!.`);
        }
        if (settings.autoDetach) {
            const returned = detachPlayerDon(player);
            if (returned > 0) addGameLog(`${label} returns ${returned} attached DON!!.`);
        }
    }

    if (settings.autoDraw && !skipDraw && player.deck?.length > 0) {
        player.hand.push(player.deck.pop());
        addGameLog(`${label} drew 1 card.`);
    }

    if (settings.autoAddDon) {
        player.don = Math.min((player.don || 0) + donGain, 10);
        addGameLog(`${label}'s turn starts: +${donGain} DON!!.`);
    }
}

// The board markup is authored from Player 1's seat: the bottom (near) section
// holds player1 and the top (far) section holds player2, with the far section
// rotated 180deg and its contents counter-rotated. For Player 2 that means they
// were looking at the match from their opponent's chair.
//
// Fix by swapping BOTH the DOM position and the near/far classes of the two
// sections. Ownership is carried by element ids and data-player attributes -
// which drag/drop and the render functions rely on - so those travel with each
// player's own elements and nothing about the game logic changes. Only which
// physical half of the screen a player's cards occupy, and which half gets the
// rotated "far side" treatment.
function applyOwnSidePerspective() {
    if (!isOnlineMatch || playerSlot !== "p2") return;

    const board = document.querySelector(".game-board");
    const ownArea = document.querySelector(".play-area.opponent-area"); // holds player2
    const foeArea = document.querySelector(".play-area.player-area");   // holds player1
    const ownHand = document.getElementById("player2Hand");
    const foeHand = document.getElementById("player1Hand");

    if (!board || !ownArea || !foeArea || !ownHand || !foeHand) return;

    // Your side becomes the near side, the opponent's becomes the far side.
    ownArea.classList.replace("opponent-area", "player-area");
    foeArea.classList.replace("player-area", "opponent-area");
    ownHand.classList.replace("opponent-hand", "player-hand");
    foeHand.classList.replace("player-hand", "opponent-hand");

    // Opponent on top, you at the bottom.
    board.append(foeHand, foeArea, ownArea, ownHand);

    // Flip the extra-zones column so your piles sit at the bottom too.
    const extraColumn = document.getElementById("extraZonesColumn");
    const ownExtra = document.getElementById("extraZonesOpponent"); // holds player2 piles
    const foeExtra = document.getElementById("extraZonesSelf");      // holds player1 piles
    if (extraColumn && ownExtra && foeExtra) {
        extraColumn.append(foeExtra, ownExtra);
    }

    document.body.classList.add("perspective-p2");
}

// ── In-match chat ────────────────────────────────────────
// Chat renders inline with the game log so players can talk without leaving the
// board. Only enabled for online matches.
let onlineChatUnsubscribe = null;
let renderedChatIds = new Set();

function getOwnChatName() {
    return playerSlot === "p2" ? "Player 2" : "Player 1";
}

function appendChatMessage(message) {
    const log = document.getElementById("gameLogMessages");
    if (!log) return;

    const isOwn = message.sender === getOwnChatName();
    const entry = document.createElement("div");
    entry.className = `game-log-entry chat-entry${isOwn ? " chat-entry-own" : ""}`;

    const who = document.createElement("strong");
    who.textContent = `${message.sender}: `;
    entry.appendChild(who);
    // textContent (not innerHTML) so message text can never inject markup.
    entry.appendChild(document.createTextNode(message.text));

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function setupOnlineChat() {
    if (!isOnlineMatch || !onlineMultiplayerService) return;

    const form = document.getElementById("chatForm");
    const input = document.getElementById("chatInput");
    if (!form || !input) return;

    form.classList.remove("hidden");

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        try {
            await onlineMultiplayerService.sendChatMessage(roomCode, getOwnChatName(), text);
        } catch (error) {
            console.warn("Chat send failed:", error);
            addGameLog("Could not send message.");
        }
    });

    onlineChatUnsubscribe = onlineMultiplayerService.subscribeToChat(roomCode, (messages) => {
        // Only append what we haven't rendered, so the log isn't rebuilt each tick.
        messages.forEach(message => {
            if (renderedChatIds.has(message.id)) return;
            renderedChatIds.add(message.id);
            appendChatMessage(message);
        });
    });
}

async function initializeOnlineMultiplayer() {
    if (!isOnlineMatch) return;

    applyOwnSidePerspective();

    if (!roomCode || !playerSlot) {
        addGameLog("Online match URL is missing room or player slot.");
        updateOnlinePhaseButton();
        return;
    }

    if (playerSlot !== "p1" && playerSlot !== "p2") {
        addGameLog("Online match URL has an invalid player slot.");
        updateOnlinePhaseButton();
        return;
    }

    try {
        onlineMultiplayerService = await import("../firebase/multiplayerService.js");
        onlineFirebaseApp = await import("../firebase/firebaseApp.js");
        await onlineFirebaseApp.signInGuest();
        onlineUser = await onlineFirebaseApp.waitForUser();

        // Self-heal: if we reached the game page but the match was never fully
        // initialised (e.g. the client holding the start claim navigated away
        // mid-write), start it from here. startMatch is idempotent and claim
        // guarded. We retry a few times spaced past the stale-claim window so a
        // claim abandoned by a dead client is eventually reclaimed - otherwise
        // both players would sit on an empty board forever.
        await ensureOnlineMatchStarted();

        setupOnlineChat();

        // Multiplayer code reads public board/count state plus this user's private zones only.
        onlineMatchUnsubscribe = onlineMultiplayerService.subscribeToPublicState(
            roomCode,
            (publicState) => applyOnlinePublicState(publicState || {})
        );
        onlinePrivateUnsubscribe = onlineMultiplayerService.subscribeToPrivateState(
            roomCode,
            onlineUser.uid,
            (privateState) => applyOnlinePrivateState(privateState || {})
        );

        addGameLog(`Connected to online room ${roomCode} as ${playerSlot.toUpperCase()}.`);
        updateOnlinePhaseButton();
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to connect online match: ${error.message}`);
        updateOnlinePhaseButton();
    }
}

async function handleOnlineDiceRoll() {
    if (!onlineMultiplayerService || onlinePublicState?.phase !== "diceRoll") return;

    try {
        await onlineMultiplayerService.rollMultiplayerDice(roomCode, playerSlot);
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to roll dice: ${error.message}`);
    }
}

async function handleOnlineTurnChoice(choice) {
    if (!onlineMultiplayerService || onlinePublicState?.setup?.dice?.winner !== playerSlot) {
        addGameLog("Only the dice winner can choose turn order.");
        return;
    }

    try {
        removeOnlineTurnChoiceButtons();
        await onlineMultiplayerService.chooseMultiplayerTurnOrder(roomCode, playerSlot, choice);
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to choose turn order: ${error.message}`);
        updateOnlinePhaseButton();
    }
}

async function handleOnlineMulligan(tookMulligan) {
    if (!onlineMultiplayerService || !onlineUser || onlinePublicState?.phase !== "mulligan") {
        return;
    }

    try {
        removeOnlineMulliganButtons();
        await onlineMultiplayerService.setMultiplayerMulligan(
            roomCode,
            onlineUser,
            playerSlot,
            tookMulligan
        );
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to choose mulligan: ${error.message}`);
        updateOnlinePhaseButton();
    }
}

// Exposed for manual-play.js's sidebar "Next Turn" button - see nextTurn().
window.isOnlineMatchActive = () => Boolean(isOnlineMatch);
window.isOwnOnlineTurn = () => isCurrentOnlinePlayer();

// Big centre-screen "Your Turn" flash the moment the shared turn pointer lands
// on you. Tracked by turn key so it fires once per turn, not on every state push.
let lastAnnouncedOwnTurnKey = null;

function maybeAnnounceOwnTurn() {
    if (!isOnlineMatch || !onlinePublicState) return;
    if (onlinePublicState.phase !== "main") return;

    const turnKey = `${onlinePublicState.currentPlayer}:${onlinePublicState.turnNumber}`;

    if (!isCurrentOnlinePlayer()) {
        // Remember the opponent's turn so the next own-turn is announced fresh.
        lastAnnouncedOwnTurnKey = null;
        return;
    }

    if (lastAnnouncedOwnTurnKey === turnKey) return;

    lastAnnouncedOwnTurnKey = turnKey;
    showTurnBanner("YOUR TURN", `Turn ${onlinePublicState.turnNumber}`, "turn");
}

// Concede. The loser writes the result for BOTH sides in one public update, so
// the winner sees "You Won" without needing to agree to anything.
async function handleOnlineConcede() {
    if (!isOnlineMatch || !onlineMultiplayerService) return;

    const confirmed = window.confirm("Concede this match? Your opponent will be shown as the winner.");
    if (!confirmed) return;

    const winnerSlot = playerSlot === "p1" ? "p2" : "p1";

    try {
        await onlineMultiplayerService.updatePublicState(roomCode, {
            phase: "gameOver",
            winner: winnerSlot,
            gameOverReasonTitle: "Concede",
            gameOverReasonText: `${onlinePlayerLabels[playerSlot] || playerSlot.toUpperCase()} conceded the match.`
        });
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to concede: ${error.message}`);
    }
}

window.handleOnlineConcede = handleOnlineConcede;

async function handleOnlinePassTurn() {
    if (!isOnlineMatch) return;

    if (!onlineMultiplayerService || !onlinePublicState?.currentPlayer) {
        addGameLog("Online match is still connecting.");
        updateOnlinePhaseButton();
        return;
    }

    if (!isCurrentOnlinePlayer()) {
        addGameLog("Only the current online player can end the turn.");
        updateOnlinePhaseButton();
        return;
    }

    const phaseButton = document.getElementById("phaseButton");

    try {
        if (phaseButton) {
            phaseButton.disabled = true;
        }

        const ownPlayer = gameState[getOwnOnlinePlayerKey()];
        const phaseInfo = createPhaseLogProxy();

        if (ownPlayer) {
            const endOfTurnResults = resolveEndOfTurnEffects(ownPlayer, ui);

            endOfTurnResults.forEach(result => addGameLog(result.message));

            if (gameState.currentPhase === "gameOver") {
                await syncOnlineStateFromLocal();
                updateOnlinePhaseButton();
                return;
            }

            await syncOnlineStateFromLocal();
            await syncOnlineAllPublicBoardsFromLocal();
        }

        // Multiplayer turn owner writes private/public snapshot, then flips public turn pointer.
        const result = await onlineMultiplayerService.passTurn(roomCode, onlinePublicState.currentPlayer);

        if (!result?.committed) {
            addGameLog("Online turn was already updated.");
            updateOnlinePhaseButton();
        }
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to end online turn: ${error.message}`);
        updateOnlinePhaseButton();
    }
}

window.handleOnlinePassTurn = handleOnlinePassTurn;

// =========================
// Selected Card State
// =========================

let selectedHandCard = null;
let selectedHandCardData = null;
let pendingReplacePlay = null;

let selectedBoardCard = null;
let selectedBoardCardData = null;
let selectedDonAttachment = null;

let pendingAttack = null;
let currentAttack = null;
let pendingBlock = null;
let pendingTrashChoice = null;
let combatNextPhaseAction = null;
let pendingBoardChoice = null;

const renderedBoardCardStates = new Map();

// =========================
// Game State
// =========================

let gameState = null;

// =========================
// UI Bridge
// =========================

let ui = null;

// =========================
// Game Initialization
// =========================

function getSelectedDeckIds() {
    const params = new URLSearchParams(window.location.search);
    const defaultDeckId = window.getAvailableDecks?.()[0]?.id;

    return {
        player1DeckId: params.get("player1Deck") || defaultDeckId,
        player2DeckId: params.get("player2Deck") || defaultDeckId
    };
}

function getPracticeSnapshotDecks() {
    try {
        const raw = sessionStorage.getItem("custom-cards-sim-practice-decks");
        if (!raw) return null;

        const payload = JSON.parse(raw);
        if (!payload?.player?.leaderId || !payload?.opponent?.leaderId) {
            return null;
        }

        return {
            player1Deck: snapshotToDeckDefinition(payload.player, "practice-player-1"),
            player2Deck: snapshotToDeckDefinition(payload.opponent, "practice-player-2")
        };
    } catch (error) {
        console.warn("Could not load selected practice decks.", error);
        return null;
    }
}

function snapshotToDeckDefinition(snapshot, id) {
    const deckText = Object.entries(snapshot.deck || {})
        .filter(([, qty]) => Number(qty) > 0)
        .map(([cardId, qty]) => `${Number(qty)}x${cardId}`)
        .join("\n");

    return {
        id,
        name: snapshot.name || "Practice Deck",
        leaderKey: snapshot.leaderId,
        deckText,
        // Token types ride along with the deck - they're not part of deckText
        // because they are not deck contents.
        tokens: Array.isArray(snapshot.tokens) ? snapshot.tokens : []
    };
}

function createInitialPlayerState(playerName, deckDefinition) {
    // Prefer a deck whose leader actually exists in the card pool. The bundled
    // ST01 starter deck points at a leader this app doesn't ship, so falling
    // back to it blindly made the practice board fail to load entirely.
    const available = window.getAvailableDecks?.() || [];
    const playable = available.filter(deck => window.isDeckLeaderAvailable?.(deck) !== false);
    const selectedDeck = deckDefinition || playable[0] || available[0];

    if (!selectedDeck) {
        throw new Error("No decks are available. Build and save a deck in the Deck Builder first.");
    }

    const leaders = window.leaders || {};
    const key = selectedDeck.leaderKey;
    let leader = leaders[key];

    if (!leader) {
        leader = Object.values(leaders).find(entry =>
            entry?.cardNumber === key || entry?.id === key) || null;
    }
    if (!leader && typeof window.getCardById === "function") {
        leader = window.getCardById(key);
    }

    if (!leader) {
        throw new Error(
            `Leader "${key}" for deck "${selectedDeck.name}" isn't in your card pool. ` +
            `Build and save a deck using one of your own leaders.`
        );
    }

    return {
        name: playerName,
        don: 0,
        restedDon: 0,
        donDeck: 10,
        turns: 0,
        deck: shuffleDeck(parseDeckText(selectedDeck.deckText)),
        deckName: selectedDeck.name,
        hasMulliganed: false,
        hand: [],
        life: [],
        trash: [],
        leader: createCardInstance(leader),
        characters: [],
        stage: null,
        // Extra utility piles (custom zones for leader-effect ideas)
        extraFaceUp: [],
        extraFaceDown: [],
        // Face-up pile of token copies created during the match.
        tokens: [],
        // Token TYPES this deck makes available. Copies are created and removed
        // freely at the table, so this list never shrinks during a match - it is
        // the menu, not the supply.
        tokenTypes: resolveTokenTypes(selectedDeck.tokens)
    };
}

// Turn saved token ids into full card objects once, at match start, so the token
// picker can render art without hitting the database on every open. Unknown ids
// are dropped rather than throwing - a deck should still be playable if a token
// card was deleted from the pool.
function resolveTokenTypes(tokenIds) {
    if (!Array.isArray(tokenIds)) return [];

    // Read the card map directly rather than via getCardById, which logs a
    // console error on every miss - a missing token is expected, not a fault.
    const database = window.cardDatabase || {};

    return tokenIds.map(id => database[id]).filter(Boolean);
}

function createInitialGameState() {
    const practiceDecks = getPracticeSnapshotDecks();

    if (practiceDecks) {
        return {
            player1: createInitialPlayerState("Player 1", practiceDecks.player1Deck),
            player2: createInitialPlayerState("Player 2", practiceDecks.player2Deck),

            diceWinner: null,
            firstPlayer: null,
            secondPlayer: null,
            currentPlayer: null,
            turnNumber: 1,
            currentPhase: "diceRoll"
        };
    }

    const selectedDeckIds = getSelectedDeckIds();
    const player1Deck = window.getDeckById(selectedDeckIds.player1DeckId);
    const player2Deck = window.getDeckById(selectedDeckIds.player2DeckId);

    return {
        player1: createInitialPlayerState("Player 1", player1Deck),
        player2: createInitialPlayerState("Player 2", player2Deck),

        diceWinner: null,
        firstPlayer: null,
        secondPlayer: null,
        currentPlayer: null,
        turnNumber: 1,
        currentPhase: "diceRoll"
    };
}

function createUiBridge() {
    return {
        updateDonDisplay,
        renderDonDecks,
        renderHands,
        renderDecks,
        renderLifeCards,
        renderLeaders,
        renderCharacters,
        renderTrash,
        renderStages,
        lookTopCardsAddToHand,
        chooseBoardCard: showBoardCardChoice,
        chooseEffectActivation,
        chooseEffectOption,
        revealCards: publishOnlineReveal
    };
}

// =========================
// Animation Helpers
// =========================

function takeCardAnimationClass(card) {
    const animation = card?.uiAnimation;

    if (!animation) {
        return "";
    }

    delete card.uiAnimation;

    return `card-${animation}-animation`;
}

function getBoardCardRenderKey(playerKey, cardType, slotIndex = "") {
    return `${playerKey}:${cardType}:${slotIndex}`;
}

function getBoardStateAnimationClass(card, renderKey) {
    if (!card || !renderKey) {
        return "";
    }

    const currentState = card.state || "active";
    const previousState = renderedBoardCardStates.get(renderKey);

    renderedBoardCardStates.set(renderKey, currentState);

    if (!previousState || previousState === currentState) {
        return "";
    }

    if (previousState === "active" && currentState === "rested") {
        return "card-rest-transition";
    }

    if (previousState === "rested" && currentState === "active") {
        return "card-ready-transition";
    }

    return "";
}

function applyCardAnimationClass(element, animationClass) {
    if (!element || !animationClass) {
        return;
    }

    element.classList.add(animationClass);
}

async function initializeGamePage() {
    try {
        await loadCardDatabase();

        gameState = createInitialGameState();
        ui = createUiBridge();

        setupLifeArea("lifeArea", "lifeToggleText");
        setupLifeArea("opponentLifeArea", "opponentLifeToggleText");

        updateDonDisplay();
        renderDecks();
        renderDonDecks();
        renderLeaders();
        renderHands();
        renderCharacters();
        renderTrash();
        renderStages();
        renderExtraPiles();

        setupCharacterSlotInteractions();
        setupBoardLeaderSelection();
        setupCardPreview();
        setupDonAttachmentClearListener();
        autoStartSelfMatch();

        addGameLog(`
            Card database loaded. Game ready.<br>
            Player 1: ${gameState.player1.deckName}<br>
            Player 2: ${gameState.player2.deckName}
        `);

        initializeOnlineMultiplayer();
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to load card database: ${error.message}`);
    }
}

document.addEventListener("DOMContentLoaded", initializeGamePage);

// =========================
// Board Scale-to-Fit
// =========================

// The board is laid out on a fixed 1680x1120 design canvas (.game-layout) and
// scaled as one unit so it fits any landscape viewport without internal
// overlap. This replaces the old stepped media-query scale, which only changed
// at a few breakpoints and ignored the tools sidebar.
function fitBoardToViewport() {
    const DESIGN_WIDTH = 1680;
    const DESIGN_HEIGHT = 1120;
    const MARGIN = 16;

    const sidebar = document.querySelector(".manual-sidebar");
    const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;

    const availableWidth = window.innerWidth - sidebarWidth - MARGIN;
    const availableHeight = window.innerHeight - MARGIN;
    const scale = Math.max(
        0.15,
        Math.min(availableWidth / DESIGN_WIDTH, availableHeight / DESIGN_HEIGHT, 1)
    );

    document.documentElement.style.setProperty("--sim-board-scale", scale.toFixed(4));

    // Arrows/notes are positioned in viewport space, so refresh them on rescale
    window.manualPlay?.reapplyAnnotations?.();
}

window.addEventListener("resize", fitBoardToViewport);
window.addEventListener("orientationchange", fitBoardToViewport);
// Some mobile webviews resize the visual viewport without firing window.resize
window.visualViewport?.addEventListener("resize", fitBoardToViewport);
document.addEventListener("DOMContentLoaded", fitBoardToViewport);

function setupDonAttachmentClearListener() {
    if (document.body.dataset.donAttachmentClearListener === "true") {
        return;
    }

    document.body.dataset.donAttachmentClearListener = "true";

    document.addEventListener("click", (event) => {
        if (!selectedDonAttachment) {
            return;
        }

        if (event.target.closest(".selectable-don, .don-attach-target, .board-leader-card, .board-character-card, .don-attachment-confirm")) {
            return;
        }

        clearSelectedDonAttachment({ silent: false });
    });
}

// =========================
// Blocker Target UI
// =========================

function clearBlockerTargets() {
    document.querySelectorAll(".blocker-target").forEach(target => {
        target.classList.remove("blocker-target");
    });
}

function enterBlockerStep(defenderPlayerKey, onResolve) {
    const defenderPlayer = gameState[defenderPlayerKey];

    if (!defenderPlayer || !currentAttack) {
        startCounterPhase(defenderPlayerKey, onResolve);
        return;
    }

    const availableBlockers = CardEffects.getAvailableBlockers(defenderPlayer);

    pendingBlock = {
        defenderPlayerKey,
        onResolve
    };

    clearBlockerTargets();

    availableBlockers.forEach(({ slotIndex }) => {
        const blockerElement = document.querySelector(
            `.board-character-card[data-player="${defenderPlayerKey}"][data-character-slot="${slotIndex}"]`
        );

        if (blockerElement) {
            blockerElement.classList.add("blocker-target");
        }
    });

    if (availableBlockers.length > 0) {
        addGameLog(`${defenderPlayer.name} may choose a Blocker or skip blocking.`);
    } else {
        addGameLog(`${defenderPlayer.name} has no available Blockers.`);
    }
}

async function handleBlockerSelection(playerKey, slotIndex) {
    if (!pendingBlock || !currentAttack) return;

    if (playerKey !== pendingBlock.defenderPlayerKey) {
        addGameLog("Only the defending player can block this attack.");
        return;
    }

    const defenderPlayer = gameState[playerKey];

    if (!defenderPlayer) return;

    const blockerCard = defenderPlayer.characters[slotIndex];

    if (!CardEffects.canBlock(blockerCard)) {
        addGameLog(`${blockerCard?.name ?? "That card"} cannot block.`);
        return;
    }

    const blockerData = {
        playerKey,
        cardType: "character",
        slotIndex
    };

    currentAttack.target = blockerData;

    restBoardCard(blockerData);

    drawAttackArrow(currentAttack.attacker, currentAttack.target);

    clearBlockerTargets();

    pendingBlock = null;

    addGameLog(`${defenderPlayer.name} blocked the attack with ${blockerCard.name}.`);

    resolveWhenBlockingEffectsBeforeCounter(defenderPlayer, blockerCard, () => {
        startCounterPhase(playerKey, () => {
            resolveCurrentAttack();
        });

        if (isOnlineMatch && onlinePublicState?.currentAttack) {
            syncOnlineCurrentAttack({
                ...onlinePublicState.currentAttack,
                target: currentAttack.target,
                targetPowerBonus: currentAttack.targetPowerBonus || 0,
                counterPhaseStarted: true
            }).catch(error => {
                console.error("Failed to sync online counter phase:", error);
            });
        }
    });

    await syncOnlinePublicBoardFromLocal();
}

function skipCurrentBlockStep(defenderPlayerKey, onResolve) {
    const defenderName = gameState[defenderPlayerKey]?.name ?? "Defender";

    pendingBlock = null;

    clearBlockerTargets();

    addGameLog(`${defenderName} skipped the Block Phase.`);

    startCounterPhase(defenderPlayerKey, onResolve);

    if (isOnlineMatch && onlinePublicState?.currentAttack) {
        syncOnlineCurrentAttack({
            ...onlinePublicState.currentAttack,
            target: currentAttack?.target || onlinePublicState.currentAttack.target,
            targetPowerBonus: currentAttack?.targetPowerBonus || 0,
            counterPhaseStarted: true
        }).catch(error => {
            console.error("Failed to sync online counter phase:", error);
        });
    }
}

// =========================
// Game Over UI
// =========================

// outcomeText is set in online matches so each player reads the result from
// their own seat ("You Won" / "You Lost") instead of a player name.
function showGameOverPopup(winnerPlayer, reasonTitle = "Victory", reasonText = "", outcomeText = "") {
    removeGameOverPopup();

    const overlay = document.createElement("div");
    overlay.className = "game-over-overlay";
    overlay.id = "gameOverOverlay";

    const popup = document.createElement("div");
    popup.className = "game-over-popup";
    if (outcomeText) {
        popup.classList.add(outcomeText === "You Won" ? "outcome-won" : "outcome-lost");
    }

    const title = document.createElement("h2");
    title.textContent = outcomeText || "Game Over";

    // The reason heading/text below already explain why, so in online matches the
    // outcome heading replaces the "<name> wins!" line rather than repeating it.
    const message = document.createElement("p");
    message.textContent = outcomeText ? "" : `${winnerPlayer.name} wins!`;
    if (outcomeText) message.hidden = true;

    const reasonHeading = document.createElement("h3");
    reasonHeading.className = "game-over-reason-title";
    reasonHeading.textContent = reasonTitle;

    const reasonMessage = document.createElement("p");
    reasonMessage.className = "game-over-reason-text";
    reasonMessage.textContent = reasonText;

    const buttons = document.createElement("div");
    buttons.className = "game-over-buttons";

    const mainMenuButton = document.createElement("a");
    mainMenuButton.className = "game-over-button main-menu";
    mainMenuButton.href = isOnlineMatch ? "multiplayer.html" : "../index.html";
    mainMenuButton.textContent = isOnlineMatch ? "Go to Lobby" : "Main Menu";

    popup.appendChild(title);
    popup.appendChild(message);
    popup.appendChild(reasonHeading);
    popup.appendChild(reasonMessage);

    if (isOnlineMatch) {
        // Online: ready up (optionally with a different deck) and rematch in
        // place once BOTH players are ready. Handled by the rematch panel.
        popup.appendChild(buildRematchPanel());
        buttons.appendChild(mainMenuButton);
    } else {
        const playAgainButton = document.createElement("button");
        playAgainButton.className = "game-over-button play-again";
        playAgainButton.textContent = "Play Again";
        playAgainButton.addEventListener("click", () => window.location.reload());

        buttons.appendChild(mainMenuButton);
        buttons.appendChild(playAgainButton);
    }

    popup.appendChild(buttons);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    if (isOnlineMatch) startRematchWatch();
}

// ── Rematch panel (online game-over screen) ──────────────
// Both players ready up here rather than trekking back to the lobby. Readiness
// lives in the match document so each side sees the same indicators live, and
// the re-deal fires automatically the moment both are ready.
let rematchUnsubscribe = null;
let rematchState = {};
let ownRematchDeckId = null;
let rematchRestartAttempted = false;

function buildRematchPanel() {
    const panel = document.createElement("div");
    panel.className = "rematch-panel";
    panel.id = "rematchPanel";

    const heading = document.createElement("div");
    heading.className = "rematch-heading";
    heading.textContent = "Rematch";
    panel.appendChild(heading);

    // Deck swap - defaults to whatever this player used last game.
    const decks = window.getAvailableDecks?.() || [];
    if (decks.length) {
        const deckRow = document.createElement("label");
        deckRow.className = "rematch-deck-row";
        deckRow.textContent = "Deck";

        const select = document.createElement("select");
        select.id = "rematchDeckSelect";
        decks.forEach(deck => {
            const option = document.createElement("option");
            option.value = deck.id;
            option.textContent = deck.name;
            select.appendChild(option);
        });

        const currentName = onlinePrivateState?.selectedDeck?.name;
        const match = decks.find(deck => deck.name === currentName);
        if (match) select.value = match.id;
        ownRematchDeckId = select.value;

        // Changing decks clears your ready flag so the other player can see it.
        select.addEventListener("change", () => {
            ownRematchDeckId = select.value;
            setOwnRematchReady(false);
        });

        deckRow.appendChild(select);
        panel.appendChild(deckRow);
    }

    const status = document.createElement("div");
    status.className = "rematch-status";
    status.id = "rematchStatus";
    panel.appendChild(status);

    const readyButton = document.createElement("button");
    readyButton.className = "game-over-button play-again";
    readyButton.id = "rematchReadyBtn";
    readyButton.textContent = "Ready";
    readyButton.addEventListener("click", () => {
        setOwnRematchReady(!rematchState?.[playerSlot]?.ready);
    });
    panel.appendChild(readyButton);

    renderRematchStatusInto(panel);
    return panel;
}

async function setOwnRematchReady(ready) {
    if (!onlineMultiplayerService || !roomCode || !playerSlot) return;

    const deck = ready
        ? (window.getDeckById?.(ownRematchDeckId) || null)
        : null;

    try {
        await onlineMultiplayerService.setRematchReady(roomCode, playerSlot, ready, deck);
    } catch (error) {
        console.error(error);
        addGameLog(`Failed to update rematch: ${error.message}`);
    }
}

function startRematchWatch() {
    if (!onlineMultiplayerService || !roomCode) return;

    rematchRestartAttempted = false;
    rematchUnsubscribe?.();
    rematchUnsubscribe = onlineMultiplayerService.subscribeToRematch(roomCode, (state) => {
        rematchState = state || {};
        renderRematchStatusInto(document.getElementById("rematchPanel"));
        maybeTriggerRematch();
    });
}

function stopRematchWatch() {
    rematchUnsubscribe?.();
    rematchUnsubscribe = null;
}

function renderRematchStatusInto(panel) {
    if (!panel) return;

    const status = panel.querySelector("#rematchStatus");
    const button = panel.querySelector("#rematchReadyBtn");
    const ownReady = Boolean(rematchState?.[playerSlot]?.ready);
    const foeSlot = playerSlot === "p1" ? "p2" : "p1";
    const foeReady = Boolean(rematchState?.[foeSlot]?.ready);

    if (status) {
        status.innerHTML = "";
        [
            { label: "You", ready: ownReady },
            { label: "Opponent", ready: foeReady }
        ].forEach(entry => {
            const chip = document.createElement("span");
            chip.className = `rematch-chip ${entry.ready ? "is-ready" : "is-waiting"}`;
            chip.textContent = `${entry.label}: ${entry.ready ? "Ready" : "Not ready"}`;
            status.appendChild(chip);
        });
    }

    if (button) {
        button.textContent = ownReady ? "Cancel Ready" : "Ready";
        button.classList.toggle("is-ready", ownReady);
    }
}

function maybeTriggerRematch() {
    const bothReady = Boolean(rematchState?.p1?.ready && rematchState?.p2?.ready);
    if (!bothReady || rematchRestartAttempted) return;

    rematchRestartAttempted = true;
    addGameLog("Both players are ready - starting a new game…");

    // Both clients call this; the transaction inside guarantees only one deals.
    onlineMultiplayerService.restartMatch(roomCode)
        .catch(error => {
            console.error(error);
            addGameLog(`Failed to start rematch: ${error.message}`);
            rematchRestartAttempted = false;
        });
}

function removeGameOverPopup() {
    const oldPopup = document.getElementById("gameOverOverlay");

    if (oldPopup) {
        oldPopup.remove();
    }
}

function endGame(winnerPlayer, reasonTitle = "Victory", reasonText = "") {
    gameState.currentPhase = "gameOver";

    pendingAttack = null;
    currentAttack = null;
    pendingBlock = null;
    pendingTrashChoice = null;
    pendingReplacePlay = null;

    clearAttackTargets();
    clearBlockerTargets();
    clearBattleControls();
    clearHandSelection();
    clearBoardSelection();
    clearReplaceTargets();
    clearTrashChoiceTargets();
    clearCancelAttackButton();
    clearAttackArrow();

    addGameLog(`${winnerPlayer.name} wins the game! ${reasonTitle}: ${reasonText}`);

    showGameOverPopup(winnerPlayer, reasonTitle, reasonText);

    if (isOnlineMatch && onlineMultiplayerService) {
        const winnerSlot = getOnlineSlotFromPlayerKey(getPlayerKey(winnerPlayer));

        onlinePendingWinnerSlot = winnerSlot;

        syncOnlineStateFromLocal().catch(error => {
            console.error("Failed to sync final online state:", error);
        });

        if (winnerSlot) {
            syncOnlineAllPublicBoardsFromLocal({
                phase: "gameOver",
                currentAttack: null,
                winner: winnerSlot,
                gameOverReasonTitle: reasonTitle,
                gameOverReasonText: reasonText
            }).catch(error => {
                console.error("Failed to sync online game over:", error);
            });
        }
    }
}

// =========================
// Attack Arrow UI
// =========================

function getBoardElementFromData(boardCardData) {
    if (!boardCardData) return null;

    if (boardCardData.cardType === "leader") {
        return document.querySelector(
            `.board-leader-card[data-player="${boardCardData.playerKey}"]`
        );
    }

    if (boardCardData.cardType === "character") {
        return document.querySelector(
            `.board-character-card[data-player="${boardCardData.playerKey}"][data-character-slot="${boardCardData.slotIndex}"]`
        );
    }

    return null;
}

// =========================
// Life Area Setup
// =========================

function setupLifeArea(areaId, textId) {
    const lifeArea = document.getElementById(areaId);
    const lifeToggleText = document.getElementById(textId);

    if (!lifeArea || !lifeToggleText) return;

    lifeToggleText.textContent = "View Life Cards";

    lifeArea.addEventListener("mouseenter", () => {
        if (!lifeArea.classList.contains("open")) {
            lifeToggleText.textContent = "Life Cards";
        }
    });

    lifeArea.addEventListener("mouseleave", () => {
        if (!lifeArea.classList.contains("open")) {
            lifeToggleText.textContent = "View Life Cards";
        }
    });

    lifeArea.addEventListener("click", () => {
        lifeArea.classList.toggle("open");

        if (lifeArea.classList.contains("open")) {
            lifeToggleText.textContent = "Life Cards View Locked";
        } else {
            lifeToggleText.textContent = "View Life Cards";
        }
    });
}

// =========================
// Phase Controls UI
// =========================

function canPassTurnNow() {
    if (!gameState) {
        return {
            canPass: false,
            reason: "Game is not ready yet."
        };
    }

    if (gameState.currentPhase !== "main") {
        return {
            canPass: false,
            reason: "Finish the current phase before passing turn."
        };
    }

    if (pendingAttack || currentAttack || pendingBlock || combatNextPhaseAction) {
        return {
            canPass: false,
            reason: "Resolve the current attack before passing turn."
        };
    }

    if (pendingReplacePlay) {
        return {
            canPass: false,
            reason: "Choose whether to replace the character slot first."
        };
    }

    if (pendingTrashChoice) {
        return {
            canPass: false,
            reason: "Finish trashing the required card first."
        };
    }

    if (selectedDonAttachment) {
        return {
            canPass: false,
            reason: "Attach or clear the selected DON!! before passing turn."
        };
    }

    const activeOverlay = document.querySelector(
        "#lookTopOverlay, #boardChoiceOverlay, #effectChoiceOverlay, #donAttachmentConfirm, #trashViewerOverlay, #searchCardImageOverlay, #powerBreakdownOverlay"
    );

    if (activeOverlay) {
        return {
            canPass: false,
            reason: "Finish the open effect window before passing turn."
        };
    }

    return {
        canPass: true,
        reason: ""
    };
}

function autoStartSelfMatch() {
    if (isOnlineMatch || !gameState || gameState.currentPhase !== "diceRoll") {
        return;
    }

    // Auto-start: Player 1 goes first
    gameState.diceWinner = gameState.player1;
    gameState.firstPlayer = gameState.player1;
    gameState.secondPlayer = gameState.player2;
    gameState.turnNumber = 1;

    // Draw initial 5 cards for each player
    for (let i = 0; i < 5; i++) {
        if (gameState.player1.deck.length > 0) {
            gameState.player1.hand.push(gameState.player1.deck.pop());
        }
        if (gameState.player2.deck.length > 0) {
            gameState.player2.hand.push(gameState.player2.deck.pop());
        }
    }

    // Mark players as not having mulliganed yet
    gameState.player1.hasMulliganed = false;
    gameState.player2.hasMulliganed = false;
    gameState.player1.turnCount = 0;
    gameState.player2.turnCount = 0;

    // Display hands and decks first
    renderDecks();
    renderHands();
    renderCharacters();
    updateDonDisplay();
    
    addGameLog("Both players drew 5 cards. Checking for mulligans...");
    
    // Ask Player 1 to mulligan
    showMulliganChoice(gameState.player1, "Player 1", () => {
        // After Player 1 decides, ask Player 2
        showMulliganChoice(gameState.player2, "Player 2", () => {
            // After both mulligan decisions, set up Player 1's turn
            startPlayerTurn(gameState.player1);
        });
    });
}

function showMulliganChoice(player, playerName, callback) {
    if (player.hasMulliganed) {
        callback();
        return;
    }

    // Create a modal dialog instead of confirm so hand is visible
    const modal = document.createElement("div");
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    `;
    
    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background: #1a1a2e;
        border: 2px solid #4a90e2;
        border-radius: 8px;
        padding: 30px;
        text-align: center;
        color: #fff;
        font-size: 16px;
        max-width: 400px;
    `;
    
    dialog.innerHTML = `
        <h2 style="color: #4a90e2; margin-bottom: 20px;">${playerName}</h2>
        <p style="margin-bottom: 20px;">Do you want to mulligan?<br>(Shuffle hand back and draw 5 new cards)</p>
        <div style="display: flex; gap: 10px; justify-content: center;">
            <button id="mulliganYes" style="padding: 10px 20px; background: #4a90e2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold;">Yes, Mulligan</button>
            <button id="mulliganNo" style="padding: 10px 20px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold;">No, Keep Hand</button>
        </div>
    `;
    
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    
    document.getElementById("mulliganYes").addEventListener("click", () => {
        // Shuffle hand back into deck
        player.deck.push(...player.hand);
        player.hand = [];
        
        // Shuffle the deck
        player.deck = shuffleDeck(player.deck);
        
        // Draw 5 new cards
        for (let i = 0; i < 5; i++) {
            if (player.deck.length > 0) {
                player.hand.push(player.deck.pop());
            }
        }
        
        player.hasMulliganed = true;
        addGameLog(`${playerName} took a mulligan.`);
        renderHands();
        renderDecks();
        
        modal.remove();
        callback();
    });
    
    document.getElementById("mulliganNo").addEventListener("click", () => {
        player.hasMulliganed = true;
        addGameLog(`${playerName} kept their hand.`);
        
        modal.remove();
        callback();
    });
}

// Start-of-turn automation toggles, shared with the Settings panel on the home
// page via localStorage. All default ON so behavior matches the old hardcoded
// sequence unless the player opts out.
const TURN_AUTOMATION_KEY = "optcgTurnAutomation";
function getTurnAutomationSettings() {
    const defaults = { autoDraw: true, autoAddDon: true, autoRestand: true, autoDetach: true };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(TURN_AUTOMATION_KEY) || "{}") };
    } catch {
        return defaults;
    }
}

// Set every one of a player's board cards (leader, characters, stage) to active,
// and return all of their rested DON!! to the active pool.
function restandPlayerCards(player) {
    [player.leader, player.stage, ...(player.characters || [])]
        .filter(Boolean)
        .forEach(card => { card.state = "active"; });

    if (player.restedDon > 0) {
        player.don = (player.don || 0) + player.restedDon;
        player.restedDon = 0;
    }
}

// Return all DON attached to a player's board cards to their active DON count.
function detachPlayerDon(player) {
    let returned = 0;
    [player.leader, player.stage, ...(player.characters || [])]
        .filter(Boolean)
        .forEach(card => {
            if (card.attachedDon) {
                returned += card.attachedDon;
                card.attachedDon = 0;
            }
        });
    if (returned > 0) player.don = Math.min((player.don || 0) + returned, 10);
    return returned;
}

function startPlayerTurn(player) {
    const playerKey = player === gameState.player1 ? "player1" : "player2";
    const playerNum = playerKey === "player1" ? "1" : "2";
    gameState.currentPlayer = player;

    // Increment turn count for this player
    player.turnCount = (player.turnCount || 0) + 1;

    const isFirstTurn = player.turnCount === 1;
    const settings = getTurnAutomationSettings();

    // Refresh phase (untap + return attached DON) - only after the first turn,
    // when there's actually something on the board to refresh.
    if (!isFirstTurn) {
        if (settings.autoRestand) {
            restandPlayerCards(player);
            addGameLog(`Player ${playerNum} restands all cards and DON!!.`);
        }
        if (settings.autoDetach) {
            const returned = detachPlayerDon(player);
            if (returned > 0) addGameLog(`Player ${playerNum} returns ${returned} attached DON!!.`);
        }
        renderLeaders();
        renderCharacters();
        renderStages();
        updateDonDisplay();
    }

    // DON phase
    if (isFirstTurn) {
        // First turn is fixed: 1 DON for the first player, 2 for the second.
        if (player === gameState.firstPlayer) {
            player.don = 1;
            addGameLog("Player 1's turn starts with 1 DON");
        } else {
            player.don = 2;
            addGameLog("Player 2's turn starts with 2 DON");
        }
    } else if (settings.autoAddDon) {
        player.don = Math.min((player.don || 0) + 2, 10);
        addGameLog(`Player ${playerNum}'s turn starts: +2 DON${player.don === 10 ? " (capped at 10)" : ""}`);
    }

    // Draw phase - skipped on the first player's first turn per the rules.
    const canDraw = !(player === gameState.firstPlayer && isFirstTurn);
    if (canDraw && settings.autoDraw && player.deck.length > 0) {
        player.hand.push(player.deck.pop());
        addGameLog(`Player ${playerNum} drew 1 card.`);
        renderHands();
        renderDecks();
    }

    gameState.currentPhase = "main";
    updateDonDisplay();

    // Update phase display
    const phaseDisplay = document.getElementById("phaseDisplay");
    if (phaseDisplay) {
        phaseDisplay.textContent = playerKey === "player1" ? "Your Turn" : "Opponent's Turn";
    }
}

function showDiceRollAnimation(player1Roll, player2Roll, winner) {
    const phaseControls = document.querySelector(".phase-controls");

    if (!phaseControls) return;

    removeDiceRollDisplay();

    const display = document.createElement("div");
    display.className = "dice-roll-display";
    display.id = "diceRollDisplay";

    const player1Die = createD20Die({
        playerLabel: "Player 1",
        colorClass: "blue-d20",
        finalValue: player1Roll
    });

    const player2Die = createD20Die({
        playerLabel: "Player 2",
        colorClass: "red-d20",
        finalValue: player2Roll
    });

    const center = document.createElement("div");
    center.className = "dice-roll-center";
    center.textContent = "D20";

    const result = document.createElement("div");
    result.className = "dice-roll-result";
    result.textContent = `${winner.name} wins`;

    display.appendChild(player1Die.root);
    display.appendChild(center);
    display.appendChild(player2Die.root);
    display.appendChild(result);

    phaseControls.insertBefore(display, phaseControls.querySelector(".choice-buttons"));

    animateD20(player1Die.valueElement, player1Roll);
    animateD20(player2Die.valueElement, player2Roll);
}

function createD20Die({ playerLabel, colorClass, finalValue }) {
    const root = document.createElement("div");
    root.className = `d20-roll ${colorClass}`;

    const die = document.createElement("div");
    die.className = "d20-die rolling";

    const value = document.createElement("span");
    value.className = "d20-value";
    value.textContent = finalValue;

    const label = document.createElement("span");
    label.className = "d20-label";
    label.textContent = playerLabel;

    die.appendChild(value);
    root.appendChild(die);
    root.appendChild(label);

    return {
        root,
        valueElement: value
    };
}

function animateD20(valueElement, finalValue) {
    let ticks = 0;
    const die = valueElement.closest(".d20-die");

    const intervalId = window.setInterval(() => {
        ticks++;
        valueElement.textContent = Math.floor(Math.random() * 20) + 1;

        if (ticks >= 12) {
            window.clearInterval(intervalId);
            valueElement.textContent = finalValue;
            die?.classList.remove("rolling");
            die?.classList.add("rolled");
        }
    }, 55);
}

function removeDiceRollDisplay() {
    const oldDisplay = document.getElementById("diceRollDisplay");

    if (oldDisplay) {
        oldDisplay.remove();
    }
}

window.showDiceRollAnimation = showDiceRollAnimation;
window.removeDiceRollDisplay = removeDiceRollDisplay;

function showTurnBanner(title, subtitle = "", tone = "turn") {
    const oldBanner = document.getElementById("turnBanner");

    if (oldBanner) {
        oldBanner.remove();
    }

    const banner = document.createElement("div");
    banner.id = "turnBanner";
    banner.className = `turn-banner ${tone}`;

    const titleElement = document.createElement("div");
    titleElement.className = "turn-banner-title";
    titleElement.textContent = title;

    banner.appendChild(titleElement);

    if (subtitle) {
        const subtitleElement = document.createElement("div");
        subtitleElement.className = "turn-banner-subtitle";
        subtitleElement.textContent = subtitle;
        banner.appendChild(subtitleElement);
    }

    document.body.appendChild(banner);

    window.setTimeout(() => {
        banner.classList.add("turn-banner-exit");
    }, 1500);

    window.setTimeout(() => {
        banner.remove();
    }, 2050);
}

window.showTurnBanner = showTurnBanner;

function removeChoiceButtons() {
    const oldButtons = document.querySelector(".choice-buttons");

    if (oldButtons) {
        oldButtons.remove();
    }
}

// =========================
// Game Log
// =========================

function addGameLog(message) {
    const gameLogMessages = document.getElementById("gameLogMessages");

    if (!gameLogMessages) return;

    const cleanMessage = message
        .replace(/^\s*(<br>\s*)+/gi, "")
        .replace(/(<br>\s*){3,}/gi, "<br><br>")
        .trim();

    if (!cleanMessage) return;

    const logMessage = document.createElement("div");

    logMessage.className = "log-message";
    logMessage.innerHTML = cleanMessage;

    gameLogMessages.appendChild(logMessage);

    gameLogMessages.scrollTop = gameLogMessages.scrollHeight;
}

// =========================
// DON!! Rendering
// =========================

function updateDonDisplay() {
    renderDonArea(gameState.player1, "player1DonArea");
    renderDonArea(gameState.player2, "player2DonArea");
    renderDonDecks();
}

// DON!! is stored as two COUNTS (don / restedDon) rather than as card objects,
// so nothing distinguishes one DON from another. Rendering drew every active
// card then every rested card, which meant resting "a" DON just moved the
// boundary - the rightmost active card always appeared to flip, no matter which
// one you double-clicked.
//
// donOrder records the visible left-to-right state of each DON so a specific one
// can be toggled. The counts remain the source of truth for everything else
// (attaching, restand, DON deck maths, sync); the order is rebuilt from them
// whenever the two disagree, so any code that changes the counts directly still
// works and simply gets the default "active first, then rested" arrangement.
function getDonSlots(player) {
    const active = Math.max(0, Number(player.don) || 0);
    const rested = Math.max(0, Number(player.restedDon) || 0);
    const total = active + rested;
    const order = Array.isArray(player.donOrder) ? player.donOrder : null;

    if (order && order.length === total &&
        order.filter(slot => slot === "rested").length === rested) {
        return order.slice();
    }

    return [
        ...new Array(active).fill("active"),
        ...new Array(rested).fill("rested")
    ];
}

function setDonSlots(player, slots) {
    player.donOrder = slots.slice();
    player.don = slots.filter(slot => slot === "active").length;
    player.restedDon = slots.filter(slot => slot === "rested").length;
}

// Flip one specific DON between active and rested. Returns false if the index
// no longer exists (the board re-rendered under the click).
function toggleDonSlot(player, index) {
    const slots = getDonSlots(player);

    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return false;

    slots[index] = slots[index] === "rested" ? "active" : "rested";
    setDonSlots(player, slots);
    return true;
}

// Remove one specific DON from the field (right-click), keeping the rest in place.
function removeDonSlot(player, index) {
    const slots = getDonSlots(player);

    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return false;

    slots.splice(index, 1);
    setDonSlots(player, slots);
    return true;
}

window.toggleDonSlot = toggleDonSlot;
window.removeDonSlot = removeDonSlot;

function renderDonArea(player, areaId) {
    const donArea = document.getElementById(areaId);

    if (!donArea) return;

    donArea.innerHTML = "";
    const playerKey = getPlayerKey(player);
    const slots = getDonSlots(player);

    slots.forEach((slot, index) => {
        const rested = slot === "rested";
        const img = document.createElement("img");

        img.src = donImage;
        img.alt = rested ? "Rested DON!!" : "Active DON!!";
        // Rested DON stays selectable so it can still be picked up and attached.
        img.className = `don-card-img selectable-don${rested ? " rested-don" : ""}`;
        img.dataset.player = playerKey;
        img.dataset.donSlot = String(index);
        img.draggable = true;

        img.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (removeDonSlot(player, index)) {
                updateDonDisplay();
                renderDonDecks();
                addGameLog(`${player.name} returned 1 DON!! to their DON!! deck.`);
                window.scheduleOnlineBoardSync?.();
            }
        });

        donArea.appendChild(img);
    });
}

function renderFloatingDon() {
    if (!gameState) return;
    
    // Update existing floating DON elements instead of recreating
    document.querySelectorAll(".floating-don").forEach(el => {
        const playerKey = el.getAttribute("data-player");
        const donId = el.getAttribute("data-don-id");
        const player = gameState[playerKey];
        
        if (player && player.floatingDon) {
            const don = player.floatingDon.find(d => d.instanceId === donId);
            if (don) {
                el.style.left = don.x + "px";
                el.style.top = don.y + "px";
                
                // Ensure context menu handler is attached
                if (!el.dataset.hasContextMenu) {
                    el.oncontextmenu = (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        
                        const menu = document.createElement("div");
                        menu.className = "context-menu";
                        menu.style.position = "fixed";
                        menu.style.top = event.clientY + "px";
                        menu.style.left = event.clientX + "px";
                        menu.style.zIndex = "10001";
                        menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
                        menu.style.border = "1px solid #888";
                        menu.style.borderRadius = "4px";
                        menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
                        
                        const btn = document.createElement("div");
                        btn.textContent = "Return to DON!! Deck";
                        btn.style.padding = "8px 16px";
                        btn.style.cursor = "pointer";
                        btn.style.color = "#fff";
                        btn.style.fontSize = "14px";
                        btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                        btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                        btn.onclick = () => {
                            const currentPlayer = gameState[playerKey];
                            currentPlayer.don++;
                            gameState[playerKey].floatingDon = gameState[playerKey].floatingDon.filter(d => d.instanceId !== don.instanceId);
                            window.updateDonDisplay?.();
                            el.remove();
                            window.addGameLog?.(`DON!! returned to deck`);
                            window.scheduleOnlineBoardSync?.();
                            document.body.removeChild(menu);
                        };
                        menu.appendChild(btn);
                        document.body.appendChild(menu);
                        
                        const closeMenu = () => {
                            if (menu.parentNode) document.body.removeChild(menu);
                            document.removeEventListener("click", closeMenu);
                        };
                        setTimeout(() => document.addEventListener("click", closeMenu), 0);
                    };
                    el.dataset.hasContextMenu = "true";
                }
            } else {
                el.remove();
            }
        } else {
            el.remove();
        }
    });
    
    // Create new floating DON elements if they don't exist
    if (gameState.player1.floatingDon && gameState.player1.floatingDon.length > 0) {
        gameState.player1.floatingDon.forEach(don => {
            if (!document.querySelector(`[data-player="player1"][data-don-id="${don.instanceId}"]`)) {
                const div = document.createElement("div");
                div.className = "floating-don";
                div.style.position = "absolute";
                div.style.left = don.x + "px";
                div.style.top = don.y + "px";
                div.style.width = "80px";
                div.style.height = "110px";
                div.style.cursor = "grab";
                div.style.zIndex = "50";
                div.style.userSelect = "none";
                div.style.pointerEvents = "auto";
                div.setAttribute("data-player", "player1");
                div.setAttribute("data-don-id", don.instanceId);
                
                const img = document.createElement("img");
                img.src = don.image;
                img.alt = "DON!!";
                img.className = "don-card-img";
                img.style.width = "100%";
                img.style.height = "100%";
                img.style.pointerEvents = "none";
                img.style.borderRadius = "8px";
                img.draggable = false;
                
                // Right-click to show context menu
                div.oncontextmenu = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    
                    const menu = document.createElement("div");
                    menu.className = "context-menu";
                    menu.style.position = "fixed";
                    menu.style.top = event.clientY + "px";
                    menu.style.left = event.clientX + "px";
                    menu.style.zIndex = "10001";
                    menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
                    menu.style.border = "1px solid #888";
                    menu.style.borderRadius = "4px";
                    menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
                    
                    const btn = document.createElement("div");
                    btn.textContent = "Return to DON!! Deck";
                    btn.style.padding = "8px 16px";
                    btn.style.cursor = "pointer";
                    btn.style.color = "#fff";
                    btn.style.fontSize = "14px";
                    btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                    btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                    btn.onclick = () => {
                        const player = gameState.player1;
                        player.don++;
                        gameState.player1.floatingDon = gameState.player1.floatingDon.filter(d => d.instanceId !== don.instanceId);
                        window.updateDonDisplay?.();
                        div.remove();
                        window.addGameLog?.(`DON!! returned to deck`);
                        window.scheduleOnlineBoardSync?.();
                        document.body.removeChild(menu);
                    };
                    menu.appendChild(btn);
                    document.body.appendChild(menu);
                    
                    const closeMenu = () => {
                        if (menu.parentNode) document.body.removeChild(menu);
                        document.removeEventListener("click", closeMenu);
                    };
                    setTimeout(() => document.addEventListener("click", closeMenu), 0);
                };
                
                div.appendChild(img);
                document.querySelector(".game-board").appendChild(div);
            }
        });
    }
    
    // Create new floating DON elements if they don't exist
    if (gameState.player2.floatingDon && gameState.player2.floatingDon.length > 0) {
        gameState.player2.floatingDon.forEach(don => {
            if (!document.querySelector(`[data-player="player2"][data-don-id="${don.instanceId}"]`)) {
                const div = document.createElement("div");
                div.className = "floating-don";
                div.style.position = "absolute";
                div.style.left = don.x + "px";
                div.style.top = don.y + "px";
                div.style.width = "80px";
                div.style.height = "110px";
                div.style.cursor = "grab";
                div.style.zIndex = "50";
                div.style.userSelect = "none";
                div.style.pointerEvents = "auto";
                div.setAttribute("data-player", "player2");
                div.setAttribute("data-don-id", don.instanceId);
                
                const img = document.createElement("img");
                img.src = don.image;
                img.alt = "DON!!";
                img.className = "don-card-img";
                img.style.width = "100%";
                img.style.height = "100%";
                img.style.pointerEvents = "none";
                img.style.borderRadius = "8px";
                img.draggable = false;
                
                // Right-click to show context menu
                div.oncontextmenu = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    
                    const menu = document.createElement("div");
                    menu.className = "context-menu";
                    menu.style.position = "fixed";
                    menu.style.top = event.clientY + "px";
                    menu.style.left = event.clientX + "px";
                    menu.style.zIndex = "10001";
                    menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
                    menu.style.border = "1px solid #888";
                    menu.style.borderRadius = "4px";
                    menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
                    
                    const btn = document.createElement("div");
                    btn.textContent = "Return to DON!! Deck";
                    btn.style.padding = "8px 16px";
                    btn.style.cursor = "pointer";
                    btn.style.color = "#fff";
                    btn.style.fontSize = "14px";
                    btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                    btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                    btn.onclick = () => {
                        const player = gameState.player2;
                        player.don++;
                        gameState.player2.floatingDon = gameState.player2.floatingDon.filter(d => d.instanceId !== don.instanceId);
                        window.updateDonDisplay?.();
                        div.remove();
                        window.addGameLog?.(`DON!! returned to deck`);
                        window.scheduleOnlineBoardSync?.();
                        document.body.removeChild(menu);
                    };
                    menu.appendChild(btn);
                    document.body.appendChild(menu);
                    
                    const closeMenu = () => {
                        if (menu.parentNode) document.body.removeChild(menu);
                        document.removeEventListener("click", closeMenu);
                    };
                    setTimeout(() => document.addEventListener("click", closeMenu), 0);
                };
                
                
                div.appendChild(img);
                document.querySelector(".game-board").appendChild(div);
            }
        });
    }
}

function returnDonCardToDeck(player, donIndex, isRested) {
    const playerKey = getPlayerKey(player);

    if (!playerKey || !gameState) return;

    if (isRested) {
        if (player.restedDon < 1) return;
        player.restedDon -= 1;
    } else {
        if (player.don < 1 || donIndex >= player.don) return;
        player.don -= 1;

        if (
            selectedDonAttachment &&
            selectedDonAttachment.playerKey === playerKey
        ) {
            const newIndexes = selectedDonAttachment.indexes
                .filter(index => index !== donIndex)
                .map(index => (index > donIndex ? index - 1 : index));

            selectedDonAttachment = newIndexes.length
                ? { playerKey, indexes: newIndexes }
                : null;
        }
    }

    addGameLog(`${player.name} returned 1 DON!! to the DON!! deck.`);
    updateDonDisplay();
    renderLeaders();
    renderCharacters();
    window.scheduleOnlineBoardSync?.();
}

function handleDonSelectionClick(player, donIndex) {
    const playerKey = getPlayerKey(player);

    if (!playerKey || gameState.currentPhase !== "main" || gameState.currentPlayer !== player) {
        clearSelectedDonAttachment();
        addGameLog("DON!! can only be selected during your Main Phase.");
        return;
    }

    const selectedIndexes = selectedDonAttachment?.playerKey === playerKey
        ? [...(selectedDonAttachment.indexes || [])]
        : [];
    const clickedIndex = Number(donIndex);
    const existingIndex = selectedIndexes.indexOf(clickedIndex);

    if (existingIndex === -1) {
        selectedIndexes.push(clickedIndex);
    } else {
        selectedIndexes.splice(existingIndex, 1);
    }

    selectedIndexes.sort((left, right) => left - right);

    selectedDonAttachment = selectedIndexes.length > 0
        ? { playerKey, indexes: selectedIndexes }
        : null;

    clearHandSelection();
    clearBoardSelection();
    updateDonDisplay();
    renderLeaders();
    renderCharacters();

    if (selectedDonAttachment) {
        addGameLog(`${player.name} selected ${selectedDonAttachment.indexes.length} DON!! to attach.`);
    }

    updatePhaseButtonPassState();
}

function clearSelectedDonAttachment({ silent = true } = {}) {
    if (!selectedDonAttachment) {
        return;
    }

    selectedDonAttachment = null;
    updateDonDisplay();
    renderLeaders();
    renderCharacters();

    if (!silent) {
        addGameLog("DON!! attachment selection cleared.");
    }

    updatePhaseButtonPassState();
}

async function attachSelectedDonToBoardCard(playerKey, card) {
    if (!selectedDonAttachment) {
        return false;
    }

    const player = gameState[playerKey];

    if (!player || selectedDonAttachment.playerKey !== playerKey) {
        clearSelectedDonAttachment({ silent: false });
        return true;
    }

    if (!canAttachDonToBoardCard(player, card)) {
        addGameLog(`${player.name} cannot attach DON!! to ${card?.name || "that card"} right now.`);
        clearSelectedDonAttachment();
        return true;
    }

    const donAmount = Math.min(
        selectedDonAttachment.indexes?.length || 0,
        Number(player.don || 0)
    );

    if (donAmount < 1) {
        clearSelectedDonAttachment();
        return true;
    }

    showDonAttachmentConfirm(player, card, donAmount);

    return true;
}

function showDonAttachmentConfirm(player, card, donAmount) {
    removeDonAttachmentConfirm();

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay don-attachment-confirm";
    overlay.id = "donAttachmentConfirm";

    const popup = document.createElement("div");
    popup.className = "look-top-popup don-attachment-popup";

    const heading = document.createElement("h2");
    heading.textContent = "Attach DON!!";

    const body = document.createElement("div");
    body.className = "don-attachment-body";

    const cardImage = document.createElement("img");
    cardImage.src = cardArtSrc(card);
    cardImage.alt = card.name;
    cardImage.className = "don-attachment-card";

    const summary = document.createElement("div");
    summary.className = "don-attachment-summary";

    const amountBadge = document.createElement("div");
    amountBadge.className = "don-attachment-amount";
    amountBadge.textContent = `x${donAmount}`;

    const message = document.createElement("p");
    message.textContent = `Attach ${donAmount} active DON!! to ${card.name}?`;

    const buttonRow = document.createElement("div");
    buttonRow.className = "look-top-buttons don-attachment-buttons";

    const attachButton = document.createElement("button");
    attachButton.className = "look-top-action-button";
    attachButton.textContent = "Attach";

    const cancelButton = document.createElement("button");
    cancelButton.className = "look-top-action-button secondary";
    cancelButton.textContent = "Nevermind";

    attachButton.addEventListener("click", async () => {
        const result = attachActiveDonToCard(player, card, ui, donAmount);

        addGameLog(result.message);
        removeDonAttachmentConfirm();
        clearSelectedDonAttachment();

        if (result.success) {
            await syncOnlineStateFromLocal();
        }
    });

    cancelButton.addEventListener("click", () => {
        removeDonAttachmentConfirm();
        clearSelectedDonAttachment({ silent: false });
    });

    buttonRow.appendChild(attachButton);
    buttonRow.appendChild(cancelButton);
    summary.appendChild(amountBadge);
    summary.appendChild(message);
    summary.appendChild(buttonRow);

    body.appendChild(cardImage);
    body.appendChild(summary);

    popup.appendChild(heading);
    popup.appendChild(body);
    overlay.appendChild(popup);
    overlay.addEventListener("click", event => {
        if (event.target === overlay) {
            removeDonAttachmentConfirm();
            clearSelectedDonAttachment({ silent: false });
        }
    });

    document.body.appendChild(overlay);

    updatePhaseButtonPassState();
}

function removeDonAttachmentConfirm() {
    const oldOverlay = document.getElementById("donAttachmentConfirm");

    if (oldOverlay) {
        oldOverlay.remove();
    }

    updatePhaseButtonPassState();
}

function getDonOnField(player) {
    const active = Number(player.don || 0);
    const rested = Number(player.restedDon || 0);
    const floating = Number(player.floatingDon?.length || 0);

    let attached = 0;

    if (player.leader?.attachedDon) {
        attached += Number(player.leader.attachedDon);
    }

    player.characters?.forEach(card => {
        if (card?.attachedDon) {
            attached += Number(card.attachedDon);
        }
    });

    if (player.stage?.attachedDon) {
        attached += Number(player.stage.attachedDon);
    }

    return active + rested + floating + attached;
}

function renderDonDecks() {
    renderDonDeck(gameState.player1, "player1DonDeckArea");
    renderDonDeck(gameState.player2, "player2DonDeckArea");
}

function renderDonDeck(player, areaId) {
    const donDeckArea = document.getElementById(areaId);

    if (!donDeckArea) return;

    donDeckArea.innerHTML = "";
    donDeckArea.style.cursor = "pointer";

    const symbol = document.createElement("div");
    symbol.className = "don-deck-symbol";

    // Calculate remaining DON in deck: 10 total - all DON cards on the field
    const donOnField = getDonOnField(player);
    const remaining = Math.max(0, 10 - donOnField);
    player.donDeck = remaining;

    symbol.title = `${remaining} DON!! left in deck - Click to add DON to field`;
    symbol.style.cursor = "pointer";

    const glyph = document.createElement("span");
    glyph.className = "don-deck-glyph";
    glyph.textContent = "ド!!";

    const count = document.createElement("div");
    count.className = "don-deck-number";
    count.textContent = remaining;

    symbol.appendChild(glyph);

    // Click to add DON from deck to field
    const handleClick = (event) => {
        event.stopPropagation();
        if (remaining > 0) {
            player.don++;
            window.updateDonDisplay?.();
            window.renderDonDecks?.();
            window.addGameLog?.(`Added DON to field`);
            window.scheduleOnlineBoardSync?.();
        } else {
            window.addGameLog?.(`Cannot add DON - no DON left in deck or maximum reached`);
        }
    };
    
    // Only add handler to symbol, not donDeckArea (avoid duplicate handlers)
    symbol.addEventListener("click", handleClick);
    
    donDeckArea.appendChild(symbol);
    donDeckArea.appendChild(count);
}

// =========================
// Deck Rendering
// =========================

function renderDecks() {
    renderDeck(gameState.player1, "player1DeckArea");
    renderDeck(gameState.player2, "player2DeckArea");
}

function renderDeck(player, deckAreaId) {
    const deckArea = document.getElementById(deckAreaId);

    if (!deckArea) return;

    deckArea.innerHTML = "";

    deckArea.classList.remove("deck-warning");

    if (player.deck.length > 0 && player.deck.length <= 2) {
        deckArea.classList.add("deck-warning");
    }

    if (player.deck.length > 0) {
        const img = document.createElement("img");

        img.src = cardBackImage;
        img.alt = `${player.name} Deck`;
        img.className = "deck-card-img life-card-img";
        img.draggable = true;
        img.setAttribute("data-card-source", "deck");
        img.setAttribute("data-player", player === gameState.player1 ? "player1" : "player2");
        img.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            showDeckContextMenu(event, player, "deck", "Deck");
        };

        deckArea.appendChild(img);
    } else {
        deckArea.textContent = "";
    }

    const count = document.createElement("div");
    count.className = "deck-count-badge main-deck-count";
    count.textContent = player.deck.length;

    deckArea.appendChild(count);
}

// =========================
// Extra utility piles (face-up + face-down)
// =========================

// The board is authored from Player 1's seat and P2 only gets the two halves
// swapped, so hardcoded "Your"/"Opponent" labels read backwards for P2. Label
// each group by who actually owns it instead.
function updateExtraZoneLabels() {
    const ownKey = isOnlineMatch ? getOwnOnlinePlayerKey() : "player1";

    const p1Label = document.getElementById("extraZonesLabelP1");
    const p2Label = document.getElementById("extraZonesLabelP2");

    if (p1Label) p1Label.textContent = ownKey === "player1" ? "Your Piles" : "Opponent Piles";
    if (p2Label) p2Label.textContent = ownKey === "player2" ? "Your Piles" : "Opponent Piles";
}

function renderExtraPiles() {
    updateExtraZoneLabels();
    renderExtraPile(gameState.player1, "player1", "extraFaceUp", "player1ExtraFaceUpArea", true);
    renderExtraPile(gameState.player1, "player1", "extraFaceDown", "player1ExtraFaceDownArea", false);
    renderExtraPile(gameState.player2, "player2", "extraFaceUp", "player2ExtraFaceUpArea", true);
    renderExtraPile(gameState.player2, "player2", "extraFaceDown", "player2ExtraFaceDownArea", false);
    renderTokenZones();
}

// =========================
// Token Zone
// =========================
// The token zone is a FACE-UP PILE, behaving like the deck and the extra piles:
// it holds token cards, you drag them out to wherever you want them, and
// right-clicking opens the standard pile viewer with all the same controls.
// The deck only decides which token TYPES are available; you add and remove
// copies in the pile freely during a match via the "Add tokens" picker.

function renderTokenZones() {
    renderTokenZone(gameState.player1, "player1", "player1TokenZoneArea");
    renderTokenZone(gameState.player2, "player2", "player2TokenZoneArea");
}

function renderTokenZone(player, playerKey, areaId) {
    const area = document.getElementById(areaId);
    if (!area || !player) return;

    const tokenTypes = Array.isArray(player.tokenTypes) ? player.tokenTypes : [];
    if (!Array.isArray(player.tokens)) player.tokens = [];
    const pile = player.tokens;

    area.innerHTML = "";

    // A deck with no token types has no token zone at all - tokens are optional.
    if (tokenTypes.length === 0) {
        area.classList.add("hidden");
        return;
    }

    area.classList.remove("hidden");

    // The "+" button below means this area is never CSS-:empty, so the shared
    // empty-label rule can't apply - render the placeholder explicitly.
    if (pile.length === 0) {
        const empty = document.createElement("span");
        empty.className = "token-empty-label";
        empty.textContent = "Token pile";
        area.appendChild(empty);
    }

    if (pile.length > 0) {
        const topCard = pile[pile.length - 1];
        const img = document.createElement("img");
        // Always face-up.
        img.src = cardArtSrc(topCard);
        img.alt = topCard?.name || "Token";
        img.className = "extra-pile-img";
        img.draggable = true;
        img.setAttribute("data-card-source", "extra");
        img.setAttribute("data-player", playerKey);
        img.setAttribute("data-pile", "tokens");
        img.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            showDeckContextMenu(event, player, "tokens", "Token Pile");
        };
        area.appendChild(img);

        const count = document.createElement("div");
        count.className = "extra-pile-count";
        count.textContent = pile.length;
        area.appendChild(count);
    }

    // Small always-visible control to put more tokens into the pile.
    const addButton = document.createElement("button");
    addButton.className = "token-add-btn";
    addButton.textContent = "+";
    addButton.title = "Add tokens to this pile";
    addButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showTokenPicker(player, playerKey);
    });
    area.appendChild(addButton);
}

function countTokensInPile(player, tokenCard) {
    return (player.tokens || []).filter(token =>
        token && token.tokenTypeId === tokenCard.id).length;
}

// Put one copy of a token type into the player's token pile. From there it is
// dragged onto the board like any other card.
function createTokenCopy(player, playerKey, tokenCard) {
    if (!Array.isArray(player.tokens)) player.tokens = [];

    const instance = createCardInstance(tokenCard);
    instance.isToken = true;
    instance.tokenTypeId = tokenCard.id;
    // Tokens play exactly like characters once they leave the pile.
    instance.cardType = "character";
    player.tokens.push(instance);

    addGameLog(`${player.name} added a ${tokenCard.name} token to their token pile.`);
    return true;
}

// Take the most recent copy of this token type back out of the pile.
function removeTokenCopy(player, tokenCard) {
    const pile = player.tokens || [];

    for (let index = pile.length - 1; index >= 0; index--) {
        if (pile[index] && pile[index].tokenTypeId === tokenCard.id) {
            pile.splice(index, 1);
            addGameLog(`${player.name} removed a ${tokenCard.name} token from their token pile.`);
            return true;
        }
    }

    addGameLog(`No ${tokenCard.name} token in the pile to remove.`);
    return false;
}

function renderExtraPile(player, playerKey, pileKey, areaId, faceUp) {
    const area = document.getElementById(areaId);
    if (!area || !player) return;

    if (!Array.isArray(player[pileKey])) player[pileKey] = [];
    const pile = player[pileKey];

    area.innerHTML = "";
    area.setAttribute("data-empty-label", faceUp ? "Face-up pile" : "Face-down pile");

    if (pile.length > 0) {
        const topCard = pile[pile.length - 1];
        const img = document.createElement("img");
        // Face-up pile shows the top card's art; face-down shows the card back.
        img.src = faceUp ? cardArtSrc(topCard) : cardBackImage;
        img.alt = faceUp ? (topCard?.name || "Card") : "Face-down card";
        img.className = "extra-pile-img";
        img.draggable = true;
        img.setAttribute("data-card-source", "extra");
        img.setAttribute("data-player", playerKey);
        img.setAttribute("data-pile", pileKey);
        img.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            showDeckContextMenu(event, player, pileKey, faceUp ? "Face-up Pile" : "Face-down Pile");
        };
        area.appendChild(img);

        const count = document.createElement("div");
        count.className = "extra-pile-count";
        count.textContent = pile.length;
        area.appendChild(count);
    }
}

// The token zone's viewer. Lists every token type the deck made available, with
// how many copies are currently on the board and controls to create or remove
// them. Stays open while you work so several tokens can be made in one go.
function showTokenPicker(player, playerKey) {
    removeTokenPicker();

    const tokenTypes = Array.isArray(player.tokenTypes) ? player.tokenTypes : [];

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "tokenPickerOverlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10000;";

    const popup = document.createElement("div");
    popup.style.cssText = "width:95%;max-width:1000px;max-height:88vh;background:rgba(20,20,20,0.98);border:2px solid #888;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;";

    const title = document.createElement("h2");
    title.style.cssText = "color:#fff;padding:10px 16px;margin:0;border-bottom:1px solid #555;font-size:14px;";
    title.textContent = `${player.name}'s Tokens (${tokenTypes.length} type${tokenTypes.length === 1 ? "" : "s"})`;

    const grid = document.createElement("div");
    grid.style.cssText = "padding:12px;display:flex;flex-wrap:wrap;gap:12px;overflow-y:auto;align-content:flex-start;";

    const refresh = () => {
        renderTokenZones();
        window.scheduleOnlineBoardSync?.();
        showTokenPicker(player, playerKey); // rebuild so pile counts stay live
    };

    if (tokenTypes.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#bbb;padding:18px;font-size:13px;";
        empty.textContent = "This deck has no token types. Add some in the Deck Builder.";
        grid.appendChild(empty);
    }

    tokenTypes.forEach(tokenCard => {
        const inPile = countTokensInPile(player, tokenCard);

        const cell = document.createElement("div");
        cell.style.cssText = "width:150px;display:flex;flex-direction:column;gap:6px;align-items:center;";

        const img = document.createElement("img");
        img.src = cardArtSrc(tokenCard);
        img.alt = tokenCard.name || "Token";
        img.style.cssText = "width:100%;border-radius:6px;display:block;";
        img.addEventListener("mouseenter", () => showCardPreview(tokenCard));
        cell.appendChild(img);

        const label = document.createElement("div");
        label.style.cssText = "color:#fff;font-size:12px;font-weight:700;text-align:center;";
        label.textContent = `${tokenCard.name || "Token"} — ${inPile} in pile`;
        cell.appendChild(label);

        const controls = document.createElement("div");
        controls.style.cssText = "display:flex;gap:6px;";

        const createButton = document.createElement("button");
        createButton.textContent = "+ Add";
        createButton.style.cssText = "flex:1;padding:5px;font-size:11px;font-weight:700;cursor:pointer;border-radius:4px;border:1px solid #0e9f70;background:#10b981;color:#000;";
        createButton.addEventListener("click", () => {
            if (createTokenCopy(player, playerKey, tokenCard)) refresh();
        });

        const removeButton = document.createElement("button");
        removeButton.textContent = "− Remove";
        removeButton.style.cssText = "flex:1;padding:5px;font-size:11px;font-weight:700;cursor:pointer;border-radius:4px;border:1px solid #c82333;background:#dc3545;color:#fff;";
        removeButton.disabled = inPile === 0;
        if (inPile === 0) removeButton.style.opacity = ".5";
        removeButton.addEventListener("click", () => {
            if (removeTokenCopy(player, tokenCard)) refresh();
        });

        controls.appendChild(createButton);
        controls.appendChild(removeButton);
        cell.appendChild(controls);
        grid.appendChild(cell);
    });

    const footer = document.createElement("div");
    footer.style.cssText = "padding:8px 12px;border-top:1px solid #555;display:flex;justify-content:flex-end;";

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
    closeButton.style.cssText = "padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;border-radius:4px;border:1px solid #5a6268;background:#6c757d;color:#fff;";
    closeButton.addEventListener("click", removeTokenPicker);
    footer.appendChild(closeButton);

    popup.appendChild(title);
    popup.appendChild(grid);
    popup.appendChild(footer);
    overlay.appendChild(popup);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) removeTokenPicker();
    });

    document.body.appendChild(overlay);
}

function removeTokenPicker() {
    document.getElementById("tokenPickerOverlay")?.remove();
}

// Right-clicking a deck opens this first: browse the whole deck, or look at
// just the top N. Both land in the same viewer with the same controls.
function showDeckContextMenu(event, player, pileKey = "deck", pileLabel = "Deck") {
    document.getElementById("deckContextMenu")?.remove();

    const menu = document.createElement("div");
    menu.id = "deckContextMenu";
    menu.className = "context-menu";
    menu.style.cssText =
        `position:fixed;top:${event.clientY}px;left:${event.clientX}px;z-index:10001;` +
        "min-width:180px;padding:6px;border:1px solid #555;border-radius:8px;" +
        "background:rgba(20,20,20,.98);box-shadow:0 12px 32px rgba(0,0,0,.55);" +
        "display:flex;flex-direction:column;gap:4px;";

    const close = () => menu.remove();

    const addItem = (label, onClick) => {
        const item = document.createElement("button");
        item.textContent = label;
        item.style.cssText =
            "padding:8px 10px;border:0;border-radius:5px;background:transparent;color:#fff;" +
            "font-size:12px;font-weight:700;text-align:left;cursor:pointer;";
        item.onmouseenter = () => { item.style.background = "rgba(255,255,255,.12)"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };
        item.onclick = (e) => { e.stopPropagation(); close(); onClick(); };
        menu.appendChild(item);
    };

    const total = Array.isArray(player[pileKey]) ? player[pileKey].length : 0;

    addItem(`Open ${pileLabel.toLowerCase()} (${total})`, () =>
        showDeckViewer(player, pileKey, pileLabel));

    // Common look-at sizes, only offered when there are that many cards.
    [1, 3, 5].forEach(n => {
        if (total >= n) {
            addItem(`Peek at top ${n}`, () =>
                showDeckViewer(player, pileKey, pileLabel, n));
        }
    });

    addItem("Peek at top…", () => {
        window.showCustomPrompt?.(`Look at how many cards? (1-${total})`, "5", (input) => {
            const count = Math.max(1, Math.min(total, parseInt(input, 10) || 0));
            if (count > 0) showDeckViewer(player, pileKey, pileLabel, count);
        });
    });

    document.body.appendChild(menu);

    // Keep the menu on screen when right-clicking near an edge.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

    setTimeout(() => {
        document.addEventListener("click", close, { once: true });
        document.addEventListener("contextmenu", close, { once: true });
    }, 0);
}

// peekCount limits the view to the TOP N cards ("look at the top 5"). Every
// control still acts on the real pile, so a card can be sent to hand/trash/
// bottom exactly as when browsing the whole deck - you just can't see past the
// cards you're allowed to look at. 0 / omitted shows everything.
function showDeckViewer(player, pileKey = "deck", pileLabel = "Deck", peekCount = 0) {
    if (!Array.isArray(player[pileKey])) player[pileKey] = [];
    // Re-render whichever pile this viewer is showing (deck or an extra pile).
    const renderPileSource = () => {
        if (pileKey === "deck") window.renderDecks?.();
        else window.renderExtraPiles?.();
    };
    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "deckViewerOverlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10000;";

    const popup = document.createElement("div");
    popup.className = "look-top-popup";
    popup.style.cssText = "width:95%;max-width:1200px;max-height:88vh;background:rgba(20,20,20,0.98);border:2px solid #888;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;";

    const title = document.createElement("h2");
    title.style.cssText = "color:#fff;padding:10px 16px;margin:0;border-bottom:1px solid #555;font-size:14px;";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "padding:7px 12px;border-bottom:1px solid #555;display:flex;gap:8px;flex-wrap:wrap;align-items:center;";

    function mkBtn(text, bg) {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText = `padding:5px 10px;background:${bg};color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;`;
        return b;
    }
    const revealAllBtn = mkBtn("Reveal All", "#4CAF50");
    revealAllBtn.onclick = () => { player[pileKey].forEach(c => c.faceUp = true); buildGrid(); addGameLog(`${player.name}'s deck revealed`); window.scheduleOnlineBoardSync?.(); };
    toolbar.appendChild(revealAllBtn);

    const hideAllBtn = mkBtn("Hide All", "#2196F3");
    hideAllBtn.onclick = () => { player[pileKey].forEach(c => c.faceUp = false); buildGrid(); addGameLog(`${player.name}'s deck hidden`); window.scheduleOnlineBoardSync?.(); };
    toolbar.appendChild(hideAllBtn);

    const shuffleBtn = mkBtn("\uD83D\uDD00 Shuffle", "#FF9800");
    shuffleBtn.onclick = () => { shuffleDeck(player[pileKey]); buildGrid(); addGameLog(`${player.name}'s deck shuffled`); window.scheduleOnlineBoardSync?.(); };
    toolbar.appendChild(shuffleBtn);

    // Prompt for a count, then move that many cards off the top of the deck
    // (the end of the array - see the top/bottom convention used throughout
    // this file) to the chosen zone, preserving their relative order.
    function sendTopCardsPrompt(destination, label) {
        const maxCount = player[pileKey].length;
        if (maxCount === 0) {
            addGameLog(`${player.name}'s deck is empty`);
            return;
        }
        window.showCustomPrompt(`Send top how many cards to ${label}? (1-${maxCount})`, "1", (input) => {
            const count = Math.floor(Number(input));
            if (!Number.isFinite(count) || count <= 0) return;
            const actualCount = Math.min(count, maxCount);

            // moved is ordered [deepest ... topmost] since splice preserves original index order
            const moved = player[pileKey].splice(player[pileKey].length - actualCount, actualCount);

            if (destination === "trash") {
                if (!player.trash) player.trash = [];
                player.trash.push(...moved); // last pushed (topmost) becomes new top-of-trash
                window.renderTrash?.();
            } else if (destination === "hand") {
                player.hand.push(...moved);
                window.renderHands?.();
            } else if (destination === "life") {
                // Life's "top" is the front of the array, so reverse the moved group first
                // to keep the true top-of-deck card on top of life, and hide them face-down.
                const lifeCards = moved.slice().reverse().map(c => ({ ...c, faceUp: false }));
                player.life.unshift(...lifeCards);
                window.renderLifeCards?.();
            }

            renderPileSource();
            buildGrid();
            addGameLog(`Sent top ${actualCount} card${actualCount === 1 ? "" : "s"} of ${player.name}'s deck to ${label}`);
            window.scheduleOnlineBoardSync?.();
        });
    }

    const trashTopBtn = mkBtn("Send Top X \u2192 Trash", "#F44336");
    trashTopBtn.onclick = () => sendTopCardsPrompt("trash", "trash");
    toolbar.appendChild(trashTopBtn);

    const lifeTopBtn = mkBtn("Send Top X \u2192 Life", "#00BCD4");
    lifeTopBtn.onclick = () => sendTopCardsPrompt("life", "life");
    toolbar.appendChild(lifeTopBtn);

    const handTopBtn = mkBtn("Send Top X \u2192 Hand", "#FF9800");
    handTopBtn.onclick = () => sendTopCardsPrompt("hand", "hand");
    toolbar.appendChild(handTopBtn);

    const hint = document.createElement("span");
    hint.textContent = "Drag to reorder \u2022 Hover for actions";
    hint.style.cssText = "color:#777;font-size:11px;margin-left:auto;";
    toolbar.appendChild(hint);

    const cardGrid = document.createElement("div");
    cardGrid.style.cssText = "overflow-y:auto;flex:1;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;align-content:start;";

    // Ghost placeholder — the visible "gap" that moves as you drag
    const ghost = document.createElement("div");
    ghost.style.cssText = "border-radius:4px;border:2px dashed #FFD700;background:rgba(255,215,0,0.10);aspect-ratio:5/7;box-sizing:border-box;display:none;pointer-events:none;";

    let dragSrcIndex = null;   // display index of card being dragged
    let dragSrcFrame = null;   // the actual source frame element (tracked by reference so it
                                // can always be excluded correctly, even before its hide takes effect)
    let ghostTarget  = null;   // frame element ghost is currently sitting before (null = end)
    const frameRefs  = [];     // ordered array of frame elements

    // FLIP: smoothly animate cards from their old positions to new ones after a DOM change.
    // moveGhost fires on almost every dragover, so a new flipAnimate call can land while a
    // previous card's transition is still mid-flight. Without a way to tell "my" scheduled
    // cleanup apart from an older, superseded one, both would eventually fire and stomp on
    // the same transform/transition, which is what made cards visibly bounce/jitter. Each
    // frame gets a token bumped on every flip; a scheduled cleanup only applies if it's
    // still the most recent one for that frame.
    function flipAnimate(doChange) {
        const before = frameRefs.map(f => f.getBoundingClientRect());
        doChange();
        frameRefs.forEach((f, i) => {
            const after = f.getBoundingClientRect();
            const dx = before[i].left - after.left;
            const dy = before[i].top  - after.top;
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                const token = (f._flipToken = (f._flipToken || 0) + 1);
                f.style.transition = "none";
                f.style.transform  = `translate(${dx}px,${dy}px)`;
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (f._flipToken !== token) return; // superseded by a newer flip
                    f.style.transition = "transform 0.18s ease";
                    f.style.transform  = "";
                }));
            }
        });
    }

    // Move ghost before `beforeFrame` (or append if null), animating surrounding cards
    function moveGhost(beforeFrame) {
        if (ghostTarget === beforeFrame) return; // already there
        ghostTarget = beforeFrame;
        flipAnimate(() => {
            if (beforeFrame) {
                cardGrid.insertBefore(ghost, beforeFrame);
            } else {
                cardGrid.appendChild(ghost);
            }
        });
    }

    function buildGrid() {
        // How many cards this view may show, clamped to what's actually left.
        const visibleCount = peekCount > 0
            ? Math.min(peekCount, player[pileKey].length)
            : player[pileKey].length;

        title.textContent = peekCount > 0
            ? `${player.name}'s ${pileLabel} — top ${visibleCount} of ${player[pileKey].length}`
            : `${player.name}'s ${pileLabel} (${player[pileKey].length} cards)`;

        cardGrid.innerHTML = "";
        frameRefs.length = 0;
        dragSrcIndex = null;
        dragSrcFrame = null;
        ghostTarget  = null;
        ghost.style.display = "none";
        // The pile stores bottom-first (draws pop() off the end), so reversing
        // puts the top of the deck first; slicing then takes the top N.
        const display = [...player[pileKey]].reverse().slice(0, visibleCount);

        display.forEach((card, displayIndex) => {
            const frame = document.createElement("div");
            frame.draggable = true;
            frame._card = card;
            frame._di   = displayIndex;
            frame.style.cssText = "position:relative;cursor:grab;border-radius:4px;overflow:hidden;border:1px solid #555;user-select:none;";
            frameRefs.push(frame);

            // Position number badge
            const badge = document.createElement("div");
            badge.textContent = displayIndex + 1;
            badge.style.cssText = "position:absolute;top:3px;left:3px;background:rgba(0,0,0,0.82);color:#fff;font-size:10px;font-weight:bold;padding:1px 5px;border-radius:3px;z-index:2;pointer-events:none;line-height:15px;min-width:14px;text-align:center;";

            const img = document.createElement("img");
            img.src = card.faceUp ? cardArtSrc(card) : cardBackImage;
            img.alt = card.faceUp && card.name ? card.name : "Card";
            img.style.cssText = "width:100%;display:block;aspect-ratio:5/7;object-fit:cover;";
            img.draggable = false;

            // Hover action overlay
            const hoverPanel = document.createElement("div");
            hoverPanel.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.72);display:flex;flex-direction:column;gap:3px;align-items:stretch;justify-content:center;opacity:0;transition:opacity .13s;z-index:3;padding:5px;box-sizing:border-box;";

            function mkSmBtn(text, bg) {
                const b = document.createElement("button");
                b.textContent = text;
                b.style.cssText = `width:100%;padding:3px 2px;font-size:9px;background:${bg};color:#fff;border:none;border-radius:2px;cursor:pointer;white-space:nowrap;`;
                return b;
            }
            const rBtn   = mkSmBtn(card.faceUp ? "Hide" : "Reveal", "#2196F3");
            rBtn.onclick = (e) => { e.stopPropagation(); card.faceUp = !card.faceUp; buildGrid(); };

            const hBtn   = mkSmBtn("\u2192 Hand", "#FF9800");
            hBtn.onclick = (e) => { e.stopPropagation(); const idx = player[pileKey].indexOf(card); if (idx===-1) return; player.hand.push(card); player[pileKey].splice(idx,1); window.renderHands?.(); renderPileSource(); buildGrid(); addGameLog(`Card moved to ${player.name}'s hand`); window.scheduleOnlineBoardSync?.(); };

            const botBtn = mkSmBtn("\u2193 Bottom", "#9C27B0");
            botBtn.onclick = (e) => { e.stopPropagation(); const idx = player[pileKey].indexOf(card); if (idx===-1) return; player[pileKey].splice(idx,1); player[pileKey].unshift(card); renderPileSource(); buildGrid(); addGameLog(`Card moved to bottom of ${player.name}'s deck`); window.scheduleOnlineBoardSync?.(); };

            const tBtn   = mkSmBtn("\uD83D\uDDD1 Trash", "#F44336");
            tBtn.onclick = (e) => { e.stopPropagation(); const idx = player[pileKey].indexOf(card); if (idx===-1) return; if (!player.trash) player.trash=[]; player.trash.push(card); player[pileKey].splice(idx,1); window.renderTrash?.(); renderPileSource(); buildGrid(); addGameLog(`Card moved to ${player.name}'s trash`); window.scheduleOnlineBoardSync?.(); };

            hoverPanel.appendChild(rBtn);
            hoverPanel.appendChild(hBtn);
            hoverPanel.appendChild(botBtn);
            hoverPanel.appendChild(tBtn);

            frame.addEventListener("mouseenter", () => { if (dragSrcIndex === null) hoverPanel.style.opacity = "1"; });
            frame.addEventListener("mouseleave", () => { hoverPanel.style.opacity = "0"; });

            // ── Drag source ──
            frame.addEventListener("dragstart", (e) => {
                dragSrcIndex = displayIndex;
                dragSrcFrame = frame;
                e.dataTransfer.effectAllowed = "move";
                hoverPanel.style.opacity = "0";
                // Defer hiding the card and swapping in the ghost: mutating the dragged
                // element synchronously inside dragstart (e.g. hiding it) can make the
                // browser cancel the native drag outright. Waiting a tick also lets the
                // browser capture the card at full opacity as the drag image first.
                setTimeout(() => {
                    ghost.style.display = "";
                    // Size ghost to match a card cell
                    ghost.style.width = frame.offsetWidth + "px";
                    // Place ghost where the card was, hide the card
                    flipAnimate(() => {
                        cardGrid.insertBefore(ghost, frame);
                        frame.style.visibility = "hidden";
                    });
                    ghostTarget = frame; // ghost is before the hidden src frame
                }, 0);
            });

            frame.addEventListener("dragend", () => {
                buildGrid(); // always clean rebuild on cancel or drop
            });

            frame.appendChild(img);
            frame.appendChild(badge);
            frame.appendChild(hoverPanel);
            cardGrid.appendChild(frame);
        });

        // Keep ghost in DOM (hidden) so it's always available
        cardGrid.appendChild(ghost);
    }

    // ── Drag target (delegated to the whole grid, not individual cards) ──
    // Cards are small with gaps between them and the ghost placeholder itself has
    // pointer-events:none, so relying on per-card dragover handlers meant the cursor
    // could easily drift onto a gap or the ghost's own cell mid-drag with nothing
    // listening there - the browser would then refuse the drop entirely. Tracking the
    // nearest card to the cursor over the whole grid keeps the ghost (and the drop)
    // working anywhere inside it.
    cardGrid.addEventListener("dragover", (e) => {
        if (dragSrcIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        let closestFrame = null;
        let closestDist = Infinity;
        let insertBeforeClosest = true;
        frameRefs.forEach(f => {
            // Exclude the true source by reference (not by visibility, which may not
            // have taken effect yet if the deferred hide in dragstart hasn't run)
            if (f === dragSrcFrame) return;
            const rect = f.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
            if (dist < closestDist) {
                closestDist = dist;
                closestFrame = f;
                insertBeforeClosest = e.clientX < cx;
            }
        });

        if (closestFrame) {
            moveGhost(insertBeforeClosest ? closestFrame : closestFrame.nextElementSibling);
        }
    });

    cardGrid.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragSrcIndex === null) return;

        // Determine ghost's position in DOM among visible (non-hidden) frames
        const children = [...cardGrid.children];
        const ghostPos = children.indexOf(ghost);
        if (ghostPos === -1) { buildGrid(); return; }

        // Build new display order from DOM order, skipping ghost and the true source
        // frame (excluded by reference, not visibility - see dragover above)
        const newDisplay = [];
        children.forEach(ch => {
            if (ch === ghost) {
                // insert dragged card here
                newDisplay.push(frameRefs[dragSrcIndex]._card);
            } else if (ch !== dragSrcFrame && ch._card !== undefined) {
                newDisplay.push(ch._card);
            }
        });

        // newDisplay only covers the cards on screen. When peeking that's just
        // the top N, so splice them back over the top of the pile instead of
        // replacing it wholesale - assigning directly would delete every card
        // below the peek window.
        const reordered = [...newDisplay].reverse();
        if (peekCount > 0 && reordered.length < player[pileKey].length) {
            player[pileKey].splice(player[pileKey].length - reordered.length, reordered.length, ...reordered);
        } else {
            player[pileKey] = reordered;
        }

        renderPileSource();
        buildGrid();
        window.scheduleOnlineBoardSync?.();
    });

    buildGrid();

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
    closeButton.style.cssText = "padding:7px 18px;background:#555;color:#fff;border:none;cursor:pointer;align-self:flex-end;margin:8px;border-radius:4px;font-size:13px;";
    closeButton.onclick = removeDeckViewer;

    popup.appendChild(title);
    popup.appendChild(toolbar);
    popup.appendChild(cardGrid);
    popup.appendChild(closeButton);
    overlay.appendChild(popup);
    overlay.onclick = (e) => { if (e.target === overlay) removeDeckViewer(); };
    document.body.appendChild(overlay);
}
function removeDeckViewer() {
    const overlay = document.getElementById("deckViewerOverlay");
    if (overlay) overlay.remove();
}

function shuffleDeck(deck) {
    // Fisher-Yates shuffle algorithm
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// =========================
// Hand Rendering
// =========================

function renderHands() {
    if (isOnlineMatch) {
        renderPlayerHand(gameState.player1, "player1Hand", playerSlot !== "p1");
        renderPlayerHand(gameState.player2, "player2Hand", playerSlot !== "p2");
        window.manualPlay?.reapplyAnnotations?.();
        return;
    }

    renderPlayerHand(gameState.player1, "player1Hand", false);
    renderPlayerHand(gameState.player2, "player2Hand", false);
    window.manualPlay?.reapplyAnnotations?.();
}

function renderPlayerHand(player, handElementId, hidden) {
    const handElement = document.getElementById(handElementId);

    if (!handElement) return;

    handElement.innerHTML = "";

    handElement.style.setProperty("--hand-total", player.hand.length);

    player.hand.forEach((card, index) => {
        const cardElement = document.createElement("div");
        cardElement.className = hidden ? "hand-card hidden-card" : "hand-card";
        cardElement.draggable = true; // Enable native HTML5 drag
        cardElement.style.setProperty("--hand-index", index);
        cardElement.style.setProperty("--hand-middle", (player.hand.length - 1) / 2);

        if (hidden) {
            const img = document.createElement("img");

            img.src = cardBackImage;
            img.alt = "Hidden Card";
            img.className = "hand-card-img";

            cardElement.appendChild(img);
        } else {
            cardElement.setAttribute("data-card-image", card.image);
            cardElement.setAttribute("data-player", player === gameState.player1 ? "player1" : "player2");
            cardElement.setAttribute("data-card-instance-id", card.instanceId);
            cardElement.classList.add("selectable-card");
            applyCardAnimationClass(cardElement, takeCardAnimationClass(card));

            const img = document.createElement("img");

            img.src = cardArtSrc(card);
            img.alt = card.name;
            img.className = "hand-card-img";

            cardElement.appendChild(img);

            // Right-click context menu for hand cards
            cardElement.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();

                document.querySelectorAll(".context-menu").forEach(m => m.parentNode && m.parentNode.removeChild(m));

                const menu = document.createElement("div");
                menu.className = "context-menu";
                menu.style.position = "fixed";
                menu.style.top = event.clientY + "px";
                menu.style.left = event.clientX + "px";
                menu.style.zIndex = "10001";
                menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
                menu.style.border = "1px solid #888";
                menu.style.borderRadius = "4px";
                menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";

                const options = [
                    {
                        label: "Send to Trash",
                        action: () => {
                            const cardIndex = player.hand.findIndex(c => c.instanceId === card.instanceId);
                            if (cardIndex === -1) return;
                            const [removed] = player.hand.splice(cardIndex, 1);
                            if (!player.trash) player.trash = [];
                            player.trash.push(removed);
                            renderHands();
                            renderTrash();
                            addGameLog(`${removed.name} sent to trash from hand.`);
                        }
                    },
                    {
                        label: "Send to Top Deck",
                        action: () => {
                            const cardIndex = player.hand.findIndex(c => c.instanceId === card.instanceId);
                            if (cardIndex === -1) return;
                            const [removed] = player.hand.splice(cardIndex, 1);
                            player.deck.push(removed);
                            renderHands();
                            renderDecks();
                            addGameLog(`${removed.name} sent to top of deck from hand.`);
                        }
                    },
                    {
                        label: "Send to Bottom Deck",
                        action: () => {
                            const cardIndex = player.hand.findIndex(c => c.instanceId === card.instanceId);
                            if (cardIndex === -1) return;
                            const [removed] = player.hand.splice(cardIndex, 1);
                            player.deck.unshift(removed);
                            renderHands();
                            renderDecks();
                            addGameLog(`${removed.name} sent to bottom of deck from hand.`);
                        }
                    },
                    {
                        label: "Send to Top Life",
                        action: () => {
                            const cardIndex = player.hand.findIndex(c => c.instanceId === card.instanceId);
                            if (cardIndex === -1) return;
                            const [removed] = player.hand.splice(cardIndex, 1);
                            removed.faceUp = false;
                            player.life.unshift(removed);
                            renderHands();
                            renderLifeCards();
                            addGameLog(`${removed.name} sent to top of life from hand.`);
                        }
                    }
                ];

                options.forEach(opt => {
                    const btn = document.createElement("div");
                    btn.textContent = opt.label;
                    btn.style.padding = "8px 16px";
                    btn.style.cursor = "pointer";
                    btn.style.color = "#fff";
                    btn.style.borderBottom = "1px solid #555";
                    btn.style.fontSize = "14px";
                    btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                    btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                    btn.onclick = () => {
                        opt.action();
                        if (menu.parentNode) document.body.removeChild(menu);
                    };
                    menu.appendChild(btn);
                });

                document.body.appendChild(menu);

                const closeMenu = () => {
                    if (menu.parentNode) document.body.removeChild(menu);
                    document.removeEventListener("click", closeMenu);
                };
                setTimeout(() => document.addEventListener("click", closeMenu), 0);
            });
        }

        handElement.appendChild(cardElement);
    });

    if (!hidden) {
        const sortButton = document.createElement("button");
        sortButton.className = "hand-sort-button";
        sortButton.type = "button";
        sortButton.textContent = "S";
        sortButton.setAttribute("aria-label", "Sort hand");
        sortButton.title = "Sort hand by category, cost, then card ID.";

        sortButton.addEventListener("click", async (event) => {
            event.stopPropagation();

            await sortPlayerHand(player);
        });

        handElement.appendChild(sortButton);
    }

    const count = document.createElement("div");

    count.className = "hand-count";
    count.textContent = player.hand.length;

    handElement.appendChild(count);

    setupCardPreview();
    setupHandCardSelection();
    setupHandGlide();
}

async function sortPlayerHand(player) {
    if (!player || !Array.isArray(player.hand)) {
        return;
    }

    const indexedHand = player.hand.map((card, index) => ({ card, index }));

    indexedHand.sort((left, right) => {
        const leftKey = getHandSortKey(left.card);
        const rightKey = getHandSortKey(right.card);

        return leftKey.category - rightKey.category ||
            leftKey.cost - rightKey.cost ||
            leftKey.cardId.localeCompare(rightKey.cardId) ||
            left.index - right.index;
    });

    player.hand = indexedHand.map(entry => entry.card);

    clearHandSelection();
    renderHands();

    addGameLog(`${player.name}'s hand was sorted.`);

    if (isOnlineMatch && player === gameState[getOwnOnlinePlayerKey()]) {
        await syncOnlineStateFromLocal();
    }
}

function getHandSortKey(card) {
    const categoryOrder = {
        stage: 0,
        event: 1,
        character: 2
    };
    const cardType = String(card?.cardType || "").toLowerCase();

    return {
        category: categoryOrder[cardType] ?? 3,
        cost: Number(card?.cost ?? card?.playCost ?? 0),
        cardId: String(card?.cardNumber || card?.id || card?.name || "")
    };
}

// =========================
// Life Rendering
// =========================

function renderLifeCards() {
    renderPlayerLife(gameState.player2, "lifeArea");
    renderPlayerLife(gameState.player1, "opponentLifeArea");
}

function renderPlayerLife(player, lifeAreaId) {
    const lifeArea = document.getElementById(lifeAreaId);

    if (!lifeArea) return;

    lifeArea.querySelectorAll(".life-card").forEach(card => card.remove());
    lifeArea.querySelectorAll(".life-count").forEach(counter => counter.remove());
    lifeArea.querySelectorAll(".life-drop-zone").forEach(zone => zone.remove());

    const playerKey = player === gameState.player1 ? "player1" : "player2";

    const LIFE_CARD_TOP_BASE = 7;
    const LIFE_CARD_STEP = 36;
    const LIFE_CARD_HEIGHT = 165;

    // Render life cards (face-down by default)
    player.life.forEach((lifeCard, lifeIndex) => {
        const cardElement = document.createElement("div");
        cardElement.className = "life-card";
        cardElement.draggable = true;
        cardElement.setAttribute("data-card-source", "life");
        cardElement.setAttribute("data-player", playerKey);
        cardElement.setAttribute("data-life-index", lifeIndex);

        // Stack every card, no matter how many — overrides any CSS cap
        cardElement.style.setProperty("top", `${LIFE_CARD_TOP_BASE + lifeIndex * LIFE_CARD_STEP}px`, "important");
        cardElement.style.setProperty("z-index", `${1000 - lifeIndex}`, "important");

        const img = document.createElement("img");

        // Show face-down (card back) for life cards, or revealed if faceUp
        img.src = lifeCard?.faceUp ? cardArtSrc(lifeCard) : cardBackImage;
        img.alt = lifeCard?.faceUp && lifeCard.name ? lifeCard.name : "Life Card";
        img.className = "life-card-img board-card-img";
        // Let the parent .life-card own the drag (images are natively draggable).
        img.draggable = false;
        img.setAttribute("data-card-image", img.src);
        img.setAttribute("data-player", playerKey);
        img.setAttribute("data-life-index", lifeIndex);
        img.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            
            const menu = document.createElement("div");
            menu.className = "context-menu";
            menu.style.position = "fixed";
            menu.style.top = event.clientY + "px";
            menu.style.left = event.clientX + "px";
            menu.style.zIndex = "10001";
            menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
            menu.style.border = "1px solid #888";
            menu.style.borderRadius = "4px";
            menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
            
            // Always locate the card by identity at the moment the action runs.
            // The index captured at render time can be stale (the life pile may
            // have changed since), and splicing a stale index removes the WRONG
            // card - which showed up as cards duplicating while others vanished.
            const takeLifeCard = () => {
                const index = player.life.findIndex(c => c && c.instanceId === lifeCard.instanceId);
                if (index === -1) return null;
                return player.life.splice(index, 1)[0];
            };

            const options = [
                {
                    label: lifeCard?.faceUp ? "Hide Card" : "Reveal Card",
                    action: () => {
                        lifeCard.faceUp = !lifeCard.faceUp;
                        renderLifeCards();
                        window.addGameLog?.(`Life card ${lifeCard.faceUp ? "revealed" : "hidden"}`);
                        window.scheduleOnlineBoardSync?.();
                    }
                },
                {
                    label: "Send to Top Deck",
                    action: () => {
                        const taken = takeLifeCard();
                        if (!taken) return;
                        player.deck.push(taken);  // Top = push (end of array)
                        renderLifeCards();
                        window.renderDecks?.();
                        window.addGameLog?.(`Card sent to top of deck`);
                        window.scheduleOnlineBoardSync?.();
                    }
                },
                {
                    label: "Send to Bottom Deck",
                    action: () => {
                        const taken = takeLifeCard();
                        if (!taken) return;
                        player.deck.unshift(taken);  // Bottom = unshift (front of array)
                        renderLifeCards();
                        window.renderDecks?.();
                        window.addGameLog?.(`Card sent to bottom of deck`);
                        window.scheduleOnlineBoardSync?.();
                    }
                },
                {
                    label: "Send to Hand",
                    action: () => {
                        const taken = takeLifeCard();
                        if (!taken) return;
                        player.hand.push(taken);
                        renderLifeCards();
                        window.renderHands?.();
                        window.addGameLog?.(`Life card added to hand`);
                        window.scheduleOnlineBoardSync?.();
                    }
                },
                {
                    label: "Send to Trash",
                    action: () => {
                        const taken = takeLifeCard();
                        if (!taken) return;
                        if (!player.trash) player.trash = [];
                        player.trash.push(taken);
                        renderLifeCards();
                        window.renderTrash?.();
                        window.addGameLog?.(`Life card sent to trash`);
                        window.scheduleOnlineBoardSync?.();
                    }
                }
            ];
            
            options.forEach(opt => {
                const btn = document.createElement("div");
                btn.textContent = opt.label;
                btn.style.padding = "8px 16px";
                btn.style.cursor = "pointer";
                btn.style.color = "#fff";
                btn.style.borderBottom = "1px solid #555";
                btn.style.fontSize = "14px";
                btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                btn.onclick = () => {
                    opt.action();
                    document.body.removeChild(menu);
                };
                menu.appendChild(btn);
            });
            
            document.body.appendChild(menu);
            
            const closeMenu = () => {
                if (menu.parentNode) document.body.removeChild(menu);
                document.removeEventListener("click", closeMenu);
            };
            setTimeout(() => document.addEventListener("click", closeMenu), 0);
        };

        cardElement.appendChild(img);
        lifeArea.appendChild(cardElement);
    });

    const count = document.createElement("div");

    count.className = "life-count";
    count.textContent = player.life.length;

    lifeArea.appendChild(count);

    // The container itself collapses to ~0 height because every child is
    // position:absolute — grow it to match the pile so the whole stack
    // (not just pixels directly on a card) is a valid drop target. It's
    // fine for this to extend past the fixed grid row and go off-screen.
    const zoneHeight = player.life.length > 0
        ? LIFE_CARD_TOP_BASE + (player.life.length - 1) * LIFE_CARD_STEP + LIFE_CARD_HEIGHT
        : LIFE_CARD_HEIGHT;
    lifeArea.style.setProperty("min-height", `${zoneHeight}px`, "important");

    setupCardPreview();
}

// =========================
// Leader Rendering
// =========================

function renderLeaders() {
    renderLeader(gameState.player1, "player1LeaderArea");
    renderLeader(gameState.player2, "player2LeaderArea");
    window.manualPlay?.reapplyAnnotations?.();
}

function renderLeader(player, areaId) {
    const leaderArea = document.getElementById(areaId);

    if (!leaderArea) return;

    leaderArea.innerHTML = "";
    leaderArea.classList.remove("don-attach-target");
    leaderArea.onclick = null;

    if (!player.leader.state) {
        player.leader.state = "active";
    }

    const playerKey = player === gameState.player1 ? "player1" : "player2";
    const renderKey = getBoardCardRenderKey(playerKey, "leader");

    const img = document.createElement("img");

    img.src = cardArtSrc(player.leader);
    img.alt = player.leader.name;
    img.className = "leader-card-img board-leader-card";

    img.setAttribute("data-card-image", player.leader.image);
    img.setAttribute("data-player", playerKey);
    img.setAttribute("data-board-card-type", "leader");

    const leaderState = player.leader.state || "active";

    img.dataset.cardState = leaderState;

    if (leaderState === "rested") {
        img.classList.add("board-card-rested");
    }

    applyCardAnimationClass(img, takeCardAnimationClass(player.leader));
    applyCardAnimationClass(img, getBoardStateAnimationClass(player.leader, renderKey));

    leaderArea.classList.toggle("don-attach-target", isDonAttachmentTarget(playerKey, player.leader));
    leaderArea.onclick = async (event) => {
        if (selectedDonAttachment) {
            event.stopPropagation();
            await attachSelectedDonToBoardCard(playerKey, player.leader);
            return;
        }
    };

     leaderArea.appendChild(img);
    renderKeywordTags(player.leader, leaderArea);
    renderAttachedDonBadge(player.leader, leaderArea);

    setupCardPreview();
    setupBoardLeaderSelection();
    setupBoardContextMenus();
}

// =========================
// Character Rendering
// =========================

function renderCharacters() {
    renderPlayerCharacters(gameState.player1, "player1");
    renderPlayerCharacters(gameState.player2, "player2");
    window.manualPlay?.reapplyAnnotations?.();
}

function renderPlayerCharacters(player, playerKey) {
    const slots = document.querySelectorAll(`.character-slot[data-player="${playerKey}"]`);

    slots.forEach((slot, index) => {
        slot.innerHTML = "";
        slot.classList.remove("don-attach-target");
        slot.onclick = null;

        const card = player.characters[index];

        if (!card) {
            slot.dataset.state = "empty";
            slot.classList.remove("occupied-slot");
            renderedBoardCardStates.delete(getBoardCardRenderKey(playerKey, "character", index));
            return;
        }

        const renderKey = getBoardCardRenderKey(playerKey, "character", index);
        slot.dataset.state = "occupied";
        slot.classList.add("occupied-slot");
        slot.classList.toggle("don-attach-target", isDonAttachmentTarget(playerKey, card));
         slot.onclick = async (event) => {
            if (selectedDonAttachment) {
                event.stopPropagation();
                await attachSelectedDonToBoardCard(playerKey, card);
                return;
            }
        };

        const img = document.createElement("img");

        img.src = cardArtSrc(card);
        img.alt = card.name;
        img.className = "board-card-img board-character-card";

        img.setAttribute("data-card-image", card.image);
        img.setAttribute("data-player", playerKey);
        img.setAttribute("data-character-slot", index);

        const cardState = card.state || "active";

        img.dataset.cardState = cardState;

        if (cardState === "rested") {
            img.classList.add("board-card-rested");
        }

        applyCardAnimationClass(img, takeCardAnimationClass(card));
        applyCardAnimationClass(img, getBoardStateAnimationClass(card, renderKey));

        slot.appendChild(img);
        renderKeywordTags(card, slot);
        renderAttachedDonBadge(card, slot);
    });

    setupCardPreview();
    setupBoardCharacterSelection();
    setupBoardContextMenus();
}

function isDonAttachmentTarget(playerKey, card) {
    const player = gameState?.[playerKey];

    return Boolean(
        selectedDonAttachment &&
        selectedDonAttachment.playerKey === playerKey &&
        canAttachDonToBoardCard(player, card)
    );
}

// =========================
// Stage Rendering
// =========================

function renderStages() {
    renderPlayerStage(gameState.player1, "player1StageArea");
    renderPlayerStage(gameState.player2, "player2StageArea");
    window.manualPlay?.reapplyAnnotations?.();
}

function getVisibleKeywords(card) {
    const boardOwner = typeof getPlayerForBoardCard === "function"
        ? getPlayerForBoardCard(card)
        : null;
    const keywords = [
        ...(Array.isArray(card?.keywords) ? card.keywords : []),
        ...(Array.isArray(card?.temporaryKeywords) ? card.temporaryKeywords : []),
        ...(Array.isArray(card?.battleKeywords) ? card.battleKeywords : []),
        ...(Array.isArray(card?.effects)
            ? card.effects
                .filter(effect => window.CustomEffectV2Engine?.isV2Effect?.(effect))
                .filter(effect => window.CustomEffectV2Engine?.getEventType?.(effect) === "static")
                .filter(effect => !window.CustomEffectV2Engine?.canUseEffect || window.CustomEffectV2Engine.canUseEffect(boardOwner, card, effect).ok)
                .flatMap(effect => effect.actions || [])
                .filter(action => action.type === "giveKeyword" && (!action.target || action.target === "thisCard"))
                .filter(action => {
                    const conditions = Array.isArray(action.conditions) ? action.conditions : [];
                    return conditions.every(condition => window.CustomEffectV2Engine?.conditionMet?.(boardOwner, card, condition) !== false);
                })
                .map(action => action.keyword)
            : [])
    ];
    const wanted = ["Blocker", "Rush", "Rush:Characters", "Double Attack", "Banish", "Unblockable"];
    const seen = new Set();

    return keywords
        .map(keyword => String(keyword || "").trim())
        .filter(Boolean)
        .map(keyword => {
            const normalized = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "");
            const match = wanted.find(item => item.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized);
            return match || keyword;
        })
        .filter(keyword => {
            const key = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "");
            if (!wanted.some(item => item.toLowerCase().replace(/[^a-z0-9]+/g, "") === key) || seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
}

function getVisibleStatusTags(card) {
    const statuses = [
        { field: "cannotAttackUntil", label: "No Attack" },
        { field: "cannotBlockUntil", label: "No Block" },
        { field: "cannotBecomeActiveUntil", label: "No Active" },
        { field: "cannotBeRestedUntil", label: "No Rest" },
        { field: "cannotBeKOdUntil", label: "No K.O." }
    ];

    return statuses
        .filter(status => isCardStatusActive(card?.[status.field], card))
        .map(status => status.label);
}

function isCardStatusActive(status, card) {
    if (!status) return false;

    const expiringPlayer = status.expiresAtPlayerKey
        ? gameState?.[status.expiresAtPlayerKey]
        : getPlayerForBoardCard(card);

    if (!expiringPlayer) return true;

    return Number(expiringPlayer.turns || 0) <= Number(status.expiresAtEndOfTurns ?? 0);
}

function renderKeywordTags(card, container) {
    const keywords = getVisibleKeywords(card);
    const statusTags = getVisibleStatusTags(card);
    const tags = [...keywords, ...statusTags];

    if (!container || tags.length === 0) return;

    const tagWrap = document.createElement("div");
    tagWrap.className = "keyword-tags";

    tags.forEach(keyword => {
        const tag = document.createElement("span");
        tag.className = `keyword-tag ${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
        tag.textContent = keyword === "Rush:Characters" ? "Rush:Character" : keyword;
        tagWrap.appendChild(tag);
    });

    container.appendChild(tagWrap);
}

function renderPlayerStage(player, stageAreaId) {
    const stageArea = document.getElementById(stageAreaId);

    if (!stageArea) return;

    stageArea.innerHTML = "";

    if (!player.stage) {
        stageArea.textContent = "";
        stageArea.dataset.state = "empty";
        renderedBoardCardStates.delete(getBoardCardRenderKey(
            player === gameState.player1 ? "player1" : "player2",
            "stage"
        ));
        return;
    }

    stageArea.dataset.state = "occupied";
    const playerKey = player === gameState.player1 ? "player1" : "player2";
    const renderKey = getBoardCardRenderKey(playerKey, "stage");

    const img = document.createElement("img");

    img.src = cardArtSrc(player.stage);
    img.alt = player.stage.name;
    img.className = "deck-card-img board-card-img board-stage-card";

    img.setAttribute("data-card-image", player.stage.image);
    img.setAttribute("data-player", playerKey);
    img.setAttribute("data-board-card-type", "stage");

    const stageState = player.stage.state || "active";

    img.dataset.cardState = stageState;

    if (stageState === "rested") {
        img.classList.add("board-card-rested");
    }

    applyCardAnimationClass(img, takeCardAnimationClass(player.stage));
    applyCardAnimationClass(img, getBoardStateAnimationClass(player.stage, renderKey));

    stageArea.classList.toggle("don-attach-target", isDonAttachmentTarget(playerKey, player.stage));
    stageArea.onclick = async (event) => {
        if (selectedDonAttachment) {
            event.stopPropagation();
            await attachSelectedDonToBoardCard(playerKey, player.stage);
            return;
        }
        
        // If card has attached DON, show detach button
        if (player.stage.attachedDon && player.stage.attachedDon > 0) {
            const detachButton = document.createElement("button");
            detachButton.textContent = `Detach ${player.stage.attachedDon} DON!!`;
            detachButton.className = "tool-btn secondary";
            detachButton.style.position = "fixed";
            detachButton.style.top = "50%";
            detachButton.style.left = "50%";
            detachButton.style.transform = "translate(-50%, -50%)";
            detachButton.style.zIndex = "10000";
            
            detachButton.onclick = () => {
                gameState[playerKey].don += player.stage.attachedDon;
                player.stage.attachedDon = 0;
                document.body.removeChild(detachButton);
                updateDonDisplay();
                renderStages();
                window.scheduleOnlineBoardSync?.();
                console.log("✓ Detached DON from stage");
            };
            
            document.body.appendChild(detachButton);
        }
    };

    stageArea.appendChild(img);
    renderKeywordTags(player.stage, stageArea);
    renderAttachedDonBadge(player.stage, stageArea);

    setupCardPreview();
    setupBoardStageSelection();
}

// =========================
// Trash Rendering
// =========================

function renderTrash() {
    renderPlayerTrash(gameState.player1, "player1TrashArea");
    renderPlayerTrash(gameState.player2, "player2TrashArea");
}

function renderPlayerTrash(player, trashAreaId) {
    const trashArea = document.getElementById(trashAreaId);

    if (!trashArea) return;

    trashArea.innerHTML = "";
    trashArea.classList.toggle("clickable-trash", player.trash.length > 0);
    trashArea.onclick = () => {
        if (player.trash.length === 0) return;

        showTrashViewer(player);
    };

    if (player.trash.length > 0) {
        const topCard = player.trash[player.trash.length - 1];

        const img = document.createElement("img");

        img.src = cardArtSrc(topCard);
        img.alt = topCard.name;
        img.className = "deck-card-img life-card-img board-card-img";
        img.setAttribute("data-card-image", topCard.image);
        img.setAttribute("data-player", getPlayerKey(player));
        applyCardAnimationClass(img, takeCardAnimationClass(topCard));

        trashArea.appendChild(img);
    } else {
        trashArea.replaceChildren();
    }

    const count = document.createElement("div");

    count.className = "trash-count";
    count.textContent = player.trash.length;

    trashArea.appendChild(count);

    setupCardPreview();
}

function showTrashViewer(player) {
    removeTrashViewer();

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "trashViewerOverlay";

    const popup = document.createElement("div");
    popup.className = "look-top-popup trash-viewer-popup";

    const title = document.createElement("h2");
    title.textContent = `${player.name}'s Trash`;

    const description = document.createElement("p");
    description.textContent = player.trash.length > 0
        ? "Cards are shown from newest to oldest."
        : "Trash is empty.";

    const cardGrid = document.createElement("div");
    cardGrid.className = "look-top-card-grid trash-viewer-grid";

    [...player.trash].reverse().forEach((card, displayIndex) => {
        const cardFrame = document.createElement("div");
        cardFrame.className = "look-top-card-button trash-viewer-card";
        cardFrame.style.position = "relative";
        cardFrame.style.display = "flex";
        cardFrame.style.flexDirection = "column";
        cardFrame.style.backgroundColor = "#222";
        cardFrame.style.border = "1px solid #666";
        cardFrame.style.borderRadius = "4px";
        cardFrame.style.overflow = "visible";

        const img = document.createElement("img");
        img.src = cardArtSrc(card);
        img.alt = card.name;
        img.className = "look-top-card-img";
        img.setAttribute("data-card-image", card.image);
        img.style.width = "120px";
        img.style.height = "180px";
        img.style.objectFit = "cover";
        img.addEventListener("click", (event) => {
            event.stopPropagation();
            showSearchCardImagePopup(card);
        });

        const cardButtons = document.createElement("div");
        cardButtons.style.display = "flex";
        cardButtons.style.flexDirection = "column";
        cardButtons.style.gap = "4px";
        cardButtons.style.padding = "6px";
        cardButtons.style.backgroundColor = "#222";

        // Send to Hand button
        const handBtn = document.createElement("button");
        handBtn.textContent = "→ Hand";
        handBtn.style.padding = "6px 10px";
        handBtn.style.fontSize = "11px";
        handBtn.style.backgroundColor = "#FF9800";
        handBtn.style.color = "white";
        handBtn.style.border = "none";
        handBtn.style.borderRadius = "2px";
        handBtn.style.cursor = "pointer";
        handBtn.style.flex = "1";
        handBtn.onmouseover = () => handBtn.style.backgroundColor = "#F57C00";
        handBtn.onmouseout = () => handBtn.style.backgroundColor = "#FF9800";
        handBtn.onclick = () => {
            const currentIndex = player.trash.indexOf(card);
            if (currentIndex === -1) return;
            player.hand.push(card);
            player.trash.splice(currentIndex, 1);
            window.renderHands?.();
            window.renderTrash?.();
            removeTrashViewer();
            addGameLog(`Card moved to ${player.name}'s hand`);
        };
        cardButtons.appendChild(handBtn);

        // Send to Top Deck button
        const topBtn = document.createElement("button");
        topBtn.textContent = "↑ Top Deck";
        topBtn.style.padding = "6px 10px";
        topBtn.style.fontSize = "11px";
        topBtn.style.backgroundColor = "#2196F3";
        topBtn.style.color = "white";
        topBtn.style.border = "none";
        topBtn.style.borderRadius = "2px";
        topBtn.style.cursor = "pointer";
        topBtn.style.flex = "1";
        topBtn.onmouseover = () => topBtn.style.backgroundColor = "#1976D2";
        topBtn.onmouseout = () => topBtn.style.backgroundColor = "#2196F3";
        topBtn.onclick = () => {
            const currentIndex = player.trash.indexOf(card);
            if (currentIndex === -1) return;
            player.deck.push(card);
            player.trash.splice(currentIndex, 1);
            window.renderDecks?.();
            window.renderTrash?.();
            removeTrashViewer();
            addGameLog(`Card moved to top of ${player.name}'s deck`);
        };
        cardButtons.appendChild(topBtn);

        // Send to Bottom Deck button
        const bottomBtn = document.createElement("button");
        bottomBtn.textContent = "↓ Bottom Deck";
        bottomBtn.style.padding = "6px 10px";
        bottomBtn.style.fontSize = "11px";
        bottomBtn.style.backgroundColor = "#9C27B0";
        bottomBtn.style.color = "white";
        bottomBtn.style.border = "none";
        bottomBtn.style.borderRadius = "2px";
        bottomBtn.style.cursor = "pointer";
        bottomBtn.style.flex = "1";
        bottomBtn.onmouseover = () => bottomBtn.style.backgroundColor = "#7B1FA2";
        bottomBtn.onmouseout = () => bottomBtn.style.backgroundColor = "#9C27B0";
        bottomBtn.onclick = () => {
            const currentIndex = player.trash.indexOf(card);
            if (currentIndex === -1) return;
            player.deck.unshift(card);
            player.trash.splice(currentIndex, 1);
            window.renderDecks?.();
            window.renderTrash?.();
            removeTrashViewer();
            addGameLog(`Card moved to bottom of ${player.name}'s deck`);
        };
        cardButtons.appendChild(bottomBtn);

        cardFrame.appendChild(img);
        cardFrame.appendChild(cardButtons);
        cardGrid.appendChild(cardFrame);
    });

    const buttonRow = document.createElement("div");
    buttonRow.className = "look-top-buttons";

    const closeButton = document.createElement("button");
    closeButton.className = "look-top-action-button secondary";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", removeTrashViewer);

    buttonRow.appendChild(closeButton);

    popup.appendChild(title);
    popup.appendChild(description);
    popup.appendChild(cardGrid);
    popup.appendChild(buttonRow);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    setupCardPreview();
}

function removeTrashViewer() {
    const oldOverlay = document.getElementById("trashViewerOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

// =========================
// Card Preview
// =========================

function setupCardPreview() {
    document.querySelectorAll("[data-card-image]").forEach(cardElement => {
        cardElement.onmouseenter = () => {
            if (selectedHandCard) return;

            const imageSrc = cardElement.getAttribute("data-card-image");

            showCardPreview(imageSrc);
        };

        cardElement.onmouseleave = () => {
            if (selectedHandCard) return;

            if (selectedBoardCard) {
                const selectedImage = selectedBoardCard.getAttribute("data-card-image");

                if (selectedImage) {
                    showCardPreview(selectedImage);
                    return;
                }
            }

            clearCardPreview();
        };
    });
}

function showCardPreview(imageSrc) {
    const previewImage = document.getElementById("previewImage");
    const previewPlaceholder = document.getElementById("previewPlaceholder");

    if (!previewImage || !previewPlaceholder || !imageSrc) return;

    previewImage.src = imageSrc;
    previewImage.style.display = "block";
    previewPlaceholder.style.display = "none";
}

function clearCardPreview() {
    const previewImage = document.getElementById("previewImage");
    const previewPlaceholder = document.getElementById("previewPlaceholder");

    if (!previewImage || !previewPlaceholder) return;

    previewImage.src = "";
    previewImage.style.display = "none";
    previewPlaceholder.style.display = "block";
}

// =========================
// Hand Card Selection
// =========================

function setupHandCardSelection() {
    const previewImage = document.getElementById("previewImage");
    const previewPlaceholder = document.getElementById("previewPlaceholder");

    if (!previewImage || !previewPlaceholder) return;

    document.querySelectorAll(".hand-card.selectable-card[data-card-instance-id]").forEach(cardElement => {
        cardElement.onclick = () => {
            if (pendingTrashChoice) {
                handlePendingTrashChoice(
                    cardElement.getAttribute("data-player"),
                    cardElement.getAttribute("data-card-instance-id")
                );
                return;
            }

            if (gameState.currentPhase === "counterPhase") {
                if (!currentAttack) {
                    return;
                }
            } else if (pendingReplacePlay || pendingAttack || pendingBlock || currentAttack) {
                return;
            }

            const imageSrc = cardElement.getAttribute("data-card-image");
            const playerKey = cardElement.getAttribute("data-player");
            const cardInstanceId = cardElement.getAttribute("data-card-instance-id");

            if (selectedHandCard === cardElement) {
                clearHandSelection();
                return;
            }

            clearHandSelection();
            clearBoardSelection();

            pendingReplacePlay = null;
            clearReplaceTargets();

            selectedHandCard = cardElement;

            selectedHandCardData = playerKey && cardInstanceId
                ? {
                    playerKey,
                    cardInstanceId
                }
                : null;

            cardElement.classList.add("selected-card");

            showCardPreview(imageSrc);

            if (gameState.currentPhase === "counterPhase") {
                showSelectedCounterActions();
            } else {
                showSelectedCardActions();
            }
        };
    });
}

function showSelectedCardActions() {
    clearSelectedCardActions();

    if (!selectedHandCard || !selectedHandCardData) return;

    const player = gameState[selectedHandCardData.playerKey];

    if (!player) return;

    const handIndex = findHandCardIndexByInstanceId(
        player,
        selectedHandCardData.cardInstanceId
    );

    if (handIndex === -1) return;

    const card = player.hand[handIndex];

    if (!card) return;

    const playButton = document.createElement("button");

    playButton.className = "card-action-button-on-card";
    playButton.textContent = "Play";

    const cardCost = getCardPlayCost(card, player);
    const canAfford = canPlayerAffordCard(player, card);
    const openSlotIndex = getFirstOpenCharacterSlotIndex(player);
    const canPlayNow = canPlayerPlayCards(player);
    const playLocked = typeof isCardTypePlayLocked === "function" && isCardTypePlayLocked(player, card.cardType);

    if (!canPlayNow) {
        playButton.disabled = true;

        if (gameState.currentPhase === "mulligan") {
            playButton.textContent = "Wait";
            playButton.title = "Cards cannot be played during the mulligan phase.";
        } else if (!gameState.currentPlayer) {
            playButton.textContent = "Wait";
            playButton.title = "Cards cannot be played before the first turn starts.";
        } else if (gameState.currentPlayer !== player) {
            playButton.textContent = "Not Turn";
            playButton.title = `It is currently ${gameState.currentPlayer.name}'s turn.`;
        } else {
            playButton.textContent = "Wait";
            playButton.title = "Cards cannot be played right now.";
        }
    } else if (playLocked) {
        playButton.disabled = true;
        playButton.textContent = "Locked";
        playButton.title = `${player.name} cannot play ${card.cardType} cards this turn.`;
    } else if (!canAfford) {
        playButton.disabled = true;
        playButton.textContent = `Need ${cardCost}`;
        playButton.title = `${player.name} does not have enough active DON!! to play this card.`;
    } else if (card.cardType === "character" && openSlotIndex === -1) {
        playButton.textContent = `Replace ${cardCost}`;
        playButton.title = `${player.name}'s board is full. Click to choose a character to replace.`;
    } else if (card.cardType === "stage") {
        playButton.textContent = `Stage ${cardCost}`;
        playButton.title = `Play ${card.name} to the stage area.`;
    } else if (card.cardType === "event") {
        playButton.textContent = `Event ${cardCost}`;
        playButton.title = `Play ${card.name}, then place it in trash.`;
    } else {
        playButton.textContent = `Play ${cardCost}`;
    }

    playButton.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (playButton.disabled) return;

        if (!canPlayerPlayCards(player)) {
            addGameLog("Cards cannot be played right now.");
            return;
        }

        const latestHandIndex = findHandCardIndexByInstanceId(
            player,
            selectedHandCardData.cardInstanceId
        );

        if (latestHandIndex === -1) {
            addGameLog("Selected card could not be found.");
            return;
        }

        const currentCard = player.hand[latestHandIndex];

        if (!currentCard) {
            addGameLog("Selected card could not be found.");
            return;
        }

        const currentOpenSlotIndex = getFirstOpenCharacterSlotIndex(player);

        if (currentCard.cardType === "character" && currentOpenSlotIndex === -1) {
            enterReplaceMode(
                selectedHandCardData.playerKey,
                selectedHandCardData.cardInstanceId
            );
            return;
        }

        const result = playCard(player, latestHandIndex, ui);

        addGameLog(result.message);

        if (!result.success) return;

        clearHandSelection();
        clearReplaceTargets();

        pendingReplacePlay = null;

        await syncOnlineStateFromLocal();
    });

    selectedHandCard.appendChild(playButton);
}

function showSelectedCounterActions() {
    clearSelectedCardActions();

    if (!selectedHandCard || !selectedHandCardData || !currentAttack) return;

    const player = gameState[selectedHandCardData.playerKey];

    if (!player) return;

    const handIndex = findHandCardIndexByInstanceId(
        player,
        selectedHandCardData.cardInstanceId
    );

    if (handIndex === -1) return;

    const card = player.hand[handIndex];

    if (!card) return;

    const defenderPlayerKey = currentAttack.defenderPlayerKey;
    const isDefender = selectedHandCardData.playerKey === defenderPlayerKey;
    const isOnlineOwnDefender = !isOnlineMatch ||
        (isDefender && selectedHandCardData.playerKey === getOwnOnlinePlayerKey());
    const counterValue = typeof getCounterPowerForUse === "function"
        ? getCounterPowerForUse(card, player)
        : getCardCounterValue(card, player);

    const counterButton = document.createElement("button");

    counterButton.className = "card-action-button-on-card";

    if (!isOnlineOwnDefender) {
        counterButton.disabled = true;
        counterButton.textContent = "Not Def.";
        counterButton.title = "Only the defending player can counter with their own hand.";
    } else if (!canCardBeUsedAsCounter(card, player)) {
        counterButton.disabled = true;
        counterButton.textContent = "No Counter";
        counterButton.title = `${card.name} has no counter value.`;
    } else {
        counterButton.textContent = counterValue > 0
            ? `Counter +${counterValue}`
            : "Counter";
        counterButton.title = `Use ${card.name} as counter.`;
    }

    counterButton.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (counterButton.disabled) return;

        const latestHandIndex = findHandCardIndexByInstanceId(
            player,
            selectedHandCardData.cardInstanceId
        );

        if (latestHandIndex === -1) {
            addGameLog("Selected counter card could not be found.");
            return;
        }

        const result = useCounterFromHand(player, latestHandIndex, ui);

        addGameLog(result.message);

        if (!result.success) return;

        if (isOnlineMatch) {
            await syncOnlineStateFromLocal();
        }

        if (result.counterPower > 0) {
            applyCounterPowerToCurrentAttack(result.counterPower);

            addGameLog(
                `${player.name}'s attack target has +${currentAttack.targetPowerBonus} counter power this battle.`
            );
        }

        if (isOnlineMatch && onlinePublicState?.currentAttack) {
            await syncOnlineCurrentAttack({
                ...onlinePublicState.currentAttack,
                target: currentAttack.target,
                targetPowerBonus: currentAttack.targetPowerBonus || 0,
                counterPhaseStarted: true
            });
        }

        clearHandSelection();

        if (!isOnlineMatch) {
            await syncOnlineStateFromLocal();
        }
    });

    selectedHandCard.appendChild(counterButton);
}

function clearSelectedCardActions() {
    document.querySelectorAll(".card-action-button-on-card").forEach(button => {
        button.remove();
    });
}

// =========================
// Board Card Selection
// =========================

function setupBoardCharacterSelection() {
    document.querySelectorAll(".board-character-card").forEach(cardElement => {
        cardElement.onclick = async (event) => {
            event.stopPropagation();

            const playerKey = cardElement.getAttribute("data-player");
            const slotIndex = Number(cardElement.getAttribute("data-character-slot"));
            const player = gameState[playerKey];
            const card = player?.characters?.[slotIndex];

            if (pendingBoardChoice && await handleInlineBoardChoiceSelection({
                playerKey,
                cardType: "character",
                slotIndex
            })) {
                return;
            }

            if (pendingReplacePlay) {
                await handlePendingReplaceSlot(playerKey, slotIndex);
                return;
            }

            if (await attachSelectedDonToBoardCard(playerKey, card)) {
                return;
            }

            if (pendingBlock) {
                handleBlockerSelection(playerKey, slotIndex);
                return;
            }

            if (pendingReplacePlay || pendingAttack) {
                return;
            }

            if (!player) return;

            if (!card) return;

            if (selectedBoardCard === cardElement) {
                clearBoardSelection();
                return;
            }

            clearBoardSelection();
            clearHandSelection();

            selectedBoardCard = cardElement;
            selectedBoardCardData = {
                playerKey,
                cardType: "character",
                slotIndex
            };

            cardElement.classList.add("selected-board-card");

            showCardPreview(cardElement.getAttribute("data-card-image"));

            showSelectedBoardActions();

            addGameLog(`${player.name} selected ${card.name}.`);
        };
    });
}

function setupBoardLeaderSelection() {
    document.querySelectorAll(".board-leader-card").forEach(leaderElement => {
        leaderElement.onclick = async (event) => {
            event.stopPropagation();

            const playerKey = leaderElement.getAttribute("data-player");

            if (pendingBoardChoice && await handleInlineBoardChoiceSelection({
                playerKey,
                cardType: "leader"
            })) {
                return;
            }

            if (pendingReplacePlay || pendingAttack) {
                return;
            }

            const player = gameState[playerKey];

            if (!player || !player.leader) return;

            if (await attachSelectedDonToBoardCard(playerKey, player.leader)) {
                return;
            }

            if (selectedBoardCard === leaderElement) {
                clearBoardSelection();
                return;
            }

            clearBoardSelection();
            clearHandSelection();

            selectedBoardCard = leaderElement;
            selectedBoardCardData = {
                playerKey,
                cardType: "leader"
            };

            leaderElement.classList.add("selected-board-card");

            showCardPreview(leaderElement.getAttribute("data-card-image"));

            showSelectedBoardActions();

            addGameLog(`${player.name} selected ${player.leader.name}.`);
        };
    });
}

function showSelectedBoardActions() {
    clearSelectedBoardActions();

    if (!selectedBoardCard || !selectedBoardCardData) return;

    const player = gameState[selectedBoardCardData.playerKey];
    const card = getSelectedBoardCardObject();

    if (!player || !card) return;

    const actionButtons = [];

    const inspectButton = document.createElement("button");

    inspectButton.className = "board-action-button-on-card inspect-board-card-button";
    inspectButton.textContent = "Inspect";
    inspectButton.title = `Inspect ${card.name}.`;
    inspectButton.addEventListener("click", (event) => {
        event.stopPropagation();
        showSearchCardImagePopup(card);
    });

    actionButtons.push(inspectButton);

    if (selectedBoardCardData.cardType === "leader" || selectedBoardCardData.cardType === "character") {
        const breakdownButton = document.createElement("button");

        breakdownButton.className = "board-action-button-on-card power-breakdown-button";
        breakdownButton.textContent = "Power";
        breakdownButton.title = "Show this card's power breakdown.";
        breakdownButton.addEventListener("click", (event) => {
            event.stopPropagation();
            showPowerBreakdown(card, player, selectedBoardCardData);
        });

        actionButtons.push(breakdownButton);
    }

    const buttonContainer = getBoardActionButtonContainer();

    if (!buttonContainer) return;

    actionButtons.forEach((button, index) => {
        button.style.bottom = `${8 + (index * 35)}px`;
        buttonContainer.appendChild(button);
    });
}

function canAttachDonToBoardCard(player, card) {
    if (!player || !card) {
        return false;
    }

    if (pendingAttack || currentAttack) {
        return false;
    }

    if (gameState.currentPhase !== "main") {
        return false;
    }

    if (gameState.currentPlayer !== player) {
        return false;
    }

    if (card.cardType !== "leader" && card.cardType !== "character") {
        return false;
    }

    return player.don > 0;
}

function createAttachDonButton(player, card) {
    const attachDonButton = document.createElement("button");

    attachDonButton.className = "board-action-button-on-card attach-don-button";
    attachDonButton.textContent = "Attach DON";
    attachDonButton.title = `Attach 1 active DON!! to ${card.name}.`;

    attachDonButton.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (!canAttachDonToBoardCard(player, card)) {
            addGameLog(`${player.name} cannot attach DON!! right now.`);
            return;
        }

        const result = attachActiveDonToCard(player, card, ui);

        addGameLog(result.message);

        if (!result.success) return;

        if (refreshSelectedBoardCardElement()) {
            showSelectedBoardActions();
        } else {
            clearBoardSelection();
        }

        await syncOnlineStateFromLocal();
    });

    return attachDonButton;
}

function refreshSelectedBoardCardElement() {
    if (!selectedBoardCardData) {
        return false;
    }

    let cardElement = null;

    if (selectedBoardCardData.cardType === "leader") {
        cardElement = document.querySelector(
            `.board-leader-card[data-player="${selectedBoardCardData.playerKey}"]`
        );
    }

    if (selectedBoardCardData.cardType === "character") {
        cardElement = document.querySelector(
            `.board-character-card[data-player="${selectedBoardCardData.playerKey}"][data-character-slot="${selectedBoardCardData.slotIndex}"]`
        );
    }

    if (selectedBoardCardData.cardType === "stage") {
        cardElement = document.querySelector(
            `.board-stage-card[data-player="${selectedBoardCardData.playerKey}"]`
        );
    }

    if (!cardElement) {
        return false;
    }

    selectedBoardCard = cardElement;
    selectedBoardCard.classList.add("selected-board-card");

    return true;
}

function setupBoardContextMenus() {
    document.querySelectorAll(".board-leader-card, .board-character-card").forEach(cardElement => {
        cardElement.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();

            const playerKey = cardElement.getAttribute("data-player");
            const player = gameState[playerKey];
            const cardType = cardElement.classList.contains("board-leader-card") ? "leader" : "character";
            const slotIndex = Number(cardElement.getAttribute("data-character-slot"));
            const card = cardType === "leader"
                ? player?.leader
                : player?.characters?.[slotIndex];

            if (!player || !card) return;

            // Create context menu
            const menu = document.createElement("div");
            menu.className = "context-menu";
            menu.style.position = "fixed";
            menu.style.top = event.clientY + "px";
            menu.style.left = event.clientX + "px";
            menu.style.zIndex = "10001";
            menu.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
            menu.style.border = "1px solid #888";
            menu.style.borderRadius = "4px";
            menu.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.5)";
            
            const options = [];
            
            // For characters: add movement and trash options
            if (cardType === "character") {
                options.push({
                    label: "Send to Bottom Deck",
                    action: () => {
                        player.characters.splice(slotIndex, 1);
                        player.deck.unshift(card);
                        renderCharacters();
                        addGameLog(`${card.name} sent to bottom of deck`);
                    }
                });
                options.push({
                    label: "Send to Top Deck",
                    action: () => {
                        player.characters.splice(slotIndex, 1);
                        player.deck.push(card);
                        renderCharacters();
                        addGameLog(`${card.name} sent to top of deck`);
                    }
                });
                options.push({
                    label: "Send to Trash",
                    action: () => {
                        player.characters.splice(slotIndex, 1);
                        player.trash.push(card);
                        renderCharacters();
                        addGameLog(`${card.name} sent to trash`);
                    }
                });
            }
            
            // Both characters and leaders can detach DON
            options.push({
                label: "Detach All DON!!",
                action: () => {
                    if (card.attachedDon && card.attachedDon > 0) {
                        const detached = card.attachedDon;
                        gameState[playerKey].don += detached;
                        card.attachedDon = 0;
                        updateDonDisplay();
                        if (cardType === "leader") {
                            renderLeaders();
                        } else {
                            renderCharacters();
                        }
                        addGameLog(`Detached ${detached} DON!! from ${card.name}`);
                        window.scheduleOnlineBoardSync?.();
                    }
                }
            });
            
            // Render menu items
            options.forEach(opt => {
                const btn = document.createElement("div");
                btn.textContent = opt.label;
                btn.style.padding = "8px 16px";
                btn.style.cursor = "pointer";
                btn.style.color = "#fff";
                btn.style.borderBottom = "1px solid #555";
                btn.style.fontSize = "14px";
                btn.onmouseenter = () => btn.style.backgroundColor = "rgba(100, 150, 255, 0.3)";
                btn.onmouseleave = () => btn.style.backgroundColor = "transparent";
                btn.onclick = () => {
                    opt.action();
                    document.body.removeChild(menu);
                };
                menu.appendChild(btn);
            });
            
            document.body.appendChild(menu);
            
            // Close menu when clicking elsewhere
            const closeMenu = () => {
                if (menu.parentNode) document.body.removeChild(menu);
                document.removeEventListener("click", closeMenu);
            };
            setTimeout(() => document.addEventListener("click", closeMenu), 0);
        };
    });
}

function setupHandGlide() {
    document.querySelectorAll(".hand").forEach(handElement => {
        handElement.onmousemove = (event) => {
            const cards = Array.from(
                handElement.querySelectorAll(".hand-card.selectable-card[data-card-image]")
            );

            if (cards.length === 0) {
                return;
            }

            let nearestCard = null;
            let nearestDistance = Number.POSITIVE_INFINITY;

            cards.forEach(cardElement => {
                const rect = cardElement.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const distance = Math.abs(event.clientX - centerX) + Math.abs(event.clientY - centerY) * 0.35;

                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestCard = cardElement;
                }
            });

            cards.forEach(cardElement => {
                cardElement.classList.toggle("hand-card-glide", cardElement === nearestCard);
            });

            if (!selectedHandCard && !selectedBoardCard && nearestCard) {
                showCardPreview(nearestCard.getAttribute("data-card-image"));
            }
        };

        handElement.onmouseleave = () => {
            handElement
                .querySelectorAll(".hand-card-glide")
                .forEach(cardElement => cardElement.classList.remove("hand-card-glide"));

            if (!selectedHandCard && !selectedBoardCard) {
                clearCardPreview();
            }
        };
    });
}

function resolveBoardActionEffect(player, card, effect) {
    if (effect.actionId === "drawOneCard") {
        // Drawn inline rather than via phases.js's drawCard(), which is not
        // defined in this build and threw whenever this effect fired.
        if (!player.deck?.length) {
            return { success: false, message: `${player.name} could not draw a card.` };
        }

        player.hand.push(player.deck.pop());
        renderHands();
        renderDecks();

        return { success: true, message: `${player.name} drew 1 card.` };
    }

    if (effect.id === "DD01-015-activate-main-power") {
        if ((card.state || "active") === "rested") {
            return {
                success: false,
                message: `${card.name} is already rested.`
            };
        }

        card.state = "rested";
        renderCharacters();

        const message = chooseOwnBoardCard(player, card, {
            prompt: "Choose up to 1 Ayase Seiko or Okarun to give +3000 power for its next battle.",
            optional: true,
            includeLeader: true,
            filter: targetCard => {
                return CardEffects.hasCardName(targetCard, "Ayase Seiko") ||
                    CardEffects.hasCardName(targetCard, "Okarun");
            },
            onSelect: ({ card: targetCard }) => {
                addBattlePowerBonus(targetCard, Number(effect.powerModifier ?? 3000));
                renderLeaders();
                renderCharacters();
                addGameLog(`${card.name} gave ${targetCard.name} +3000 power for its next battle.`);
            },
            skipMessage: `${player.name} rested ${card.name} but did not choose a target.`,
            emptyMessage: `${card.name} found no Ayase Seiko or Okarun cards.`
        });

        renderCharacters();

        return {
            success: true,
            message
        };
    }

    if (
        effect.id === "EGG1-002-activate-main-copy" ||
        effect.id === "EGG1-006-activate-main-base-power" ||
        effect.id === "EGG1-008-activate-main-trash-power"
    ) {
        if (effect.id === "EGG1-002-activate-main-copy") {
            const copyChoices = getOpponentBoardChoices(player, {
                includeLeader: true,
                filter: targetCard => getCopyableEffects(targetCard).length > 0
            });

            if (copyChoices.length === 0) {
                return {
                    success: false,
                    message: `${card.name} found no opposing leader or character abilities to copy.`
                };
            }
        }

        if (effect.id === "EGG1-006-activate-main-base-power") {
            const ownEggmanCharacters = getOwnBoardChoices(player, {
                includeLeader: false,
                filter: targetCard => targetCard.cardType === "character" && hasTypeText(targetCard, "Eggman Empire")
            });
            const opponentCharacters = getOpponentCharacterChoices(player);

            if (ownEggmanCharacters.length === 0 || opponentCharacters.length === 0) {
                return {
                    success: false,
                    message: `${card.name} needs one of your Eggman Empire characters and one opposing character.`
                };
            }
        }

        if (effect.id === "EGG1-008-activate-main-trash-power") {
            const otherCharacters = getOwnBoardChoices(player, {
                includeLeader: false,
                filter: targetCard => targetCard.cardType === "character" && targetCard.instanceId !== card.instanceId
            });

            if (otherCharacters.length === 0) {
                return {
                    success: false,
                    message: `${card.name} needs another character to trash.`
                };
            }
        }
        const message = resolveEffectAction(player, card, effect, ui, {
            skipActivationPrompt: true
        });

        return {
            success: Boolean(message),
            message: message || `${card.name}'s effect is not implemented yet.`
        };
    }

    const message = resolveEffectAction(player, card, effect, ui, {
        skipActivationPrompt: true
    });

    if (message) {
        return {
            success: true,
            message
        };
    }

    return {
        success: false,
        message: `${card.name}'s effect is not implemented yet.`
    };
}

function clearSelectedBoardActions() {
    document.querySelectorAll(".board-action-button-on-card").forEach(button => {
        button.remove();
    });
}

// =========================
// Selection Clearing
// =========================

function clearHandSelection() {
    document.querySelectorAll(".selected-card").forEach(card => {
        card.classList.remove("selected-card");
    });

    selectedHandCard = null;
    selectedHandCardData = null;

    clearSelectedCardActions();

    clearCardPreview();
}

function clearBoardSelection() {
    document.querySelectorAll(".selected-board-card").forEach(card => {
        card.classList.remove("selected-board-card");
    });

    clearSelectedBoardActions();

    selectedBoardCard = null;
    selectedBoardCardData = null;

    clearCardPreview();
}

// =========================
// Replace Mode UI
// =========================

function clearReplaceTargets() {
    document.querySelectorAll(".character-slot.replace-target").forEach(slot => {
        slot.classList.remove("replace-target");
    });
}

function enterReplaceMode(playerKey, cardInstanceId) {
    const player = gameState[playerKey];

    if (!player) return;

    const handIndex = findHandCardIndexByInstanceId(player, cardInstanceId);
    const card = player.hand[handIndex];

    if (!card || handIndex === -1) return;

    pendingReplacePlay = {
        playerKey,
        cardInstanceId
    };

    clearReplaceTargets();

    document
        .querySelectorAll(`.character-slot[data-player="${playerKey}"]`)
        .forEach(slot => {
            const slotIndex = Number(slot.getAttribute("data-slot"));

            if (player.characters[slotIndex]) {
                slot.classList.add("replace-target");
            }
        });

    addGameLog(`${player.name}'s board is full. Choose a character to replace with ${card.name}.`);
}

function setupCharacterSlotInteractions() {
    document.querySelectorAll(".character-slot").forEach(slot => {
        if (slot.dataset.replaceListenerAttached === "true") {
            return;
        }

        slot.dataset.replaceListenerAttached = "true";

        slot.addEventListener("click", async () => {
            if (!pendingReplacePlay) return;

            const slotPlayerKey = slot.getAttribute("data-player");
            const slotIndex = Number(slot.getAttribute("data-slot"));

            await handlePendingReplaceSlot(slotPlayerKey, slotIndex);
        });
    });
}

async function handlePendingReplaceSlot(slotPlayerKey, slotIndex) {
    if (!pendingReplacePlay) return;

    if (slotPlayerKey !== pendingReplacePlay.playerKey) {
        addGameLog("You can only replace that player's own characters.");
        return;
    }

    const player = gameState[slotPlayerKey];

    if (!canPlayerPlayCards(player)) {
        addGameLog("Cards cannot be played right now.");
        return;
    }

    if (!player.characters[slotIndex]) {
        addGameLog("Choose an occupied character slot to replace.");
        return;
    }

    const handIndex = findHandCardIndexByInstanceId(
        player,
        pendingReplacePlay.cardInstanceId
    );

    if (handIndex === -1) {
        addGameLog("Selected card could not be found.");

        pendingReplacePlay = null;
        clearReplaceTargets();

        return;
    }

    const result = playCard(
        player,
        handIndex,
        ui,
        { targetSlotIndex: slotIndex }
    );

    addGameLog(result.message);

    if (!result.success) return;

    pendingReplacePlay = null;

    clearReplaceTargets();
    clearHandSelection();

    await syncOnlineStateFromLocal();
}

function setupBoardStageSelection() {
    document.querySelectorAll(".board-stage-card").forEach(stageElement => {
        stageElement.onclick = async (event) => {
            event.stopPropagation();

            const playerKey = stageElement.getAttribute("data-player");

            if (pendingBoardChoice && await handleInlineBoardChoiceSelection({
                playerKey,
                cardType: "stage"
            })) {
                return;
            }

            if (pendingReplacePlay || pendingAttack || selectedDonAttachment) {
                return;
            }

            const player = gameState[playerKey];

            if (!player || !player.stage) return;

            if (selectedBoardCard === stageElement) {
                clearBoardSelection();
                return;
            }

            clearBoardSelection();
            clearHandSelection();

            selectedBoardCard = stageElement;
            selectedBoardCardData = {
                playerKey,
                cardType: "stage"
            };

            stageElement.classList.add("selected-board-card");
            showCardPreview(stageElement.getAttribute("data-card-image"));
            showSelectedBoardActions();

            addGameLog(`${player.name} selected ${player.stage.name}.`);
        };
    });
}

// =========================
// Battle Controls UI
// =========================

// =========================
// Attack Flow UI
// =========================

function resolveWhenBlockingEffectsBeforeCounter(player, sourceCard, onComplete) {
    const v2Effects = sourceCard?.effects
        ?.filter(effect => window.CustomEffectV2Engine?.getEventType?.(effect) === "whenBlocking") ?? [];

    const promptNext = index => {
        const effect = v2Effects[index];

        if (!effect) {
            const oldOnBlockMessage = resolveOnBlockEffects(player, sourceCard, ui);

            if (oldOnBlockMessage) {
                addGameLog(oldOnBlockMessage);
            }

            if (typeof onComplete === "function") {
                onComplete();
            }

            return;
        }

        const canUse = window.CustomEffectV2Engine.canUseEffect(player, sourceCard, effect);

        if (!canUse.ok) {
            promptNext(index + 1);
            return;
        }

        const runEffect = () => {
            let completed = false;
            const finish = () => {
                if (completed) return;
                completed = true;
                promptNext(index + 1);
            };

            const result = window.CustomEffectV2Engine.runEffect({
                player,
                sourceCard,
                effect,
                gameState,
                ui,
                options: {
                    skipActivationPrompt: true,
                    onComplete: finish
                }
            });

            if (result.message) {
                addGameLog(result.message);
            }

            if (!result.pending) {
                finish();
            }
        };

        if (effect.optional) {
            chooseEffectActivation({
                player,
                sourceCard,
                effect,
                title: sourceCard.name,
                prompt: effect.generatedText || effect.text || effect.sourceText || "Activate this When Blocking effect?",
                activateText: "Activate",
                skipText: "Skip",
                onComplete: shouldActivate => {
                    if (!shouldActivate) {
                        addGameLog(`${player.name} skipped ${sourceCard.name}'s When Blocking effect.`);
                        promptNext(index + 1);
                        return;
                    }

                    runEffect();
                }
            });
            return;
        }

        runEffect();
    };

    promptNext(0);
}

function highlightTrashChoiceTargets(playerKey) {
    clearTrashChoiceTargets();

    document
        .querySelectorAll(`.hand-card.selectable-card[data-player="${playerKey}"]`)
        .forEach(cardElement => {
            cardElement.classList.add("trash-choice-card");
        });
}

function clearTrashChoiceTargets() {
    document.querySelectorAll(".trash-choice-card").forEach(cardElement => {
        cardElement.classList.remove("trash-choice-card");
    });
}

async function handlePendingTrashChoice(playerKey, cardInstanceId) {
    if (!pendingTrashChoice) return;

    if (playerKey !== pendingTrashChoice.playerKey) {
        addGameLog("Choose a card from the attacking player's hand.");
        return;
    }

    const player = gameState[playerKey];

    if (!player) return;

    const handIndex = findHandCardIndexByInstanceId(player, cardInstanceId);

    if (handIndex === -1) {
        addGameLog("Selected card could not be found.");
        return;
    }

    const trashedCard = player.hand.splice(handIndex, 1)[0];
    const onComplete = pendingTrashChoice.onComplete;
    const sourceCardName = pendingTrashChoice.sourceCardName;

    moveCardToTrash(player, trashedCard, ui);

    pendingTrashChoice = null;
    clearTrashChoiceTargets();
    clearHandSelection();

    ui.renderHands();
    ui.renderTrash();

    addGameLog(`${player.name} trashed ${trashedCard.name} for ${sourceCardName}'s When Attacking effect.`);

    if (typeof onComplete === "function") {
        onComplete();
    }

    ui.renderHands();

    await syncOnlineStateFromLocal();
}

async function resolveCurrentAttack() {
    // Game mechanics disabled - this function is now a stub
}

function clearCancelAttackButton() {
    document.querySelectorAll(".cancel-attack-button-on-card").forEach(button => {
        button.remove();
    });
}

function showCancelAttackButton(attackerData) {
    clearCancelAttackButton();

    const buttonContainer = getBoardActionButtonContainerFromData(attackerData);

    if (!buttonContainer) return;

    const cancelButton = document.createElement("button");

    cancelButton.className = "board-action-button-on-card cancel-attack-button-on-card";
    cancelButton.textContent = "Cancel Attack";

    cancelButton.addEventListener("click", (event) => {
        event.stopPropagation();

        cancelPendingAttack();
    });

    buttonContainer.appendChild(cancelButton);
}

function cancelPendingAttack() {
    if (!pendingAttack) return;

    const attackerPlayer = gameState[pendingAttack.attackerPlayerKey];
    const attackerCard = getBoardCardFromData(pendingAttack.attacker);
    const attackerData = { ...pendingAttack.attacker };

    setBoardCardActive(attackerData);

    addGameLog(`${attackerPlayer.name} cancelled the attack with ${attackerCard.name}.`);

    pendingAttack = null;
    currentAttack = null;

    clearAttackTargets();
    clearBattleControls();
    clearAttackArrow();
    clearCancelAttackButton();

    gameState.currentPhase = "main";
}

// =========================
// Look Top Cards UI
// =========================

function lookTopCardsAddToHand({
    player,
    sourceCard,
    cards,
    isSelectable,
    onComplete,
    revealSelected = true,
    descriptionText = null,
    maxSelect = 1
}) {
    removeLookTopOverlay();

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "lookTopOverlay";

    const popup = document.createElement("div");
    popup.className = "look-top-popup";

    const title = document.createElement("h2");
    title.textContent = sourceCard
        ? `${sourceCard.name}`
        : "Look at cards";

    const description = document.createElement("p");
    description.textContent = descriptionText ||
        `Choose up to 1 valid card to add to ${player.name}'s hand. The rest go to the bottom of the deck.`;

    const cardGrid = document.createElement("div");
    cardGrid.className = "look-top-card-grid";

    const maximumSelections = Math.max(1, Number(maxSelect || 1));
    const selectedIndexes = new Set();
    let selectedIndex = null;

    const completeLookTopSelection = async (selection) => {
        const selectedIndexes = Array.isArray(selection?.selectedIndexes)
            ? selection.selectedIndexes
            : selection?.selectedIndex !== null && selection?.selectedIndex !== undefined
                ? [selection.selectedIndex]
                : [];
        const selectedCards = selectedIndexes
            .map(index => cards[index])
            .filter(Boolean);
        const selectedCard = selectedCards[0] || null;

        if (typeof onComplete === "function") {
            onComplete(selection);
        }

        // Multiplayer search pools stay local/private; only explicitly revealed chosen cards go public.
        if (isOnlineMatch && player === gameState[getOwnOnlinePlayerKey()]) {
            if (revealSelected && selectedCards.length) {
                await publishOnlineReveal(selectedCards.filter(card => isSelectable(card)));
            }

            await syncOnlineStateFromLocal();
        }
    };

    const continueToBottomOrder = () => {
        const remainingCards = cards
            .map((card, index) => ({ card, index }))
            .filter(entry => !selectedIndexes.has(entry.index));

        if (remainingCards.length <= 1) {
            removeLookTopOverlay();

            completeLookTopSelection({
                selectedIndex,
                selectedIndexes: [...selectedIndexes],
                bottomOrder: remainingCards.map(entry => entry.index)
            });

            return;
        }

        renderBottomOrderStep({
            player,
            sourceCard,
            remainingCards,
            selectedIndex,
            selectedIndexes: [...selectedIndexes],
            onComplete: completeLookTopSelection
        });
    };

    const selectCard = (cardButton, index, validChoice) => {
        if (!validChoice) return;

        if (maximumSelections > 1) {
            if (selectedIndexes.has(index)) {
                selectedIndexes.delete(index);
            } else if (selectedIndexes.size < maximumSelections) {
                selectedIndexes.add(index);
            }

            selectedIndex = selectedIndexes.size ? [...selectedIndexes][0] : null;
        } else {
            selectedIndexes.clear();
            selectedIndexes.add(index);
            selectedIndex = index;
        }

        document.querySelectorAll(".look-top-card-button").forEach(button => {
            button.classList.remove("selected-look-card");
        });

        selectedIndexes.forEach(selected => {
            document.querySelectorAll(".look-top-card-button")[selected]?.classList.add("selected-look-card");
        });

        addButton.disabled = selectedIndexes.size < 1;
    };

    cards.forEach((card, index) => {
        const cardButton = document.createElement("button");
        cardButton.className = "look-top-card-button";

        const validChoice = isSelectable(card);

        if (!validChoice) {
            cardButton.classList.add("disabled-choice");
            cardButton.title = "This card is not a valid choice, but you can inspect it.";
        } else {
            cardButton.title = "Click to inspect. Use Select Card to add it.";
        }

        const img = document.createElement("img");
        img.src = cardArtSrc(card);
        img.alt = card.name;
        img.className = "look-top-card-img";

        const name = document.createElement("span");
        name.className = "look-top-card-name";
        name.textContent = card.name;

        cardButton.appendChild(img);
        cardButton.appendChild(name);

        cardButton.addEventListener("click", () => {
            selectCard(cardButton, index, validChoice);
            showSearchCardImagePopup(card, {
                canSelect: validChoice,
                onSelect: () => {
                    selectCard(cardButton, index, validChoice);
                    if (maximumSelections === 1) {
                        continueToBottomOrder();
                    }
                }
            });
        });

        cardGrid.appendChild(cardButton);
    });

    const buttonRow = document.createElement("div");
    buttonRow.className = "look-top-buttons";

    const addButton = document.createElement("button");
    addButton.className = "look-top-action-button";
    addButton.textContent = "Add Selected";
    addButton.disabled = true;

    const skipButton = document.createElement("button");
    skipButton.className = "look-top-action-button secondary";
    skipButton.textContent = "Add Nothing";

    addButton.addEventListener("click", () => {
        if (selectedIndexes.size < 1) return;

        continueToBottomOrder();
    });

    skipButton.addEventListener("click", () => {
        selectedIndex = null;
        selectedIndexes.clear();

        continueToBottomOrder();
    });

    buttonRow.appendChild(addButton);
    buttonRow.appendChild(skipButton);

    popup.appendChild(title);
    popup.appendChild(description);
    popup.appendChild(cardGrid);
    popup.appendChild(buttonRow);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}

function showSearchCardImagePopup(card, options = {}) {
    if (!card?.image) return;

    removeSearchCardImagePopup();

    const overlay = document.createElement("div");
    overlay.className = "search-card-image-overlay";
    overlay.id = "searchCardImageOverlay";

    const popup = document.createElement("div");
    popup.className = "search-card-image-popup";

    const image = document.createElement("img");
    image.src = cardArtSrc(card);
    image.alt = card.name;
    image.className = "search-card-image-large";

    const name = document.createElement("h3");
    name.textContent = card.name;

    const buttons = document.createElement("div");
    buttons.className = "search-card-image-buttons";

    if (options.canSelect) {
        const selectButton = document.createElement("button");
        selectButton.className = "look-top-action-button";
        selectButton.textContent = "Select Card";
        selectButton.addEventListener("click", () => {
            if (typeof options.onSelect === "function") {
                options.onSelect();
            }

            removeSearchCardImagePopup();
        });

        buttons.appendChild(selectButton);
    }

    const closeButton = document.createElement("button");
    closeButton.className = "look-top-action-button secondary";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", removeSearchCardImagePopup);

    buttons.appendChild(closeButton);

    popup.appendChild(image);
    popup.appendChild(name);
    popup.appendChild(buttons);
    overlay.appendChild(popup);

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            removeSearchCardImagePopup();
        }
    });

    document.body.appendChild(overlay);
}

function removeSearchCardImagePopup() {
    const oldOverlay = document.getElementById("searchCardImageOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

function removeLookTopOverlay() {
    removeSearchCardImagePopup();

    const oldOverlay = document.getElementById("lookTopOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

// =========================
// Board Choice UI
// =========================

function showBoardCardChoice({
    player,
    sourceCard,
    prompt,
    choices,
    optional,
    onComplete
}) {
    removeBoardChoiceOverlay();

    if (choices.every(isInlineBoardChoice)) {
        showInlineBoardChoice({
            player,
            sourceCard,
            prompt,
            choices,
            optional,
            onComplete
        });
        return;
    }

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "boardChoiceOverlay";

    const popup = document.createElement("div");
    popup.className = "look-top-popup";

    const title = document.createElement("h2");
    title.textContent = sourceCard ? sourceCard.name : "Choose a card";

    const description = document.createElement("p");
    description.textContent = prompt || `Choose a card for ${player.name}.`;

    const cardGrid = document.createElement("div");
    cardGrid.className = "look-top-card-grid";

    let selectedChoice = null;

    const getFreshChoice = (choice) => {
        if (!choice) return null;

        const freshCard = getBoardCardFromData(choice);

        return freshCard
            ? { ...choice, card: freshCard }
            : choice;
    };

    choices.forEach(choice => {
        const cardButton = document.createElement("button");
        cardButton.className = "look-top-card-button";

        const img = document.createElement("img");
        img.src = cardArtSrc(choice.card);
        img.alt = choice.card.name;
        img.className = "look-top-card-img";

        const name = document.createElement("span");
        name.className = "look-top-card-name";
        name.textContent = choice.card.name;

        cardButton.appendChild(img);
        cardButton.appendChild(name);

        cardButton.addEventListener("click", () => {
            selectedChoice = choice;

            document.querySelectorAll("#boardChoiceOverlay .look-top-card-button").forEach(button => {
                button.classList.remove("selected-look-card");
            });

            cardButton.classList.add("selected-look-card");

            chooseButton.disabled = false;
        });

        cardGrid.appendChild(cardButton);
    });

    const buttonRow = document.createElement("div");
    buttonRow.className = "look-top-buttons";

    const chooseButton = document.createElement("button");
    chooseButton.className = "look-top-action-button";
    chooseButton.textContent = "Choose";
    chooseButton.disabled = true;

    const skipButton = document.createElement("button");
    skipButton.className = "look-top-action-button secondary";
    skipButton.textContent = "Skip";
    skipButton.disabled = !optional;

    chooseButton.addEventListener("click", async () => {
        if (!selectedChoice) return;

        removeBoardChoiceOverlay();

        if (typeof onComplete === "function") {
            await onComplete(getFreshChoice(selectedChoice));
        }

        await syncOnlineStateFromLocal();

        if (isOnlineMatch) {
            await syncOnlineAllPublicBoardsFromLocal();
        }
    });

    skipButton.addEventListener("click", async () => {
        removeBoardChoiceOverlay();

        if (typeof onComplete === "function") {
            await onComplete(null);
        }

        await syncOnlineStateFromLocal();

        if (isOnlineMatch) {
            await syncOnlineAllPublicBoardsFromLocal();
        }
    });

    buttonRow.appendChild(chooseButton);
    buttonRow.appendChild(skipButton);

    popup.appendChild(title);
    popup.appendChild(description);
    popup.appendChild(cardGrid);
    popup.appendChild(buttonRow);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}

function renderBottomOrderStep({
    player,
    sourceCard,
    remainingCards,
    selectedIndex,
    selectedIndexes = [],
    onComplete
}) {
    const overlay = document.getElementById("lookTopOverlay");
    const popup = overlay?.querySelector(".look-top-popup");

    if (!overlay || !popup) return;

    popup.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = sourceCard
        ? `${sourceCard.name}`
        : "Order cards";

    const description = document.createElement("p");
    description.textContent = `Click the remaining cards in the order ${player.name} wants to place them on the bottom of the deck.`;

    const cardGrid = document.createElement("div");
    cardGrid.className = "look-top-card-grid";

    const selectedOrder = [];
    const doneButton = document.createElement("button");

    const updateDoneState = () => {
        doneButton.disabled = selectedOrder.length !== remainingCards.length;
    };

    remainingCards.forEach(entry => {
        const cardButton = document.createElement("button");
        cardButton.className = "look-top-card-button bottom-order-card-button";

        const orderBadge = document.createElement("span");
        orderBadge.className = "bottom-order-badge";

        const img = document.createElement("img");
        img.src = cardArtSrc(entry.card);
        img.alt = entry.card.name;
        img.className = "look-top-card-img";

        const name = document.createElement("span");
        name.className = "look-top-card-name";
        name.textContent = entry.card.name;

        cardButton.appendChild(orderBadge);
        cardButton.appendChild(img);
        cardButton.appendChild(name);

        cardButton.addEventListener("click", () => {
            if (selectedOrder.includes(entry.index)) return;

            selectedOrder.push(entry.index);
            orderBadge.textContent = selectedOrder.length;
            cardButton.classList.add("selected-look-card", "bottom-order-selected");
            updateDoneState();
        });

        cardGrid.appendChild(cardButton);
    });

    const buttonRow = document.createElement("div");
    buttonRow.className = "look-top-buttons";

    doneButton.className = "look-top-action-button";
    doneButton.textContent = "Place on Bottom";
    doneButton.disabled = true;

    const resetButton = document.createElement("button");
    resetButton.className = "look-top-action-button secondary";
    resetButton.textContent = "Reset Order";

    doneButton.addEventListener("click", () => {
        if (selectedOrder.length !== remainingCards.length) return;

        removeLookTopOverlay();

        if (typeof onComplete === "function") {
            onComplete({
                selectedIndex,
                selectedIndexes,
                bottomOrder: selectedOrder
            });
        }
    });

    resetButton.addEventListener("click", () => {
        selectedOrder.splice(0, selectedOrder.length);

        cardGrid.querySelectorAll(".bottom-order-card-button").forEach(cardButton => {
            cardButton.classList.remove("selected-look-card", "bottom-order-selected");
            const orderBadge = cardButton.querySelector(".bottom-order-badge");

            if (orderBadge) {
                orderBadge.textContent = "";
            }
        });

        updateDoneState();
    });

    buttonRow.appendChild(doneButton);
    buttonRow.appendChild(resetButton);

    popup.appendChild(title);
    popup.appendChild(description);
    popup.appendChild(cardGrid);
    popup.appendChild(buttonRow);
}

function removeBoardChoiceOverlay() {
    clearInlineBoardChoice();

    const oldOverlay = document.getElementById("boardChoiceOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

function isInlineBoardChoice(choice) {
    return choice &&
        choice.playerKey &&
        ["leader", "character", "stage"].includes(choice.cardType);
}

function showInlineBoardChoice({
    player,
    sourceCard,
    prompt,
    choices,
    optional,
    onComplete
}) {
    clearInlineBoardChoice();
    clearBoardSelection();
    clearHandSelection();

    pendingBoardChoice = {
        player,
        sourceCard,
        choices,
        optional,
        onComplete
    };

    choices.forEach(choice => {
        const element = getBoardElementForChoice(choice);

        if (!element) return;

        element.classList.add("board-choice-target");
        element.classList.toggle("board-choice-own", gameState[choice.playerKey] === player);
        element.classList.toggle("board-choice-opponent", gameState[choice.playerKey] !== player);
        element.title = `${gameState[choice.playerKey]?.name || "Player"}: ${choice.card?.name || "Card"}`;
    });

    renderInlineBoardChoicePrompt(prompt || `Choose a card for ${player.name}.`, Boolean(optional));
}

function renderInlineBoardChoicePrompt(prompt, optional) {
    const box = document.createElement("div");
    box.id = "inlineBoardChoicePrompt";
    box.className = "inline-board-choice-prompt";

    const text = document.createElement("span");
    text.textContent = prompt;

    box.appendChild(text);

    if (optional) {
        const skipButton = document.createElement("button");
        skipButton.type = "button";
        skipButton.textContent = "Skip";
        skipButton.addEventListener("click", async () => {
            const choice = pendingBoardChoice;

            clearInlineBoardChoice();

            if (typeof choice?.onComplete === "function") {
                await choice.onComplete(null);
            }

            await syncOnlineStateFromLocal();
        });

        box.appendChild(skipButton);
    }

    document.body.appendChild(box);
}

function clearInlineBoardChoice() {
    pendingBoardChoice = null;

    document.querySelectorAll(".board-choice-target").forEach(element => {
        element.classList.remove("board-choice-target", "board-choice-own", "board-choice-opponent");
        element.removeAttribute("title");
    });

    document.getElementById("inlineBoardChoicePrompt")?.remove();
}

async function handleInlineBoardChoiceSelection(choiceData) {
    const choiceState = pendingBoardChoice;

    if (!choiceState) return false;

    const selectedChoice = choiceState.choices.find(choice => {
        return choice.playerKey === choiceData.playerKey &&
            choice.cardType === choiceData.cardType &&
            (choice.cardType !== "character" || Number(choice.slotIndex) === Number(choiceData.slotIndex));
    });

    if (!selectedChoice) {
        addGameLog("That card is not a valid choice for this effect.");
        return true;
    }

    const freshCard = getBoardCardFromData(selectedChoice);
    const finalChoice = freshCard
        ? { ...selectedChoice, card: freshCard }
        : selectedChoice;

    clearInlineBoardChoice();

    if (typeof choiceState.onComplete === "function") {
        await choiceState.onComplete(finalChoice);
    }

    await syncOnlineStateFromLocal();

    if (isOnlineMatch) {
        await syncOnlineAllPublicBoardsFromLocal();
    }

    return true;
}

function getBoardElementForChoice(choice) {
    if (!choice) return null;

    if (choice.cardType === "leader") {
        return document.querySelector(`.board-leader-card[data-player="${choice.playerKey}"]`);
    }

    if (choice.cardType === "character") {
        return document.querySelector(`.board-character-card[data-player="${choice.playerKey}"][data-character-slot="${choice.slotIndex}"]`);
    }

    if (choice.cardType === "stage") {
        return document.querySelector(`.board-stage-card[data-player="${choice.playerKey}"]`);
    }

    return null;
}

// =========================
// Effect Choice UI
// =========================

function chooseEffectActivation({
    player,
    sourceCard,
    effect,
    title,
    prompt,
    activateText = "Activate This Effect",
    skipText = "Do Not Activate",
    onComplete
}) {
    chooseEffectOption({
        player,
        sourceCard,
        effect,
        title,
        prompt,
        activationPrompt: true,
        options: [
            {
                label: activateText,
                value: true
            },
            {
                label: skipText,
                value: false,
                secondary: true
            }
        ],
        onComplete
    });
}

function chooseEffectOption({
    sourceCard,
    title,
    prompt,
    options,
    activationPrompt = false,
    onComplete
}) {
    removeEffectChoiceOverlay();

    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "effectChoiceOverlay";

    const popup = document.createElement("div");
    popup.className = "look-top-popup effect-choice-popup";
    if (activationPrompt) {
        popup.classList.add("effect-activation-popup");
    }

    const heading = document.createElement("h2");
    heading.textContent = title || sourceCard?.name || "Choose Effect";

    const body = document.createElement("div");
    body.className = "effect-choice-body";

    if (sourceCard?.image) {
        const image = document.createElement("img");
        image.src = cardArtSrc(sourceCard);
        image.alt = sourceCard.name;
        image.className = "effect-choice-card-img";
        body.appendChild(image);
    }

    const content = document.createElement("div");
    content.className = "effect-choice-content";

    const description = document.createElement("p");
    description.textContent = prompt || "Choose how to resolve this effect.";

    if (activationPrompt && effect) {
        const effectText = document.createElement("div");
        effectText.className = "effect-activation-text";
        effectText.textContent = effect.generatedText || effect.text || effect.sourceText || "";
        if (effectText.textContent.trim()) {
            content.appendChild(effectText);
        }
    }

    const buttonRow = document.createElement("div");
    const hasCardOptions = options.some(option => option.card?.image);
    buttonRow.className = hasCardOptions
        ? "look-top-card-grid effect-choice-card-options"
        : "look-top-buttons effect-choice-buttons";

    options.forEach(option => {
        const button = document.createElement("button");
        button.className = hasCardOptions && option.card
            ? "look-top-card-button effect-choice-card-option"
            : option.secondary
                ? "look-top-action-button secondary"
                : "look-top-action-button";

        if (option.card?.image) {
            const img = document.createElement("img");
            img.src = cardArtSrc(option.card);
            img.alt = option.card.name || option.label;
            img.className = "look-top-card-img";

            const name = document.createElement("span");
            name.className = "look-top-card-name";
            name.textContent = option.card.name || option.label;

            button.appendChild(img);
            button.appendChild(name);
        } else {
            button.textContent = option.label;
        }

        button.addEventListener("click", async () => {
            const completeChoice = async () => {
                removeEffectChoiceOverlay();

                if (typeof onComplete === "function") {
                    await onComplete(option.value);
                }

                await syncOnlineStateFromLocal();
            };

            if (option.card?.image) {
                showSearchCardImagePopup(option.card, {
                    canSelect: true,
                    onSelect: completeChoice
                });
                return;
            }

            await completeChoice();
        });

        buttonRow.appendChild(button);
    });

    content.appendChild(description);
    content.appendChild(buttonRow);
    body.appendChild(content);

    popup.appendChild(heading);
    popup.appendChild(body);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}

function removeEffectChoiceOverlay() {
    const oldOverlay = document.getElementById("effectChoiceOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

// =========================
// Board Helpers
// =========================

function getSelectedBoardCardObject() {
    if (!selectedBoardCardData) return null;

    return getBoardCardFromData(selectedBoardCardData);
}

function canSelectedBoardCardAttack() {
    if (pendingAttack || currentAttack) {
        return false;
    }

    if (!selectedBoardCardData) {
        return false;
    }

    const player = gameState[selectedBoardCardData.playerKey];

    if (!player) {
        return false;
    }

    if (gameState.currentPhase !== "main") {
        return false;
    }

    if (gameState.currentPlayer !== player) {
        return false;
    }

    if (!canCurrentPlayerAttack()) {
        return false;
    }

    const card = getSelectedBoardCardObject();

    if (!card) {
        return false;
    }

    if (
        selectedBoardCardData.cardType === "character" &&
        isCharacterPlayedThisTurn(player, card) &&
        !CardEffects.canAttackOnTurnPlayed(card) &&
        !CardEffects.canAttackCharactersOnTurnPlayed(card)
    ) {
        return false;
    }

    const cardState = card.state || "active";

    if (cardState !== "active") {
        return false;
    }

    if (selectedBoardCardData.cardType === "character" && isCharacterAttackLocked(card, player)) {
        return false;
    }

    return true;
}

function getBoardActionButtonContainer() {
    if (!selectedBoardCard || !selectedBoardCardData) return null;

    if (selectedBoardCardData.cardType === "leader") {
        return selectedBoardCard.closest(".leader-area");
    }

    if (selectedBoardCardData.cardType === "character") {
        return selectedBoardCard.closest(".character-slot");
    }

    if (selectedBoardCardData.cardType === "stage") {
        return selectedBoardCard.closest(".stage-area");
    }

    return null;
}

function getOpponentPlayerKey(playerKey) {
    return playerKey === "player1" ? "player2" : "player1";
}

function isCharacterPlayedThisTurn(player, card) {
    if (!player || !card) {
        return false;
    }

    return card.cardType === "character" && card.playedOnTurn === player.turns;
}

let resolvingCustomEffectV2SetPower = false;

function getPrintedPower(card) {
    if (card?.temporaryBasePower && !isTemporaryBasePowerExpired(card.temporaryBasePower)) {
        return Number(card.temporaryBasePower.value ?? card.power ?? 0);
    }

    if (card?.cardNumber === "BK01-007") {
        const owner = getPlayerForBoardCard(card);
        const player = owner;

        if (player?.characters?.some(character => CardEffects.hasCardName(character, "Guts"))) {
            return 6000;
        }
    }

    return Number(card?.power ?? 0);
}

function isTemporaryBasePowerExpired(basePowerEntry) {
    const playerKey = basePowerEntry?.expiresAtPlayerKey;
    const player = playerKey ? gameState?.[playerKey] : null;

    return Boolean(player && Number(player.turns || 0) > Number(basePowerEntry.expiresAtEndOfTurns ?? 0));
}

function getPowerModifier(card, player = null) {
    if (!card) {
        return 0;
    }

    return getYourTurnPowerBonus(card, player) +
        getTurboGrannyFormPowerModifier(card, player) +
        getSerpicoFarnesePowerModifier(card, player) +
        getGutsLeaderPowerModifier(card, player) +
        getRimuruTempestPowerModifier(card, player) +
        getOpponentTurnPowerModifier(card, player) +
        getAttachedDonPowerModifier(card, player) +
        getST01PowerModifier(card, player) +
        getCustomEffectV2PowerModifier(card, player) +
        getTemporaryPowerModifier(card) +
        getDurationPowerModifier(card) +
        getTokenAttachedPowerModifier(card) +
        getBattlePowerModifier(card);
}

function getST01PowerModifier(card, player) {
    if (!card || !player) {
        return 0;
    }

    if (card.cardNumber === "ST01-013" && Number(card.attachedDon || 0) >= 1) {
        return 1000;
    }

    return 0;
}

function getPlayerForBoardCard(card) {
    if (!card || !gameState) {
        return null;
    }

    return [gameState.player1, gameState.player2].find(player => {
        return player.leader === card || player.stage === card || player.characters.includes(card);
    }) || null;
}

function getYourTurnPowerBonus(card, player) {
    if (!card || !player) {
        return 0;
    }

    if (gameState.currentPlayer !== player) {
        return 0;
    }

    return card.effects
        ?.filter(effect => effect.type === "yourTurn")
        .reduce((total, effect) => {
            if (effect.actionId === "leaderPowerPerCharacter") {
                return total + player.characters.filter(Boolean).length * 1000;
            }

            if (effect.actionId === "attachedDonPower") {
                const requiredTokens = Number(effect.requiredTokens ?? 1);

                if (Number(card.attachedDon || 0) >= requiredTokens) {
                    return total + Number(effect.powerModifier ?? 0);
                }
            }

            return total;
        }, 0) ?? 0;
}

function getTurboGrannyFormPowerModifier(card, player) {
    if (!card || !player || !player.stage) {
        return 0;
    }

    if (card.cardType !== "leader" && card.cardType !== "character") {
        return 0;
    }

    if (!CardEffects.hasCardName(player.stage, "Turbo Granny Form")) {
        return 0;
    }

    if (!CardEffects.hasCardName(card, "Okarun")) {
        return 0;
    }

    return player.stage.effects
        ?.filter(effect => {
            return effect.type === "continuous" &&
                effect.id === "DD01-002-your-turn-power";
        })
        .reduce((total, effect) => {
            return total + Number(effect.powerModifier ?? 0);
        }, 0) ?? 0;
}

function getOpponentTurnPowerModifier(card, player) {
    if (!card || !player) {
        return 0;
    }

    if (gameState.currentPlayer === player) {
        return 0;
    }

    return card.effects
        ?.filter(effect => effect.type === "opponentsTurn")
        .reduce((total, effect) => {
            return total + Number(effect.powerModifier ?? 0);
        }, 0) ?? 0;
}

function getCustomEffectV2PowerModifier(card, player) {
    if (!card || !player || !window.CustomEffectV2Engine?.isV2Effect) {
        return 0;
    }

    const sources = [
        player.leader,
        player.stage,
        ...player.characters.filter(Boolean)
    ].filter(Boolean);

    return sources.reduce((total, sourceCard) => {
        return total + (sourceCard.effects || [])
            .filter(effect => window.CustomEffectV2Engine.isV2Effect(effect))
            .filter(effect => {
                const eventType = window.CustomEffectV2Engine.getEventType(effect);
                if (eventType === "yourTurn") return gameState.currentPlayer === player;
                if (eventType === "opponentTurn") return gameState.currentPlayer !== player;
                return eventType === "static";
            })
            .filter(effect => window.CustomEffectV2Engine.canUseEffect?.(player, sourceCard, effect)?.ok)
            .flatMap(effect => (effect.actions || []).map(action => ({ effect, action })))
            .filter(entry => entry.action.type === "modifyPower")
            .filter(entry => {
                const conditions = Array.isArray(entry.action.conditions) ? entry.action.conditions : [];
                return conditions.every(condition => window.CustomEffectV2Engine.conditionMet?.(player, sourceCard, condition) !== false);
            })
            .filter(entry => customEffectV2ActionAppliesToCard(entry.action, entry.effect, sourceCard, card, player))
            .reduce((effectTotal, entry) => effectTotal + Number(entry.action.amount || 0), 0);
    }, 0);
}

function getCustomEffectV2SetPowerValue(card, player) {
    if (!card || !player || resolvingCustomEffectV2SetPower || !window.CustomEffectV2Engine?.isV2Effect) {
        return null;
    }

    const sources = [
        player.leader,
        player.stage,
        ...player.characters.filter(Boolean)
    ].filter(Boolean);

    resolvingCustomEffectV2SetPower = true;

    try {
        let setPowerValue = null;

        sources.forEach(sourceCard => {
            (sourceCard.effects || [])
                .filter(effect => window.CustomEffectV2Engine.isV2Effect(effect))
                .filter(effect => {
                    const eventType = window.CustomEffectV2Engine.getEventType(effect);
                    if (eventType === "yourTurn") return gameState.currentPlayer === player;
                    if (eventType === "opponentTurn") return gameState.currentPlayer !== player;
                    return eventType === "static";
                })
                .filter(effect => window.CustomEffectV2Engine.canUseEffect?.(player, sourceCard, effect)?.ok)
                .flatMap(effect => (effect.actions || []).map(action => ({ effect, action })))
                .filter(entry => entry.action.type === "setPower")
                .filter(entry => !entry.action.duration || entry.action.duration === window.CustomEffectV2?.DURATIONS?.permanent)
                .filter(entry => {
                    const conditions = Array.isArray(entry.action.conditions) ? entry.action.conditions : [];
                    return conditions.every(condition => window.CustomEffectV2Engine.conditionMet?.(player, sourceCard, condition) !== false);
                })
                .filter(entry => customEffectV2ActionAppliesToCard(entry.action, entry.effect, sourceCard, card, player))
                .forEach(entry => {
                    const amount = Number(entry.action.amount);
                    if (Number.isFinite(amount)) setPowerValue = amount;
                });
        });

        return setPowerValue;
    } finally {
        resolvingCustomEffectV2SetPower = false;
    }
}

function customEffectV2ActionAppliesToCard(action, effect, sourceCard, card, player) {
    const target = String(action.target || "");

    if (target === "thisCard") return sourceCard === card;
    if (target === "thisLeader" || target === "yourLeader") return player.leader === card;
    if (target === "yourCharacters") return card.cardType === "character" && player.characters.includes(card);
    if (target === "yourLeaderOrCharacters") {
        return player.leader === card || (card.cardType === "character" && player.characters.includes(card));
    }

    const selection = (effect.targets || []).find(entry => entry.id === target);
    if (!selection || selection.controller === "opponent") return false;

    if (selection.zone === "characters" && card.cardType !== "character") return false;
    if (selection.zone === "leader" && card.cardType !== "leader") return false;
    if (selection.zone === "stage" && card.cardType !== "stage") return false;
    if (selection.zone === "leaderOrCharacters" && card.cardType !== "leader" && card.cardType !== "character") return false;
    if (selection.zone !== "board" && selection.zone !== "leaderOrCharacters" && selection.zone !== "characters" && selection.zone !== "leader" && selection.zone !== "stage") return false;

    return customEffectV2FiltersMatch(card, selection.filters || []);
}

function customEffectV2FiltersMatch(card, filters) {
    return filters.every(filter => {
        if (filter.field === "any") {
            return (filter.branches || []).some(branch => customEffectV2FiltersMatch(card, branch));
        }
        if (filter.field === "cost") return compareCustomEffectV2Number(getCardEffectiveCost(card), filter.operator, filter.value);
        if (filter.field === "power") return compareCustomEffectV2Number(Number(card.power || 0), filter.operator, filter.value);
        if (filter.field === "basePower") return compareCustomEffectV2Number(Number(card.power || 0), filter.operator, filter.value);
        if (filter.field === "attachedDon") return compareCustomEffectV2Number(Number(card.attachedDon || 0), filter.operator, filter.value);
        if (filter.field === "cardType") return String(card.cardType || "").toLowerCase() === String(filter.value || "").toLowerCase();
        if (filter.field === "name") {
            if (filter.operator === "!=") {
                return !String(card.name || "").toLowerCase().includes(String(filter.value || "").toLowerCase());
            }
            return String(card.name || "").toLowerCase().includes(String(filter.value || "").toLowerCase());
        }
        if (filter.field === "type") return typeof hasExactTypeText === "function"
            ? hasExactTypeText(card, filter.value)
            : String(card.type || "").toLowerCase().includes(String(filter.value || "").toLowerCase());
        if (filter.field === "color") {
            const colors = Array.isArray(card.colors)
                ? card.colors
                : String(card.color || "").split(/[\/,]/);
            return colors.some(color => String(color || "").trim().toLowerCase() === String(filter.value || "").toLowerCase());
        }
        if (filter.field === "keyword") return CardEffects.hasKeyword(card, filter.value);
        return true;
    });
}

function compareCustomEffectV2Number(actual, operator, expected) {
    if (operator === "<=") return Number(actual) <= Number(expected);
    if (operator === ">=") return Number(actual) >= Number(expected);
    if (operator === "==") return Number(actual) === Number(expected);
    return true;
}

function getTokenAttachedPowerModifier(card) {
    if (!card) {
        return 0;
    }

    const attachedDon = Number(card.attachedDon ?? 0);

    return card.effects
        ?.filter(effect => effect.type === "tokenAttached")
        .reduce((total, effect) => {
            const requiredTokens = Number(effect.requiredTokens ?? 0);

            if (attachedDon < requiredTokens) {
                return total;
            }

            return total + Number(effect.powerModifier ?? 0);
        }, 0) ?? 0;
}

function getSerpicoFarnesePowerModifier(card, player) {
    if (!card || !player || card.cardType !== "character") {
        return 0;
    }

    if (!CardEffects.hasCardName(card, "Farnese")) {
        return 0;
    }

    return player.characters
        .filter(character => character?.cardNumber === "BK01-010")
        .reduce((total, character) => {
            const effect = character.effects?.find(cardEffect => cardEffect.id === "BK01-010-farnese-power");
            return total + Number(effect?.powerModifier ?? 0);
        }, 0);
}

function getGutsLeaderPowerModifier(card, player) {
    if (!card || !player || card.cardType !== "leader") {
        return 0;
    }

    if (!CardEffects.hasCardName(card, "Guts")) {
        return 0;
    }

    return player.characters
        .filter(character => character?.cardNumber === "BK01-016")
        .reduce((total, character) => {
            const effect = character.effects?.find(cardEffect => cardEffect.id === "BK01-016-guts-rush-leader-power");
            return total + Number(effect?.leaderPowerModifier ?? 0);
        }, 0);
}

function getRimuruTempestPowerModifier(card, player) {
    if (!card || !player || !player.leader || !CardEffects.hasCardName(player.leader, "Rimuru Tempest")) {
        return 0;
    }

    if (card.cardNumber === "RIM1-004") {
        return 1000;
    }

    return 0;
}

function getAttachedDonPowerModifier(card, player) {
    if (gameState.currentPlayer !== player) {
        return 0;
    }

    return Number(card?.attachedDon ?? 0) * 1000;
}

function getTemporaryPowerModifier(card) {
    return Number(card?.temporaryPowerBonus ?? 0);
}

function getDurationPowerModifier(card) {
    return card?.durationPowerBonuses
        ?.filter(entry => !isDurationPowerBonusExpired(card, entry))
        .reduce((total, entry) => total + Number(entry.amount ?? 0), 0) ?? 0;
}

function isDurationPowerBonusExpired(card, entry) {
    const fallbackPlayer = getPlayerForBoardCard(card);
    const expiringPlayer = entry?.expiresAtPlayerKey
        ? gameState?.[entry.expiresAtPlayerKey]
        : fallbackPlayer;

    if (!expiringPlayer) {
        return false;
    }

    return Number(expiringPlayer.turns || 0) > Number(entry.expiresAtEndOfTurns ?? 0);
}

function getCostModifier(card) {
    return card?.costModifiers
        ?.reduce((total, entry) => total + Number(entry.amount ?? 0), 0) ?? 0;
}

function renderCostModifierBadge(card, container) {
    if (!card || !container || card.cardType !== "character") {
        return;
    }

    const modifier = getCostModifier(card);

    if (modifier === 0) {
        return;
    }

    const printedCost = Number(card.cost ?? card.playCost ?? 0);
    const sign = modifier > 0 ? "+" : "";
    const badge = document.createElement("div");

    badge.className = modifier < 0
        ? "cost-modifier-badge cost-modifier-negative"
        : "cost-modifier-badge cost-modifier-positive";
    badge.textContent = `${sign}${modifier} Cost`;
    badge.title = `Cost modifier: ${sign}${modifier} (${printedCost} printed cost)`;

    container.appendChild(badge);
}

function renderPowerModifierBadge(card, player, container, boardCardData = null) {
    if (!card || !container) {
        return;
    }

    const modifier = getPowerModifier(card, player) +
        getCurrentAttackTargetPowerBonus(boardCardData);

    if (modifier === 0) {
        return;
    }

    const badge = document.createElement("div");
    const sign = modifier > 0 ? "+" : "";
    const printedPower = getPrintedPower(card);
    const currentPower = printedPower + modifier;

    badge.className = modifier > 0
        ? "power-modifier-badge power-modifier-positive"
        : "power-modifier-badge power-modifier-negative";

    badge.textContent = `${sign}${modifier}`;
    badge.title = `Current power: ${currentPower} (${printedPower} ${sign}${modifier})`;

    container.appendChild(badge);
}

function renderLivePowerBadge(card, player, container, boardCardData = null) {
    if (!card || !container || (card.cardType !== "leader" && card.cardType !== "character")) {
        return;
    }

    const battlePower = getCardBattlePower(card, player) + getCurrentAttackTargetPowerBonus(boardCardData);
    const badge = document.createElement("button");

    badge.type = "button";
    badge.className = "live-power-badge";
    badge.textContent = String(battlePower);
    badge.title = "Power breakdown";
    badge.addEventListener("click", event => {
        event.stopPropagation();
        showPowerBreakdown(card, player, boardCardData);
    });

    container.appendChild(badge);
}

function renderBasePowerBadge(card, container) {
    if (!card || !container || (card.cardType !== "leader" && card.cardType !== "character")) {
        return;
    }

    const basePower = getPrintedPower(card);
    const badge = document.createElement("div");

    badge.className = "base-power-badge";
    badge.textContent = `Base ${basePower}`;
    badge.title = `Base power: ${basePower}`;

    container.appendChild(badge);
}

function renderAttachedDonBadge(card, container) {
    if (!card || !container) {
        return;
    }

    const attachedDon = Number(card.attachedDon ?? 0);

    if (attachedDon <= 0) {
        return;
    }

    const badge = document.createElement("div");
    badge.className = "attached-don-badge";
    badge.textContent = `DON!! x${attachedDon}`;
    badge.title = `${attachedDon} attached DON!!: +${attachedDon * 1000} power`;

    container.appendChild(badge);
}

function getCurrentAttackTargetPowerBonus(boardCardData) {
    if (!currentAttack || !boardCardData) {
        return 0;
    }

    if (!isSameBoardCard(currentAttack.target, boardCardData)) {
        return 0;
    }

    return Number(currentAttack.targetPowerBonus || 0);
}

function isSameBoardCard(firstCardData, secondCardData) {
    if (!firstCardData || !secondCardData) {
        return false;
    }

    if (firstCardData.playerKey !== secondCardData.playerKey) {
        return false;
    }

    if (firstCardData.cardType !== secondCardData.cardType) {
        return false;
    }

    if (firstCardData.cardType === "character") {
        return Number(firstCardData.slotIndex) === Number(secondCardData.slotIndex);
    }

    return true;
}

function getBoardActionButtonContainerFromData(boardCardData) {
    if (!boardCardData) return null;

    if (boardCardData.cardType === "leader") {
        const leaderElement = document.querySelector(
            `.board-leader-card[data-player="${boardCardData.playerKey}"]`
        );

        return leaderElement?.closest(".leader-area") ?? null;
    }

    if (boardCardData.cardType === "character") {
        const characterElement = document.querySelector(
            `.board-character-card[data-player="${boardCardData.playerKey}"][data-character-slot="${boardCardData.slotIndex}"]`
        );

        return characterElement?.closest(".character-slot") ?? null;
    }

    if (boardCardData.cardType === "stage") {
        const stageElement = document.querySelector(
            `.board-stage-card[data-player="${boardCardData.playerKey}"]`
        );

        return stageElement?.closest(".stage-area") ?? null;
    }

    return null;
}

function powerLine(label, amount) {
    return {
        label,
        amount: Number(amount || 0)
    };
}

function getPowerBreakdown(card, player, boardCardData = null) {
    const lines = [powerLine("Printed/Base power", getPrintedPower(card))];
    const addLine = (label, amount) => {
        const value = Number(amount || 0);

        if (value !== 0) {
            lines.push(powerLine(label, value));
        }
    };

    addLine("Your Turn effects", getYourTurnPowerBonus(card, player));
    addLine("Stage/field effects", getTurboGrannyFormPowerModifier(card, player));
    addLine("Serpico/Farnese effects", getSerpicoFarnesePowerModifier(card, player));
    addLine("Guts leader effects", getGutsLeaderPowerModifier(card, player));
    addLine("Rimuru leader effects", getRimuruTempestPowerModifier(card, player));
    addLine("Opponent's Turn effects", getOpponentTurnPowerModifier(card, player));
    addLine("Attached DON!!", getAttachedDonPowerModifier(card, player));
    addLine("DON!! condition effects", getST01PowerModifier(card, player));
    addLine("Temporary power", getTemporaryPowerModifier(card));
    addLine("Duration power", getDurationPowerModifier(card));
    addLine("Token attached power", getTokenAttachedPowerModifier(card));
    addLine("Battle counter power", getBattlePowerModifier(card));
    addLine("Current attack bonus", getCurrentAttackTargetPowerBonus(boardCardData));

    const total = lines.reduce((sum, line) => sum + line.amount, 0);

    return { lines, total };
}

function showPowerBreakdown(card, player, boardCardData = null) {
    if (!card || !player) return;

    document.getElementById("powerBreakdownOverlay")?.remove();

    const breakdown = getPowerBreakdown(card, player, boardCardData);
    const overlay = document.createElement("div");
    overlay.className = "look-top-overlay";
    overlay.id = "powerBreakdownOverlay";

    const popup = document.createElement("div");
    popup.className = "look-top-popup power-breakdown-popup";

    const title = document.createElement("h2");
    title.textContent = `${card.name} Power`;

    const list = document.createElement("div");
    list.className = "power-breakdown-list";

    breakdown.lines.forEach(line => {
        const row = document.createElement("div");
        row.className = "power-breakdown-row";

        const label = document.createElement("span");
        label.textContent = line.label;

        const value = document.createElement("strong");
        value.textContent = line.amount > 0 && line.label !== "Printed/Base power"
            ? `+${line.amount}`
            : String(line.amount);

        row.append(label, value);
        list.appendChild(row);
    });

    const total = document.createElement("div");
    total.className = "power-breakdown-total";
    total.innerHTML = `<span>Total</span><strong>${breakdown.total}</strong>`;

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => overlay.remove());

    popup.append(title, list, total, close);
    overlay.appendChild(popup);
    overlay.addEventListener("click", event => {
        if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
}

// =========================
// General Helpers
// =========================

function rollD20() {
    return Math.floor(Math.random() * 20) + 1;
}

// =========================
// Stub Functions (Game Mechanics Removed)
// =========================
// These functions are called by other code but do nothing since game mechanics are disabled.

function clearAttackTargets() {}
function clearBattleControls() {}
function clearAttackArrow() {}
function drawAttackArrow() {}
function createPhaseLogProxy() { return { get innerHTML() { return ""; }, set innerHTML(v) {} }; }
function setupPhaseControls() {}
function updatePhaseButtonPassState() {}
function createTurnOrderButtons() {}
function createMulliganButtons() {}
function setupAttackTargetSelection() {}
function enterAttackTargetSelection() {}
function beginAttack() {}
function createBattleButton() { return document.createElement("button"); }
function showResolveAttackButton() {}
function showCounterPhaseControls() {}
function canCurrentPlayerAttack() { return false; }
function isCharacterAttackLocked() { return false; }
function getCardBattlePower() { return 0; }
function getActivateMainEffect() { return null; }
function createActivateMainButton() { return document.createElement("button"); }
function canUseActivateMainEffect() { return false; }
function resolveWhenAttackingEffectsBeforeBattle() {}
function promptOptionalWhenAttackingEffects() {}
function promptOnOpponentAttackCharacterEffects() {}
function promptTrashOneCardForAttack() {}
function markAttackEffectSkipped() {}
// This board is fully manual - there is no automatic card-effect engine - so
// end-of-turn resolution has nothing to do. It still has to EXIST though:
// handleOnlinePassTurn called it on every End Turn, and an undefined function
// there threw "resolveEndOfTurnEffects is not defined" and aborted the turn
// pass, which is why ending a turn online failed outright.
function resolveEndOfTurnEffects() { return []; }
function isAttackEffectSkipped() { return false; }
function clearBattleOnlyEffectsForCurrentAttack() {}
function setCombatNextPhaseButton() {}
function isCurrentAttackingCard() { return false; }
function concludeAttackBecauseAttackerLeft() { return false; }
function applyCounterPowerToCurrentAttack() {}
function createSkipBlockButton() { return document.createElement("button"); }
function showWaitingForOnlineDefenderEffects() {}
function maybeRunOnlineDefenderAttackEffects() { return false; }
function showOnlineAttackLog() {}
function applyOnlineCurrentAttack() {}
function renderOnlineAttackControls() {}

// The only turn control on this page is the sidebar's "Next Turn" button. In an
// online match the turn is shared state owned by the match document, so the
// button has to be locked while it is the opponent's turn - otherwise both
// players can advance independently and each ends up with their own turn
// counter and DON!! progression. Called from every place the online state is
// applied, so it always reflects the live pointer.
function updateOnlinePhaseButton() {
    const button = document.getElementById("nextTurnBtn");
    const phaseDisplay = document.getElementById("phaseDisplay");
    const concedeButton = document.getElementById("concedeBtn");

    // Conceding only means anything against a real opponent.
    concedeButton?.classList.toggle("hidden", !isOnlineMatch);

    if (!isOnlineMatch) {
        if (button) {
            button.disabled = false;
            button.title = "";
            button.classList.remove("not-your-turn");
        }
        return;
    }

    const yourTurn = isCurrentOnlinePlayer();
    const connecting = !onlinePublicState?.currentPlayer;

    if (button) {
        button.disabled = connecting || !yourTurn;
        button.classList.toggle("not-your-turn", !yourTurn);
        button.textContent = yourTurn ? "End Turn" : "Opponent's Turn";
        button.title = connecting
            ? "Waiting for the match to start."
            : (yourTurn ? "End your turn" : "You can only end the turn on your own turn.");
    }

    if (phaseDisplay) {
        phaseDisplay.textContent = connecting
            ? "Waiting…"
            : (yourTurn ? "Your Turn" : "Opponent's Turn");
    }
}
