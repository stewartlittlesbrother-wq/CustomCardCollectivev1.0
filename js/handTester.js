// Opening-hand tester (Deck Builder → "Test hand"). Shuffle the deck being built,
// draw an opening hand of 5, take the one mulligan, then draw turn by turn - and
// see the odds of having a card (or any card of a kind) by a given turn.
//
// The odds are exact (hypergeometric): drawing n cards from a deck of N that has K
// "hits", the chance of at least k hits. A mulligan reshuffles everything and draws
// a fresh 5, so "with a mulligan if you miss" = 1 - (chance of missing)².

const HAND = 5;
const TURNS = 6;

let host = null;   // { entries(), deckName(), imageFor(card) -> Promise<url> }

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── maths ────────────────────────────────────────────────────────────────────

function comb(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
}

/** Chance of at least `atLeast` hits when drawing `draws` from `deck` cards with `hits` hits. */
export function chanceAtLeast(deck, hits, draws, atLeast = 1) {
    draws = Math.min(draws, deck);
    if (hits <= 0 || draws <= 0) return atLeast <= 0 ? 1 : 0;
    const total = comb(deck, draws);
    let miss = 0;
    for (let i = 0; i < atLeast; i++) miss += comb(hits, i) * comb(deck - hits, draws - i);
    return Math.max(0, Math.min(1, 1 - miss / total));
}

/** Cards seen by your Nth turn: going first you don't draw on turn 1. */
export const cardsSeenBy = (turn, goingFirst) => HAND + (goingFirst ? turn - 1 : turn);

