// deckParser.js

function parseDeckText(deckText) {
    const deck = [];
    const lines = deckText.trim().split("\n");

    lines.forEach(line => {
        const cleanLine = line.trim();

        if (!cleanLine) return;

        const parts = cleanLine.split("x");

        if (parts.length !== 2) {
            console.error(`Invalid deck line: ${cleanLine}`);
            return;
        }

        const amount = parseInt(parts[0], 10);
        const cardId = parts[1].trim();

        for (let i = 0; i < amount; i++) {
            const card = getCardById(cardId);

            if (card) {
                deck.push(card);
            }
        }
    });

    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const randomIndex = Math.floor(Math.random() * (i + 1));

        [deck[i], deck[randomIndex]] = [deck[randomIndex], deck[i]];
    }

    return deck;
}

// Cards the deck is set to START already in play (chosen in the Deck Builder).
// `startingCards` is a list of { id, zone } - ONE entry per copy. Pull each out
// of the freshly-built (already shuffled) deck array into its zone so the match
// opens with them placed. Board zones (characters/stage) get active state and a
// fresh instanceId; life cards go face-down. Cards are CLONED before placing so
// pooled/shared card objects (practice decks reuse one object per card id) can't
// bleed state between copies. Zone caps: stage 1, character field 5.
//
// `player` is a state object with array zones deck/hand/life/trash/characters
// and a single `stage`. Mutated in place. Safe to call with an empty list.
function applyStartingCards(player, startingCards) {
    if (!player || !Array.isArray(startingCards) || !startingCards.length) return;
    if (!Array.isArray(player.deck)) return;

    const CAPS = { characters: 5, stage: 1, hand: Infinity, life: Infinity, trash: Infinity };
    const used = { characters: 0, stage: 0, hand: 0, life: 0, trash: 0 };

    startingCards.forEach(entry => {
        const id = entry && entry.id;
        const zone = entry && entry.zone;
        if (!id || !(zone in used)) return;
        if (used[zone] >= CAPS[zone]) return;

        const idx = player.deck.findIndex(c => c && (c.cardNumber === id || c.id === id));
        if (idx === -1) return;

        const raw = player.deck.splice(idx, 1)[0];
        const card = { ...raw };
        if (!card.instanceId) {
            card.instanceId = `start-${Math.random().toString(36).slice(2)}`;
        }

        if (zone === "stage") {
            card.state = "active";
            player.stage = card;
        } else if (zone === "characters") {
            card.state = "active";
            (player.characters = player.characters || []).push(card);
        } else if (zone === "trash") {
            (player.trash = player.trash || []).push(card);
        } else if (zone === "life") {
            card.faceUp = false;
            (player.life = player.life || []).push(card);
        } else if (zone === "hand") {
            (player.hand = player.hand || []).push(card);
        }
        used[zone] += 1;
    });
}