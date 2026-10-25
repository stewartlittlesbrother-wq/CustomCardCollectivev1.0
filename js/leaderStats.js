// Deck Builder "Popular cards": for a leader, what share of the decks played
// online with it ran each card, and how many copies (js/firebase/metaStats.js
// collects the numbers). Loaded on first use.

import { loadLeaderStats, loadLeaderTotals } from "./firebase/metaStats.js?v=1";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const SMALL_SAMPLE = 10;

function injectStyles() {
    if (document.getElementById("lsStyles")) return;
    const style = document.createElement("style");
    style.id = "lsStyles";
    style.textContent = `
.ls-overlay { position: fixed; inset: 0; z-index: 2147483200; display: grid; place-items: center; background: rgba(0,0,0,.62); padding: 16px; }
.ls-dialog { width: min(680px, 96vw); max-height: 90vh; display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 14px;
  background: var(--surface, #101614); color: var(--ink, #f3f8f5); border: 1px solid var(--line, #263029); box-shadow: var(--shadow, 0 20px 60px rgba(0,0,0,.5)); }
.ls-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.ls-head h2 { margin: 0; font-size: 1.1rem; flex: 1 1 auto; }
.ls-dialog select.ls-leader { width: auto; max-width: 100%; min-height: 0; margin: 0; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--line, #263029);
  background: var(--surface-2, #161d1a); color: var(--ink, #f3f8f5); font: inherit; font-size: .86rem; }
.ls-summary { margin: 0; color: var(--muted, #9db1a8); font-size: .86rem; line-height: 1.45; }
.ls-summary b { color: var(--ink, #f3f8f5); }
.ls-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.ls-dialog button.ls-chip { appearance: none; margin: 0; width: auto; min-width: 0; min-height: 0; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line, #263029);
  background: var(--surface-2, #161d1a); color: var(--muted, #9db1a8); font: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; box-shadow: none; text-transform: none; letter-spacing: 0; }
.ls-dialog button.ls-chip[aria-pressed="true"] { background: var(--accent, #10b981); border-color: var(--accent, #10b981); color: #04140d; }
.ls-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line, #263029); padding-top: 8px; }
.ls-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) minmax(90px, 160px) 54px auto; gap: 10px; align-items: center; padding: 5px 8px; border-radius: 8px; background: var(--surface-2, #161d1a); font-size: .84rem; }
.ls-thumb { width: 38px; height: 53px; border-radius: 4px; object-fit: cover; background: var(--surface-3, #202a26); display: block; }
.ls-name { min-width: 0; }
.ls-name strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ls-name small { color: var(--muted, #9db1a8); }
.ls-share { display: grid; gap: 3px; font-variant-numeric: tabular-nums; }
.ls-share span { font-weight: 800; }
.ls-bar { height: 6px; border-radius: 99px; background: var(--surface-3, #202a26); overflow: hidden; }
.ls-bar > i { display: block; height: 100%; background: var(--accent, #10b981); }
.ls-copies { text-align: right; color: var(--muted, #9db1a8); font-variant-numeric: tabular-nums; font-size: .78rem; line-height: 1.2; }
.ls-copies b { display: block; color: var(--ink, #f3f8f5); font-size: .9rem; }
.ls-dialog button.ls-add { appearance: none; margin: 0; width: 30px; min-width: 30px; height: 30px; min-height: 0; padding: 0; border-radius: 8px; border: 1px solid var(--line, #263029);
  background: var(--surface-3, #202a26); color: var(--ink, #f3f8f5); font: inherit; font-size: 1rem; font-weight: 800; cursor: pointer; box-shadow: none; }
.ls-dialog button.ls-add:hover { border-color: var(--accent, #10b981); }
.ls-row .ls-add-gap { width: 30px; }
.ls-empty { padding: 18px 8px; color: var(--muted, #9db1a8); font-size: .88rem; text-align: center; }
.ls-actions { display: flex; justify-content: flex-end; }
.ls-dialog button.ls-close { appearance: none; margin: 0; width: auto; min-width: 0; min-height: 0; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--line, #263029);
  background: var(--surface-3, #202a26); color: var(--ink, #f3f8f5); font: inherit; font-size: .85rem; font-weight: 700; cursor: pointer; box-shadow: none; text-transform: none; letter-spacing: 0; }
@media (max-width: 520px) {
  .ls-row { grid-template-columns: 34px minmax(0, 1fr) 70px auto; }
  .ls-row .ls-copies { display: none; }
}
`;
    document.head.append(style);
}

const CATEGORY_FILTERS = [
    ["all", "All"],
    ["character", "Characters"],
    ["event", "Events"],
    ["stage", "Stages"]
];

/**
 * options:
 *   leaderId          - the leader to show first (the deck being built), may be ""
 *   cardFor(id)       - the card for an id, or null
 *   imageFor(card)    - Promise of a picture URL
 *   canAdd(id)        - whether "+" should be offered (the deck's own leader only)
 *   onAdd(id)         - add one copy to the deck being built
 */
