// cardDatabase.js

let cardDatabase = {};
let leaders = {};
const customCardsStorageKey = "custom-cards-sim-imported-cards-v1";
const cardDataFiles = [
    { path: "../data/cards/characters.json", category: "character" },
    { path: "../data/cards/stages.json", category: "stage" },
    { path: "../data/cards/events.json", category: "event" },
    { path: "../data/cards/leaders.json", category: "leader" },
    { path: "../data/cards/custom-project-cards.json", optional: true, projectCards: true }
];

async function loadJson(path) {
    const response = await fetch(path);

    if (!response.ok) {
        throw new Error(`Failed to load JSON file: ${path}`);
    }

    return response.json();
}

// Cards created by players live in the shared Firebase library, NOT in the
// bundled JSON files. Without this the game pages only knew about the cards
// shipped in the repo, so a deck built around a card you made failed at match
// start with "isn't in your card pool" - even though the deck builder (which
// does read the library) showed it fine.
//
// cardDatabase.js is a classic script, so the ES-module service is imported
// dynamically. Any failure here is non-fatal: the bundled files still load.
async function loadSharedCardsForGame() {
    try {
        const library = await import("../firebase/cardLibraryService.js?v=collections-3");
        const { cards, deleted } = await library.loadSharedCards();
        return { cards: cards || [], deleted: deleted || new Set() };
    } catch (error) {
        console.warn("Shared card library unavailable to the game board:", error);
        return { cards: [], deleted: new Set() };
    }
}

