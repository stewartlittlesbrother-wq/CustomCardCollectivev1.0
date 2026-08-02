import {
    ref,
    set,
    get,
    update,
    remove,
    push,
    query,
    limitToLast,
    onValue,
    onDisconnect,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import { database } from "./firebaseApp.js";

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanRoomCode(roomCode) {
    return String(roomCode || "").trim().toUpperCase();
}

function cloneData(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

// Card artwork is stored as a base64 data URL on custom cards (~88KB each), which
// made a single match document several megabytes and every sync painfully slow.
// Never send artwork over the wire - strip it before writing and rebuild it from
// the local card database on read (see hydrateSyncedCard).
export function stripCardForSync(card) {
    if (!card || typeof card !== "object") return card;

    const slim = { ...card };
    // Only base64 data URLs are too large to transmit (~88KB each). A plain
    // image URL is a few dozen bytes, so keep it - that way a custom card still
    // renders for an opponent whose local card pool doesn't contain it.
    if (typeof slim.image === "string" && slim.image.startsWith("data:")) {
        delete slim.image;
    }
    // Same for a base64 alt art - rebuilt from the local DB by hydrateSyncedCard.
    if (typeof slim.altArt === "string" && slim.altArt.startsWith("data:")) {
        delete slim.altArt;
    }
    delete slim.effects;
    delete slim.aliases;

    // Firebase rejects any write that contains `undefined` ANYWHERE - a single
    // undefined property aborts the whole match update ("values argument
    // contains undefined in property …"). Custom cards can carry undefined
    // fields (e.g. copyLimit on a card saved before that option existed), so
    // drop every undefined key here rather than hunting them one at a time.
    Object.keys(slim).forEach(key => {
        if (slim[key] === undefined) delete slim[key];
    });

    return slim;
}

export function stripCardsForSync(cards) {
    if (!Array.isArray(cards)) return cards;
    return cards.map(card => (card ? stripCardForSync(card) : card));
}

// Restore the artwork (and any other heavy fields) from the locally loaded card
// database so rendering is unchanged despite the slim network payload.
export function hydrateSyncedCard(card) {
    if (!card || typeof card !== "object") return card;
    // Fast path: image present AND alt art not stripped (undefined) - nothing to
    // rebuild. A stripped base64 alt art comes back as undefined and needs the DB.
    if (card.image && card.altArt !== undefined) return card;

    const key = card.cardNumber || card.id;

    // Leaders live in their own map and are not covered by getCardById. Check
    // the leaders map FIRST for leader cards - getCardById logs a console error
    // for every miss, and hydration runs on every state update.
    const leaders = globalThis.leaders || {};
    let lookup = leaders[key] ||
        Object.values(leaders).find(leader =>
            leader?.cardNumber === key || leader?.id === key) ||
        null;

    // Read the card map directly first - getCardById logs a console error on
    // every miss, and hydration runs on every state update.
    if (!lookup) {
        lookup = (globalThis.cardDatabase || {})[key] || null;
    }
    if (!lookup && typeof globalThis.getCardById === "function") {
        lookup = globalThis.getCardById(key);
    }

    if (!lookup) return card;

    return {
        ...card,
        image: lookup.image || card.image,
        altArt: card.altArt || lookup.altArt || "",
        effects: card.effects || lookup.effects || [],
        aliases: card.aliases || lookup.aliases || []
    };
}

export function hydrateSyncedCards(cards) {
    if (!Array.isArray(cards)) return cards;
    return cards.map(card => (card ? hydrateSyncedCard(card) : card));
}

function createMultiplayerCard(card) {
    return {
        ...stripCardForSync(cloneData(card)),
        keywords: card.keywords ? [...card.keywords] : [],
        instanceId: crypto.randomUUID(),
        state: card.state || "active",
        attachedDon: Number(card.attachedDon || 0)
    };
}

function requireDeckTools() {
    if (
        typeof globalThis.getCardById !== "function" ||
        typeof globalThis.parseDeckText !== "function" ||
        typeof globalThis.shuffleDeck !== "function" ||
        !globalThis.leaders
    ) {
        throw new Error("Card database and deck parser must be loaded before initializing multiplayer.");
    }
}

function createInitialPrivateState(selectedDeck) {
    requireDeckTools();

    // Saved decks store a custom leader id, which may not be a key in the
    // `leaders` map (that's keyed by the built-in leader set). Fall back to a
    // direct card lookup, then to a case-insensitive scan, so a custom leader
    // never hard-fails match start and strands both players in the lobby.
    const leaderKey = selectedDeck.leaderKey;
    let leaderDefinition = globalThis.leaders[leaderKey];

    if (!leaderDefinition && typeof globalThis.getCardById === "function") {
        leaderDefinition = globalThis.getCardById(leaderKey);
    }

    if (!leaderDefinition) {
        const wanted = String(leaderKey || "").toLowerCase();
        const match = Object.entries(globalThis.leaders || {})
            .find(([key, value]) =>
                key.toLowerCase() === wanted ||
                String(value?.cardNumber || "").toLowerCase() === wanted ||
                String(value?.id || "").toLowerCase() === wanted);
        leaderDefinition = match?.[1];
    }

    if (!leaderDefinition) {
        throw new Error(
            `Leader "${leaderKey}" for deck "${selectedDeck.name}" was not found in the card database.`
        );
    }

    const deck = globalThis.shuffleDeck(globalThis.parseDeckText(selectedDeck.deckText))
        .map(card => createMultiplayerCard(card));
    const hand = deck.splice(0, 5);
    const leader = createMultiplayerCard(leaderDefinition);

    // Token TYPES the deck makes available. Resolved here so the board can show
    // the token zone without another database round-trip. Read the card map
    // directly - getCardById logs an error on every miss.
    const cardMap = globalThis.cardDatabase || {};
    const tokenTypes = (selectedDeck.tokens || [])
        .map(id => cardMap[id])
        .filter(Boolean)
        .map(card => createMultiplayerCard(card));

    const privateState = {
        selectedDeck,
        hand,
        deck,
        // Life starts EMPTY, matching the manual board: players deal their own
        // life from the top of the deck by dragging (the board is fully manual,
        // so auto-dealing here surprised players with pre-filled life).
        life: [],
        leader,
        stage: null,
        tokenTypes
    };

    applyStartingZangetsuStage(privateState);

    return privateState;
}

function applyStartingZangetsuStage(privateState) {
    if (privateState?.leader?.cardNumber !== "BL01-001") {
        return;
    }

    const zones = [
        { name: "deck", cards: privateState.deck || [] },
        { name: "hand", cards: privateState.hand || [] },
        { name: "life", cards: privateState.life || [] }
    ];
    let stageLocation = null;

    for (const zone of zones) {
        const index = zone.cards.findIndex(card => {
            return card.cardType === "stage" &&
                Number(card.cost || 0) === 1 &&
                (String(card.name || "").includes("Zangetsu") || String(card.type || "").includes("Zanpakto"));
        });

        if (index !== -1) {
            stageLocation = { zone, index };
            break;
        }
    }

    if (!stageLocation) {
        return;
    }

    const stage = stageLocation.zone.cards.splice(stageLocation.index, 1)[0];

    if (stageLocation.zone.name === "hand" && privateState.deck.length) {
        privateState.hand.push(privateState.deck.shift());
    }

    if (stageLocation.zone.name === "life" && privateState.deck.length) {
        privateState.life.push(privateState.deck.shift());
    }

    stage.state = "active";
    privateState.stage = stage;
}

function createPublicCardSnapshot(card) {
    if (!card) return null;

    // Deliberately no `image` - see stripCardForSync.
    return {
        name: card.name,
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

function createInitialPublicPlayerState(privateState) {
    // Board is a JSON string for the same lossless-round-trip reason as
    // createPublicPlayerStateFromLocal in self.js - Firebase mangles arrays.
    const board = {
        leader: stripCardForSync(privateState.leader || null),
        characters: [],
        stage: stripCardForSync(privateState.stage || null),
        trash: [],
        extraFaceUp: [],
        extraFaceDown: [],
        tokens: [],
        tokenTypes: (privateState.tokenTypes || []).map(stripCardForSync),
        floatingDon: [],
        don: 0,
        restedDon: 0
    };

    return {
        boardJson: JSON.stringify(board),
        handCount: privateState.hand.length,
        deckCount: privateState.deck.length,
        lifeCount: privateState.life.length,
        faceUpLifeCards: privateState.life
            .map((card, index) => card?.faceUp ? { index, card: createPublicCardSnapshot(card) } : null)
            .filter(Boolean),
        activeTokens: 0,
        restedTokens: 0,
        tokenDeckCount: 10,
        turns: 0
    };
}

function shuffleCards(cards) {
    const shuffled = [...cards];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const randomIndex = Math.floor(Math.random() * (i + 1));

        [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
    }

    return shuffled;
}

export async function createRoom(user, opts = {}) {
    console.log("createRoom() called with user:", user, "opts:", opts);

    if (!user) {
        throw new Error("No user found. Guest login did not finish.");
    }

    const roomCode = generateRoomCode();
    const nickname = opts.nickname || "Player 1";
    const isPublic = Boolean(opts.isPublic);
    const lobbyName = opts.lobbyName || (nickname + "'s Game");

    console.log("Generated room code:", roomCode);

    const matchRef = ref(database, `matches/${roomCode}`);

    await set(matchRef, {
        status: "waiting",
        createdAt: serverTimestamp(),
        hostUid: user.uid,
        isPublic,
        lobbyName,

        players: {
            p1: {
                uid: user.uid,
                name: nickname,
                connected: true,
                ready: false
            }
        },

        public: {
            phase: "waiting",
            currentPlayer: null,
            turnNumber: 0,
            winner: null,
            player1: null,
            player2: null
        },

        private: {
            [user.uid]: {
                selectedDeck: null,
                hand: [],
                deck: [],
                life: []
            }
        }
    });

    // Rooms are private and joined by code. The public /lobbies listing was
    // removed - the database rules denied it and it was never usable.
    console.log("Firebase set() finished.");
    return { roomCode, publicListingFailed: false };
}

export async function joinRoom(roomCode, user, nickname = "Player 2") {
    const code = roomCode.trim().toUpperCase();
    const matchRef = ref(database, `matches/${code}`);

    const snapshot = await get(matchRef);

    if (!snapshot.exists()) {
        throw new Error("Room does not exist.");
    }

    const match = snapshot.val();

    if (match.players?.p2 && match.players.p2.uid !== user.uid) {
        throw new Error("Room is already full.");
    }

    await update(matchRef, {
        status: "ready",

        "players/p2": {
            uid: user.uid,
            name: nickname,
            connected: true,
            ready: false
        },

        [`private/${user.uid}`]: {
            selectedDeck: null,
            hand: [],
            deck: [],
            life: []
        }
    });

    return code;
}

// The lobby only needs the handful of fields below. Subscribing to the whole
// match node pulled every card in both players' private state on every update
// (megabytes), which is a large part of why online play felt so slow.
export function subscribeToMatch(roomCode, callback) {
    const code = cleanRoomCode(roomCode);
    const paths = ["status", "players", "isPublic", "lobbyName", "startError"];
    const latest = {};
    const unsubscribers = [];

    paths.forEach(path => {
        const unsubscribe = onValue(ref(database, `matches/${code}/${path}`), (snapshot) => {
            latest[path] = snapshot.val();
            // A room always has a status once created; until then treat as absent.
            callback(latest.status == null && latest.players == null ? null : { ...latest });
        });
        unsubscribers.push(unsubscribe);
    });

    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

export function subscribeToPublicState(roomCode, callback) {
    const publicRef = ref(database, `matches/${cleanRoomCode(roomCode)}/public`);

    return onValue(publicRef, (snapshot) => {
        callback(snapshot.val());
    });
}

export function subscribeToPrivateState(roomCode, uid, callback) {
    const privateRef = ref(database, `matches/${cleanRoomCode(roomCode)}/private/${uid}`);

    return onValue(privateRef, (snapshot) => {
        callback(snapshot.val());
    });
}

export async function getMatch(roomCode) {
    const matchRef = ref(database, `matches/${cleanRoomCode(roomCode)}`);
    const snapshot = await get(matchRef);

    return snapshot.val();
}

export async function updatePublicState(roomCode, partialState) {
    const publicRef = ref(database, `matches/${cleanRoomCode(roomCode)}/public`);

    await update(publicRef, partialState);
}

export async function updatePrivateState(roomCode, uid, partialState) {
    const privateRef = ref(database, `matches/${cleanRoomCode(roomCode)}/private/${uid}`);

    await update(privateRef, partialState);
}

export async function setPlayerDeck(roomCode, playerSlot, deckData) {
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}/players/${playerSlot}`), {
        deck: deckData
    });
}

// ── In-match chat ────────────────────────────────────────
// Messages live under the match so both clients get them in realtime and they
// disappear with the room. Kept deliberately small (sender/text/at).
export async function sendChatMessage(roomCode, sender, text) {
    const message = String(text || "").trim();
    if (!message) return;

    const chatRef = ref(database, `matches/${cleanRoomCode(roomCode)}/chat`);
    await push(chatRef, {
        sender: String(sender || "Player").slice(0, 24),
        text: message.slice(0, 300),
        at: Date.now()
    });
}

export function subscribeToChat(roomCode, callback) {
    const chatRef = query(
        ref(database, `matches/${cleanRoomCode(roomCode)}/chat`),
        limitToLast(50)
    );

    return onValue(chatRef, (snapshot) => {
        const data = snapshot.val() || {};
        const messages = Object.entries(data)
            .map(([id, value]) => ({ id, ...value }))
            .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
        callback(messages);
    });
}

export async function clearMatchStartError(roomCode) {
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}`), { startError: null });
}

export async function setPlayerReady(roomCode, playerSlot, ready) {
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}`), {
        [`players/${playerSlot}/ready`]: Boolean(ready)
    });
}

export async function initializeMultiplayerGame(roomCode) {
    const matchRef = ref(database, `matches/${cleanRoomCode(roomCode)}`);
    const snapshot = await get(matchRef);

    if (!snapshot.exists()) {
        throw new Error("Room does not exist.");
    }

    const match = snapshot.val();

    // Idempotent: the host's auto-start can fire on several match updates before
    // the "started" status propagates back. Re-running the setup would reshuffle
    // decks and rewrite both players' private state mid-game, so bail out if the
    // match is already going.
    if (match.status === "started") {
        return;
    }

    const player1 = match.players?.p1;
    const player2 = match.players?.p2;

    if (!player1 || !player2) {
        throw new Error("Both players must be connected.");
    }

    if (!player1.ready || !player2.ready) {
        throw new Error("Both players must be ready before starting.");
    }

    const player1Deck = match.players?.p1?.deck;
    const player2Deck = match.players?.p2?.deck;

    if (!player1Deck || !player2Deck) {
        throw new Error("Both players must choose decks before starting.");
    }

    await update(matchRef, buildFreshMatchPayload(player1, player2, player1Deck, player2Deck));
}

// The full "deal a brand new game" write. Shared by the first start and by a
// rematch so the two can never drift apart. On a rematch, `rematchLoser` (the
// player who lost the last game) is pre-set as the dice "winner" so THEY get to
// choose who goes first - no dice roll needed.
function buildFreshMatchPayload(player1, player2, player1Deck, player2Deck, rematchLoser = null) {
    const p1Private = createInitialPrivateState(player1Deck);
    const p2Private = createInitialPrivateState(player2Deck);

    const chooser = (rematchLoser === "p1" || rematchLoser === "p2") ? rematchLoser : null;
    const diceSetup = chooser
        // Pre-resolved: the loser is the "winner" (chooser). rematchLoser flags
        // the client to show rematch wording instead of dice results.
        ? { p1Roll: null, p2Roll: null, winner: chooser, tie: false, rematchLoser: chooser }
        : { p1Roll: null, p2Roll: null, winner: null, tie: false };

    return {
        status: "started",
        "public/phase": "diceRoll",
        "public/currentPlayer": null,
        "public/turnNumber": 0,
        "public/winner": null,
        "public/gameOverReasonTitle": null,
        "public/gameOverReasonText": null,
        "public/firstPlayer": null,
        "public/secondPlayer": null,
        "public/playerTurns": {
            p1: 0,
            p2: 0
        },
        "public/revealedCards": [],
        "public/currentAttack": null,
        "public/setup": {
            dice: diceSetup,
            turnChoice: {
                chooser: null,
                firstPlayer: null,
                secondPlayer: null
            },
            mulligan: {
                p1: {
                    done: false,
                    took: false
                },
                p2: {
                    done: false,
                    took: false
                }
            }
        },
        "public/player1": {
            ...createInitialPublicPlayerState(p1Private)
        },
        "public/player2": createInitialPublicPlayerState(p2Private),
        [`private/${player1.uid}`]: p1Private,
        [`private/${player2.uid}`]: p2Private
    };
}

// ── Rematch ──────────────────────────────────────────────
// After a game ends both players can ready up on the game-over screen (and swap
// decks first). The match document holds each side's readiness so both screens
// show the same indicators; when both are ready one client re-deals.

export async function setRematchReady(roomCode, playerSlot, ready, deck = null) {
    if (playerSlot !== "p1" && playerSlot !== "p2") {
        throw new Error("Invalid player slot.");
    }

    const code = cleanRoomCode(roomCode);
    const updates = {
        [`rematch/${playerSlot}/ready`]: Boolean(ready),
        [`rematch/${playerSlot}/at`]: serverTimestamp()
    };

    // A deck swap also updates the lobby selection, so the re-deal picks it up.
    if (deck) {
        updates[`rematch/${playerSlot}/deck`] = deck;
        updates[`players/${playerSlot}/deck`] = deck;
    }

    await update(ref(database, `matches/${code}`), updates);
}

export function subscribeToRematch(roomCode, callback) {
    const rematchRef = ref(database, `matches/${cleanRoomCode(roomCode)}/rematch`);
    return onValue(rematchRef, (snapshot) => callback(snapshot.val() || {}));
}

// Re-deal the match. Guarded by a transaction on rematch/startedAt so that when
// both clients notice "both ready" at the same moment only one actually deals -
// otherwise the decks would be shuffled twice and the two sides would disagree.
export async function restartMatch(roomCode) {
    const code = cleanRoomCode(roomCode);
    const matchRef = ref(database, `matches/${code}`);

    const snapshot = await get(matchRef);
    const match = snapshot.val();

    if (!match) throw new Error("Match not found.");

    const player1 = match.players?.p1;
    const player2 = match.players?.p2;

    if (!player1 || !player2) throw new Error("Both players must be connected.");

    // A rematch deck choice wins over the one used last game.
    const player1Deck = match.rematch?.p1?.deck || player1.deck;
    const player2Deck = match.rematch?.p2?.deck || player2.deck;

    if (!player1Deck || !player2Deck) {
        throw new Error("Both players must have a deck selected.");
    }

    if (!match.rematch?.p1?.ready || !match.rematch?.p2?.ready) {
        return { committed: false };
    }

    // Claim the re-deal; the loser of this race simply waits for the new state.
    const claim = await runTransaction(
        ref(database, `matches/${code}/rematch/startedAt`),
        (current) => (current ? undefined : Date.now())
    );

    if (!claim.committed) return { committed: false };

    // The loser of the game that just ended chooses turn order for the rematch.
    const prevWinner = match.public?.winner;
    const rematchLoser = prevWinner === "p1" ? "p2" : (prevWinner === "p2" ? "p1" : null);

    await update(matchRef, {
        ...buildFreshMatchPayload(player1, player2, player1Deck, player2Deck, rematchLoser),
        // Clear readiness so the next game-over starts from a clean slate.
        rematch: null
    });

    return { committed: true };
}

export async function updateCurrentAttack(roomCode, attackState) {
    await updatePublicState(roomCode, attackState
        ? {
            currentAttack: attackState,
            phase: "attackResolving"
        }
        : {
            currentAttack: null
        });
}

export async function applyMultiplayerLifeDamage(roomCode, defenderSlot, attackerSlot, amount, options = {}) {
    if (defenderSlot !== "p1" && defenderSlot !== "p2") {
        throw new Error("Invalid defender slot.");
    }

    const matchRef = ref(database, `matches/${cleanRoomCode(roomCode)}`);
    const snapshot = await get(matchRef);

    if (!snapshot.exists()) {
        throw new Error("Room does not exist.");
    }

    const match = snapshot.val();
    const defender = match.players?.[defenderSlot];

    if (!defender?.uid) {
        throw new Error("Defender was not found.");
    }

    const privateState = match.private?.[defender.uid] || {};
    const publicKey = defenderSlot === "p1" ? "player1" : "player2";
    const life = [...(privateState.life || [])];
    // Clear any prior "from Life" highlight - only the newest life grab is marked.
    const hand = [...(privateState.hand || [])].map(card =>
        card && card.fromLife ? { ...card, fromLife: false } : card);
    const publicPlayer = match.public?.[publicKey] || {};
    const trash = [...(publicPlayer.trash || [])];
    let moved = 0;

    for (let i = 0; i < Number(amount || 0); i++) {
        const lifeCard = life.shift();

        if (!lifeCard) break;

        if (options.banish) {
            trash.push(lifeCard);
        } else {
            // Mark it so both players see it highlighted in hand until played or
            // the owner's turn ends.
            hand.push({ ...lifeCard, fromLife: true });
        }

        moved++;
    }

    const updates = {
        [`private/${defender.uid}/life`]: life,
        [`private/${defender.uid}/hand`]: hand,
        [`public/${publicKey}/lifeCount`]: life.length,
        [`public/${publicKey}/faceUpLifeCards`]: life
            .map((card, index) => card?.faceUp ? { index, card: createPublicCardSnapshot(card) } : null)
            .filter(Boolean),
        [`public/${publicKey}/handCount`]: hand.length,
        [`public/${publicKey}/lifeTriggerCount`]: hand.filter(card => card?.fromLife).length,
        "public/currentAttack": null
    };

    if (options.banish) {
        updates[`public/${publicKey}/trash`] = trash;
    }

    if (moved === 0 && attackerSlot) {
        updates["public/winner"] = attackerSlot;
        updates["public/phase"] = "gameOver";
        updates["public/gameOverReasonTitle"] = "Final Attack";
        updates["public/gameOverReasonText"] = "A player had no life cards left and took a successful leader attack.";
    }

    await update(matchRef, updates);

    return {
        moved,
        remainingLife: life.length
    };
}

export async function rollMultiplayerDice(roomCode, playerSlot) {
    if (playerSlot !== "p1" && playerSlot !== "p2") {
        throw new Error("Invalid player slot.");
    }

    const diceRef = ref(database, `matches/${cleanRoomCode(roomCode)}/public/setup/dice`);
    const roll = Math.floor(Math.random() * 12) + 1;

    return runTransaction(diceRef, (dice = {}) => {
        const ownKey = `${playerSlot}Roll`;
        const otherKey = playerSlot === "p1" ? "p2Roll" : "p1Roll";

        if (dice.winner && !dice.tie) {
            return;
        }

        if (dice[ownKey] && !dice.tie) {
            return;
        }

        const nextDice = dice.tie
            ? { p1Roll: null, p2Roll: null, winner: null, tie: false }
            : { ...dice };

        nextDice[ownKey] = roll;

        if (nextDice[otherKey]) {
            if (nextDice.p1Roll === nextDice.p2Roll) {
                nextDice.tie = true;
                nextDice.winner = null;
            } else {
                nextDice.tie = false;
                nextDice.winner = nextDice.p1Roll > nextDice.p2Roll ? "p1" : "p2";
            }
        }

        return nextDice;
    });
}

export async function chooseMultiplayerTurnOrder(roomCode, chooserSlot, choice) {
    if (chooserSlot !== "p1" && chooserSlot !== "p2") {
        throw new Error("Invalid player slot.");
    }

    if (choice !== "first" && choice !== "second") {
        throw new Error("Invalid turn choice.");
    }

    const publicRef = ref(database, `matches/${cleanRoomCode(roomCode)}/public`);

    return runTransaction(publicRef, (publicState) => {
        const diceWinner = publicState?.setup?.dice?.winner;

        if (!publicState || publicState.phase !== "diceRoll" || diceWinner !== chooserSlot) {
            return;
        }

        const otherSlot = chooserSlot === "p1" ? "p2" : "p1";
        const firstPlayer = choice === "first" ? chooserSlot : otherSlot;
        const secondPlayer = firstPlayer === "p1" ? "p2" : "p1";
        return {
            ...publicState,
            phase: "mulligan",
            currentPlayer: null,
            turnNumber: 0,
            firstPlayer,
            secondPlayer,
            playerTurns: {
                p1: 0,
                p2: 0
            },
            setup: {
                ...publicState.setup,
                turnChoice: {
                    chooser: chooserSlot,
                    firstPlayer,
                    secondPlayer
                }
            }
        };
    });
}

export async function setMultiplayerMulligan(roomCode, user, playerSlot, tookMulligan) {
    if (!user?.uid) {
        throw new Error("User is required for mulligan.");
    }

    if (playerSlot !== "p1" && playerSlot !== "p2") {
        throw new Error("Invalid player slot.");
    }

    const matchRef = ref(database, `matches/${cleanRoomCode(roomCode)}`);
    const snapshot = await get(matchRef);

    if (!snapshot.exists()) {
        throw new Error("Room does not exist.");
    }

    const match = snapshot.val();
    const publicState = match.public || {};
    const player = match.players?.[playerSlot];

    if (publicState.phase !== "mulligan") {
        throw new Error("Mulligan is not available right now.");
    }

    if (player?.uid !== user.uid) {
        throw new Error("Only your player slot can mulligan.");
    }

    if (publicState.setup?.mulligan?.[playerSlot]?.done) {
        throw new Error("Mulligan was already chosen.");
    }

    const privateState = match.private?.[user.uid] || {};
    let hand = privateState.hand || [];
    let deck = privateState.deck || [];

    if (tookMulligan) {
        deck = shuffleCards([...deck, ...hand]);
        hand = deck.splice(0, 5);
    }

    const publicPlayerKey = playerSlot === "p1" ? "player1" : "player2";
    const mulliganState = {
        ...(publicState.setup?.mulligan || {}),
        [playerSlot]: {
            done: true,
            took: Boolean(tookMulligan)
        }
    };
    const bothDone = Boolean(mulliganState.p1?.done && mulliganState.p2?.done);
    const updates = {
        [`private/${user.uid}/hand`]: hand,
        [`private/${user.uid}/deck`]: deck,
        [`public/${publicPlayerKey}/handCount`]: hand.length,
        [`public/${publicPlayerKey}/deckCount`]: deck.length,
        [`public/setup/mulligan/${playerSlot}`]: mulliganState[playerSlot]
    };

    if (bothDone) {
        const firstPlayer = publicState.firstPlayer || publicState.setup?.turnChoice?.firstPlayer || "p1";

        updates["public/phase"] = "main";
        updates["public/currentPlayer"] = firstPlayer;
        updates["public/turnNumber"] = 1;

        // Deliberately leave playerTurns/turns at 0 for the first player. Their
        // client runs the opening turn start itself (maybeRunOnlineTurnStart),
        // which is what actually grants the 1 DON!!, skips the turn-1 draw and
        // then stamps turns = 1. Pre-setting it to 1 here made that guard think
        // the turn had already been processed, so the player going first started
        // with an empty DON!! area.
        updates[`public/playerTurns/${firstPlayer}`] = 0;
    }

    await update(matchRef, updates);
}

export async function sendMultiplayerAction(roomCode, user, actionType, payload) {
    if (!user?.uid) {
        throw new Error("User is required for multiplayer actions.");
    }

    return applyMultiplayerAction(roomCode, user, actionType, payload);
}

export async function applyMultiplayerAction(roomCode, user, actionType, payload) {
    if (!user?.uid) {
        throw new Error("User is required for multiplayer actions.");
    }

    if (actionType === "updateState") {
        await Promise.all([
            updatePublicState(roomCode, payload.publicState),
            updatePrivateState(roomCode, user.uid, payload.privateState)
        ]);

        return;
    }

    if (actionType === "passTurn") {
        return passTurn(roomCode, payload.currentPlayer);
    }

    throw new Error(`Unsupported multiplayer action: ${actionType}`);
}

export async function passTurn(roomCode, currentPlayer) {
    if (currentPlayer !== "p1" && currentPlayer !== "p2") {
        throw new Error("Invalid current player.");
    }

    const publicRef = ref(database, `matches/${cleanRoomCode(roomCode)}/public`);

    return runTransaction(publicRef, (publicState) => {
        if (
            !publicState ||
            publicState.currentPlayer !== currentPlayer ||
            publicState.phase !== "main" ||
            publicState.currentAttack
        ) {
            return;
        }

        const nextPlayer = currentPlayer === "p1" ? "p2" : "p1";
        const currentTurnNumber = Number(publicState.turnNumber || 1);
        const secondPlayer = publicState.secondPlayer || "p2";
        const nextTurnNumber = currentPlayer === secondPlayer
            ? currentTurnNumber + 1
            : currentTurnNumber;

        return {
            ...publicState,
            currentPlayer: nextPlayer,
            phase: "main",
            currentAttack: null,
            turnNumber: nextTurnNumber,
            playerTurns: {
                ...(publicState.playerTurns || {})
            }
        };
    });
}

const START_CLAIM_STALE_MS = 8000;

// Atomically claim the right to initialise the match. Uses a timestamped claim
// rather than a "starting" status so a client that dies (or navigates away)
// mid-start can't deadlock the match - after START_CLAIM_STALE_MS anyone may
// reclaim and retry. Only one client wins at a time, so both players can safely
// attempt a start without double-initialising and reshuffling decks.
async function claimMatchStart(code) {
    const claimRef = ref(database, `matches/${code}/startClaim`);
    const result = await runTransaction(claimRef, (current) => {
        const now = Date.now();
        if (current?.at && (now - Number(current.at)) < START_CLAIM_STALE_MS) {
            return; // abort - another client is actively starting
        }
        return { at: now };
    });
    return Boolean(result.committed);
}

export async function startMatch(roomCode) {
    const code = cleanRoomCode(roomCode);

    const snapshot = await get(ref(database, `matches/${code}/status`));
    if (snapshot.val() === "started") return; // already running

    if (!(await claimMatchStart(code))) {
        return; // another client is mid-start
    }

    try {
        await initializeMultiplayerGame(code);
        // Release the claim and clear any previous failure so both clients unblock.
        await update(ref(database, `matches/${code}`), { startError: null, startClaim: null });
    } catch (error) {
        // Release the claim and publish the failure so BOTH players see why the
        // game didn't begin. Without this only the host got the error and the
        // other client sat on the Ready screen indefinitely.
        try {
            await update(ref(database, `matches/${code}`), {
                startClaim: null,
                startError: error?.message || "Failed to start the match."
            });
        } catch {
            // ignore - the thrown error below is still surfaced to the caller
        }
        throw error;
    }
}

// ── Presence / disconnect detection ──────────────────────
// Each player writes a heartbeat flag under the match. onDisconnect() arms a
// server-side write so that if the tab closes, the network drops, or the client
// crashes, Firebase itself flips the flag to offline - the OTHER player then
// gets a subscribeToPresence callback and can show a "they left" banner instead
// of waiting forever. We re-arm on every reconnect via .info/connected so a
// brief drop-and-return doesn't strand the flag as offline.
export function setupPresence(roomCode, playerSlot, user) {
    if ((playerSlot !== "p1" && playerSlot !== "p2") || !user?.uid) {
        return () => {};
    }

    const code = cleanRoomCode(roomCode);
    const presenceRef = ref(database, `matches/${code}/presence/${playerSlot}`);
    const connectedRef = ref(database, ".info/connected");

    const unsubscribe = onValue(connectedRef, (snapshot) => {
        if (snapshot.val() !== true) return;

        // Arm the server-side "offline" write FIRST so it is registered before we
        // announce ourselves online - otherwise a crash in the gap would leave us
        // marked online forever.
        onDisconnect(presenceRef)
            .set({ online: false, uid: user.uid, at: serverTimestamp() })
            .then(() => set(presenceRef, {
                online: true,
                uid: user.uid,
                at: serverTimestamp()
            }))
            .catch(() => {});
    });

    return () => {
        unsubscribe();
        // Cancel the armed disconnect and mark ourselves cleanly offline on a
        // normal teardown (e.g. navigating back to the lobby).
        onDisconnect(presenceRef).cancel().catch(() => {});
        set(presenceRef, { online: false, uid: user.uid, at: serverTimestamp() }).catch(() => {});
    };
}

export function subscribeToPresence(roomCode, callback) {
    const presenceRef = ref(database, `matches/${cleanRoomCode(roomCode)}/presence`);
    return onValue(presenceRef, (snapshot) => callback(snapshot.val() || {}));
}

// ── Active-games registry (spectating) ───────────────────
// A lightweight public list of in-progress games so anyone can find and watch
// them. The registry only holds enough to render the list (player names, phase,
// turn); a spectator reads the live board straight from the match's /public
// node. Entries carry a server timestamp so the list can hide games that went
// stale (both players gone) without needing perfect cleanup.
export async function registerActiveGame(roomCode, meta = {}) {
    const code = cleanRoomCode(roomCode);

    // Names come from the match itself so either player can register the entry
    // with the same result (no need to pass both nicknames from the client).
    let p1Name = meta.p1Name;
    let p2Name = meta.p2Name;
    if (!p1Name || !p2Name) {
        try {
            const playersSnap = await get(ref(database, `matches/${code}/players`));
            const players = playersSnap.val() || {};
            p1Name = p1Name || players.p1?.name;
            p2Name = p2Name || players.p2?.name;
        } catch {
            // fall back to defaults below
        }
    }

    await set(ref(database, `activeGames/${code}`), {
        roomCode: code,
        p1Name: String(p1Name || "Player 1").slice(0, 24),
        p2Name: String(p2Name || "Player 2").slice(0, 24),
        phase: meta.phase || "main",
        turnNumber: Number(meta.turnNumber || 0),
        status: meta.status || "started",
        updatedAt: serverTimestamp()
    });
}

export async function touchActiveGame(roomCode, meta = {}) {
    const code = cleanRoomCode(roomCode);
    const updates = { updatedAt: serverTimestamp() };
    if (meta.phase !== undefined) updates.phase = meta.phase;
    if (meta.turnNumber !== undefined) updates.turnNumber = Number(meta.turnNumber || 0);
    if (meta.status !== undefined) updates.status = meta.status;
    try {
        await update(ref(database, `activeGames/${code}`), updates);
    } catch {
        // A touch failing (e.g. the entry was already removed) is not fatal.
    }
}

export async function removeActiveGame(roomCode) {
    try {
        await remove(ref(database, `activeGames/${cleanRoomCode(roomCode)}`));
    } catch {
        // ignore - best effort cleanup
    }
}

// Games older than this with no update are treated as abandoned and hidden from
// the spectate list. A live game touches its entry on every turn, so this only
// ever culls games whose players both vanished.
const ACTIVE_GAME_STALE_MS = 6 * 60 * 1000;

export function subscribeToActiveGames(callback, onError) {
    const gamesRef = ref(database, "activeGames");
    return onValue(gamesRef, (snapshot) => {
        const data = snapshot.val() || {};
        const now = Date.now();
        const games = Object.entries(data)
            .map(([code, value]) => ({ roomCode: code, ...value }))
            .filter(game => {
                const updated = Number(game.updatedAt || 0);
                // serverTimestamp resolves to a number once written; keep entries
                // without a resolved timestamp (just-created) too.
                return !updated || (now - updated) < ACTIVE_GAME_STALE_MS;
            })
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        callback(games);
    }, (error) => {
        // The most common cause is the /activeGames rule not being published yet
        // (Firebase denies reads by default). Surface it so the spectate list can
        // explain the empty state instead of looking broken.
        console.warn("Active games listener failed:", error);
        if (typeof onError === "function") onError(error);
    });
}
