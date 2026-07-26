// presetDecks.js

// =========================
// Page State
// =========================

let presetDecks = [];
let cardsReady = false;

// =========================
// Page Setup
// =========================

document.addEventListener("DOMContentLoaded", async () => {
    await initializePresetDecksPage();
});

// =========================
// Initialization
// =========================

async function initializePresetDecksPage() {
    try {
        if (typeof loadCardDatabase === "function") {
            await loadCardDatabase();
            cardsReady = true;
        } else {
            console.warn("loadCardDatabase() was not found. Deck images may not load.");
        }

        presetDecks = getAvailableDecksSafe();

        renderPresetDecks(presetDecks);
        setupDeckSearch();
        setupModalCloseEvents();
    } catch (error) {
        console.error(error);
        presetDecks = getAvailableDecksSafe();

        renderPresetDecks(presetDecks);
        setupDeckSearch();
    }
}

// =========================
// Deck Loading
// =========================

function getAvailableDecksSafe() {
    if (typeof getAvailableDecks !== "function") {
        console.error("getAvailableDecks() was not found. Make sure decks.js is loaded before presetDecks.js.");
        return [];
    }

    return getAvailableDecks();
}

// =========================
// Rendering
// =========================

function renderPresetDecks(decks) {
    const grid = document.getElementById("presetDecksGrid");
    const emptyMessage = document.getElementById("emptyDecksMessage");
    const deckCountText = document.getElementById("deckCountText");

    if (!grid || !emptyMessage || !deckCountText) return;

    grid.innerHTML = "";

    deckCountText.textContent = `${decks.length} preset deck${decks.length === 1 ? "" : "s"} available`;

    if (decks.length === 0) {
        emptyMessage.classList.remove("hidden");
        return;
    }

    emptyMessage.classList.add("hidden");

    decks.forEach(deck => {
        grid.appendChild(createDeckCard(deck));
    });
}

function createDeckCard(deck) {
    const card = document.createElement("article");
    card.className = "preset-deck-card";

    const parsedDeckLines = parseDeckLines(deck.deckText);
    const totalCards = getTotalCardCount(parsedDeckLines);
    const uniqueCards = parsedDeckLines.length;
    const leaderCard = getLeaderCard(deck.leaderKey);
    const coverCard = leaderCard || getFirstExistingCard(parsedDeckLines);

    const header = document.createElement("div");
    header.className = "deck-card-header";

    const title = document.createElement("h3");
    title.textContent = deck.name;

    const badge = document.createElement("span");
    badge.className = "deck-id-badge";
    badge.textContent = deck.id;

    header.appendChild(title);
    header.appendChild(badge);

    const coverRow = document.createElement("div");
    coverRow.className = "deck-cover-row";

    if (coverCard?.image) {
        const coverImage = document.createElement("img");
        coverImage.className = "deck-cover-image";
        coverImage.src = coverCard.image;
        coverImage.alt = coverCard.name;
        coverRow.appendChild(coverImage);
    }

    const coverInfo = document.createElement("div");
    coverInfo.className = "deck-cover-info";
    coverInfo.innerHTML = `
        <strong>${escapeHtml(leaderCard?.name || deck.leaderKey || "Unknown Leader")}</strong>
        <span>Click “View Cards” to open the deck image gallery.</span>
    `;

    coverRow.appendChild(coverInfo);

    const meta = document.createElement("div");
    meta.className = "deck-meta";

    meta.appendChild(createMetaItem("Leader", leaderCard?.name || deck.leaderKey));
    meta.appendChild(createMetaItem("Cards", `${totalCards} total`));
    meta.appendChild(createMetaItem("Unique", `${uniqueCards} cards`));
    meta.appendChild(createMetaItem("Format", "Preset"));

    const deckList = document.createElement("div");
    deckList.className = "deck-list-preview";
    deckList.innerHTML = parsedDeckLines.length > 0
        ? parsedDeckLines.map(line => `<div>${escapeHtml(line.raw)}</div>`).join("")
        : `<div>No cards listed.</div>`;

    const actions = document.createElement("div");
    actions.className = "deck-actions";

    const viewButton = document.createElement("button");
    viewButton.className = "deck-action-button primary";
    viewButton.textContent = "View Cards";

    viewButton.addEventListener("click", () => {
        openDeckImageModal(deck);
    });

    const useButton = document.createElement("button");
    useButton.className = "deck-action-button secondary";
    useButton.textContent = "Use in VS Self";

    useButton.addEventListener("click", () => {
        useDeckInVsSelf(deck.id);
    });

    actions.appendChild(viewButton);
    actions.appendChild(useButton);

    card.appendChild(header);
    card.appendChild(coverRow);
    card.appendChild(meta);
    card.appendChild(deckList);
    card.appendChild(actions);

    card.addEventListener("dblclick", () => {
        openDeckImageModal(deck);
    });

    return card;
}

function createMetaItem(label, value) {
    const item = document.createElement("div");
    item.className = "deck-meta-item";

    const labelElement = document.createElement("span");
    labelElement.className = "deck-meta-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "deck-meta-value";
    valueElement.textContent = value || "Unknown";

    item.appendChild(labelElement);
    item.appendChild(valueElement);

    return item;
}

// =========================
// Deck Image Modal
// =========================

