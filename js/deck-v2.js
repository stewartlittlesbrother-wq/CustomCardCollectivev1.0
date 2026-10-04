// Deck Builder: new layout (opt-in).
//
// Classic layout: nothing here runs except one small "Try the new layout" button.
// New layout (html.deck-v2, switched on with that button or ?deckv2=1): this file
// MOVES the existing Deck Builder controls into a slimmer arrangement - one filter
// row on top, the card pool across the full width, the deck docked at the bottom -
// and adds the menus and the deck check. It reuses the app's own elements, so every
// existing handler (search, filters, save, export, import, saved decks, DON!! decks,
// starting zones...) keeps working; menu entries simply click the original buttons.
// It is a classic script that runs after app.js, so it can see app.js's globals.
(function () {
    "use strict";

    const FLAG = "cc_deck_v2";
    const SIZE_KEY = "cc_deck_v2_size";
    const html = document.documentElement;
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const cap1 = (text) => text.charAt(0).toUpperCase() + text.slice(1);

    function switchLayout(enable) {
        try { localStorage.setItem(FLAG, enable ? "1" : "0"); } catch (e) { /* storage unavailable */ }
        window.location.reload();
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // ── Classic layout: just offer the switch ───────────────────────────────
    if (!html.classList.contains("deck-v2")) {
        const tabs = $(".deck-tabs");
        if (tabs) {
            const button = make("button", "v2-try", "✨ Try the new layout");
            button.type = "button";
            button.id = "v2Try";
            button.title = "A cleaner Deck Builder: filters in one row, the deck docked along the bottom. You can switch back at any time.";
            button.addEventListener("click", () => switchLayout(true));
            tabs.appendChild(button);
        }
        return;
    }

    if (typeof el === "undefined" || typeof state === "undefined") return;   // app.js didn't load

    // ── Menus ───────────────────────────────────────────────────────────────
    const menus = [];
    function closeMenus(except) {
        menus.forEach(([button, panel]) => {
            if (panel !== except) { panel.hidden = true; button.setAttribute("aria-expanded", "false"); }
        });
        resetClearConfirm();
    }
    function addMenu(button, panel) {
        menus.push([button, panel]);
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            const open = panel.hidden;
            closeMenus(panel);
            panel.hidden = !open;
            button.setAttribute("aria-expanded", String(open));
        });
    }
    function menuItem(label, onClick, className = "") {
        const item = make("button", `v2-item ${className}`.trim(), label);
        item.type = "button";
        item.addEventListener("click", () => { closeMenus(); onClick(); });
        return item;
    }
    document.addEventListener("click", (event) => { if (!event.target.closest(".v2-menu")) closeMenus(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenus(); });

    const click = (id) => { const target = document.getElementById(id); if (target) target.click(); };

    // ── Filter bar ──────────────────────────────────────────────────────────
    let resetButton = null;

    function buildFilterBar() {
        const stack = $(".filter-stack");
        if (!stack) return;
        const search = el.searchInput;
        const tip = $("#showSearchTips");
        const sortBox = $(".sort-buttons", stack);
        const rowBox = $(".filter-row", stack);
        const toggles = $$(".builder-size-toggle", stack);
        resetButton = el.resetFilters;

        const bar = make("div", "v2-fb");

        const searchWrap = make("div", "v2-search");
        searchWrap.append(search);
        if (tip) searchWrap.append(tip);
        bar.append(searchWrap);

        // Colors: dots that drive the original color wedges (so their handlers run).
        const dots = make("div", "v2-dots");
        dots.setAttribute("role", "group");
        dots.setAttribute("aria-label", "Color");
        const COLORS = { red: "#d94c4c", green: "#35d07f", blue: "#3b8eea", purple: "#8b65df", black: "#2b2e35", yellow: "#e6c84a" };
        Object.entries(COLORS).forEach(([color, hex]) => {
            const dot = make("button", "v2-dot");
            dot.type = "button";
            dot.dataset.color = color;
            dot.style.setProperty("--dot", hex);
            dot.title = cap1(color);
            dot.setAttribute("aria-label", cap1(color));
            dot.setAttribute("aria-pressed", "false");
            dots.append(dot);
        });
        dots.addEventListener("click", (event) => {
            const dot = event.target.closest(".v2-dot");
            if (!dot) return;
            const color = dot.dataset.color;
            if (el.colorFilter.value === color) {
                el.colorFilter.value = "";
                $$("[data-color-shortcut]").forEach(wedge => wedge.classList.remove("selected"));
                renderCardGrid();
            } else {
                const wedge = $(`[data-color-shortcut="${color}"]`);
                if (wedge) wedge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
        });
        bar.append(dots);

        // Type + cost: chips that drive the original selects.
        const typeChips = make("div", "v2-chips");
        typeChips.setAttribute("role", "group");
        typeChips.setAttribute("aria-label", "Type");
        [["leader", "Leader"], ["character", "Character"], ["event", "Event"], ["stage", "Stage"]].forEach(([value, label]) => {
            const chip = make("button", "v2-chip", label);
            chip.type = "button";
            chip.dataset.type = value;
            chip.setAttribute("aria-pressed", "false");
            typeChips.append(chip);
        });
        typeChips.addEventListener("click", (event) => {
            const chip = event.target.closest(".v2-chip");
            if (!chip) return;
            el.categoryFilter.value = el.categoryFilter.value === chip.dataset.type ? "" : chip.dataset.type;
            el.categoryFilter.dispatchEvent(new Event("input", { bubbles: true }));
        });
        bar.append(typeChips);

        const costChips = make("div", "v2-chips costs");
        costChips.setAttribute("role", "group");
        costChips.setAttribute("aria-label", "Cost");
        for (let cost = 0; cost <= 7; cost++) {
            const chip = make("button", "v2-chip", String(cost));
            chip.type = "button";
            chip.dataset.cost = String(cost);
            chip.setAttribute("aria-pressed", "false");
            costChips.append(chip);
        }
        costChips.addEventListener("click", (event) => {
            const chip = event.target.closest(".v2-chip");
            if (!chip) return;
            el.costFilter.value = el.costFilter.value === chip.dataset.cost ? "" : chip.dataset.cost;
            el.costFilter.dispatchEvent(new Event("input", { bubbles: true }));
        });
        bar.append(costChips);

        // Card size (inside the menu below)
        const sizeWrap = make("div", "v2-sizebox");
        const slider = document.createElement("input");
        slider.type = "range"; slider.min = "100"; slider.max = "210"; slider.value = "132";
        slider.setAttribute("aria-label", "Card size");
        try { slider.value = localStorage.getItem(SIZE_KEY) || "132"; } catch (e) { /* default */ }
        const applySize = () => {
            const panel = $(".collection-panel");
            if (panel) panel.style.setProperty("--v2-card-min", `${slider.value}px`);
        };
        slider.addEventListener("input", () => {
            applySize();
            try { localStorage.setItem(SIZE_KEY, slider.value); } catch (e) { /* not saved */ }
        });
        sizeWrap.append(slider);
        applySize();

        // Sort + the rarer filters + the two layout switches live in one menu.
        const moreWrap = make("div", "v2-menu-wrap");
        const moreButton = make("button", "v2-btn", "Sort & more ▾");
        moreButton.type = "button";
        const moreMenu = make("div", "v2-menu left");
        moreMenu.hidden = true;
        moreMenu.append(make("h5", "", "Sort by"));
        if (sortBox) moreMenu.append(sortBox);
        moreMenu.append(make("h5", "", "More filters"));
        if (rowBox) moreMenu.append(rowBox);
        moreMenu.append(make("h5", "", "Card size"), sizeWrap);
        if (toggles.length) { moreMenu.append(make("div", "v2-sep")); toggles.forEach(t => moreMenu.append(t)); }
        moreWrap.append(moreButton, moreMenu);
        addMenu(moreButton, moreMenu);
        bar.append(moreWrap);

        if (resetButton) {
            resetButton.className = "v2-link";
            resetButton.textContent = "Reset";
            resetButton.hidden = true;
            bar.append(resetButton);
        }

        stack.prepend(bar);
    }

    function syncFilters() {
        $$(".v2-dot").forEach(dot => dot.setAttribute("aria-pressed", String(el.colorFilter.value === dot.dataset.color)));
        $$(".v2-chip[data-type]").forEach(chip => chip.setAttribute("aria-pressed", String(el.categoryFilter.value === chip.dataset.type)));
        $$(".v2-chip[data-cost]").forEach(chip => chip.setAttribute("aria-pressed", String(el.costFilter.value === chip.dataset.cost)));
        if (resetButton) {
            const any = [el.searchInput, el.categoryFilter, el.colorFilter, el.setFilter, el.costFilter,
                el.powerFilter, el.counterFilter, el.rarityFilter, el.blockFilter].some(field => field && field.value);
            resetButton.hidden = !any;
        }
    }

    // ── Card pool: show how many copies are in the deck, add a "−" ──────────
    function decorateGrid() {
        $$("#cardGrid .card-tile").forEach(tile => {
            const id = tile.dataset.id;
            const image = $(".card-image", tile);
            if (image) image.dataset.qty = String((state.deck && state.deck[id]) || 0);
        });
    }

    // ── Deck dock ───────────────────────────────────────────────────────────
    let decksButton = null, pill = null, pillText = null, fill = null, bar = null, checksList = null, barsBox = null,
        typeBar = null, typeLegend = null, miniCurve = null, clearAsk = null, clearConfirm = null;

    // Rebuilt every time it opens, so it always shows what is saved right now.
    function fillDecksMenu(menu) {
        const decks = typeof savedDecks === "function" ? savedDecks() : [];
        menu.textContent = "";
        menu.append(make("h5", "", decks.length ? `Saved decks (${decks.length}) - click one to load it` : "Saved decks"));
        if (!decks.length) {
            menu.append(make("div", "v2-empty", "Nothing saved yet. Build a deck, give it a name and press Save."));
        } else {
            const list = make("div", "v2-decklist");
            decks.forEach((deck, index) => {
                const item = make("button", "v2-item v2-deck");
                item.type = "button";
                const leader = getCard(deck.leaderId);
                const count = typeof deckSnapshotCount === "function" ? deckSnapshotCount(deck.deck) : "";
                const text = make("span", "v2-deck-text");
                text.append(make("b", "", deck.name || `Deck ${index + 1}`),
                    make("small", "", `${leader ? leader.name : "No leader"} · ${count}/50`));
                item.append(text, make("span", "v2-load", "Load"));
                item.addEventListener("click", () => { closeMenus(); loadNamedDeck(index); });
                list.append(item);
            });
            menu.append(list);
        }
        menu.append(make("div", "v2-sep"),
            menuItem("Manage or delete saved decks…", () => click("savedDecksTab")),
            menuItem("DON!! decks…", () => click("donDeckTab")));
    }

    function resetClearConfirm() {
        if (clearAsk) clearAsk.hidden = false;
        if (clearConfirm) clearConfirm.hidden = true;
    }

    function buildDock() {
        const table = $(".deck-table");
        const board = $(".deck-board-scroll", table);
        if (!table || !board) return;

        const head = make("div", "v2-dockhead");

        // My decks: a clear green button that lists your saved decks, click one to load it.
        const decksWrap = make("div", "v2-menu-wrap");
        decksButton = make("button", "v2-btn v2-btn-green", "📂 My decks");
        decksButton.type = "button";
        decksButton.title = "Your saved decks: load one, or manage them";
        const decksMenu = make("div", "v2-menu up left v2-decks-menu");
        decksMenu.hidden = true;
        decksButton.addEventListener("click", () => fillDecksMenu(decksMenu));
        decksWrap.append(decksButton, decksMenu);
        addMenu(decksButton, decksMenu);
        head.append(decksWrap);

        const nameWrap = make("div", "v2-dname");
        nameWrap.append(el.deckName);
        head.append(nameWrap);

        const countWrap = make("div", "v2-dcount");
        const counts = $(".deck-counts", table);
        const strong = counts && $("strong", counts);
        if (strong) countWrap.append(strong);
        bar = make("div", "v2-pbar");
        fill = make("span");
        bar.append(fill);
        countWrap.append(bar);
        head.append(countWrap);

        // The deck check: one pill, details on demand.
        const checkWrap = make("div", "v2-menu-wrap");
        pill = make("button", "v2-pill todo");
        pill.type = "button";
        pill.append(make("i", "", "…"));
        pillText = make("span", "", "Deck check");
        pill.append(pillText);
        const checkMenu = make("div", "v2-menu up left");
        checkMenu.hidden = true;
        checkMenu.style.minWidth = "300px";
        checksList = make("ul", "v2-checks");
        barsBox = make("div", "v2-bars");
        const axis = make("div", "v2-axis");
        ["0", "1", "2", "3", "4", "5", "6", "7", "8+"].forEach(label => axis.append(make("span", "", label)));
        typeBar = make("div", "v2-typebar");
        typeLegend = make("div", "v2-typelegend");
        checkMenu.append(make("h5", "", "Deck check"), checksList, make("div", "v2-sep"),
            make("h5", "", "Cost curve"), barsBox, axis, make("div", "v2-sep"),
            make("h5", "", "Card types"), typeBar, typeLegend);
        checkWrap.append(pill, checkMenu);
        addMenu(pill, checkMenu);
        head.append(checkWrap);

        miniCurve = make("div", "v2-mini-curve");
        miniCurve.setAttribute("aria-hidden", "true");
        head.append(miniCurve);

        const actions = make("div", "v2-dactions");

        // Export / import
        const exportWrap = make("div", "v2-menu-wrap");
        const exportButton = make("button", "v2-btn", "Export ▾");
        exportButton.type = "button";
        const exportMenu = make("div", "v2-menu up");
        exportMenu.hidden = true;
        exportMenu.append(
            menuItem("Copy as text", () => click("exportDeck")),
            menuItem("Save as image", () => click("exportDeckImage")),
            menuItem("Print", () => click("printDeck")),
            make("div", "v2-sep"),
            menuItem("Import a deck…", () => click("importDeck")));
        exportWrap.append(exportButton, exportMenu);
        addMenu(exportButton, exportMenu);
        actions.append(exportWrap);

        // More: deck rules, clear, back to classic
        const moreWrap = make("div", "v2-menu-wrap");
        const moreButton = make("button", "v2-btn icon", "⋯");
        moreButton.type = "button";
        moreButton.title = "More";
        moreButton.setAttribute("aria-label", "More");
        const moreMenu = make("div", "v2-menu up");
        moreMenu.hidden = true;
        moreMenu.append(make("h5", "", "Deck rules"));
        if (counts) $$(".deck-size-toggle", counts).forEach(toggle => moreMenu.append(toggle));
        moreMenu.append(make("div", "v2-sep"));
        clearAsk = menuItem("Clear deck…", () => {}, "danger");
        clearAsk.addEventListener("click", (event) => {
            event.stopPropagation();
            closeMenus(moreMenu);
            moreMenu.hidden = false;
            clearAsk.hidden = true;
            clearConfirm.hidden = false;
            $(".v2-clear-text", clearConfirm).textContent = `Remove all ${deckMainCount()} cards and the leader?`;
        });
        clearConfirm = make("div", "v2-confirm");
        clearConfirm.hidden = true;
        const clearText = make("span", "v2-clear-text", "Remove everything?");
        const clearRow = make("div");
        const clearYes = make("button", "v2-btn", "Clear deck");
        clearYes.type = "button";
        clearYes.style.color = "#ffb3b3";
        clearYes.addEventListener("click", (event) => { event.stopPropagation(); closeMenus(); click("clearDeck"); });
        const clearNo = make("button", "v2-btn", "Keep it");
        clearNo.type = "button";
        clearNo.addEventListener("click", (event) => { event.stopPropagation(); closeMenus(); });
        clearRow.append(clearYes, clearNo);
        clearConfirm.append(clearText, clearRow);
        moreMenu.append(clearAsk, clearConfirm, make("div", "v2-sep"),
            menuItem("Switch back to the classic layout", () => switchLayout(false)));
        moreWrap.append(moreButton, moreMenu);
        addMenu(moreButton, moreMenu);
        actions.append(moreWrap);

        if (el.saveDeckMini) actions.append(el.saveDeckMini);
        head.append(actions);

        table.insertBefore(head, board);

        // When the dock is dragged tall, let the cards wrap instead of scrolling sideways.
        const list = el.deckList;
        if (list && "ResizeObserver" in window) {
            new ResizeObserver(() => list.classList.toggle("v2-wrap", table.clientHeight >= 340)).observe(table);
        }
    }

    // ── Keeping the new pieces in step with the deck ────────────────────────
    function refreshDock() {
        if (!fill) return;
        const total = deckMainCount();
        const leader = getCard(state.leaderId);
        const anySize = typeof allowAnyDeckSize === "function" ? allowAnyDeckSize() : false;
        const target = 50;

        fill.style.width = `${anySize ? 100 : Math.min(100, (total / target) * 100)}%`;
        bar.className = "v2-pbar" + (!anySize && total === target ? " full" : "") + (!anySize && total > target ? " over" : "");

        // checks
        const items = [];
        if (!leader) items.push(["todo", "Pick a leader"]);
        else items.push(["ok", `Leader: ${escapeHtml(leader.name)}`]);
        if (state.dualLeader && !getCard(state.leaderId2)) items.push(["todo", "Pick the second leader (Dual Leader)"]);
        if (anySize) items.push(["ok", `${total} cards <small>(any size allowed)</small>`]);
        else if (total === target) items.push(["ok", "50 cards"]);
        else if (total < target) items.push(["todo", `${total} of 50 cards <small>· ${target - total} to go</small>`]);
        else items.push(["bad", `${total - target} card${total - target === 1 ? "" : "s"} over 50`]);

        const entries = deckEntries();
        const overLimit = entries.filter(entry => entry.qty > cardCopyLimit(entry.card)).length;
        items.push(overLimit
            ? ["bad", `${overLimit} card${overLimit === 1 ? "" : "s"} over the copy limit`]
            : ["ok", "No card over its copy limit"]);

        const symbol = { ok: "✓", todo: "…", bad: "✕" };
        const word = { ok: "Passed", todo: "In progress", bad: "Problem" };
        checksList.innerHTML = items.map(([status, text]) =>
            `<li><span class="v2-ck ${status}" aria-hidden="true">${symbol[status]}</span><span><span class="v2-hide" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${word[status]}: </span>${text}</span></li>`).join("");

        const problems = items.filter(item => item[0] === "bad").length;
        const pending = items.find(item => item[0] === "todo");
        const tone = problems ? "bad" : pending ? "todo" : "ok";
        pill.className = `v2-pill ${tone}`;
        pill.firstChild.textContent = symbol[tone];
        pillText.textContent = problems
            ? `${problems} problem${problems === 1 ? "" : "s"}`
            : !leader ? "Pick a leader"
            : (state.dualLeader && !getCard(state.leaderId2)) ? "Pick 2nd leader"
            : (!anySize && total < target) ? `${target - total} to go`
            : "Deck is ready";

        // cost curve + card types
        const buckets = Array(9).fill(0);
        const types = { character: 0, event: 0, stage: 0 };
        entries.forEach(({ card, qty }) => {
            const cost = Number(card.cost);
            buckets[Math.min(8, Number.isFinite(cost) ? Math.max(0, cost) : 0)] += qty;
            if (card.category in types) types[card.category] += qty;
        });
        const max = Math.max(1, ...buckets);
        barsBox.innerHTML = buckets.map((value, index) =>
            `<div class="v2-bar" title="${value} at cost ${index === 8 ? "8+" : index}"><span class="${value ? "" : "zero"}" style="height:${value ? Math.max(10, Math.round((value / max) * 100)) : 4}%">${value ? `<em>${value}</em>` : ""}</span></div>`).join("");
        miniCurve.innerHTML = buckets.map((value, index) =>
            `<span class="${value ? "" : "zero"}" style="height:${value ? Math.max(14, Math.round((value / max) * 100)) : 6}%" title="${value} at cost ${index === 8 ? "8+" : index}"></span>`).join("");
        const typeColor = { character: "#10b981", event: "#3b8eea", stage: "#e2b451" };
        typeBar.innerHTML = total
            ? Object.entries(types).filter(([, value]) => value).map(([key, value]) => `<span style="flex:${value};background:${typeColor[key]}"></span>`).join("")
            : "";
        typeLegend.innerHTML = Object.entries(types).map(([key, value]) =>
            `<span><i style="background:${typeColor[key]}"></i>${cap1(key)}s <b>${value}</b></span>`).join("");

        if (decksButton) {
            const saved = typeof savedDecks === "function" ? savedDecks().length : 0;
            decksButton.textContent = saved ? `📂 My decks (${saved})` : "📂 My decks";
        }

        // Names on the deck's cards (shown as a tooltip; the hover preview shows the art).
        $$(".deck-list .deck-row[data-card-id], #leaderSlot .deck-row[data-card-id]").forEach(row => {
            const card = getCard(row.dataset.cardId);
            if (card) row.title = card.name;
        });
    }

    // ── Wire it up ──────────────────────────────────────────────────────────
    function setup() {
        if (!$(".builder-window")) return;
        buildFilterBar();
        buildDock();

        // "−" on a card in the pool removes one copy.
        el.cardGrid.addEventListener("click", (event) => {
            const button = event.target.closest('[data-action="remove"]');
            if (!button) return;
            const tile = button.closest(".card-tile");
            if (tile && typeof removeFromDeck === "function") removeFromDeck(tile.dataset.id);
        });

        // The app re-draws these areas by replacing their contents, so watch them
        // (rather than wrapping the app's functions, which some listeners captured).
        let pending = false;
        const schedule = () => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                try { decorateGrid(); syncFilters(); refreshDock(); } catch (error) { console.warn("Deck layout refresh failed:", error); }
            });
        };
        [el.cardGrid, el.deckList, el.leaderSlot, el.deckWarnings, el.savedDeckList].forEach(node => {
            if (node) new MutationObserver(schedule).observe(node, { childList: true });
        });
        const stack = $(".filter-stack");
        if (stack) ["input", "change", "click"].forEach(type => stack.addEventListener(type, schedule, true));
        schedule();
    }

    setup();
})();