function shuffled(list) {
    const out = list.slice();
    const random = new Uint32Array(out.length);
    try { crypto.getRandomValues(random); } catch { random.forEach((_, i) => { random[i] = Math.floor(Math.random() * 2 ** 32); }); }
    for (let i = out.length - 1; i > 0; i--) {
        const j = random[i] % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// ── card facts ───────────────────────────────────────────────────────────────

const costOf = (card) => Number(card && card.cost) || 0;
const counterOf = (card) => Number(card && card.counter) || 0;
const isEvent = (card) => String(card && card.category).toLowerCase() === "event";
const hasTrigger = (card) => Boolean(card && String(card.trigger || "").trim());

function groupsFor(entries) {
    const costs = [...new Set(entries.map(e => Math.min(7, costOf(e.card))))].sort((a, b) => a - b);
    const groups = costs.map(c => ({ id: `cost${c}`, label: c >= 7 ? "Any card costing 7+" : `Any card costing ${c}`, test: (card) => Math.min(7, costOf(card)) === c }));
    if (entries.some(e => isEvent(e.card))) groups.push({ id: "event", label: "Any Event", test: isEvent });
    if (entries.some(e => hasTrigger(e.card))) groups.push({ id: "trigger", label: "Any card with a Trigger", test: hasTrigger });
    if (entries.some(e => counterOf(e.card) > 0)) groups.push({ id: "counter", label: "Any card with a Counter", test: (card) => counterOf(card) > 0 });
    return groups;
}

// ── dialog ───────────────────────────────────────────────────────────────────

export function openHandTester(options) {
    host = options;
    document.getElementById("htTester")?.remove();
    injectStyles();

    const entries = host.entries().filter(e => e.card && e.qty > 0);
    const deck = entries.flatMap(e => Array.from({ length: e.qty }, () => e.card));
    // The sample hand deals separate copies (so a drawn copy is told apart from its twin).
    const copies = deck.map((card, n) => ({ card, n }));
    const groups = groupsFor(entries);
    const st = {
        goingFirst: true, atLeast: 1,
        target: entries.length ? `card:${entries[0].card.id}` : "",
        library: [], hand: [], drawn: [], turn: 1, mulliganed: false
    };

    const root = document.createElement("div");
    root.id = "htTester";
    root.className = "ht-overlay";
    root.innerHTML = `
    <div class="ht-dialog" role="dialog" aria-modal="true" aria-labelledby="htTitle">
      <header class="ht-head">
        <div><h2 id="htTitle">Test hands</h2><p>${esc(host.deckName() || "Your deck")} · ${deck.length} cards</p></div>
        <button type="button" class="ht-x" data-ht="close" aria-label="Close">×</button>
      </header>
      ${deck.length < HAND ? `<div class="ht-body"><p class="ht-empty">Add at least ${HAND} cards to your deck to test hands.</p></div>` : `
      <div class="ht-body">
        <section class="ht-hand-col" aria-label="Sample hand">
          <div class="ht-bar">
            <div class="ht-seg" role="group" aria-label="Turn order">
              <button type="button" data-ht="first" aria-pressed="true">Going first</button>
              <button type="button" data-ht="second" aria-pressed="false">Going second</button>
            </div>
            <span class="ht-turn" id="htTurn"></span>
          </div>
          <div class="ht-hand" id="htHand" aria-live="polite"></div>
          <div class="ht-handinfo" id="htHandInfo"></div>
          <div class="ht-actions">
            <button type="button" class="ht-btn primary" data-ht="new">New hand</button>
            <button type="button" class="ht-btn" data-ht="mulligan" id="htMulligan">Mulligan</button>
            <button type="button" class="ht-btn" data-ht="draw" id="htDraw">Next turn (draw)</button>
          </div>
        </section>
        <section class="ht-odds-col" aria-label="Odds">
          <h3>Odds</h3>
          <label class="ht-field">Chance of drawing
            <select id="htTarget">
              <optgroup label="A card">${entries.map(e => `<option value="card:${esc(e.card.id)}">${e.qty}× ${esc(e.card.name || e.card.cardNumber)}</option>`).join("")}</optgroup>
              ${groups.length ? `<optgroup label="Any card of a kind">${groups.map(g => `<option value="group:${g.id}">${esc(g.label)}</option>`).join("")}</optgroup>` : ""}
            </select>
          </label>
          <div class="ht-seg ht-seg-small" role="group" aria-label="How many">
            <button type="button" data-ht="k1" aria-pressed="true">At least 1</button>
            <button type="button" data-ht="k2" aria-pressed="false">At least 2</button>
          </div>
          <table class="ht-table" id="htTable"></table>
          <div class="ht-summary" id="htSummary"></div>
        </section>
      </div>`}
    </div>`;
    document.body.appendChild(root);
    const $ = (sel) => root.querySelector(sel);

    // ── sample hand ─────────────────────────────────────────────────────────
    function newHand() {
        st.library = shuffled(copies);
        st.hand = st.library.splice(0, HAND);
        st.drawn = [];
        st.turn = 1;
        st.mulliganed = false;
        // Going second, you draw on your first turn.
        if (!st.goingFirst) drawOne();
        renderHand();
    }
    function drawOne() {
        const card = st.library.shift();
        if (card) { st.hand.push(card); st.drawn.push(card); }
    }
    function mulligan() {
        if (st.mulliganed) return;
        st.library = shuffled(copies);
        st.hand = st.library.splice(0, HAND);
        st.drawn = [];
        st.turn = 1;
        st.mulliganed = true;
        if (!st.goingFirst) drawOne();
        renderHand();
    }
    function nextTurn() {
        if (!st.library.length) return;
        st.turn += 1;
        drawOne();
        renderHand();
    }

    function renderHand() {
        const box = $("#htHand");
        if (!box) return;
        const drawnSet = new Set(st.drawn);
        box.innerHTML = st.hand.map((copy, i) => { const card = copy.card; return `
            <figure class="ht-card${drawnSet.has(copy) ? " drawn" : ""}" data-i="${i}">
              <div class="ht-art"><span>${esc(card.name || card.cardNumber)}</span></div>
              <figcaption>${esc(card.name || card.cardNumber)}${counterOf(card) ? ` <b>+${counterOf(card)}</b>` : ""}</figcaption>
            </figure>`; }).join("");
        st.hand.forEach((copy, i) => {
            const card = copy.card;
            Promise.resolve(host.imageFor(card)).then(url => {
                if (!url) return;
                const art = box.querySelector(`.ht-card[data-i="${i}"] .ht-art`);
                if (!art) return;
                const img = new Image();
                img.alt = card.name || "";
                img.src = url;
                img.onload = () => { art.innerHTML = ""; art.appendChild(img); };
            }).catch(() => {});
        });
        const counter = st.hand.reduce((sum, copy) => sum + counterOf(copy.card), 0);
        const opening = st.mulliganed ? "Opening hand (after mulligan)" : "Opening hand";
        $("#htTurn").textContent = st.turn === 1 ? (st.goingFirst ? opening : `${opening} + turn 1 draw`) : `Your turn ${st.turn}`;
        $("#htHandInfo").innerHTML = `<span>${st.hand.length} cards in hand</span><span>Counter in hand: <b>+${counter}</b></span><span>${st.library.length} left in deck</span>`;
        $("#htMulligan").disabled = st.mulliganed || st.turn > 1;
        $("#htMulligan").textContent = st.mulliganed ? "Mulligan used" : "Mulligan";
        $("#htDraw").disabled = !st.library.length;
    }

    // ── odds ────────────────────────────────────────────────────────────────
    function hitsFor(target) {
        if (target.startsWith("card:")) {
            const id = target.slice(5);
            const entry = entries.find(e => String(e.card.id) === id);
            return entry ? entry.qty : 0;
        }
        const group = groups.find(g => `group:${g.id}` === target);
        return group ? deck.filter(card => group.test(card)).length : 0;
    }
    const pct = (p) => `${(p * 100).toFixed(p > 0 && p < 0.01 ? 1 : 0)}%`;
    function renderOdds() {
        const table = $("#htTable");
        if (!table) return;
        const N = deck.length, K = hitsFor(st.target), k = st.atLeast;
        const open = chanceAtLeast(N, K, HAND, k);
        const rows = [
            { label: "Opening hand", seen: HAND, p: open },
            { label: "Opening hand, with a mulligan if you miss", seen: HAND, p: 1 - (1 - open) ** 2 }
        ];
        for (let turn = 1; turn <= TURNS; turn++) {
            const seen = cardsSeenBy(turn, st.goingFirst);
            rows.push({ label: `By your turn ${turn}`, seen, p: chanceAtLeast(N, K, seen, k) });
        }
        table.innerHTML = `<thead><tr><th scope="col">When</th><th scope="col">Cards seen</th><th scope="col">Chance</th></tr></thead><tbody>${rows.map(r => `
            <tr><th scope="row">${esc(r.label)}</th><td>${r.seen}</td>
              <td><div class="ht-bar-cell"><span class="ht-meter"><i style="width:${(r.p * 100).toFixed(1)}%"></i></span><b>${pct(r.p)}</b></div></td></tr>`).join("")}</tbody>`;
        const totalCounter = deck.reduce((sum, card) => sum + counterOf(card), 0);
        const counterCards = deck.filter(card => counterOf(card) > 0).length;
        $("#htSummary").innerHTML = `
            <span><b>${K}</b> of ${N} cards match</span>
            <span>Counter in deck: <b>+${totalCounter}</b> (${counterCards} cards with a counter)</span>
            <span>Average counter per card: <b>+${Math.round(totalCounter / Math.max(1, N))}</b></span>`;
    }

    // ── wiring ──────────────────────────────────────────────────────────────
    function setPressed(a, b, on) {
        root.querySelector(`[data-ht="${a}"]`)?.setAttribute("aria-pressed", String(on));
        root.querySelector(`[data-ht="${b}"]`)?.setAttribute("aria-pressed", String(!on));
    }
    root.addEventListener("click", (event) => {
        if (event.target === root) { close(); return; }
        const button = event.target.closest("[data-ht]");
        if (!button) return;
        switch (button.dataset.ht) {
            case "close": close(); break;
            case "new": newHand(); break;
            case "mulligan": mulligan(); break;
            case "draw": nextTurn(); break;
            case "first": st.goingFirst = true; setPressed("first", "second", true); newHand(); renderOdds(); break;
            case "second": st.goingFirst = false; setPressed("first", "second", false); newHand(); renderOdds(); break;
            case "k1": st.atLeast = 1; setPressed("k1", "k2", true); renderOdds(); break;
            case "k2": st.atLeast = 2; setPressed("k1", "k2", false); renderOdds(); break;
        }
    });
    $("#htTarget")?.addEventListener("change", (event) => { st.target = event.target.value; renderOdds(); });
    const onKey = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    function close() { document.removeEventListener("keydown", onKey); root.remove(); }

    if (deck.length >= HAND) { newHand(); renderOdds(); }
    root.querySelector("[data-ht='new'], [data-ht='close']")?.focus();
}

function injectStyles() {
    if (document.getElementById("ht-styles")) return;
    const s = document.createElement("style");
    s.id = "ht-styles";
    s.textContent = `
.ht-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(4, 6, 8, .78); backdrop-filter: blur(3px); }
.ht-dialog { width: min(1120px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden;
  background: #101614; color: #f3f8f5; border: 1px solid #263029; border-radius: 14px; box-shadow: 0 30px 80px rgba(0, 0, 0, .6);
  font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left; }
.ht-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid #263029; }
.ht-head h2 { margin: 0; font-size: 20px; }
.ht-head p { margin: 2px 0 0; color: #9db1a8; font-size: 13px; }
.ht-dialog button { font: inherit; cursor: pointer; min-height: 0; box-shadow: none; filter: none; width: auto; }
.ht-dialog button:hover { filter: none; box-shadow: none; }
.ht-x { background: none; border: 0; color: #9db1a8; font-size: 26px; line-height: 1; padding: 0 4px; }
.ht-x:hover { color: #fff; }
.ht-body { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 20px; padding: 16px 20px 20px; overflow: auto; }
.ht-empty { margin: 8px 0; color: #9db1a8; }
.ht-hand-col, .ht-odds-col { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.ht-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ht-turn { font-weight: 800; color: #4dff9e; }
.ht-seg { display: inline-flex; padding: 3px; gap: 3px; background: #07090a; border: 1px solid #263029; border-radius: 10px; }
.ht-seg button { border: 0; background: transparent; color: #f3f8f5; padding: 6px 12px; border-radius: 7px; font-size: 13px; font-weight: 700; }
.ht-seg button[aria-pressed="true"] { background: #0e9f70; color: #fff; }
.ht-seg-small { align-self: flex-start; }
.ht-hand { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; min-height: 170px; }
.ht-card { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.ht-art { aspect-ratio: 5 / 7; border-radius: 7px; overflow: hidden; border: 1px solid #263029; background: #202a26;
  display: flex; align-items: center; justify-content: center; text-align: center; padding: 4px; color: #9db1a8; font-size: 11px; }
.ht-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ht-card:has(img) .ht-art { padding: 0; }
.ht-card.drawn .ht-art { border-color: #4dff9e; box-shadow: 0 0 0 1px rgba(77, 255, 158, .45); }
.ht-card figcaption { font-size: 11.5px; line-height: 1.25; color: #dfe7e2; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ht-card figcaption b { color: #f3d58c; }
.ht-handinfo { display: flex; flex-wrap: wrap; gap: 6px 18px; color: #9db1a8; font-size: 13px; }
.ht-handinfo b { color: #f3d58c; }
.ht-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ht-btn { border: 1px solid #263029; background: #161d1a; color: #f3f8f5; padding: 8px 14px; border-radius: 9px; font-weight: 700; }
.ht-btn:hover:not(:disabled) { border-color: rgba(77, 255, 158, .5); }
.ht-btn.primary { background: #0e9f70; border-color: transparent; color: #fff; }
.ht-btn:disabled { opacity: .45; cursor: default; }
.ht-odds-col h3 { margin: 0; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #4dff9e; }
.ht-field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; color: #9db1a8; }
.ht-field select { width: 100%; min-height: 38px; margin: 0; padding: 6px 10px; border-radius: 9px; border: 1px solid #263029;
  background: #07090a; color: #f3f8f5; font: inherit; font-weight: 500; text-transform: none; }
.ht-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ht-table th, .ht-table td { padding: 6px 4px; border-bottom: 1px solid #1d2622; text-align: left; font-weight: 500; }
.ht-table thead th { color: #8fa398; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
.ht-table td:nth-child(2) { color: #9db1a8; font-variant-numeric: tabular-nums; width: 70px; }
.ht-bar-cell { display: flex; align-items: center; gap: 8px; }
.ht-bar-cell b { width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
.ht-meter { flex: 1; height: 8px; border-radius: 999px; background: #1b2420; overflow: hidden; min-width: 60px; }
.ht-meter i { display: block; height: 100%; background: linear-gradient(90deg, #0e9f70, #4dff9e); border-radius: 999px; }
.ht-summary { display: flex; flex-direction: column; gap: 3px; color: #9db1a8; font-size: 13px; }
.ht-summary b { color: #f3f8f5; }
@media (max-width: 820px) {
  .ht-overlay { padding: 0; align-items: stretch; }
  .ht-dialog { max-height: none; height: 100%; border-radius: 0; }
  .ht-body { grid-template-columns: minmax(0, 1fr); padding: 12px 16px; }
}`;
    document.head.appendChild(s);
}
