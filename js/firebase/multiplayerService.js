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

// For transactions that move the game along (dice, turn order, mulligan, turn
// pass, re-deal): don't show the result on this screen until the server has
// accepted it. By default Firebase shows it straight away - so this page would
// react to, say, "the game has started" (beginning your turn and saving your
// board), and that save cancelled the transaction still in flight. The choice
// was then lost and the game sat on the mulligan screen.
const SERVER_CONFIRMED = { applyLocally: false };

// Firebase's estimate of (server clock - this device's clock), so every player's
// turn timer counts from the same moment even if their clocks disagree.
let serverTimeOffset = 0;
try {
    onValue(ref(database, ".info/serverTimeOffset"), (snapshot) => {
        serverTimeOffset = Number(snapshot.val()) || 0;
    });
} catch (_) { /* fall back to this device's clock */ }

export function serverNow() {
    return Date.now() + serverTimeOffset;
}

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
// This device's chosen alt-art index for a card number (the deck-builder pick).
// A legacy boolean `true` means "the one alt art" = index 1. Runs on the card
// OWNER's device, so the choice can travel with the card to the opponent.
const ALT_ART_PREFS_KEY = "custom-cards-alt-art-prefs-v1";
function ownAltArtIndex(cardNumber) {
    if (!cardNumber) return 0;
    try {
        const prefs = JSON.parse(localStorage.getItem(ALT_ART_PREFS_KEY) || "{}") || {};
        const raw = prefs[cardNumber];
        const idx = raw === true ? 1 : Number(raw) || 0;
        return Number.isInteger(idx) && idx > 0 ? idx : 0;
    } catch { return 0; }
}

// A snapshot of THIS device's alt-art picks, sent with the player's deck. Whoever
// deals the game (the host, or whichever browser re-deals on "Play again") may be the
// OTHER player, so the dealer must use each player's own picks - never its own.
// Keys are made Firebase-safe; only real alts (index > 0) are listed.
const artPrefKey = (value) => String(value).replace(/[.#$/\[\]]/g, "-");

export function snapshotOwnArtPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(ALT_ART_PREFS_KEY) || "{}") || {};
        const out = {};
        let count = 0;
        for (const [key, raw] of Object.entries(prefs)) {
            const idx = raw === true ? 1 : Number(raw) || 0;
            if (key && Number.isInteger(idx) && idx > 0 && count < 400) {
                out[artPrefKey(key)] = idx;
                count++;
            }
        }
        return out;
    } catch { return {}; }
}

function artIndexFromPrefs(prefs, cardNumber) {
    if (!prefs || !cardNumber) return 0;
    const idx = Number(prefs[artPrefKey(cardNumber)]) || 0;
    return Number.isInteger(idx) && idx > 0 ? idx : 0;
}

// options.keepArtIndex: keep the art index already on the card (the dealer building
// the OTHER player's board) instead of re-reading this device's own picks.
export function stripCardForSync(card, options) {
    if (!card || typeof card !== "object") return card;

    const slim = { ...card };

    // Carry the OWNER'S chosen art so BOTH players see the art the owner picked,
    // just like playing an alt-art card in real life. Send it ALWAYS (even the
    // default 0). Previously 0 was omitted, which made the viewing client fall
    // back to ITS OWN local alt-art preference for this card - so if you had alts
    // on, every opponent card looked like YOUR alt. An explicit 0 means "owner
    // chose the default art", so the viewer never substitutes their own pick.
    const keepArt = Boolean(options && typeof options === "object" && options.keepArtIndex)
        && Number.isInteger(card.artIndex);
    slim.artIndex = keepArt ? card.artIndex : ownAltArtIndex(card.cardNumber || card.id);
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
    // The alt-art LIST can hold several big base64 images. Never send it - the
    // opponent rebuilds it from their own copy of the card (by number) and then
    // applies artIndex, so they see the exact art you chose.
    delete slim.altArts;
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
    // Fast path: image, single alt art AND the alt-art list all present - nothing
    // to rebuild. Any of them stripped (undefined) means we need the local DB.
    if (card.image && card.altArt !== undefined && card.altArts !== undefined) return card;

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

    if (!lookup) {
        // Not loaded yet (the board only loads the two decks up front - e.g. your
        // opponent added this from outside of play): fetch just this card, and the
        // board refreshes it once it arrives.
        if (key && typeof globalThis.requestGameCards === "function") globalThis.requestGameCards([key]);
        return card;
    }

    return {
        ...card,
        image: lookup.image || card.image,
        altArt: card.altArt || lookup.altArt || "",
        // Rebuild the alt-art list from the local card so the carried artIndex
        // resolves to the same art the owner picked.
        altArts: (Array.isArray(card.altArts) && card.altArts.length)
            ? card.altArts
            : (Array.isArray(lookup.altArts) ? lookup.altArts : []),
        effects: card.effects || lookup.effects || [],
        aliases: card.aliases || lookup.aliases || []
    };
}

export function hydrateSyncedCards(cards) {
    if (!Array.isArray(cards)) return cards;
    return cards.map(card => (card ? hydrateSyncedCard(card) : card));
}