function openDeckImageModal(deck) {
    closeDeckImageModal();

    const parsedDeckLines = parseDeckLines(deck.deckText);
    const leaderCard = getLeaderCard(deck.leaderKey);
    const cardEntries = getDeckCardEntries(parsedDeckLines);
    const totalCards = getTotalCardCount(parsedDeckLines);

    const overlay = document.createElement("div");
    overlay.className = "deck-modal-overlay";
    overlay.id = "deckModalOverlay";

    const modal = document.createElement("section");
    modal.className = "deck-modal";

    const header = document.createElement("header");
    header.className = "deck-modal-header";

    const titleGroup = document.createElement("div");

    const title = document.createElement("h2");
    title.textContent = deck.name;

    const subtitle = document.createElement("p");
    subtitle.textContent = `${totalCards} cards • ${cardEntries.length} unique cards`;

    titleGroup.appendChild(title);
    titleGroup.appendChild(subtitle);

    const closeButton = document.createElement("button");
    closeButton.className = "deck-modal-close";
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close deck image preview");

    closeButton.addEventListener("click", closeDeckImageModal);

    header.appendChild(titleGroup);
    header.appendChild(closeButton);

    const content = document.createElement("div");
    content.className = "deck-modal-content";

    if (leaderCard) {
        const leaderSection = createImageSection("Leader", [
            {
                quantity: 1,
                card: leaderCard,
                cardId: deck.leaderKey
            }
        ]);

        content.appendChild(leaderSection);
    }

    const mainDeckSection = createImageSection("Main Deck", cardEntries);
    content.appendChild(mainDeckSection);

    modal.appendChild(header);
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

function closeDeckImageModal() {
    const oldOverlay = document.getElementById("deckModalOverlay");

    if (oldOverlay) {
        oldOverlay.remove();
    }
}

function setupModalCloseEvents() {
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeDeckImageModal();
        }
    });

    document.addEventListener("click", event => {
        if (event.target?.id === "deckModalOverlay") {
            closeDeckImageModal();
        }
    });
}

function createImageSection(titleText, entries) {
    const section = document.createElement("section");
    section.className = "deck-image-section";

    const title = document.createElement("h3");
    title.textContent = titleText;

    const grid = document.createElement("div");
    grid.className = "deck-image-grid";

    entries.forEach(entry => {
        grid.appendChild(createDeckImageCard(entry));
    });

    section.appendChild(title);
    section.appendChild(grid);

    return section;
}

function createDeckImageCard(entry) {
    const wrapper = document.createElement("div");
    wrapper.className = "deck-image-card";

    const quantity = document.createElement("div");
    quantity.className = "deck-image-qty";
    quantity.textContent = `x${entry.quantity}`;

    wrapper.appendChild(quantity);

    if (entry.card?.image) {
        const img = document.createElement("img");
        img.src = entry.card.image;
        img.alt = entry.card.name;

        const name = document.createElement("span");
        name.className = "deck-image-name";
        name.textContent = entry.card.name;

        wrapper.appendChild(img);
        wrapper.appendChild(name);
    } else {
        const missing = document.createElement("div");
        missing.className = "deck-image-missing";
        missing.textContent = `Missing card: ${entry.cardId}`;

        wrapper.appendChild(missing);
    }

    return wrapper;
}

// =========================
// Search
// =========================

function setupDeckSearch() {
    const searchInput = document.getElementById("deckSearchInput");

    if (!searchInput) return;

    searchInput.addEventListener("input", () => {
        const searchValue = searchInput.value.trim().toLowerCase();

        const filteredDecks = presetDecks.filter(deck => {
            const searchableText = [
                deck.id,
                deck.name,
                deck.leaderKey,
                deck.deckText
            ]
                .join(" ")
                .toLowerCase();

            return searchableText.includes(searchValue);
        });

        renderPresetDecks(filteredDecks);
    });
}

// =========================
// Deck Helpers
// =========================

function parseDeckLines(deckText) {
    if (!deckText) return [];

    return deckText
        .trim()
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const parts = line.split("x");
            const amount = Number(parts[0]);
            const cardId = parts[1]?.trim() || "";

            return {
                raw: line,
                amount: Number.isNaN(amount) ? 0 : amount,
                cardId
            };
        });
}

function getTotalCardCount(deckLines) {
    return deckLines.reduce((total, line) => {
        return total + line.amount;
    }, 0);
}

function getDeckCardEntries(deckLines) {
    return deckLines.map(line => {
        return {
            quantity: line.amount,
            cardId: line.cardId,
            card: getCardDataById(line.cardId)
        };
    });
}

function getLeaderCard(leaderKey) {
    if (!leaderKey) return null;

    if (window.leaders && window.leaders[leaderKey]) {
        return window.leaders[leaderKey];
    }

    return getCardDataById(leaderKey);
}

function getFirstExistingCard(deckLines) {
    for (const line of deckLines) {
        const card = getCardDataById(line.cardId);

        if (card) {
            return card;
        }
    }

    return null;
}

function getCardDataById(cardId) {
    if (!cardsReady || !cardId) return null;

    if (window.cardDatabase && window.cardDatabase[cardId]) {
        return window.cardDatabase[cardId];
    }

    if (window.leaders && window.leaders[cardId]) {
        return window.leaders[cardId];
    }

    return null;
}

function useDeckInVsSelf(deckId) {
    localStorage.setItem("player1SelectedDeck", deckId);
    localStorage.setItem("player2SelectedDeck", deckId);

    window.location.href = "self.html";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}