async function loadCardDatabase() {
    const loadedCards = await loadPermanentCardFiles();
    const { cards: sharedCards, deleted } = await loadSharedCardsForGame();
    const importedCards = loadImportedCardsForGame();
    const mainCards = {};
    const leaderCards = {};

    const place = (card) => {
        const target = card.cardType === "leader" ? leaderCards : mainCards;
        // Key by id AND by cardNumber. Built-in cards have id === cardNumber, but
        // imported cards keep their external id (e.g. an Untap uuid) as `id` while
        // decks reference the CARD NUMBER (JJK1-001). Without the cardNumber key,
        // getCardById(cardNumber) misses and the card "doesn't work" in a game.
        if (card.id) target[card.id] = card;
        if (card.cardNumber && card.cardNumber !== card.id) target[card.cardNumber] = card;
    };

    // A shared-library tombstone is keyed by number+collection now (e.g.
    // "JJK1__collection"), but was historically just the bare number. A bundled
    // card is considered deleted when its exact key, its collection-qualified
    // key, OR any collection variant of its number is tombstoned - so removing a
    // card from the library still keeps it out of the game.
    const sanitizePart = (value) => String(value ?? "").trim().replace(/[.#$/\[\]]/g, "-");
    const isDeletedForGame = (card) => {
        const number = sanitizePart(card.cardNumber || card.id || "");
        if (!number) return false;
        if (deleted.has(number)) return true;
        const collection = sanitizePart(card.collection || "");
        if (collection && deleted.has(`${number}__${collection}`)) return true;
        const prefix = `${number}__`;
        for (const key of deleted) if (key.startsWith(prefix)) return true;
        return false;
    };

    // Bundled cards first, minus anything deleted from the shared library, so a
    // card removed there doesn't reappear from the repo's JSON file.
    loadedCards
        .filter(card => !isDeletedForGame(card))
        .forEach(place);

    // Shared cards layer on top - they're the newest version of a card.
    sharedCards
        .map(card => normalizePermanentCardForGame(card, card.category || card.cardType))
        .forEach(place);

    const loadedKeys = new Set([
        ...loadedCards.map(cardLibraryKeyForGame),
        ...sharedCards.map(cardLibraryKeyForGame)
    ]);

    importedCards
        .map(normalizeImportedCardForGame)
        .filter(card => !loadedKeys.has(cardLibraryKeyForGame(card)))
        .forEach(place);

    cardDatabase = mainCards;
    leaders = leaderCards;

    window.cardDatabase = cardDatabase;
    window.leaders = leaders;
    window.getCardById = getCardById;

    console.log("Card database loaded:", cardDatabase);
    console.log("Leaders loaded:", leaders);
}

async function loadPermanentCardFiles() {
    const groups = await Promise.all(cardDataFiles.map(async file => {
        try {
            const payload = await loadJson(file.path);
            const cards = Array.isArray(payload) ? payload : Object.values(payload || {});
            return cards.map(card => normalizePermanentCardForGame(card, file.category));
        } catch (error) {
            if (file.optional) return [];
            throw error;
        }
    }));

    const seen = new Set();
    const deduped = [];

    groups.flat().forEach(card => {
        const key = cardLibraryKeyForGame(card);
        if (seen.has(key)) {
            const existingIndex = deduped.findIndex(existing => cardLibraryKeyForGame(existing) === key);
            if (existingIndex >= 0) deduped[existingIndex] = card;
            return;
        }
        seen.add(key);
        deduped.push(card);
    });

    return deduped;
}

function normalizePermanentCardForGame(card, category) {
    return normalizeImportedCardForGame({
        ...card,
        category: category || card.category || card.cardType,
        cardType: category || card.cardType || card.category
    });
}

function loadImportedCardsForGame() {
    const read = (key) => {
        try {
            const cards = JSON.parse(localStorage.getItem(key) || "[]");
            return Array.isArray(cards) ? cards : [];
        } catch {
            return [];
        }
    };
    // The official One Piece card list is cached by the deck builder under its
    // own key as { fetchedAt, cards: [...] }. Load those too so decks built with
    // official cards actually work in a game.
    const readOfficial = () => {
        try {
            const cached = JSON.parse(localStorage.getItem("official-optcg-cards-v1") || "null");
            return cached && Array.isArray(cached.cards) ? cached.cards : [];
        } catch {
            return [];
        }
    };

    // Read BOTH local stores: the legacy imported-cards key AND the project-cards
    // fallback that publishSingleCard writes to when the shared library can't be
    // reached during an import. Without the second one, cards that only saved
    // locally showed up in the deck builder but "didn't work" in a game.
    return dedupeImportedCardsForGame([
        ...read(customCardsStorageKey),
        ...read("custom-cards-sim-local-project-cards-v1"),
        ...readOfficial()
    ]);
}

function dedupeImportedCardsForGame(cards) {
    const seen = new Set();
    const deduped = [];

    cards.forEach(card => {
        const key = cardLibraryKeyForGame(card);

        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(card);
    });

    if (deduped.length !== cards.length) {
        try {
            localStorage.setItem(customCardsStorageKey, JSON.stringify(deduped));
        } catch (error) {
            console.warn(error);
        }
    }

    return deduped;
}

// A card's alt arts, tolerant of the shapes they arrive in: an array, a single
// legacy `altArt` string, or a Firebase object ({0:…,1:…}).
function normalizeAltArtsForGame(card) {
    const raw = card?.altArts;
    const source = Array.isArray(raw) ? raw
        : (raw && typeof raw === "object") ? Object.values(raw)
        : (card?.altArt ? [card.altArt] : []);
    return [...new Set(source.map(a => String(a || "").trim()).filter(Boolean))];
}

// Keyed by CARD NUMBER for every category - see the matching note on
// cardLibraryKey() in app.js. Leaders used to key by name, which silently
// merged different leaders that share one (this set has five separate cards
// called "Ichigo Kurosaki"), so only one of them was ever playable.
function cardLibraryKeyForGame(card) {
    const category = normalizeImportedCardType(card.category || card.cardType);
    const name = String(card.name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
    const number = String(card.cardNumber || card.id || "").trim().toLowerCase();

    return `${category}:${number || name}`;
}

function normalizeImportedCardForGame(card) {
    let category = normalizeImportedCardType(card.category || card.cardType || card.type);
    const cardNumber = String(card.cardNumber || card.id || crypto.randomUUID());
    const cardName = String(card.name || "").toLowerCase();

    if (
        cardName.includes("stand arrow") ||
        cardName.includes("zoom punch") ||
        cardName.includes("hamon bubble cutters") ||
        cardName.includes("hamon clackers") ||
        cardName.includes("sunlight yellow overdrive")
    ) {
        category = "event";
    }

    // In manual mode, store effect text as display-only metadata, not executable effects
    const effectText = String(card.effect || "") || "";

    return {
        id: card.id || cardNumber,
        cardNumber,
        name: card.name || "Unnamed Card",
        cardType: category,
        type: card.type || "",
        color: Array.isArray(card.colors) ? card.colors.join(",") : String(card.color || ""),
        colors: Array.isArray(card.colors) ? card.colors : String(card.color || "").split(/[,/]/).map(color => color.trim()).filter(Boolean),
        cost: card.cost ?? "",
        life: card.life ?? "",
        power: card.power ?? "",
        counter: card.counter ?? "",
        attribute: card.attribute || "",
        rarity: card.rarity || "",
        // 0 means "unlimited", so preserve it with ??; default to 4 when absent.
        // Never `undefined` - Firebase refuses to write undefined and it broke
        // multiplayer setup.
        copyLimit: card.copyLimit ?? 4,
        keywords: Array.isArray(card.keywords) ? card.keywords : [],
        effect: effectText,
        effects: [],
        image: card.image || "",
        // Extra artworks a player can cycle through per device. `altArt` kept as
        // the first one for anything still reading the legacy single field.
        // Firebase can return an array as an object, so normalize that here too.
        altArts: normalizeAltArtsForGame(card),
        altArt: normalizeAltArtsForGame(card)[0] || ""
    };
}

function cardEffectDedupeKey(effect) {
    if (!effect || typeof effect !== "object") return JSON.stringify(effect);
    const system = effect.system || effect.type || "effect";
    const id = effect.id || "";
    if (id) return `${system}:${id}`;
    return `${system}:${effect.event?.type || effect.timing?.type || ""}:${effect.generatedText || effect.text || effect.sourceText || JSON.stringify(effect)}`;
}

function dedupeCardEffects(effects) {
    const seen = new Set();
    const deduped = [];

    (Array.isArray(effects) ? effects : []).forEach(effect => {
        const key = cardEffectDedupeKey(effect);
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(effect);
    });

    return deduped;
}

function hydrateCustomCardEffects(card) {
    const text = String(card.effect || card.effects?.map(effect => effect.generatedText || effect.text || effect.sourceText).join("\n") || "");
    const lowerText = text.toLowerCase();
    const name = String(card.name || "").toLowerCase();
    const effects = Array.isArray(card.effects) ? [...card.effects] : [];
    const hasAction = actionId => effects.some(effect => effect.actionId === actionId);
    const hasEffectId = id => effects.some(effect => effect.id === id);
    const pushEffect = effect => {
        if (!hasEffectId(effect.id)) effects.push(effect);
    };

    if (card.cardType === "leader" && name.includes("joseph joestar")) {
        pushEffect({
            id: `${card.cardNumber}-leader-end-turn-draw`,
            type: "endOfYourTurn",
            text: "End of Your Turn: If you have 3 or more attached DON!! cards, draw 1 card.",
            actionId: "drawOneIfAttachedDonAtLeast",
            requiredAttachedDon: 3
        });
        pushEffect({
            id: `${card.cardNumber}-leader-when-attacking-hamon-event`,
            type: "whenAttacking",
            text: "When Attacking: Activate up to 1 {Hamon} type Event from your hand. Trash it, then draw 1 card.",
            actionId: "activateHamonEventFromHandThenDraw",
            optional: true
        });
    }

    if (card.cardType === "leader" && name.includes("dio")) {
        card.faceUpLifeRule = true;
        pushEffect({
            id: `${card.cardNumber}-leader-life-rule`,
            type: "continuous",
            text: "Your and your opponent's life cards are always face up.",
            actionId: "faceUpLifeRule"
        });
        pushEffect({
            id: `${card.cardNumber}-leader-when-attacking-life-cycle`,
            type: "whenAttacking",
            text: "When Attacking: DON!! x1: Look at the top card of you or your opponent's life. You may place that card at the bottom of the owner's deck. If you do, the owner adds the top card of their deck to the top of their Life.",
            actionId: "cycleTopLifeCard",
            requiredTokens: 1,
            optional: true
        });
    }

    if (lowerText.includes("attach up to 2 rested don") && !hasAction("attachRestedDonToLeaderOrCharacter")) {
        pushEffect({
            id: `${card.cardNumber}-import-attach-rested-don`,
            type: lowerText.includes("on play") ? "onPlay" : "whenAttacking",
            text,
            actionId: "attachRestedDonToLeaderOrCharacter",
            amount: 2,
            distribute: lowerText.includes("any way"),
            optional: true
        });
    }

    if (
        (lowerText.includes("trash this character") || lowerText.includes("trash this card")) &&
        lowerText.includes("rest") &&
        lowerText.includes("opponent") &&
        !hasAction("trashSelfThenRestOpponentCard")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-trash-self-rest-opponent`,
            type: "activateMain",
            text,
            actionId: "trashSelfThenRestOpponentCard",
            optional: true,
            oncePerTurn: lowerText.includes("once per turn")
        });
    }

    if (lowerText.includes("look at the top 5") && lowerText.includes("bizarre") && !hasAction("lookTopFiveTypeAddOne")) {
        pushEffect({
            id: `${card.cardNumber}-import-search-bizarre`,
            type: "onPlay",
            text,
            actionId: "lookTopFiveTypeAddOne",
            typeText: "Bizarre"
        });
    }

    if (lowerText.includes("look at the top 5") && lowerText.includes("hamon") && !hasAction("lookTopFiveTypeAddOne") && !hasAction("lookTopFiveTypeThenDrawOne")) {
        pushEffect({
            id: `${card.cardNumber}-import-search-hamon`,
            type: "onPlay",
            text,
            actionId: lowerText.includes("draw 1") ? "lookTopFiveTypeThenDrawOne" : "lookTopFiveTypeAddOne",
            typeText: "Hamon"
        });
    }

    if (lowerText.includes("messina") && lowerText.includes("draw 1") && !hasAction("drawOneIfOwnNamedCharacter")) {
        pushEffect({
            id: `${card.cardNumber}-import-messina-draw`,
            type: "onPlay",
            text,
            actionId: "drawOneIfOwnNamedCharacter",
            requiredName: "Messina"
        });
    }

    if (lowerText.includes("play up to 1 [loggins]") && !hasAction("restDonPlayNamedCharacterFromHand")) {
        pushEffect({
            id: `${card.cardNumber}-import-play-loggins`,
            type: "onPlay",
            text,
            actionId: "restDonPlayNamedCharacterFromHand",
            costActiveDon: 1,
            requiredName: "Loggins",
            optional: true
        });
    }

    if (
        lowerText.includes("joseph joestar") &&
        lowerText.includes("hamon master") &&
        (lowerText.includes("cost of 7 or less") || lowerText.includes("cost 7 or less") || lowerText.includes("cost of 7")) &&
        !hasAction("searchPlayOrPlayFromHand")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-search-joseph-or-play-hamon-master`,
            type: "onPlay",
            text,
            actionId: "searchPlayOrPlayFromHand",
            amount: 5,
            add: 1,
            nameIncludes: "Joseph Joestar",
            toField: "characterField",
            destination: "bottomDeck",
            fallbackTypeText: "Hamon Master",
            fallbackCardTypeFilter: "character",
            fallbackMaxCost: 7,
            fallbackToField: "characterField",
            fallbackAmount: 1
        });
    }

    if (
        (name.includes("zoom punch") || (lowerText.includes("unblockable") && lowerText.includes("rest 2"))) &&
        !hasAction("restDonGiveKeyword")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-main-zoom-punch`,
            type: "main",
            text: "Main: Rest 2 DON!! cards: Up to 1 of your cards gains unblockable during this turn.",
            actionId: "restDonGiveKeyword",
            costActiveDon: 2,
            target: "own_card",
            keyword: "unblockable",
            duration: "turn"
        });
    }

    if (
        (name.includes("zoom punch") || (lowerText.includes("trash 1 card from your hand") && lowerText.includes("leader gain +3000"))) &&
        !hasAction("trashHandThenPower")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-counter-trash-hand-leader-power`,
            type: "counter",
            text: "Counter: Trash 1 card from your hand: up to 1 of your Leader gains +3000 power during this battle.",
            actionId: "trashHandThenPower",
            trashCount: 1,
            target: "leader",
            powerModifier: 3000,
            duration: "battle"
        });
    }

    if (
        (name.includes("stand arrow") || (lowerText.includes("blocker") && /\bowner'?s deck\b/.test(lowerText) && lowerText.includes("rest 5"))) &&
        !hasAction("restDonPlaceOpponentCardOnDeck")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-main-stand-arrow`,
            type: "main",
            text: "Main: Rest 5 DON!! cards: Place up to 1 opposing Blocker at the top or bottom of the owner's deck.",
            actionId: "restDonPlaceOpponentCardOnDeck",
            costActiveDon: 5,
            keyword: "Blocker",
            destination: "top_or_bottom_deck"
        });
    }

    if (
        name.includes("stand arrow") &&
        !hasAction("trashHandThenPower")
    ) {
        pushEffect({
            id: `${card.cardNumber}-import-counter-stand-arrow`,
            type: "counter",
            text: "Counter: Trash 1 card from your hand: up to 1 of your Leader or Characters gains +3000 power during this battle.",
            actionId: "trashHandThenPower",
            trashCount: 1,
            target: "leader_or_character",
            powerModifier: 3000,
            duration: "battle"
        });
    }

    if (lowerText.includes("[loggins]") && lowerText.includes("set this card as active") && !hasAction("trashOwnNamedCharacterSetSourceActive")) {
        pushEffect({
            id: `${card.cardNumber}-import-loggins-refresh`,
            type: "whenAttacking",
            text,
            actionId: "trashOwnNamedCharacterSetSourceActive",
            requiredName: "Loggins",
            oncePerTurn: lowerText.includes("once per turn")
        });
    }

    if (lowerText.includes("don!! x1") && lowerText.includes("+2000 power") && !hasAction("attachedDonPower")) {
        pushEffect({
            id: `${card.cardNumber}-import-your-turn-don-power`,
            type: "yourTurn",
            text,
            actionId: "attachedDonPower",
            requiredTokens: 1,
            powerModifier: 2000
        });
    }

    if ((name.includes("sunlight yellow overdrive") || lowerText.includes("attach up to 3 rested don")) && !hasAction("attachRestedDonToCharactersThenDraw")) {
        pushEffect({
            id: `${card.cardNumber}-import-main-sunlight-overdrive`,
            type: "main",
            text,
            actionId: "attachRestedDonToCharactersThenDraw",
            amount: 3
        });
    }

    if ((name.includes("sunlight yellow overdrive") || lowerText.includes("return up to 1 character with a cost of 3 or less")) && !hasAction("turnPowerThenBounceCostCharacter")) {
        pushEffect({
            id: `${card.cardNumber}-import-counter-sunlight-overdrive`,
            type: "counter",
            text: "Counter: Up to 1 of your Leader or Character cards gains +3000 power during this battle. Then, return up to 1 character with a cost of 3 or less.",
            actionId: "turnPowerThenBounceCostCharacter",
            powerModifier: 3000,
            duration: "battle",
            maxCost: 3
        });
    }

    const hasTrashHandCounter = effects.some(effect => effect?.type === "counter" && effect.actionId === "trashHandThenPower");
    const fixedEffects = effects
        .filter(effect => {
            if (!hasTrashHandCounter || effect?.type !== "counter" || effect.actionId === "trashHandThenPower") {
                return true;
            }

            return ![
                "leaderOrCharacterCounterPower",
                "leaderOrCharacterTriggerPower",
                "leaderCounterPower"
            ].includes(effect.actionId);
        })
        .map(effect => {
        if (
            effect?.type === "counter" &&
            (
                name.includes("sunlight yellow overdrive") ||
                name.includes("hamon bubble cutters") ||
                name.includes("hamon clackers")
            )
        ) {
            return {
                ...effect,
                text: String(effect.text || text).replace(/during this turn/ig, "during this battle")
            };
        }

        if (effect?.actionId === "attachRestedDonToLeaderOrCharacter") {
            return {
                ...effect,
                type: lowerText.includes("on play") ? "onPlay" : effect.type,
                distribute: effect.distribute || lowerText.includes("any way")
            };
        }

        if (effect?.actionId === "turnPowerThenBounceCostCharacter") {
            return {
                ...effect,
                duration: "battle"
            };
        }

        return effect;
    });

    return {
        ...card,
        customEffectV2: Array.isArray(card.customEffectV2) ? card.customEffectV2 : effects.filter(effect => effect?.system === "customEffectV2"),
        effects: fixedEffects
    };
}

function normalizeImportedCardType(value) {
    const text = String(value || "").toLowerCase();

    if (text.includes("leader")) return "leader";
    if (text.includes("event")) return "event";
    if (text.includes("stage")) return "stage";
    if (text.includes("token")) return "token";
    return "character";
}

function cloneCard(card) {
    if (typeof structuredClone === "function") {
        return structuredClone(card);
    }

    return JSON.parse(JSON.stringify(card));
}

function getCardById(cardId) {
    const card = cardDatabase[cardId];

    if (!card) {
        console.error(`Card not found in database: ${cardId}`);
        return null;
    }

    return {
        ...cloneCard(card),
        instanceId: crypto.randomUUID(),
        state: "active",
        rested: false,
        attachedDon: 0
    };
}

window.loadCardDatabase = loadCardDatabase;
window.cardDatabase = cardDatabase;
window.leaders = leaders;
window.getCardById = getCardById;