function createMultiplayerCard(card, artPrefs = null) {
    const slim = stripCardForSync(cloneData(card));
    // The browser dealing the game may belong to the OTHER player, so use the picks
    // that came with THIS player's deck (none = the default art) - never the dealer's own.
    slim.artIndex = artIndexFromPrefs(artPrefs, card.cardNumber || card.id);
    return {
        ...slim,
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

// Every card number a deck needs in order to be dealt properly: its leader(s),
// the list, its token types and its "start in play" picks.
function deckCardNumbers(deck) {
    const nums = new Set();
    if (!deck) return nums;
    [deck.leaderKey, deck.leaderKey2].forEach(key => key && nums.add(key));
    String(deck.deckText || "").split("\n").forEach(line => {
        const match = line.trim().match(/^\d+x(.+)$/i);
        if (match) nums.add(match[1].trim());
    });
    (Array.isArray(deck.tokens) ? deck.tokens : []).forEach(id => id && nums.add(id));
    (Array.isArray(deck.startingCards) ? deck.startingCards : [])
        .forEach(entry => entry && entry.id && nums.add(entry.id));
    return nums;
}

// Read the maps directly - getCardById logs a console error on every miss.
function isCardLoaded(number) {
    const leaders = globalThis.leaders || {};
    return Boolean(
        leaders[number] ||
        (globalThis.cardDatabase || {})[number] ||
        Object.values(leaders).some(leader => leader?.cardNumber === number || leader?.id === number)
    );
}

// The dealing browser builds BOTH players' decks, so it must have every card of
// both decks loaded. A card that isn't loaded is silently dropped by
// parseDeckText, and a "start in play" card that can't be found in the deck is
// silently skipped by applyStartingCards - that's how starters went missing
// "sometimes". Loads the full shared library (once more if a first try still
// leaves gaps) and returns whatever is STILL missing; never throws, so a flaky
// network can't strand a rematch.
//
// Call it BEFORE claiming a deal: the claims only last a few seconds, and a long
// download inside one let the other player's browser deal a second time.
let fullLibraryLoad = null;   // one shared download, however many callers ask at once
function loadFullLibraryOnce() {
    if (!fullLibraryLoad) {
        fullLibraryLoad = Promise.resolve()
            .then(() => globalThis.loadFullCardLibraryBlocking())
            .finally(() => { fullLibraryLoad = null; });
    }
    return fullLibraryLoad;
}

async function ensureDeckCardsLoaded(decks) {
    const missingNow = () => {
        const out = new Set();
        decks.filter(Boolean).forEach(deck => deckCardNumbers(deck).forEach(number => {
            if (!isCardLoaded(number)) out.add(number);
        }));
        return [...out];
    };

    let missing = missingNow();
    if (!missing.length) return [];

    // Just the missing cards (with their art). This used to load the WHOLE
    // library with all its art - hundreds of MB, on top of what the board had
    // already loaded - and that is what crashed the tab ("Aw, Snap") on joining.
    if (typeof globalThis.loadGameCards === "function") {
        try { await globalThis.loadGameCards(missing); }
        catch (error) { console.warn("Card lookup failed:", error); }
        missing = missingNow();
    } else if (typeof globalThis.loadFullCardLibraryBlocking === "function") {
        // A page without the targeted loader (shouldn't happen any more).
        try { await loadFullLibraryOnce(); } catch (error) { console.warn("Card library load failed:", error); }
        missing = missingNow();
    }
    if (missing.length) {
        console.warn("Dealing with cards that aren't loaded (they will be left out):", missing);
    }
    return missing;
}

// Console-only: say so when a "start in play" pick couldn't be placed, instead of
// quietly dealing the match without it.
function warnAboutMissingStarters(selectedDeck, privateState) {
    const wanted = Array.isArray(selectedDeck?.startingCards) ? selectedDeck.startingCards : [];
    if (!wanted.length) return;
    const caps = { characters: 5, stage: 1 };
    const used = {};
    let expected = 0;
    wanted.forEach(entry => {
        if (!entry || !entry.id || !entry.zone) return;
        used[entry.zone] = (used[entry.zone] || 0) + 1;
        if (used[entry.zone] <= (caps[entry.zone] ?? Infinity)) expected++;
    });
    const placed = (privateState.characters || []).length + (privateState.stage ? 1 : 0)
        + (privateState.trash || []).length + (privateState.life || []).length
        + (privateState.hand || []).length;
    if (placed < expected) {
        console.warn(`"${selectedDeck.name}": ${expected - placed} of ${expected} "start in play" cards could not be placed (not in the deck or not loaded).`);
    }
}

function createInitialPrivateState(selectedDeck, artPrefs = null) {
    requireDeckTools();

    // Saved decks store a custom leader id, which may not be a key in the
    // `leaders` map (that's keyed by the built-in leader set). Fall back to a
    // direct card lookup, then to a case-insensitive scan, so a custom leader
    // never hard-fails match start and strands both players in the lobby.
    const findLeaderDefinition = (key) => {
        let found = globalThis.leaders[key];

        if (!found && typeof globalThis.getCardById === "function") {
            found = globalThis.getCardById(key);
        }

        if (!found) {
            const wanted = String(key || "").toLowerCase();
            const match = Object.entries(globalThis.leaders || {})
                .find(([leaderKey, value]) =>
                    leaderKey.toLowerCase() === wanted ||
                    String(value?.cardNumber || "").toLowerCase() === wanted ||
                    String(value?.id || "").toLowerCase() === wanted);
            found = match?.[1];
        }
        return found || null;
    };

    const leaderKey = selectedDeck.leaderKey;
    const leaderDefinition = findLeaderDefinition(leaderKey);
    // Dual Leader: `leaderKey` is the STATS leader; `leaderKey2` is its linked
    // twin. A missing twin quietly becomes a normal single-leader game.
    const leader2Definition = selectedDeck.leaderKey2
        ? findLeaderDefinition(selectedDeck.leaderKey2)
        : null;

    if (!leaderDefinition) {
        throw new Error(
            `Leader "${leaderKey}" for deck "${selectedDeck.name}" was not found in the card database.`
        );
    }

    const deck = globalThis.shuffleDeck(globalThis.parseDeckText(selectedDeck.deckText))
        .map(card => createMultiplayerCard(card, artPrefs));
    const leader = createMultiplayerCard(leaderDefinition, artPrefs);
    const leader2 = leader2Definition ? createMultiplayerCard(leader2Definition, artPrefs) : null;

    // Token TYPES the deck makes available. Resolved here so the board can show
    // the token zone without another database round-trip. Read the card map
    // directly - getCardById logs an error on every miss.
    const cardMap = globalThis.cardDatabase || {};
    const tokenTypes = (selectedDeck.tokens || [])
        .map(id => cardMap[id])
        .filter(Boolean)
        .map(card => createMultiplayerCard(card, artPrefs));

    const privateState = {
        selectedDeck,
        hand: [],
        deck,
        // Life starts EMPTY, matching the manual board: players deal their own
        // life from the top of the deck by dragging (the board is fully manual,
        // so auto-dealing here surprised players with pre-filled life).
        life: [],
        // Board zones the deck's "start in play" cards land in; empty otherwise.
        // createInitialPublicPlayerState mirrors these onto the visible board.
        characters: [],
        trash: [],
        leader,
        leader2,
        stage: null,
        tokenTypes
    };

    // Place any "start in play" cards FIRST, pulling them out of the shuffled
    // deck, THEN deal the opening five from what remains (so a card set to start
    // on the board is never also sitting in the opening hand). Any hand-zone
    // starters ride on top of the dealt five.
    if (typeof globalThis.applyStartingCards === "function") {
        globalThis.applyStartingCards(privateState, selectedDeck.startingCards);
    }
    warnAboutMissingStarters(selectedDeck, privateState);

    // Remember which hand cards were "start in hand" picks, so a mulligan keeps
    // them (otherwise they were shuffled back into the deck and the starter
    // "didn't work" whenever the player mulliganed).
    const handStarters = (privateState.hand || []).map(card => card && card.instanceId).filter(Boolean);
    privateState.hand = privateState.deck.splice(0, 5).concat(privateState.hand);
    if (handStarters.length) privateState.handStarters = handStarters;

    applyStartingZangetsuStage(privateState);

    return privateState;
}

function applyStartingZangetsuStage(privateState) {
    if (privateState?.leader?.cardNumber !== "BL01-001") {
        return;
    }
    // A deck that already placed its own starting stage wins - don't overwrite it.
    if (privateState.stage) {
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
        faceUp: Boolean(card.faceUp),
        // Carry the owner's chosen art (e.g. a revealed life card) so the opponent
        // sees the alt you picked. Always sent, even the default 0: when it was left
        // out the viewer fell back to ITS OWN pick for that card number.
        artIndex: Number.isInteger(card.artIndex) ? card.artIndex : 0
    };
}

function createInitialPublicPlayerState(privateState) {
    // Board is a JSON string for the same lossless-round-trip reason as
    // createPublicPlayerStateFromLocal in self.js - Firebase mangles arrays.
    // The dealer may not be this player: keep the art index already on each card.
    const strip = (card) => stripCardForSync(card, { keepArtIndex: true });
    const board = {
        leader: strip(privateState.leader || null),
        leader2: strip(privateState.leader2 || null),
        characters: (privateState.characters || []).map(strip),
        stage: strip(privateState.stage || null),
        trash: (privateState.trash || []).map(strip),
        extraFaceUp: [],
        extraFaceDown: [],
        tokens: [],
        tokenTypes: (privateState.tokenTypes || []).map(strip),
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

    // A tournament pairing passes a FIXED room code, so both players compute the same
    // code and whoever arrives first creates the room while the other just joins it.
    const fixedCode = opts.roomCode ? cleanRoomCode(opts.roomCode) : "";
    const roomCode = fixedCode || generateRoomCode();
    const nickname = opts.nickname || "Player 1";
    const isPublic = Boolean(opts.isPublic);
    const lobbyName = opts.lobbyName || (nickname + "'s Game");
    // Room mode: "regular" (default, unchanged) or "draft" (booster draft battle).
    // draftCollection = "" for all cards, a collection slug, or several slugs joined
    // by commas (tournaments can draft from more than one collection).
    const mode = opts.mode === "draft" ? "draft" : "regular";
    const draftCollection = mode === "draft" ? String(opts.draftCollection || "") : "";

    console.log("Generated room code:", roomCode);

    const matchRef = ref(database, `matches/${roomCode}`);

    const matchDocument = (createdAt) => ({
        status: "waiting",
        createdAt,
        hostUid: user.uid,
        isPublic,
        lobbyName,
        mode,
        draftCollection,
        // Tournament matches: who may play, which tournament/round this is, and the
        // card pool the decks are restricted to. Absent for ordinary rooms.
        ...(opts.tournament ? { tournament: opts.tournament } : {}),
        // Room options chosen on the create screen (e.g. { turnSeconds: 120 }).
        ...(opts.settings ? { settings: opts.settings } : {}),

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

    if (fixedCode) {
        // Create only if nobody has yet: two players pressing "Play" at the same
        // moment must not overwrite each other's room.
        const outcome = await runTransaction(matchRef, current =>
            current === null ? matchDocument(Date.now()) : undefined);
        if (!outcome.committed) {
            const exists = new Error("That room already exists.");
            exists.code = "ROOM_EXISTS";
            throw exists;
        }
    } else {
        await set(matchRef, matchDocument(serverTimestamp()));
    }

    // Rooms are private and joined by code. The public /lobbies listing was
    // removed - the database rules denied it and it was never usable.
    console.log("Firebase set() finished.");
    return { roomCode, publicListingFailed: false };
}

// Returns { code, slot } - the seat you have in the room ("p1" or "p2").
export async function joinRoom(roomCode, user, nickname = "Player 2") {
    if (!user?.uid) {
        throw new Error("No user found. Guest login did not finish.");
    }

    const code = cleanRoomCode(roomCode);
    const matchRef = ref(database, `matches/${code}`);

    const [playersSnap, statusSnap, tournamentSnap] = await Promise.all([
        get(ref(database, `matches/${code}/players`)),
        get(ref(database, `matches/${code}/status`)),
        get(ref(database, `matches/${code}/tournament`))
    ]);

    if (!playersSnap.exists() && !statusSnap.exists()) {
        throw new Error("Room does not exist.");
    }

    const players = playersSnap.val() || {};

    // Already in this room (e.g. you left the game page and typed the code again):
    // just hand your seat back. This used to re-join you from scratch - the room
    // went back to "ready" and your hand and deck were wiped - so readying up again
    // re-dealt a game that was still being played, and the other player was thrown
    // back to the dice roll.
    if (players.p1?.uid === user.uid) return { code, slot: "p1" };
    if (players.p2?.uid === user.uid) return { code, slot: "p2" };

    // A tournament match is for the two paired players only. The room code is
    // derivable, so don't let anyone else take the empty seat.
    const tournament = tournamentSnap.val();
    if (tournament && tournament.players && !tournament.players[user.uid]) {
        throw new Error("This is a tournament match - only the two players in this pairing can join it.");
    }

    if (players.p2) {
        throw new Error("Room is already full.");
    }

    if (statusSnap.val() === "started") {
        throw new Error("That game has already started.");
    }

    // Take the empty seat atomically, so two people joining at the same moment
    // can't both think they got it.
    const seat = await runTransaction(ref(database, `matches/${code}/players/p2`), (current) => {
        if (current && current.uid !== user.uid) return; // someone beat us to it
        return { uid: user.uid, name: nickname, connected: true, ready: false };
    });

    if (!seat.committed) {
        throw new Error("Room is already full.");
    }

    await update(matchRef, {
        status: "ready",
        [`private/${user.uid}`]: {
            selectedDeck: null,
            hand: [],
            deck: [],
            life: []
        }
    });

    return { code, slot: "p2" };
}

// The lobby only needs the handful of fields below. Subscribing to the whole
// match node pulled every card in both players' private state on every update
// (megabytes), which is a large part of why online play felt so slow.
export function subscribeToMatch(roomCode, callback) {
    const code = cleanRoomCode(roomCode);
    // `mode` + `draftCollection` let the lobby switch to the draft layout; they're
    // small scalars so watching them adds no meaningful traffic. `tournament` is a
    // small object (names + ids), present only on tournament matches.
    const paths = ["status", "players", "isPublic", "lobbyName", "startError", "mode", "draftCollection", "tournament", "settings"];
    const latest = {};
    const reported = new Set();
    const unsubscribers = [];

    paths.forEach(path => {
        const unsubscribe = onValue(ref(database, `matches/${code}/${path}`), (snapshot) => {
            latest[path] = snapshot.val();
            reported.add(path);
            // Wait until every part has arrived once: a half-loaded room looked like
            // a regular room with no tournament (mode/tournament not in yet).
            if (reported.size < paths.length) return;
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

// Spectator helper: watch BOTH players' private zones (hand/deck/life) at once.
// It follows the players node to learn each seat's uid, then subscribes to that
// uid's private state, re-wiring if a seat's uid changes (e.g. p2 joins later).
// Calls back with { p1, p2 } raw private states (either may be null until known).
export function subscribeToAllPrivateState(roomCode, callback) {
    const code = cleanRoomCode(roomCode);
    const latest = { p1: null, p2: null };
    const uids = { p1: null, p2: null };
    const privateUnsub = { p1: null, p2: null };

    const watchPrivate = (slot, uid) => {
        if (privateUnsub[slot]) { privateUnsub[slot](); privateUnsub[slot] = null; }
        if (!uid) { latest[slot] = null; callback({ ...latest }); return; }
        privateUnsub[slot] = onValue(
            ref(database, `matches/${code}/private/${uid}`),
            (snapshot) => { latest[slot] = snapshot.val(); callback({ ...latest }); }
        );
    };

    const playersUnsub = onValue(ref(database, `matches/${code}/players`), (snapshot) => {
        const players = snapshot.val() || {};
        ["p1", "p2"].forEach(slot => {
            const uid = players[slot]?.uid || null;
            if (uid !== uids[slot]) { uids[slot] = uid; watchPrivate(slot, uid); }
        });
    });

    return () => {
        playersUnsub();
        Object.values(privateUnsub).forEach(unsub => unsub && unsub());
    };
}

// Per-seat board cosmetics (playmat / card back / DON!! back, as data URLs).
// Written once on connect and read by both players so each sees the other's
// cosmetics on their field. Kept on its own node (not the frequently-synced
// public board) so the image data isn't re-sent on every board update.
export async function setMatchCosmetics(roomCode, playerSlot, cosmetics) {
    if (playerSlot !== "p1" && playerSlot !== "p2") return;
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}/cosmetics`), {
        [playerSlot]: cosmetics || null
    });
}

export function subscribeToCosmetics(roomCode, callback) {
    const cosmeticsRef = ref(database, `matches/${cleanRoomCode(roomCode)}/cosmetics`);
    return onValue(cosmeticsRef, (snapshot) => {
        callback(snapshot.val() || {});
    });
}

// The two players' chosen nicknames, so the game board can show real names
// instead of "Player 1" / "Player 2". Names live on the match's players node.
export function subscribeToPlayerNames(roomCode, callback) {
    const playersRef = ref(database, `matches/${cleanRoomCode(roomCode)}/players`);

    return onValue(playersRef, (snapshot) => {
        const players = snapshot.val() || {};
        callback({
            p1: String(players.p1?.name || "").slice(0, 24),
            p2: String(players.p2?.name || "").slice(0, 24)
        });
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
        deck: deckData,
        // This player's alt-art picks, so whoever deals the game uses THEIRS.
        artPrefs: snapshotOwnArtPrefs()
    });
}

// ── In-match chat ────────────────────────────────────────
// Messages live under the match so both clients get them in realtime and they
// disappear with the room. Kept deliberately small (sender/text/at).
export async function sendChatMessage(roomCode, sender, text, role) {
    const message = String(text || "").trim();
    if (!message) return;

    const chatRef = ref(database, `matches/${cleanRoomCode(roomCode)}/chat`);
    await push(chatRef, {
        sender: String(sender || "Player").slice(0, 24),
        text: message.slice(0, 300),
        // "p1" | "p2" | "spectator" so the UI can colour senders by role even
        // when a spectator picks a custom name.
        role: (role === "p1" || role === "p2" || role === "spectator") ? role : null,
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

// ── Draft Battle sync ────────────────────────────────────
// A draft room lives under matches/<code>/draft:
//   draft/p1/inBuilder, draft/p2/inBuilder  — set once a player finishes opening
//     their 10 packs and enters the deck builder.
//   draft/startedAt  — the shared 15-minute clock's anchor. Claimed (once) the
//     moment BOTH players are in the builder, so the countdown is identical on
//     both screens no matter who arrived first.
//   draft/p1/locked, draft/p2/locked — a player has locked their deck (readied).
// The actual drafted decks are submitted through the normal setPlayerDeck +
// setPlayerReady path, so the existing startMatch flow deals the game unchanged.
export function subscribeToDraft(roomCode, callback) {
    const draftRef = ref(database, `matches/${cleanRoomCode(roomCode)}/draft`);
    return onValue(draftRef, (snapshot) => callback(snapshot.val() || {}));
}

export async function markDraftInBuilder(roomCode, playerSlot) {
    if (playerSlot !== "p1" && playerSlot !== "p2") return;
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}/draft/${playerSlot}`), {
        inBuilder: true
    });
}

export async function setDraftLocked(roomCode, playerSlot, locked) {
    if (playerSlot !== "p1" && playerSlot !== "p2") return;
    await update(ref(database, `matches/${cleanRoomCode(roomCode)}/draft/${playerSlot}`), {
        locked: Boolean(locked)
    });
}

// Anchor the shared countdown the instant the FIRST player reaches the builder.
// A transaction so that if both clients enter together, only one timestamp is
// written and both then count down from the same moment.
export async function claimDraftStartIfReady(roomCode) {
    const code = cleanRoomCode(roomCode);
    const snapshot = await get(ref(database, `matches/${code}/draft`));
    const draft = snapshot.val() || {};
    if (draft.startedAt) return draft.startedAt;
    if (!(draft.p1?.inBuilder || draft.p2?.inBuilder)) return null;
    const result = await runTransaction(
        ref(database, `matches/${code}/draft/startedAt`),
        (current) => (current ? undefined : Date.now())
    );
    return result.committed ? result.snapshot.val() : draft.startedAt || null;
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

    // Normally already loaded by startMatch before it claimed the start; this only
    // downloads anything if a deck changed in the meantime. If it did have to wait,
    // make sure nobody else dealt while we were loading.
    const stillMissing = await ensureDeckCardsLoaded([player1Deck, player2Deck]);
    const latestStatus = await get(ref(database, `matches/${cleanRoomCode(roomCode)}/status`));
    if (latestStatus.val() === "started") return;
    if (stillMissing.length) {
        console.warn("Starting without some cards (not in the card library):", stillMissing);
    }

    await update(matchRef, buildFreshMatchPayload(player1, player2, player1Deck, player2Deck, null,
        Number(match.settings?.clockSeconds) || 0));
}

// ── Game clock ───────────────────────────────────────────
// A chess clock: each player has their own bank of time for the whole game
// (settings/clockSeconds, chosen when the room is made). Only the player whose turn
// it is loses time; passing the turn takes the time used off their bank
// (passTurn). Run out and you lose (claimClockTimeout). Stored in public/clock as
// { total, p1, p2 } in ms - what each player had when their current/last turn
// began - so the live figure for the player on turn is bank - (now - turnStartedAt).
const CLOCK_IDLE_PHASES = ["waiting", "diceRoll", "mulligan", "gameOver"];

export function clockLeftMs(publicState, slot, now = serverNow()) {
    const clock = publicState?.clock;
    if (!clock || (slot !== "p1" && slot !== "p2")) return null;
    let left = Number(clock[slot]) || 0;
    const running = publicState.currentPlayer === slot
        && !CLOCK_IDLE_PHASES.includes(publicState.phase)
        && !publicState.winner
        && Number(publicState.turnStartedAt) > 0;
    if (running) left -= Math.max(0, now - Number(publicState.turnStartedAt));
    return Math.max(0, left);
}

/** The player on turn has run out of time: they lose. Any client may call this when
 *  its countdown hits zero; the transaction re-checks, so it's harmless if both do,
 *  or if the turn was passed in time after all. Returns true if it ended the game. */
export async function claimClockTimeout(roomCode, loserSlot, loserName = "") {
    if (loserSlot !== "p1" && loserSlot !== "p2") return false;
    const winnerSlot = loserSlot === "p1" ? "p2" : "p1";
    const result = await runTransaction(ref(database, `matches/${cleanRoomCode(roomCode)}/public`), (publicState) => {
        if (publicState === null) return null;   // no local copy yet - let the server answer
        if (!publicState.clock || publicState.winner || CLOCK_IDLE_PHASES.includes(publicState.phase)) return;
        if (publicState.currentPlayer !== loserSlot) return;
        if (clockLeftMs(publicState, loserSlot) > 0) return;
        return {
            ...publicState,
            phase: "gameOver",
            winner: winnerSlot,
            currentAttack: null,
            clock: { ...publicState.clock, [loserSlot]: 0 },
            gameOverReasonTitle: "Out of time",
            gameOverReasonText: `${loserName || loserSlot.toUpperCase()} ran out of time on the game clock.`
        };
    }, SERVER_CONFIRMED);
    return Boolean(result.committed && result.snapshot.val()?.winner === winnerSlot
        && result.snapshot.val()?.gameOverReasonTitle === "Out of time");
}

// The full "deal a brand new game" write. Shared by the first start and by a
// rematch so the two can never drift apart. On a rematch, `rematchLoser` (the
// player who lost the last game) is pre-set as the dice "winner" so THEY get to
// choose who goes first - no dice roll needed. `clockSeconds` > 0 gives both
// players a full game clock.
function buildFreshMatchPayload(player1, player2, player1Deck, player2Deck, rematchLoser = null, clockSeconds = 0) {
    const clockMs = Math.max(0, Math.round(Number(clockSeconds) || 0)) * 1000;
    const p1Private = createInitialPrivateState(player1Deck, player1 && player1.artPrefs);
    const p2Private = createInitialPrivateState(player2Deck, player2 && player2.artPrefs);

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
        // A fresh id per dealt game, so a result is only ever counted once in a
        // player's win/loss record (a reload of the game-over screen reports it again).
        "public/gameId": `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        "public/turnStartedAt": null,
        "public/clock": clockMs ? { total: clockMs, p1: clockMs, p2: clockMs } : null,
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
        [`rematch/${playerSlot}/at`]: serverTimestamp(),
        // Refreshed every time: picks made in-game (art picker) count for the re-deal.
        [`players/${playerSlot}/artPrefs`]: snapshotOwnArtPrefs()
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

// A claimed re-deal that never landed (the dealing browser closed mid-deal) may be
// taken over after this long, so the rematch can't get stuck on "starting…".
const REMATCH_CLAIM_STALE_MS = 45000;

// Re-deal the match. Guarded by a transaction on the whole rematch node so that
// when both clients notice "both ready" at the same moment only one actually
// deals - otherwise the decks would be shuffled twice and the two sides would
// disagree. (The claim used to sit on rematch/startedAt alone: a client that read
// "both ready" just before the other client's deal cleared the rematch node could
// still claim the empty startedAt afterwards and deal a SECOND time.)
export async function restartMatch(roomCode) {
    const code = cleanRoomCode(roomCode);
    const matchRef = ref(database, `matches/${code}`);

    // Only the small parts we need - the whole match also holds both players'
    // cards, the chat and the cosmetics images.
    const [playersSnap, rematchSnap, winnerSnap, clockSnap] = await Promise.all([
        get(ref(database, `matches/${code}/players`)),
        get(ref(database, `matches/${code}/rematch`)),
        get(ref(database, `matches/${code}/public/winner`)),
        get(ref(database, `matches/${code}/settings/clockSeconds`))
    ]);

    const players = playersSnap.val();
    if (!players) throw new Error("Match not found.");

    const player1 = players.p1;
    const player2 = players.p2;

    if (!player1 || !player2) throw new Error("Both players must be connected.");

    const rematch = rematchSnap.val() || {};
    if (!rematch.p1?.ready || !rematch.p2?.ready) {
        return { committed: false };
    }

    // Whichever browser deals builds BOTH decks, and it may not have the other
    // player's cards loaded (the game page loads those in the background). Without
    // them parseDeckText drops cards and "start in play" cards are silently
    // skipped. Loaded before claiming, so the claim is held only for the deal.
    await ensureDeckCardsLoaded([rematch.p1?.deck || player1.deck, rematch.p2?.deck || player2.deck]);

    let claimed = null;
    const claim = await runTransaction(ref(database, `matches/${code}/rematch`), (current) => {
        claimed = null;
        // No local copy yet: the first try is a guess of null. Returning null (not
        // undefined, which gives up on the spot) lets the server answer with the
        // real value and run this again.
        if (current === null) return null;
        // Cleared = the other browser already re-dealt.
        if (!current.p1?.ready || !current.p2?.ready) return;
        if (current.startedAt && (Date.now() - Number(current.startedAt)) < REMATCH_CLAIM_STALE_MS) return;
        claimed = { ...current, startedAt: Date.now() };
        return claimed;
    }, SERVER_CONFIRMED);

    if (!claim.committed || !claimed) return { committed: false };

    // A rematch deck choice wins over the one used last game. Read from the claim,
    // which is the latest state.
    const player1Deck = claimed.p1?.deck || player1.deck;
    const player2Deck = claimed.p2?.deck || player2.deck;

    if (!player1Deck || !player2Deck) {
        await update(matchRef, { "rematch/startedAt": null }).catch(() => {});
        throw new Error("Both players must have a deck selected.");
    }

    // Only downloads if a deck was swapped since the load above.
    await ensureDeckCardsLoaded([player1Deck, player2Deck]);

    // The loser of the game that just ended chooses turn order for the rematch.
    const prevWinner = winnerSnap.val();
    const rematchLoser = prevWinner === "p1" ? "p2" : (prevWinner === "p2" ? "p1" : null);

    await update(matchRef, {
        ...buildFreshMatchPayload(player1, player2, player1Deck, player2Deck, rematchLoser, Number(clockSnap.val()) || 0),
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

    return runTransaction(diceRef, (current) => {
        // (A default parameter doesn't cover null - the value of a node with no
        // local copy yet - and `null.winner` threw.)
        const dice = current || {};
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
    }, SERVER_CONFIRMED);
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
        if (publicState === null) return null;   // no local copy yet - let the server answer
        const diceWinner = publicState?.setup?.dice?.winner;

        if (publicState.phase !== "diceRoll" || diceWinner !== chooserSlot) {
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
    }, SERVER_CONFIRMED);
}

export async function setMultiplayerMulligan(roomCode, user, playerSlot, tookMulligan) {
    if (!user?.uid) {
        throw new Error("User is required for mulligan.");
    }

    if (playerSlot !== "p1" && playerSlot !== "p2") {
        throw new Error("Invalid player slot.");
    }

    const code = cleanRoomCode(roomCode);
    const matchRef = ref(database, `matches/${code}`);
    const [phaseSnap, mulliganSnap, uidSnap, privateSnap] = await Promise.all([
        get(ref(database, `matches/${code}/public/phase`)),
        get(ref(database, `matches/${code}/public/setup/mulligan`)),
        get(ref(database, `matches/${code}/players/${playerSlot}/uid`)),
        get(ref(database, `matches/${code}/private/${user.uid}`))
    ]);

    if (!phaseSnap.exists() && !uidSnap.exists()) {
        throw new Error("Room does not exist.");
    }

    if (phaseSnap.val() !== "mulligan") {
        throw new Error("Mulligan is not available right now.");
    }

    if (uidSnap.val() !== user.uid) {
        throw new Error("Only your player slot can mulligan.");
    }

    if (mulliganSnap.val()?.[playerSlot]?.done) {
        throw new Error("Mulligan was already chosen.");
    }

    // During setup the dealt hand/deck arrays are the truth (the board isn't
    // yours to change until the game starts).
    const privateState = privateSnap.val() || {};
    let hand = privateState.hand || [];
    let deck = privateState.deck || [];

    if (tookMulligan) {
        // "Start in hand" cards stay in hand: only the dealt cards go back into
        // the deck and get redrawn, exactly like the opening deal.
        const keepIds = Array.isArray(privateState.handStarters) ? privateState.handStarters : [];
        const kept = hand.filter(card => card && keepIds.includes(card.instanceId));
        const returned = hand.filter(card => !(card && keepIds.includes(card.instanceId)));
        deck = shuffleCards([...deck, ...returned]);
        hand = deck.splice(0, 5).concat(kept);
    }

    const publicPlayerKey = playerSlot === "p1" ? "player1" : "player2";

    // Step 1: the new hand. Written on its own, BEFORE the game can start. When the
    // hand and "game starts" went out in one write, the browser could see the game
    // start before the new hand arrived - and it locks in your cards the moment the
    // game starts, so the mulligan was silently undone. zonesJson is cleared so a
    // copy pushed during setup can't win over the dealt cards.
    await update(matchRef, {
        [`private/${user.uid}/hand`]: hand,
        [`private/${user.uid}/deck`]: deck,
        [`private/${user.uid}/zonesJson`]: null,
        [`public/${publicPlayerKey}/handCount`]: hand.length,
        [`public/${publicPlayerKey}/deckCount`]: deck.length
    });

    // Step 2: record the choice, and start the game if both players have chosen.
    // A transaction, so two players choosing at the same instant can't each miss
    // the other's choice and leave the game stuck on "mulligan".
    await runTransaction(ref(database, `matches/${code}/public`), (publicState) => {
        if (publicState === null) return null;   // no local copy yet - let the server answer
        if (publicState.phase !== "mulligan") return;
        const mulligan = {
            ...(publicState.setup?.mulligan || {}),
            [playerSlot]: { done: true, took: Boolean(tookMulligan) }
        };
        const next = { ...publicState, setup: { ...(publicState.setup || {}), mulligan } };
        return mulligan.p1?.done && mulligan.p2?.done ? startMainPhase(next) : next;
    }, SERVER_CONFIRMED);
}

// The game proper begins. Deliberately leave playerTurns at 0 for the first
// player: their client runs the opening turn start itself (maybeRunOnlineTurnStart),
// which grants the 1 DON!!, skips the turn-1 draw and then stamps turns = 1.
// Pre-setting it to 1 made that guard think the turn had already been processed,
// so the player going first started with an empty DON!! area.
function startMainPhase(publicState) {
    const firstPlayer = publicState.firstPlayer || publicState.setup?.turnChoice?.firstPlayer || "p1";
    return {
        ...publicState,
        phase: "main",
        currentPlayer: firstPlayer,
        turnNumber: 1,
        playerTurns: { ...(publicState.playerTurns || {}), [firstPlayer]: 0 },
        turnStartedAt: serverNow()   // for the optional turn timer
    };
}

// Rescue a mulligan that's stuck with both choices recorded but the phase still
// on "mulligan" (possible with an older version of the page on the other side).
// Any client that sees that state calls this. A transaction, so it can only ever
// move the phase forward from "mulligan" - never re-start a game in progress.
export async function resolveMulliganIfBothDone(roomCode) {
    const result = await runTransaction(
        ref(database, `matches/${cleanRoomCode(roomCode)}/public`),
        (publicState) => {
            if (publicState === null) return null;
            if (publicState.phase !== "mulligan") return;
            const mulligan = publicState.setup?.mulligan || {};
            if (!(mulligan.p1?.done && mulligan.p2?.done)) return;
            return startMainPhase(publicState);
        },
        SERVER_CONFIRMED
    );
    return Boolean(result.committed && result.snapshot.val()?.phase === "main");
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

    // Any other write this browser makes to the match while the transaction is in
    // flight (a board sync, a card reveal) cancels it with "set" - the turn then
    // simply didn't pass ("Failed to end online turn: set"). It hasn't changed
    // anything yet, so it's safe to just try again.
    for (let attempt = 0; ; attempt++) {
        try {
            return await runPassTurnTransaction(publicRef, currentPlayer);
        } catch (error) {
            const retryable = /^(set|maxretry|disconnect)$/i.test(String(error?.message || ""));
            if (!retryable || attempt >= 3) throw error;
        }
    }
}

function runPassTurnTransaction(publicRef, currentPlayer) {
    return runTransaction(publicRef, (publicState) => {
        if (publicState === null) return null;   // no local copy yet - let the server answer
        if (
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

        // Game clock: the time this turn took comes off the passing player's bank.
        // (If it has already run out, claimClockTimeout ends the game instead.)
        const now = serverNow();
        let clock = publicState.clock || null;
        if (clock) {
            const left = clockLeftMs(publicState, currentPlayer, now);
            if (left <= 0) return;   // too late - they've lost on time
            clock = { ...clock, [currentPlayer]: left };
        }

        return {
            ...publicState,
            currentPlayer: nextPlayer,
            phase: "main",
            currentAttack: null,
            turnNumber: nextTurnNumber,
            turnStartedAt: now,   // the game clock counts from here
            clock,
            playerTurns: {
                ...(publicState.playerTurns || {})
            }
        };
    }, SERVER_CONFIRMED);
}

const START_CLAIM_STALE_MS = 15000;

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

    // The dealer builds BOTH players' decks, so it needs every deck + "start in
    // play" card loaded — including the OPPONENT's custom cards. Without them
    // parseDeckText silently drops cards and applyStartingCards can't place them.
    // Loaded BEFORE claiming the start: the claim goes stale after
    // START_CLAIM_STALE_MS, and a slow download inside it let the other player's
    // browser claim too and deal a second game on top of the first (both players
    // thrown back to the dice roll).
    const playersSnap = await get(ref(database, `matches/${code}/players`));
    const players = playersSnap.val() || {};
    await ensureDeckCardsLoaded([players.p1?.deck, players.p2?.deck]);

    const recheck = await get(ref(database, `matches/${code}/status`));
    if (recheck.val() === "started") return;

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
    // Each side's leader card number, so the Live games list can show their art.
    let p1Leader = "";
    let p2Leader = "";
    try {
        const playersSnap = await get(ref(database, `matches/${code}/players`));
        const players = playersSnap.val() || {};
        p1Name = p1Name || players.p1?.name;
        p2Name = p2Name || players.p2?.name;
        p1Leader = String(players.p1?.deck?.leaderKey || "");
        p2Leader = String(players.p2?.deck?.leaderKey || "");
    } catch {
        // fall back to defaults below
    }

    await set(ref(database, `activeGames/${code}`), {
        roomCode: code,
        p1Name: String(p1Name || "Player 1").slice(0, 24),
        p2Name: String(p2Name || "Player 2").slice(0, 24),
        p1Leader: p1Leader.slice(0, 80),
        p2Leader: p2Leader.slice(0, 80),
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

// ── Win/loss record (accounts only) ──────────────────────
// users/<uid>/mpRecord = { wins, losses, lastGameId }. Each player records only
// their OWN result, once per dealt game (gameId), so reloading the game-over
// screen or both browsers reporting can never count a game twice.
export async function recordMatchResult(uid, gameId, won) {
    if (!uid || !gameId) return null;
    const result = await runTransaction(ref(database, `users/${uid}/mpRecord`), (current) => {
        const record = current || { wins: 0, losses: 0 };
        if (record.lastGameId === gameId) return;   // already counted
        return {
            wins: Number(record.wins || 0) + (won ? 1 : 0),
            losses: Number(record.losses || 0) + (won ? 0 : 1),
            lastGameId: gameId
        };
    });
    return result.snapshot ? result.snapshot.val() : null;
}

export async function getMatchRecord(uid) {
    if (!uid) return null;
    try {
        const snapshot = await get(ref(database, `users/${uid}/mpRecord`));
        return snapshot.val();
    } catch {
        return null;
    }
}
