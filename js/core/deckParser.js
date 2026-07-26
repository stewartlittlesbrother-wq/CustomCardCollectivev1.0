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