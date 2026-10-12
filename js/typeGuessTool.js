// "Guess missing types" - reads the types line off the pictures of cards that
// have no types and saves the reading as a search-only guess (the card's index
// entry `tg`, see cardLibraryService.saveTypeGuesses). Opened from the collection
// header in the Deck Builder by the admin / collection owners and editors.
//
// Confident readings are saved as they come in. Unsure ones are listed but NOT
// saved unless you press "Keep". Every saved guess can be removed again.

import { scanTypes, rescoreTypes, buildVocabulary, learnVocabulary, warmUp, READERS } from "./cardTypeScanner.js?v=2";

// Score (0-100) from which a reading is saved without asking. Measured on cards
// whose types were known - see the numbers next to scanCards.
export const CONFIDENT = 75;

/**
 * Scan a list of cards (no UI). Two steps:
 *   1. read every card (a few at a time), judged against the types its set
 *      already uses
 *   2. per collection, learn the types that several cards agree on and judge every
 *      reading again - this is what makes sets with NO types filled in work, since
 *      they have nothing to check a reading against at first
 * onResult(card, result, step) is called for every card in step 1, and in step 2
 * for each card whose result changed. Returns Map(card -> result).
 */
export async function scanCards({ cards, vocabCards, getImage, onResult, shouldStop }) {
    await warmUp();
    const stop = () => Boolean(shouldStop && shouldStop());
    const vocabs = new Map();
    const vocabFor = (collection) => {
        if (!vocabs.has(collection)) vocabs.set(collection, buildVocabulary(vocabCards(collection)));
        return vocabs.get(collection);
    };
    const results = new Map();
    let next = 0;
    // One loop per reader, so a few cards are read at the same time.
    const lane = async () => {
        while (!stop() && next < cards.length) {
            const card = cards[next++];
            let result = { found: false, types: "", confidence: 0, readings: [] };
            try {
                const image = await getImage(card);
                if (image) result = await scanTypes(image, { vocab: vocabFor(card.collection) });
            } catch (error) {
                console.warn("Type scan failed for", card.cardNumber, error);
            }
            results.set(card, result);
            if (onResult) await onResult(card, result, 1);
        }
    };
    await Promise.all(Array.from({ length: Math.min(READERS, cards.length) }, lane));

    const collections = new Set([...results.keys()].map(card => card.collection));
    for (const collection of collections) {
        const scanned = [...results.entries()].filter(([card]) => card.collection === collection);
        const learned = learnVocabulary(scanned.map(([, result]) => result), vocabFor(collection));
        if (learned.size === vocabFor(collection).size) continue;
        for (const [card, before] of scanned) {
            if (!before.readings || !before.readings.length) continue;
            const after = rescoreTypes(before, learned);
            if (after.types === before.types && after.confidence === before.confidence) continue;
            results.set(card, after);
            if (onResult) await onResult(card, after, 2);
        }
    }
    return results;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function injectStyles() {
    if (document.getElementById("tgToolStyles")) return;
    const style = document.createElement("style");
    style.id = "tgToolStyles";
    style.textContent = `
.tg-overlay { position: fixed; inset: 0; z-index: 2147483200; display: grid; place-items: center; background: rgba(0,0,0,.62); padding: 16px; }
.tg-dialog { width: min(620px, 96vw); max-height: 90vh; display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 14px;
  background: var(--surface, #101614); color: var(--ink, #f3f8f5); border: 1px solid var(--line, #263029); box-shadow: var(--shadow, 0 20px 60px rgba(0,0,0,.5)); }
.tg-dialog h2 { margin: 0; font-size: 1.1rem; }
.tg-dialog p { margin: 0; color: var(--muted, #9db1a8); font-size: .86rem; line-height: 1.45; }
.tg-row-opts { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; font-size: .85rem; }
.tg-row-opts label { display: inline-flex; flex-direction: row; gap: 6px; align-items: center; cursor: pointer; font-weight: 500; }
.tg-row-opts input { width: auto; margin: 0; }
.tg-bar { height: 8px; border-radius: 99px; background: var(--surface-3, #202a26); overflow: hidden; flex: none; }
.tg-bar > i { display: block; height: 100%; width: 0; background: var(--accent, #10b981); transition: width .25s; }
.tg-status { font-size: .84rem; color: var(--muted, #9db1a8); font-variant-numeric: tabular-nums; }
.tg-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line, #263029); padding-top: 8px; }
.tg-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 6px 8px; border-radius: 8px; background: var(--surface-2, #161d1a); font-size: .84rem; }
.tg-item .tg-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tg-item .tg-name small { font-weight: 500; color: var(--muted, #9db1a8); margin-left: 6px; }
.tg-item .tg-guess { grid-column: 1; color: var(--ink, #f3f8f5); overflow-wrap: anywhere; }
.tg-item.unsure .tg-guess { color: var(--muted, #9db1a8); }
.tg-item.none .tg-guess { color: var(--muted, #9db1a8); font-style: italic; }
.tg-item .tg-side { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 6px; align-items: center; }
.tg-badge { font-size: .72rem; font-weight: 800; letter-spacing: .04em; padding: 2px 7px; border-radius: 99px; background: var(--surface-3, #202a26); color: var(--muted, #9db1a8); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tg-item.saved .tg-badge { background: rgba(16, 185, 129, .2); color: var(--accent-neon, #4dff9e); }
.tg-dialog button.tg-btn { appearance: none; margin: 0; width: auto; min-width: 0; min-height: 0; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--line, #263029);
  background: var(--surface-3, #202a26); color: var(--ink, #f3f8f5); font: inherit; font-size: .85rem; font-weight: 700; cursor: pointer; box-shadow: none; text-transform: none; letter-spacing: 0; }
.tg-dialog button.tg-btn:hover { border-color: var(--accent, #10b981); }
.tg-dialog button.tg-btn.primary { background: var(--accent, #10b981); border-color: var(--accent, #10b981); color: #04140d; }
.tg-dialog button.tg-btn.small { padding: 3px 9px; font-size: .76rem; border-radius: 7px; }
.tg-dialog button.tg-btn:disabled { opacity: .5; cursor: default; }
.tg-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.tg-actions .tg-spacer { flex: 1; }
`;
    document.head.append(style);
}

/**
 * Open the tool.
 * options:
 *   title       - shown in the heading ("Barnyard")
 *   cards       - cards in scope (those with a type are ignored)
 *   vocabCards(collection) - every card of a collection (for the type dictionary)
 *   getImage(card) - Promise<HTMLImageElement|null> (CORS-clean)
 *   save(guesses)  - Promise; guesses = { storageKey: "A/B" | null }
 *   accept(types)  - optional. Promise<{ accepted: [keys], refused: [keys] }>;
 *                    types = { storageKey: "A/B" }. Makes guesses the REAL types.
 *   onChange()     - called after saves so the grid / search can refresh
 */
export function openTypeGuessTool(options) {
    injectStyles();
    document.getElementById("tgToolOverlay")?.remove();

    const candidates = (options.cards || []).filter(card => !String(card.type || "").trim() && card.__storageKey);
    const guessed = candidates.filter(card => card.typeGuess);

    const overlay = document.createElement("div");
    overlay.id = "tgToolOverlay";
    overlay.className = "tg-overlay";
    overlay.innerHTML = `
      <div class="tg-dialog" role="dialog" aria-modal="true" aria-labelledby="tgToolTitle">
        <h2 id="tgToolTitle">Guess missing types · ${esc(options.title || "")}</h2>
        <p>Reads the types line printed under each card's name (like “Human / Karakura Town”) for cards that have no types filled in.
           A saved guess only helps <b>search</b> find the card - it isn't shown as the card's types.
           Readings it isn't sure about are not saved unless you keep them.${options.accept ? `
           When the list looks right (remove any that are wrong), you can turn the saved guesses into the cards' real types.` : ""}</p>
        <div class="tg-row-opts">
          <span><b>${candidates.length}</b> card${candidates.length === 1 ? "" : "s"} without types${guessed.length ? ` · ${guessed.length} already guessed` : ""}</span>
          ${guessed.length ? `<label><input type="checkbox" data-tg-rescan> Scan those again too</label>` : ""}
        </div>
        <div class="tg-bar" hidden><i></i></div>
        <div class="tg-status" aria-live="polite"></div>
        <div class="tg-list" hidden></div>
        <div class="tg-actions">
          ${guessed.length ? `<button type="button" class="tg-btn" data-tg-clear>Remove all guesses</button>` : ""}
          ${options.accept ? `<button type="button" class="tg-btn" data-tg-accept hidden></button>` : ""}
          <span class="tg-spacer"></span>
          <button type="button" class="tg-btn" data-tg-close>Close</button>
          <button type="button" class="tg-btn primary" data-tg-start ${candidates.length ? "" : "disabled"}>Start scanning</button>
        </div>
      </div>`;
    document.body.append(overlay);

    const $ = (sel) => overlay.querySelector(sel);
    const bar = $(".tg-bar"), fill = $(".tg-bar > i"), status = $(".tg-status"), list = $(".tg-list");
    const startBtn = $("[data-tg-start]"), closeBtn = $("[data-tg-close]");
    let running = false, stopped = false;

    const close = () => { stopped = true; overlay.remove(); };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay && !running) close(); });

    const save = async (guesses) => {
        await options.save(guesses);
        Object.entries(guesses).forEach(([key, value]) => {
            candidates.filter(card => card.__storageKey === key).forEach(card => { card.typeGuess = value || ""; });
        });
        try { options.onChange && options.onChange(); } catch (_) {}
    };

    $("[data-tg-clear]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        if (button.dataset.armed !== "1") { button.dataset.armed = "1"; button.textContent = "Tap again to remove them"; return; }
        button.disabled = true;
        const guesses = {};
        candidates.filter(card => card.typeGuess).forEach(card => { guesses[card.__storageKey] = null; });
        try { await save(guesses); status.textContent = `Removed ${Object.keys(guesses).length} guesses.`; button.remove(); }
        catch (error) { status.textContent = `Couldn't remove them: ${error.message || error}`; button.disabled = false; }
    });

    // One row per card: { item, result, kept } - kept = its guess is saved.
    const rows = new Map();
    function setRow(card, result, kept) {
        let row = rows.get(card);
        if (!row) {
            row = { item: document.createElement("div") };
            rows.set(card, row);
            list.prepend(row.item);
        }
        row.result = result;
        row.kept = kept;
        row.item.className = `tg-item ${!result.found ? "none" : kept ? "saved" : "unsure"}`;
        row.item.innerHTML = `
          <div class="tg-name">${esc(card.name || "Card")}<small>${esc(card.cardNumber || "")}</small></div>
          <div class="tg-guess">${result.found ? esc(result.types) : "Couldn't read a types line"}</div>
          <div class="tg-side">
            ${result.found ? `<span class="tg-badge" title="How sure the reader is (0-100)">${kept ? "saved" : "not saved"}${result.confidence == null ? "" : ` · ${result.confidence}`}</span>` : ""}
            ${result.found ? `<button type="button" class="tg-btn small">${kept ? "Remove" : "Keep"}</button>` : ""}
          </div>`;
        row.item.querySelector("button")?.addEventListener("click", async (event) => {
            event.currentTarget.disabled = true;
            try {
                await save({ [card.__storageKey]: row.kept ? null : row.result.types });
                setRow(card, row.result, !row.kept);
                if (scanned) showCounts();
                refreshAccept();
            } catch (error) {
                status.textContent = `Couldn't save: ${error.message || error}`;
                event.currentTarget.disabled = false;
            }
        });
    }
    // "Use the guesses as real types": every guess that is saved right now.
    const acceptBtn = $("[data-tg-accept]");
    const keptRows = () => [...rows.entries()].filter(([, row]) => row.kept && row.result.found);
    function refreshAccept() {
        if (!acceptBtn) return;
        const count = keptRows().length;
        acceptBtn.hidden = !count;
        acceptBtn.disabled = running;
        acceptBtn.dataset.armed = "";
        acceptBtn.textContent = `Use the ${count} saved guess${count === 1 ? "" : "es"} as real types`;
    }
    acceptBtn?.addEventListener("click", async () => {
        const chosen = keptRows();
        if (!chosen.length || running) return;
        if (acceptBtn.dataset.armed !== "1") {
            acceptBtn.dataset.armed = "1";
            acceptBtn.textContent = `Tap again: ${chosen.length} card${chosen.length === 1 ? "" : "s"} get${chosen.length === 1 ? "s" : ""} these types`;
            return;
        }
        acceptBtn.disabled = true;
        status.textContent = "Saving the types…";
        const types = {};
        chosen.forEach(([card, row]) => { types[card.__storageKey] = row.result.types; });
        try {
            const result = await options.accept(types);
            const accepted = new Set(result.accepted || []);
            chosen.forEach(([card, row]) => {
                if (!accepted.has(card.__storageKey)) return;
                card.type = row.result.types;
                card.typeGuess = "";
                row.item.remove();
                rows.delete(card);
            });
            const refused = (result.refused || []).length;
            status.textContent = `${accepted.size} card${accepted.size === 1 ? " now has its" : "s now have their"} types.`
                + (refused ? ` ${refused} couldn't be changed (not yours to edit).` : "");
            try { options.onChange && options.onChange(); } catch (_) {}
        } catch (error) {
            status.textContent = `Couldn't save the types: ${error.message || error}`;
        }
        refreshAccept();
    });

    // Guesses this collection already has, so they can be reviewed without scanning.
    let scanned = false;
    guessed.forEach(card => setRow(card, { found: true, types: card.typeGuess, confidence: null }, true));
    if (guessed.length) list.hidden = false;
    refreshAccept();

    // Counts describe THIS scan, not the guesses that were listed when it opened.
    const scannedNow = new Set();
    const counts = () => {
        const all = [...rows.entries()].filter(([card]) => scannedNow.has(card)).map(([, row]) => row);
        return { done: all.length, saved: all.filter(row => row.kept).length, unsure: all.filter(row => row.result.found && !row.kept).length, unread: all.filter(row => !row.result.found).length };
    };
    let lead = "";
    function showCounts(extra = "") {
        const c = counts();
        status.textContent = `${lead}${c.done} scanned · ${c.saved} saved · ${c.unsure} not sure (press Keep to save one) · ${c.unread} unreadable${extra}`;
    }

    startBtn.addEventListener("click", async () => {
        if (running) { stopped = true; startBtn.disabled = true; startBtn.textContent = "Stopping…"; return; }
        const rescan = Boolean($("[data-tg-rescan]")?.checked);
        const queue = candidates.filter(card => rescan || !card.typeGuess);
        if (!queue.length) { status.textContent = "Nothing left to scan."; return; }
        running = true; stopped = false; lead = ""; scanned = true; scannedNow.clear();
        refreshAccept();
        startBtn.textContent = "Stop";
        $("[data-tg-clear]")?.setAttribute("disabled", "");
        $("[data-tg-rescan]")?.setAttribute("disabled", "");
        bar.hidden = false; list.hidden = false;
        status.textContent = "Loading the text reader…";

        let pending = {}, failed = "";
        const flush = async () => {
            const batch = pending;
            pending = {};
            if (Object.keys(batch).length) await save(batch);
        };
        const started = Date.now();
        try {
            await scanCards({
                cards: queue,
                vocabCards: options.vocabCards,
                getImage: options.getImage,
                shouldStop: () => stopped || !document.body.contains(overlay),
                onResult: async (card, result, step) => {
                    const sure = result.found && result.confidence >= CONFIDENT;
                    const was = rows.get(card);
                    // Step 2 only ever upgrades: a guess that was already saved stays.
                    if (step === 2 && was && was.kept && !sure) return;
                    if (sure) pending[card.__storageKey] = result.types;
                    scannedNow.add(card);
                    setRow(card, result, sure);
                    if (Object.keys(pending).length >= 10) {
                        try { await flush(); } catch (error) { failed = `Couldn't save: ${error.message || error}`; stopped = true; }
                    }
                    if (step === 1) {
                        const done = scannedNow.size;
                        const left = Math.round((Date.now() - started) / done * (queue.length - done) / 60000);
                        fill.style.width = `${Math.round(done / queue.length * 100)}%`;
                        showCounts(done < queue.length ? ` · about ${left < 1 ? "<1" : left} min left` : " · checking the unsure ones…");
                    }
                }
            });
            await flush();
        } catch (error) {
            failed = failed || (error && error.message) || "The text reader couldn't load.";
        }
        running = false;
        startBtn.disabled = false;
        startBtn.textContent = "Start scanning";
        lead = stopped ? "Stopped. " : "Done. ";
        if (failed) status.textContent = failed; else showCounts();
        refreshAccept();
    });
}
