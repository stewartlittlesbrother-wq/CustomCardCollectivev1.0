// Deck list dialogs: a player submitting theirs, and the viewer (image + text) the
// organiser uses to look at every submitted list.

import { $, esc, fmtDate, toast, copyText, downloadText, safeFilename } from "./tournamentUi.js?v=tour-3";
import {
    savedDecks,
    deckContents,
    checkDeck,
    submitDeck,
    getSubmittedDeck,
    lookupCards,
    deckListText
} from "../firebase/tournamentDecks.js?v=tour-3";
import { collectionsOf, bannedOf } from "../core/tournamentEngine.js?v=tour-8";

// ── submitting ───────────────────────────────────────────────────────────────

/**
 * ctx: {
 *   me()               -> { uid, name }
 *   user()             -> the Firebase user object
 *   collectionName(s)  -> display name for a collection slug
 *   onSubmitted(t)     -> called after a successful submit
 * }
 */
export function openSubmitDialog(t, ctx) {
    const overlay = $("tnDeckOverlay");
    const body = $("tnDeckBody");
    $("tnDeckTitle").textContent = `Deck list — ${t.name}`;
    overlay.hidden = false;

    const decks = savedDecks();
    const slugs = collectionsOf(t);
    const banned = bannedOf(t);
    const deadline = Number(t.deckDeadline);

    body.innerHTML = `<div class="tn-hint">Loading…</div>`;

    const draw = (current) => {
        const rows = decks.map((deck, i) => {
            const { counts, leaders } = deckContents(deck);
            const total = [...counts.values()].reduce((a, b) => a + b, 0);
            const picked = current && current.deck && current.deck.deckText === deck.deckText
                && current.deck.leaderKey === deck.leaderKey;
            return `<label class="tn-choice-card tn-deck-row">
                <input type="radio" name="tnDeckPick" value="${i}"${picked ? " checked" : ""}>
                <strong>${esc(deck.name)}</strong>
                <small>${total} cards · leader ${esc(leaders.join(" + ") || "—")}${picked ? " · currently submitted" : ""}</small>
            </label>`;
        }).join("");

        body.innerHTML = `
            <p class="tn-hint">${Number.isFinite(deadline) && t.status === "registration"
                ? `Deck lists are due <b>${esc(fmtDate(deadline))}</b>. You can swap your list until then.`
                : "You joined late, so you can hand in your deck list once."}
                The deck you submit is the one you'll play with in every match.</p>
            <p class="tn-hint">Rules: ${slugs.length ? `cards must come from ${esc(slugs.map(ctx.collectionName).join(", "))}` : "any collection is allowed"}${banned.length ? `; ${banned.length} card${banned.length === 1 ? " is" : "s are"} banned` : ""}.</p>
            ${current ? `<div class="tn-me"><div><strong>✅ Submitted: ${esc(current.name)}</strong><small>${esc(fmtDate(current.submittedAt))}</small></div></div>` : ""}
            ${decks.length
                ? `<div class="tn-choice tn-choice-1">${rows}</div>`
                : `<div class="tn-empty">You don't have any saved decks yet. Build one in the <a href="../index.html">Deck Builder</a>, then come back.</div>`}
            <div id="tnDeckProblems" class="tn-error" hidden></div>
            <div class="tn-modal-actions">
                <button type="button" class="tn-btn" id="tnDeckCancel">Close</button>
                <button type="button" class="tn-btn tn-btn-primary" id="tnDeckSubmit"${decks.length ? "" : " disabled"}>Check &amp; submit</button>
            </div>`;

        $("tnDeckCancel").onclick = () => { overlay.hidden = true; };
        $("tnDeckSubmit").onclick = async () => {
            const pick = body.querySelector("input[name='tnDeckPick']:checked");
            const problems = $("tnDeckProblems");
            problems.hidden = true;
            if (!pick) { problems.textContent = "Pick a deck first."; problems.hidden = false; return; }
            const deck = decks[Number(pick.value)];
            const button = $("tnDeckSubmit");
            button.disabled = true;
            button.textContent = "Checking…";
            try {
                const result = await checkDeck(deck, { collections: slugs, banned, collectionName: ctx.collectionName });
                if (result.problems.length) {
                    problems.innerHTML = result.problems.map(esc).join("<br>");
                    problems.hidden = false;
                    return;
                }
                await submitDeck(t.id, ctx.user(), ctx.me().name, deck, result.entries);
                toast("Deck list submitted ✓");
                overlay.hidden = true;
                if (ctx.onSubmitted) ctx.onSubmitted(t);
            } catch (error) {
                problems.textContent = /permission|denied/i.test(String(error && (error.code || error.message)))
                    ? "Couldn't submit — the deadline may have passed, or you're not in this tournament."
                    : (error.message || "Couldn't submit your deck list.");
                problems.hidden = false;
            } finally {
                button.disabled = false;
                button.textContent = "Check & submit";
            }
        };
    };

    getSubmittedDeck(t.id, ctx.me().uid).catch(() => null).then(draw);
}

// ── viewing (organiser) ──────────────────────────────────────────────────────

let viewing = null;   // { sub, who }

function tilesHtml(sub) {
    const entries = Array.isArray(sub.cards) ? sub.cards : Object.values(sub.cards || {});
    return entries.map(c => `<figure class="tn-card-tile${c.leader ? " leader" : ""}" data-number="${esc(c.number)}">
        <div class="tn-card-art"><span class="tn-card-fallback">${esc(c.name || c.number)}</span></div>
        <figcaption><b>${c.leader ? "Leader" : `×${esc(c.qty)}`}</b> ${esc(c.name || "")}<small>${esc(c.number)}</small></figcaption>
    </figure>`).join("");
}

async function fillImages(sub) {
    const entries = Array.isArray(sub.cards) ? sub.cards : Object.values(sub.cards || {});
    try {
        const found = await lookupCards(entries.map(c => c.number), { withImages: true });
        if (!viewing || viewing.sub !== sub) return;
        $("tnDeckViewBody").querySelectorAll(".tn-card-tile").forEach(tile => {
            const info = found.get(tile.dataset.number);
            if (!info || !info.imageUrl) return;
            const art = tile.querySelector(".tn-card-art");
            const img = document.createElement("img");
            img.alt = info.name || tile.dataset.number;
            img.loading = "lazy";
            img.src = info.imageUrl;
            img.addEventListener("load", () => { art.querySelector(".tn-card-fallback")?.remove(); });
            art.prepend(img);
        });
    } catch { /* names alone are fine */ }
}

/** `sub` is a submitted deck record (see submitDeck); `who` the player's name. */
export function openViewDialog(sub, who) {
    viewing = { sub, who };
    $("tnDeckViewTitle").textContent = `${who} — ${sub.name}`;
    const text = deckListText(sub);
    const count = (Array.isArray(sub.cards) ? sub.cards : Object.values(sub.cards || {}))
        .filter(c => !c.leader).reduce((a, c) => a + (Number(c.qty) || 0), 0);

    $("tnDeckViewBody").innerHTML = `
        <div class="tn-meta"><span>🃏 <b>${count}</b> cards + leader</span><span>🕒 Submitted ${esc(fmtDate(sub.submittedAt))}</span></div>
        <nav class="tn-tabs tn-tabs-inline" id="tnViewTabs">
            <button type="button" class="tn-tab active" data-view="images">Images</button>
            <button type="button" class="tn-tab" data-view="text">Text</button>
        </nav>
        <div id="tnViewImages" class="tn-card-grid">${tilesHtml(sub)}</div>
        <div id="tnViewText" hidden>
            <pre class="tn-pre">${esc(text)}</pre>
            <div class="tn-actions">
                <button type="button" class="tn-btn tn-btn-small" id="tnViewCopy">Copy list</button>
                <button type="button" class="tn-btn tn-btn-small" id="tnViewDownload">Download .txt</button>
            </div>
        </div>`;

    $("tnViewTabs").onclick = (event) => {
        const button = event.target.closest("[data-view]");
        if (!button) return;
        $("tnViewTabs").querySelectorAll(".tn-tab").forEach(b => b.classList.toggle("active", b === button));
        $("tnViewImages").hidden = button.dataset.view !== "images";
        $("tnViewText").hidden = button.dataset.view !== "text";
    };
    $("tnViewCopy").onclick = () => copyText(text, "Deck list copied");
    $("tnViewDownload").onclick = () => downloadText(`${safeFilename(who)}-${safeFilename(sub.name)}.txt`, text);

    $("tnDeckViewOverlay").hidden = false;
    fillImages(sub);
}

export function closeViewDialog() {
    viewing = null;
    $("tnDeckViewOverlay").hidden = true;
}

export function closeSubmitDialog() { $("tnDeckOverlay").hidden = true; }

$("tnDeckClose").addEventListener("click", closeSubmitDialog);
$("tnDeckViewClose").addEventListener("click", closeViewDialog);
$("tnDeckOverlay").addEventListener("click", (event) => { if (event.target === $("tnDeckOverlay")) closeSubmitDialog(); });
$("tnDeckViewOverlay").addEventListener("click", (event) => { if (event.target === $("tnDeckViewOverlay")) closeViewDialog(); });