export async function openLeaderStats(options) {
    injectStyles();
    document.getElementById("lsOverlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "lsOverlay";
    overlay.className = "ls-overlay";
    overlay.innerHTML = `
      <div class="ls-dialog" role="dialog" aria-modal="true" aria-labelledby="lsTitle">
        <div class="ls-head">
          <h2 id="lsTitle">Popular cards</h2>
          <select class="ls-leader" aria-label="Leader"></select>
        </div>
        <p class="ls-summary">Loading…</p>
        <div class="ls-filters" hidden></div>
        <div class="ls-list"></div>
        <div class="ls-actions"><button type="button" class="ls-close">Close</button></div>
      </div>`;
    document.body.append(overlay);

    const $ = (sel) => overlay.querySelector(sel);
    const select = $(".ls-leader"), summary = $(".ls-summary"), list = $(".ls-list"), filters = $(".ls-filters");
    const close = () => overlay.remove();
    $(".ls-close").addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

    const nameOf = (id) => (options.cardFor(id) || {}).name || id;
    let totals = [];
    try { totals = await loadLeaderTotals(); } catch (error) {
        summary.textContent = permissionHint(error);
        select.hidden = true;
        return;
    }

    // The deck's own leader first (even with no games yet), then every leader played.
    const own = options.leaderId ? String(options.leaderId) : "";
    const leaders = [...(own && !totals.some(t => t.id === own) ? [{ id: own, decks: 0 }] : []), ...totals];
    if (!leaders.length) {
        summary.textContent = "No online games recorded yet. Each deck played online is added here, under its leader.";
        select.hidden = true;
        return;
    }
    select.innerHTML = leaders.map(leader => `<option value="${esc(leader.id)}">${esc(nameOf(leader.id))} · ${leader.decks} deck${leader.decks === 1 ? "" : "s"}</option>`).join("");
    select.value = own && leaders.some(l => l.id === own) ? own : leaders[0].id;

    let filter = "all";
    filters.innerHTML = CATEGORY_FILTERS.map(([value, label]) => `<button type="button" class="ls-chip" data-filter="${value}" aria-pressed="${value === filter}">${label}</button>`).join("");
    filters.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-filter]");
        if (!chip) return;
        filter = chip.dataset.filter;
        filters.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
        draw();
    });

    let current = { decks: 0, cards: [] };
    async function show(leaderId) {
        summary.textContent = "Loading…";
        list.innerHTML = "";
        filters.hidden = true;
        try { current = await loadLeaderStats(leaderId); } catch (error) {
            summary.textContent = permissionHint(error);
            return;
        }
        const name = esc(nameOf(leaderId));
        if (!current.decks) {
            summary.innerHTML = `No online games with <b>${name}</b> yet. Its numbers fill in as people play it online.`;
            return;
        }
        summary.innerHTML = `Out of <b>${current.decks}</b> deck${current.decks === 1 ? "" : "s"} played online with <b>${name}</b>: the share that ran each card, and the average number of copies in the decks that ran it.`
            + (current.decks < SMALL_SAMPLE ? ` <br>Only a few games so far — the numbers will settle as more are played.` : "");
        filters.hidden = false;
        draw();
    }

    function draw() {
        const decks = current.decks;
        const rows = current.cards.filter(entry => {
            if (filter === "all") return true;
            const card = options.cardFor(entry.id);
            return card && String(card.category || card.cardType || "").toLowerCase() === filter;
        });
        if (!rows.length) { list.innerHTML = `<div class="ls-empty">None of these decks ran a card of this kind.</div>`; return; }
        const addable = (id) => select.value === own && options.canAdd && options.canAdd(id);
        list.innerHTML = rows.map((entry, i) => {
            const card = options.cardFor(entry.id);
            const share = Math.round(entry.decks / decks * 100);
            const avg = entry.decks ? (entry.copies / entry.decks) : 0;
            const meta = card ? [card.cardNumber || entry.id, card.category ? card.category[0].toUpperCase() + card.category.slice(1) : "", card.cost !== "" && card.cost != null && card.category !== "leader" ? `cost ${card.cost}` : ""].filter(Boolean).join(" · ") : `${entry.id} · not in the card library`;
            return `<div class="ls-row" data-i="${i}">
                <img class="ls-thumb" alt="" loading="lazy" data-id="${esc(entry.id)}">
                <div class="ls-name"><strong>${esc(card ? card.name : entry.id)}</strong><small>${esc(meta)}</small></div>
                <div class="ls-share" title="${entry.decks} of ${decks} decks"><span>${share}%</span><div class="ls-bar"><i style="width:${Math.max(2, share)}%"></i></div></div>
                <div class="ls-copies" title="Average copies in the decks that ran it"><b>${avg.toFixed(1)}</b>copies</div>
                ${addable(entry.id) ? `<button type="button" class="ls-add" data-add="${esc(entry.id)}" title="Add one to your deck" aria-label="Add one to your deck">+</button>` : `<span class="ls-add-gap"></span>`}
            </div>`;
        }).join("");
        list.querySelectorAll("img.ls-thumb").forEach(img => {
            const card = options.cardFor(img.dataset.id);
            if (!card) { img.style.visibility = "hidden"; return; }
            Promise.resolve(options.imageFor(card)).then(url => { if (url) img.src = url; else img.style.visibility = "hidden"; }).catch(() => { img.style.visibility = "hidden"; });
        });
    }
    list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-add]");
        if (button && options.onAdd) options.onAdd(button.dataset.add);
    });

    select.addEventListener("change", () => show(select.value));
    show(select.value);
}

function permissionHint(error) {
    return /permission/i.test(String(error && (error.code || error.message) || error))
        ? "Play stats aren't switched on yet: the site owner needs to publish the latest database rules in Firebase."
        : "Couldn't load the play stats — check your connection and try again.";
}
