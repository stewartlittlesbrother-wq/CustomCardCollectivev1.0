// play.js

const deckSelectionStorageKey = "customCardsDeckSelection";

function getSavedDeckSelection() {
    try {
        return JSON.parse(localStorage.getItem(deckSelectionStorageKey)) || {};
    } catch (error) {
        return {};
    }
}

function saveDeckSelection(player1DeckId, player2DeckId) {
    localStorage.setItem(
        deckSelectionStorageKey,
        JSON.stringify({
            player1DeckId,
            player2DeckId
        })
    );
}

function populateDeckSelect(selectElement, selectedDeckId) {
    if (!selectElement || !window.getAvailableDecks) return;

    selectElement.innerHTML = "";

    window.getAvailableDecks().forEach(deck => {
        const option = document.createElement("option");

        option.value = deck.id;
        option.textContent = deck.name;
        option.selected = deck.id === selectedDeckId;

        selectElement.appendChild(option);
    });
}

function updateSelfPlayLink() {
    const player1DeckSelect = document.getElementById("player1DeckSelect");
    const player2DeckSelect = document.getElementById("player2DeckSelect");
    const selfPlayLink = document.getElementById("selfPlayLink");

    if (!player1DeckSelect || !player2DeckSelect || !selfPlayLink) return;

    const player1DeckId = player1DeckSelect.value;
    const player2DeckId = player2DeckSelect.value;

    saveDeckSelection(player1DeckId, player2DeckId);

    const params = new URLSearchParams({
        player1Deck: player1DeckId,
        player2Deck: player2DeckId
    });

    selfPlayLink.href = `self.html?${params.toString()}`;
}

function initializeDeckPicker() {
    const player1DeckSelect = document.getElementById("player1DeckSelect");
    const player2DeckSelect = document.getElementById("player2DeckSelect");

    if (!player1DeckSelect || !player2DeckSelect || !window.getAvailableDecks) return;

    const savedSelection = getSavedDeckSelection();
    const defaultDeckId = window.getAvailableDecks()[0]?.id || "";

    populateDeckSelect(
        player1DeckSelect,
        savedSelection.player1DeckId || defaultDeckId
    );

    populateDeckSelect(
        player2DeckSelect,
        savedSelection.player2DeckId || defaultDeckId
    );

    player1DeckSelect.addEventListener("change", updateSelfPlayLink);
    player2DeckSelect.addEventListener("change", updateSelfPlayLink);

    updateSelfPlayLink();
}

document.addEventListener("DOMContentLoaded", initializeDeckPicker);
