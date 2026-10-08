import { signInGuest, waitForUser } from "../firebase/firebaseApp.js";
import {
    createTournament,
    updateTournament,
    watchTournaments,
    joinTournament,
    leaveTournament,
    cancelTournament,
    syncTournament,
    enterMatch,
    publishTopDecks,
    isPermissionError
} from "../firebase/tournamentService.js?v=tab-1";
import { lookupCards } from "../firebase/tournamentDecks.js?v=tab-1";
import {
    ROUND_LENGTHS,
    DRAFT_DEFAULTS,
    CLOCK_OPTIONS,
    DEFAULT_CLOCK_MINUTES,
    timeoutRuleOf,
    clockMinutesOf,
    formatDuration,
    collectionsOf,
    bannedOf,
    bestOfOf,
    minPlayersOf,
    draftSettingsOf,
    deckRequired,
    isPrivate,
    playerCount,
    isOpenForSignup,
    canJoin,
    myStatus,
    playersInOrder,
    pairingsOf,
    getRound,
    seriesScore,
    swissStandings,
    awaitingOrganiser,
    placings,
    showsTopDecks,
    nameOf
} from "../core/tournamentEngine.js?v=tab-1";
import { $, esc, fmtDate, relative, toast, toLocalInput, copyText } from "./tournamentUi.js?v=tour-3";
import { openSubmitDialog, closeSubmitDialog, closeViewDialog, openViewDialog } from "./tournamentDeckUi.js?v=tab-1";
import { bracketHtml } from "./tournamentBracket.js?v=tab-1";
import { createManage } from "./tournamentManage.js?v=tab-1";

// ── state ────────────────────────────────────────────────────────────────────

const state = {
    list: [],
    filter: "all",
    loaded: false,
    denied: false,
    me: { uid: "", name: "", signedIn: false },
    collections: [],            // [{ slug, name }]
    collectionNames: {},        // slug -> display name
    picked: new Set(),          // collections ticked in the form
    banned: [],                 // banned card numbers in the form
    banNames: {},               // card number -> name (looked up)
    banUnknown: new Set(),      // numbers the card library doesn't know
    editing: null,              // id of the tournament being edited (null = creating)
    openDetail: null,           // id of the tournament shown in the details dialog
    bracketView: "tree",        // knockout details: "tree" (drawn bracket) or "list"
    leaderArt: {},              // leader card number -> { name, imageUrl } (top decks)
    publishTried: new Map(),    // tournament id -> when this browser last tried to publish its top decks
    deepLinkId: new URLSearchParams(location.search).get("t") || "",
    // ?t=<id>&manage=matches - the organiser's "pick the winner" alert opens this.
    deepLinkManage: new URLSearchParams(location.search).get("manage") || ""
};
let firebaseUser = null;

// ── identity ─────────────────────────────────────────────────────────────────
// Tournaments need a stable identity, so they need a real account (guests are
// throwaway anonymous users that change every session).

function refreshIdentity() {
    const account = window.ccAccount && window.ccAccount.user;
    const real = account || (firebaseUser && !firebaseUser.isAnonymous ? firebaseUser : null);
    state.me = {
        uid: real ? real.uid : "",
        name: (real && real.displayName) || (account && account.displayName) || "",
        signedIn: Boolean(real)
    };
}

function requireSignIn(reason) {
    refreshIdentity();
    if (state.me.signedIn) return true;
    if (window.ccAccount && window.ccAccount.requireAccount) window.ccAccount.requireAccount(reason);
    else toast(reason, true);
    return false;
}

const isMember = (t) => Boolean(state.me.uid && t.players && t.players[state.me.uid]);
const isCreator = (t) => Boolean(state.me.uid && t.createdBy === state.me.uid);
const isListed = (t) => !isPrivate(t) || isMember(t) || isCreator(t) || state.deepLinkId === t.id;
const getTournament = (id) => state.list.find(t => t.id === id);
const firebaseUserOrId = () => firebaseUser || { uid: state.me.uid };

// ── formatting ───────────────────────────────────────────────────────────────

const collectionName = (slug) => state.collectionNames[slug] || slug;

function collectionChips(t, limit = 4) {
    const slugs = collectionsOf(t);
    if (!slugs.length) return `<span class="tn-chip">All collections</span>`;
    const shown = slugs.slice(0, limit).map(s => `<span class="tn-chip">${esc(collectionName(s))}</span>`).join("");
    const more = slugs.length > limit ? `<span class="tn-chip">+${slugs.length - limit} more</span>` : "";
    return shown + more;
}

const formatLabel = (t) => t.format === "swiss" ? "Swiss" : "Single elimination";
const typeLabel = (t) => t.matchType === "draft" ? "Draft battle" : "Regular matches";
const bestOfLabel = (t) => `Best of ${bestOfOf(t)}`;

function settingChips(t) {
    const chips = [
        `<span class="tn-chip format">${formatLabel(t)}</span>`,
        `<span class="tn-chip type">${typeLabel(t)}</span>`,
        `<span class="tn-chip format">${bestOfLabel(t)}</span>`
    ];
    if (t.hasPassword) chips.push(`<span class="tn-chip flag">🔒 Password</span>`);
    if (isPrivate(t)) chips.push(`<span class="tn-chip flag">👁 Private</span>`);
    if (t.lateJoin) chips.push(`<span class="tn-chip flag">⏳ Late joining</span>`);
    if (deckRequired(t)) chips.push(`<span class="tn-chip flag">📄 Deck list</span>`);
    if (clockMinutesOf(t)) chips.push(`<span class="tn-chip flag">⏱ ${clockMinutesOf(t)} min clock</span>`);
    if (bannedOf(t).length) chips.push(`<span class="tn-chip flag">🚫 ${bannedOf(t).length} banned</span>`);
    return chips.join("");
}

function statusInfo(t, now) {
    if (t.status === "cancelled") return { cls: "cancelled", text: "Cancelled" };
    if (t.status === "complete") return { cls: "done", text: "Finished" };
    if (t.status === "running") return { cls: "running", text: `Round ${t.currentRound} of ${t.totalRounds}` };
    if (now >= Number(t.startAt)) return { cls: "running", text: "Starting…" };
    return isOpenForSignup(t, now)
        ? { cls: "open", text: "Open for sign-up" }
        : { cls: "open", text: "Full" };
}

// ── deck list status (when the organiser requires one) ───────────────────────

function deckState(t, now) {
    if (!isMember(t) || !deckRequired(t)) return null;
    const has = Boolean(t.players[state.me.uid].deckAt);
    const open = (t.status === "registration" && now <= Number(t.deckDeadline))
        || (t.status === "running" && t.lateJoin && !has);
    return { has, canSubmit: open };
}

function deckStrip(t, now) {
    const d = deckState(t, now);
    if (!d || t.status === "cancelled" || t.status === "complete") return "";
    if (d.has) {
        return `<div class="tn-me"><div><strong>📄 Deck list submitted.</strong>
            <small>${d.canSubmit ? `You can still swap it until ${esc(fmtDate(t.deckDeadline))}.` : "It's locked in — this is the deck you'll play with."}</small></div>
            ${d.canSubmit ? `<button type="button" class="tn-btn tn-btn-small" data-act="deck" data-id="${esc(t.id)}">Change deck list</button>` : ""}</div>`;
    }
    if (d.canSubmit) {
        return `<div class="tn-me action"><div><strong>📄 Submit your deck list</strong>
            <small>${t.status === "registration" ? `Due ${esc(fmtDate(t.deckDeadline))} (${esc(relative(t.deckDeadline, now))}). Without one you'll be removed when it starts.` : "Hand it in to start playing."}</small></div>
            <button type="button" class="tn-btn tn-btn-primary tn-btn-small" data-act="deck" data-id="${esc(t.id)}">Submit deck list</button></div>`;
    }
    return `<div class="tn-me out"><div><strong>❌ No deck list submitted.</strong><small>The deadline has passed.</small></div></div>`;
}

// ── "where do I stand" strip ─────────────────────────────────────────────────

function meStrip(t, now) {
    if (!isMember(t)) {
        const k = state.me.uid && t.kicked && t.kicked[state.me.uid];
        return k ? `<div class="tn-me out"><div><strong>You were removed from this tournament.</strong>${k.reason ? `<small>${esc(k.reason)}</small>` : ""}</div></div>` : "";
    }
    const s = myStatus(t, state.me.uid, now);
    const pts = t.format === "swiss" ? " You score a point." : " You advance.";
    const series = bestOfOf(t) > 1;
    let main = "";

    switch (s.state) {
        case "registered":
            main = `<div class="tn-me"><div><strong>✅ You're in.</strong>
                <small>Round 1 starts ${esc(fmtDate(t.startAt))} (${esc(relative(t.startAt, now))}).</small></div></div>`;
            break;

        case "play": {
            const overdue = now > Number(s.dueAt);
            const what = series
                ? `Game ${s.game} of ${s.bestOf} vs ${esc(s.opponentName)}${s.myWins || s.oppWins ? ` — series ${s.myWins}–${s.oppWins}` : ""}`
                : `you still need to play ${esc(s.opponentName)}`;
            main = `<div class="tn-me action"><div>
                <strong>⚔️ Round ${s.round} — ${what}</strong>
                <small>${overdue
                    ? (timeoutRuleOf(t) === "organiser"
                        ? "The round timer has run out — the organiser will pick the winner. You can still finish your game until they do."
                        : "The round timer has run out — it's being settled now.")
                    : `All your games are due ${esc(fmtDate(s.dueAt))} (${esc(relative(s.dueAt, now))}).`}
                    ${t.matchType === "draft" ? " Draft battle: you'll open packs and build a deck first." : ""}</small>
                </div>
                <button type="button" class="tn-btn tn-btn-primary" data-act="play" data-id="${esc(t.id)}">▶ Play ${series ? `game ${s.game}` : "match"}</button></div>`;
            break;
        }
        case "waiting":
            main = `<div class="tn-me"><div>
                <strong>${s.won ? `✅ Round ${s.round} done — you won${series ? ` ${s.myWins}–${s.oppWins}` : ""}.` : `Round ${s.round} done — you lost${series ? ` ${s.myWins}–${s.oppWins}` : ""}.`}</strong>
                <small>Waiting for the rest of the round (ends ${esc(fmtDate(s.dueAt))}). Nothing for you to do yet.</small></div></div>`;
            break;

        case "bye":
            main = `<div class="tn-me"><div><strong>😴 Round ${s.round}: you have a bye.</strong>
                <small>Nothing to play this round.${pts}</small></div></div>`;
            break;

        case "late":
            main = `<div class="tn-me"><div><strong>⏳ You joined after the draw.</strong>
                <small>You'll be paired when the next round starts${s.dueAt ? ` (after ${esc(fmtDate(s.dueAt))} at the latest)` : ""}.</small></div></div>`;
            break;

        case "eliminated":
            main = `<div class="tn-me out"><div><strong>❌ Eliminated${s.lostInRound ? ` in round ${s.lostInRound}` : ""}.</strong>
                <small>Thanks for playing — you can still follow the bracket in Details.</small></div></div>`;
            break;

        case "champion":
            main = `<div class="tn-me"><div><strong>🏆 You won this tournament!</strong></div></div>`;
            break;

        case "finished":
            main = `<div class="tn-me"><div><strong>Finished${s.rank ? ` — you placed #${s.rank}` : ""}.</strong></div></div>`;
            break;

        case "cancelled":
            main = `<div class="tn-me out"><div><strong>This tournament was cancelled.</strong>
                <small>${esc(t.cancelReason || "")}</small></div></div>`;
            break;
    }
    return main + deckStrip(t, now);
}

// ── list ─────────────────────────────────────────────────────────────────────

function matchesFilter(t, now) {
    switch (state.filter) {
        case "open": return t.status === "registration" && now < Number(t.startAt);
        case "running": return t.status === "running" || (t.status === "registration" && now >= Number(t.startAt));
        case "done": return t.status === "complete" || t.status === "cancelled";
        case "mine": return isMember(t) || isCreator(t);
        default: return true;
    }
}

// The organiser's to-do: matches whose round ran out and that wait for their decision.
function organiserStrip(t) {
    if (!isCreator(t)) return "";
    const waiting = awaitingOrganiser(t);
    if (!waiting.length) return "";
    const names = waiting.slice(0, 3).map(p => `${esc(nameOf(t, p.a))} vs ${esc(nameOf(t, p.b))}`).join(", ");
    return `<div class="tn-me action urgent"><div><strong>⚖ ${waiting.length} match${waiting.length === 1 ? "" : "es"} need${waiting.length === 1 ? "s" : ""} you to pick the winner</strong>
        <small>Round ${esc(t.currentRound)} ran out of time (${names}${waiting.length > 3 ? ", …" : ""}). The next round starts once you decide.</small></div>
        <button type="button" class="tn-btn tn-btn-primary tn-btn-small" data-act="decide" data-id="${esc(t.id)}">Pick winners</button></div>`;
}

function sortRank(t, now) {
    const mine = isMember(t) ? myStatus(t, state.me.uid, now) : null;
    const d = deckState(t, now);
    if (isCreator(t) && awaitingOrganiser(t).length) return 0;
    if ((mine && mine.needsAction) || (d && !d.has && d.canSubmit)) return 0;   // you owe something
    if (t.status === "running" || (t.status === "registration" && now >= Number(t.startAt))) return 1;
    if (t.status === "registration") return 2;
    return 3;                                                     // finished / cancelled
}

function cardHtml(t, now) {
    const status = statusInfo(t, now);
    const mine = isMember(t);
    const creator = isCreator(t);
    const s = mine ? myStatus(t, state.me.uid, now) : null;
    const d = deckState(t, now);
    const owes = (s && s.needsAction) || (d && !d.has && d.canSubmit) || (creator && awaitingOrganiser(t).length > 0);

    const startLine = t.status === "registration"
        ? `<span>🗓 Starts <b>${esc(fmtDate(t.startAt))}</b> (${esc(relative(t.startAt, now))})</span>`
        : `<span>🗓 Started <b>${esc(fmtDate(t.startAt))}</b></span>`;

    const buttons = [];
    if (!mine && canJoin(t, state.me.uid, now)) {
        buttons.push(`<button type="button" class="tn-btn tn-btn-primary tn-btn-small" data-act="join" data-id="${esc(t.id)}">${t.status === "running" ? "Join late" : "Join"}${t.hasPassword ? " 🔒" : ""}</button>`);
    }
    if (mine && t.status === "registration" && now < Number(t.startAt)) {
        buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-act="leave" data-id="${esc(t.id)}">Leave</button>`);
    }
    buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-act="view" data-id="${esc(t.id)}">Details</button>`);
    if (t.status === "complete" && showsTopDecks(t)) {
        buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-gold" data-act="topdecks" data-id="${esc(t.id)}">🏆 Top decks</button>`);
    }
    if (creator) buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-gold" data-act="manage" data-id="${esc(t.id)}">⚙ Manage</button>`);

    const description = t.description
        ? `<p class="tn-desc">${esc(t.description.length > 170 ? t.description.slice(0, 167) + "…" : t.description)}</p>` : "";

    return `<article class="tn-card${mine ? " mine" : ""}${owes ? " needs-action" : ""}" data-id="${esc(t.id)}">
        <div class="tn-card-top">
            <div>
                <h2 class="tn-card-title">${esc(t.name)}</h2>
                <p class="tn-by">Organised by ${esc(t.createdByName || "someone")}${creator ? " (you)" : ""}</p>
            </div>
            <span class="tn-status ${status.cls}">${esc(status.text)}</span>
        </div>
        ${description}
        <div class="tn-meta">
            ${startLine}
            <span>⏱ Each round lasts <b>${esc(formatDuration(t.roundMinutes))}</b></span>
            <span>👥 <b>${playerCount(t)}</b> / ${esc(t.maxPlayers)} players${t.status === "registration" && minPlayersOf(t) > 2 ? ` (min ${minPlayersOf(t)})` : ""}</span>
        </div>
        <div class="tn-chips">
            ${settingChips(t)}
            ${collectionChips(t)}
        </div>
        ${organiserStrip(t)}
        ${meStrip(t, now)}
        <div class="tn-actions">${buttons.join("")}</div>
    </article>`;
}

function renderList() {
    const list = $("tnList");
    if (!state.loaded) { list.innerHTML = `<div class="tn-empty">Loading tournaments…</div>`; return; }
    const now = Date.now();

    const shown = state.list
        .filter(t => isListed(t) && matchesFilter(t, now))
        .sort((a, b) => sortRank(a, now) - sortRank(b, now)
            || (sortRank(a, now) >= 3 ? Number(b.startAt) - Number(a.startAt) : Number(a.startAt) - Number(b.startAt)));

    if (!shown.length) {
        const text = state.denied ? "Tournaments aren't available yet."
            : state.filter === "mine" ? "You haven't joined or created any tournaments yet."
            : state.list.length ? "Nothing matches this filter."
            : "No tournaments yet — be the first and create one!";
        list.innerHTML = `<div class="tn-empty">${text}</div>`;
        return;
    }
    list.innerHTML = shown.map(t => cardHtml(t, now)).join("");
}

function setNotice(html) {
    const el = $("tnNotice");
    el.innerHTML = html || "";
    el.hidden = !html;
}

// ── actions ──────────────────────────────────────────────────────────────────

// A password-protected tournament: ask for it, and only close the box once joining
// actually worked (a wrong password is reported inside the box).
function joinWithPassword(t) {
    return new Promise((resolve) => {
        const overlay = $("tnPasswordOverlay");
        const form = $("tnPasswordForm");
        const input = $("tnPasswordInput");
        const error = $("tnPasswordError");
        $("tnPasswordFor").textContent = `"${t.name}" is password protected. Ask the organiser for the password.`;
        input.value = "";
        error.hidden = true;
        overlay.hidden = false;
        input.focus();

        const finish = (joined) => { overlay.hidden = true; form.onsubmit = null; resolve(joined); };
        form.onsubmit = async (event) => {
            event.preventDefault();
            error.hidden = true;
            try {
                await joinTournament(t.id, firebaseUserOrId(), state.me.name, t, input.value);
                finish(true);
            } catch (e) {
                error.textContent = e.message || "Couldn't join.";
                error.hidden = false;
            }
        };
        $("tnPasswordCancel").onclick = () => finish(false);
        $("tnPasswordClose").onclick = () => finish(false);
    });
}

async function doJoin(id) {
    if (!requireSignIn("Sign in to join tournaments.")) return;
    const t = getTournament(id);
    if (!t) return;
    try {
        let joined = true;
        if (t.hasPassword) joined = await joinWithPassword(t);
        else await joinTournament(id, firebaseUserOrId(), state.me.name, t);
        if (!joined) return;
        toast(t.status === "running" ? "You're in — you'll be paired shortly." : "You're in! Check back when it starts.");
        // A required deck list is the next thing to do.
        if (deckRequired(t)) setTimeout(() => { const fresh = getTournament(id); if (fresh && isMember(fresh)) doDeck(id); }, 700);
    } catch (error) { toast(error.message, true); }
}

async function doLeave(id) {
    try { await leaveTournament(id, state.me.uid); toast("You've left the tournament."); }
    catch (error) { toast(error.message, true); }
}

function doDeck(id) {
    const t = getTournament(id);
    if (!t) return;
    openSubmitDialog(t, {
        me: () => state.me,
        user: firebaseUserOrId,
        collectionName,
        onSubmitted: () => { renderList(); refreshDetail(); }
    });
}

async function doPlay(id) {
    if (!requireSignIn("Sign in to play tournament matches.")) return;
    try {
        toast("Opening your match…");
        // Re-check first: a result may have just moved the tournament to a new round.
        const fresh = (await syncTournament(id, state.me.uid)) || getTournament(id);
        const { code, slot } = await enterMatch(id, fresh, firebaseUserOrId(), state.me.name);
        // Straight into the room in the Multiplayer tab (same page, no reload).
        if (window.ccTnHost && window.ccTnHost.enterRoom) window.ccTnHost.enterRoom(code, slot);
        else window.location.href = `index.html?view=multiplayer&room=${encodeURIComponent(code)}&slot=${encodeURIComponent(slot)}`;
    } catch (error) { toast(error.message || "Couldn't open the match.", true); }
}

const manage = createManage({
    getTournament,
    openEdit: (t) => openForm(t)
});

function handleAction(button) {
    const id = button.dataset.id;
    switch (button.dataset.act) {
        case "join": doJoin(id); break;
        case "leave": doLeave(id); break;
        case "play": doPlay(id); break;
        case "deck": doDeck(id); break;
        case "view": openDetail(id); break;
        case "topdecks": openDetail(id, "tnTopDecks"); break;
        case "manage": closeDetail(); manage.open(id); break;
        case "decide": closeDetail(); manage.open(id, "matches"); break;
    }
}

$("tnList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (button) handleAction(button);
});

$("tnFilters").addEventListener("click", (event) => {
    const button = event.target.closest(".tn-filter");
    if (!button) return;
    state.filter = button.dataset.filter;
    document.querySelectorAll(".tn-filter").forEach(b => b.classList.toggle("active", b === button));
    renderList();
});

// ── details dialog ───────────────────────────────────────────────────────────

function reasonNote(result) {
    switch (result && result.reason) {
        case "bye": return "Bye";
        case "forfeit": return "Won by forfeit — their opponent didn't show up";
        case "seed": return "Neither finished in time — higher seed advances";
        case "timeout": return "Not finished in time — nobody scores";
        case "lead": return "Time ran out — the player ahead in the series wins";
        case "coin": return "Not finished in time — won on a coin flip";
        case "kicked": return "Their opponent was removed from the tournament";
        case "organiser": return "Decided by the organiser";
        default: return "";
    }
}

function roundHtml(t, n) {
    const round = getRound(t, n);
    if (!round) return "";
    const series = bestOfOf(t) > 1;
    const rows = pairingsOf(round).map(p => {
        const done = p.result && p.result.winner && p.result.winner !== "none";
        const side = (uid, right) => {
            const cls = done ? (p.result.winner === uid ? "win" : "lose") : "";
            const me = uid === state.me.uid ? " (you)" : "";
            return `<span class="side ${cls}${right ? " right" : ""}">${esc(nameOf(t, uid))}${me}${done && p.result.winner === uid ? " ✓" : ""}</span>`;
        };
        const score = seriesScore(p);
        const middle = p.bye ? "BYE" : (series && score.played ? `${score.a}–${score.b}` : "VS");
        const note = p.result ? reasonNote(p.result) : "";
        return `<div class="tn-pairing">
            ${side(p.a, false)}<span class="vs">${middle}</span>${p.bye ? `<span class="side right lose">—</span>` : side(p.b, true)}
            ${note && !p.bye ? `<div class="note">${esc(note)}</div>` : ""}
        </div>`;
    }).join("");
    const ends = t.status === "running" && n === t.currentRound ? `ends ${fmtDate(round.endsAt)}` : "";
    return `<div class="tn-round"><div class="tn-round-head">Round ${n}<span>${esc(ends)}</span></div>${rows}</div>`;
}

function standingsHtml(t) {
    const rows = swissStandings(t).map(r => `<tr class="${r.uid === state.me.uid ? "me" : ""}${r.kicked ? " removed" : ""}">
        <td>${r.rank}</td><td><button type="button" class="tn-name-link" data-profile="${esc(r.uid)}" data-name="${esc(r.name)}">${esc(r.name)}</button>${r.kicked ? " (removed)" : ""}</td><td>${r.points}</td><td>${r.wins}–${r.losses}</td><td>${r.buchholz}</td></tr>`).join("");
    return `<table class="tn-table"><thead><tr><th>#</th><th>Player</th><th>Points</th><th>W–L</th><th>Opp. points</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bannedNames(t) {
    return bannedOf(t).map(n => state.banNames[n] ? `${esc(state.banNames[n])} (${esc(n)})` : esc(n));
}

// Look up the names of banned cards so the lists read nicely (cached; redraws when done).
let nameLookupRunning = false;
async function ensureBanNames(numbers) {
    const missing = numbers.filter(n => !(n in state.banNames) && !state.banUnknown.has(n));
    if (!missing.length || nameLookupRunning) return;
    nameLookupRunning = true;
    try {
        const found = await lookupCards(missing);
        missing.forEach(n => {
            const info = found.get(n);
            if (info && info.name) state.banNames[n] = info.name; else state.banUnknown.add(n);
        });
    } catch { /* numbers alone are fine */ }
    finally {
        nameLookupRunning = false;
        refreshDetail();
        renderBanChips();
    }
}

function rulesHtml(t) {
    const lines = [];
    const bestOf = bestOfOf(t);
    const draft = draftSettingsOf(t);
    lines.push(`Each round lasts <b>${esc(formatDuration(t.roundMinutes))}</b>. ${bestOf > 1
        ? `Each match is a <b>best of ${bestOf}</b>: play up to ${bestOf} games in that window and the first to win ${Math.floor(bestOf / 2) + 1} takes the match. `
        : ""}Play any time in the window by pressing <b>Play ${bestOf > 1 ? "game" : "match"}</b> — whoever opens it first creates the room and the other joins. Results are recorded automatically from your accounts.`);
    lines.push(t.roundMode === "full"
        ? "Rounds keep to their schedule: the next round starts only when the round time is up, even if everyone has finished."
        : "The next round starts as soon as every match in the round has finished (or the round time is up).");
    lines.push(t.format === "swiss"
        ? `Swiss: a win or a bye is 1 point. You're paired with someone on a similar score and never face the same person twice if it can be avoided. ${t.totalRounds || t.roundsSetting ? `${t.totalRounds || t.roundsSetting} rounds. ` : ""}Highest points wins, then opponents' points, then sign-up order.`
        : "Single elimination: win and you go through, lose and you're out. If the player count isn't a power of two, some players get a round-1 bye.");
    const rule = timeoutRuleOf(t);
    const level = rule === "coin" ? "a <b>coin flip</b> decides the winner."
        : rule === "organiser" ? "the <b>organiser picks the winner</b> (until then you can still finish the game)."
        : t.format === "swiss" ? "nobody scores." : "the higher seed — the earlier sign-up — advances.";
    lines.push(`If a round runs out: ${bestOf > 1 ? "the player ahead in the series wins; " : ""}a player who showed up beats one who didn't. Otherwise ${level} The organiser can correct any result afterwards.`);
    const clock = clockMinutesOf(t);
    if (clock) lines.push(`<b>Game clock:</b> each player has <b>${clock} minutes</b> per game, and it only runs during their own turn. Whoever runs out of time loses that game.`);
    const slugs = collectionsOf(t);
    lines.push(t.matchType === "draft"
        ? `Draft battle: both players open <b>${draft.packs}</b> packs from ${slugs.length ? "the chosen collections" : "every collection"}, then build a <b>${draft.deckSize}-card</b> deck on a <b>${draft.minutes}-minute</b> timer.`
        : `Regular matches: decks may only contain cards from ${slugs.length ? "the chosen collections" : "any collection"}.${deckRequired(t) ? ` Everyone must submit a deck list by <b>${esc(fmtDate(t.deckDeadline))}</b> and plays that deck; anyone without one is removed at the start.` : ""}`);
    if (bannedOf(t).length) lines.push(`<b>Banned cards:</b> ${bannedNames(t).join(", ")}.`);
    lines.push(`It needs at least <b>${minPlayersOf(t)}</b> players (up to <b>${esc(t.maxPlayers)}</b>) or it's cancelled. ${t.lateJoin ? "Late joining is allowed while there's a free spot." : "You can't join once it has started."}`);
    if (showsTopDecks(t)) lines.push(`When it ends, the top ${playerCount(t) >= 16 ? "8" : "4"} decks are shown to everyone here, so anyone can look at them or copy them.`);
    if (t.hasPassword) lines.push("Joining needs the password from the organiser.");
    if (isPrivate(t)) lines.push("This tournament is private — it's only shown to people who have the link.");
    return `<ul class="tn-rules">${lines.map(l => `<li>${l}</li>`).join("")}</ul>`;
}

function detailHtml(t) {
    const now = Date.now();
    const status = statusInfo(t, now);
    const players = playersInOrder(t).map(p => {
        const cls = p.uid === t.winner ? "champ" : p.uid === state.me.uid ? "me" : "";
        return `<button type="button" class="tn-player ${cls}" data-profile="${esc(p.uid)}" data-name="${esc(p.name)}" title="See ${esc(p.name)}'s profile">${p.uid === t.winner ? "🏆 " : ""}${esc(p.name)}${p.uid === state.me.uid ? " (you)" : ""}</button>`;
    }).join("") || `<span class="tn-hint">Nobody has joined yet.</span>`;

    let rounds = "";
    if (t.rounds) {
        for (let n = Number(t.currentRound || 0); n >= 1; n--) rounds += roundHtml(t, n);
    }
    // Knockouts: the drawn bracket (or the plain list of rounds).
    const knockout = t.format !== "swiss" && t.rounds && Number(t.totalRounds) >= 1;
    const bracketSection = knockout ? `<section><div class="tn-section-head"><h3>Bracket</h3>
            <div class="tn-seg" role="group" aria-label="Bracket view">
                <button type="button" data-bkview="tree" aria-pressed="${state.bracketView === "tree"}">Bracket</button>
                <button type="button" data-bkview="list" aria-pressed="${state.bracketView === "list"}">List</button>
            </div></div>
            ${state.bracketView === "tree" ? bracketHtml(t, state.me.uid) : rounds}</section>` : "";

    const mine = isMember(t);
    const buttons = [];
    if (!mine && canJoin(t, state.me.uid, now)) buttons.push(`<button type="button" class="tn-btn tn-btn-primary tn-btn-small" data-act="join" data-id="${esc(t.id)}">${t.status === "running" ? "Join late" : "Join"}${t.hasPassword ? " 🔒" : ""}</button>`);
    if (mine && t.status === "registration" && now < Number(t.startAt)) buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-act="leave" data-id="${esc(t.id)}">Leave</button>`);
    if (isCreator(t)) buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-gold" data-act="manage" data-id="${esc(t.id)}">⚙ Manage</button>`);
    buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-copy="${esc(t.id)}">🔗 Copy link</button>`);

    return `
        <div class="tn-meta">
            <span class="tn-status ${status.cls}">${esc(status.text)}</span>
            <span>🗓 ${t.status === "registration" ? "Starts" : "Started"} <b>${esc(fmtDate(t.startAt))}</b></span>
            <span>⏱ Rounds: <b>${esc(formatDuration(t.roundMinutes))}</b></span>
            <span>👥 <b>${playerCount(t)}</b> / ${esc(t.maxPlayers)}</span>
            <span>Organiser: <b>${esc(t.createdByName || "—")}</b></span>
        </div>
        <div class="tn-chips">${settingChips(t)}${collectionChips(t, 99)}</div>
        ${t.description ? `<p class="tn-desc full">${esc(t.description)}</p>` : ""}
        ${organiserStrip(t)}
        ${meStrip(t, now)}
        <section><h3>How it works</h3>${rulesHtml(t)}</section>
        <section><h3>Players (${playerCount(t)})</h3><div class="tn-players">${players}</div></section>
        ${topDecksHtml(t)}
        ${t.format === "swiss" && t.rounds ? `<section><h3>Standings</h3>${standingsHtml(t)}</section>` : ""}
        ${knockout ? bracketSection : (rounds ? `<section><h3>Rounds</h3>${rounds}</section>` : "")}
        <div class="tn-actions">${buttons.join("")}</div>`;
}

// ── top decks (finished tournaments) ─────────────────────────────────────────

const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

function topDecksHtml(t) {
    if (t.status !== "complete" || !showsTopDecks(t)) return "";
    const places = placings(t);
    if (!places.length) return "";
    const decks = t.topDecks || {};
    let missing = 0;
    const rows = places.map(p => {
        const d = decks[p.uid];
        if (!d) missing++;
        const art = d && state.leaderArt[d.leaderKey];
        const leaderName = (art && art.name) || (d && d.leaderKey) || "";
        const medal = MEDALS[p.place] || (p.place <= 4 ? "🥉" : "🎖");
        return `<div class="tn-top-row${p.uid === state.me.uid ? " me" : ""}${d ? "" : " pending"}">
            <span class="tn-top-place"><span aria-hidden="true">${medal}</span>${esc(p.label)}</span>
            <span class="tn-top-art">${art && art.imageUrl ? `<img src="${esc(art.imageUrl)}" alt="" loading="lazy">` : ""}</span>
            <span class="tn-top-who"><strong>${esc(nameOf(t, p.uid))}${p.uid === state.me.uid ? " (you)" : ""}</strong>
                <small>${d ? `${esc(d.deckName || "Deck")}${leaderName ? ` · ${esc(leaderName)}` : ""}` : "Deck not published yet"}</small></span>
            ${d ? `<span class="tn-top-actions">
                <button type="button" class="tn-btn tn-btn-small" data-top="view" data-uid="${esc(p.uid)}">View</button>
                <button type="button" class="tn-btn tn-btn-small" data-top="copy" data-uid="${esc(p.uid)}">Copy</button>
                <button type="button" class="tn-btn tn-btn-small tn-btn-primary" data-top="open" data-uid="${esc(p.uid)}">Open in Deck Builder</button>
            </span>` : ""}
        </div>`;
    }).join("");
    return `<section id="tnTopDecks"><h3>Top decks</h3><div class="tn-top">${rows}</div>
        ${missing ? `<p class="tn-hint">A missing deck fills in on its own when a player from this tournament (or the organiser) opens it.</p>` : ""}</section>`;
}

// The deck in the Deck Builder's import format ("Leader: …", "4x NUMBER").
function deckImportText(d) {
    const lines = [];
    if (d.deckName) lines.push(`# ${d.deckName}`);
    if (d.leaderKey) lines.push(`Leader: ${d.leaderKey}`);
    if (d.leaderKey2) lines.push(`Leader2: ${d.leaderKey2}`);
    String(d.deckText || "").split(/\n+/).forEach(line => {
        const m = line.trim().match(/^(\d+)\s*x\s*(.+)$/i);
        if (m) lines.push(`${m[1]}x ${m[2].trim()}`);
    });
    return lines.join("\n");
}

function topDeckAction(t, action, uid) {
    const d = (t.topDecks || {})[uid];
    if (!d) return;
    const who = nameOf(t, uid);
    if (action === "view") {
        const cards = Array.isArray(d.cards) ? d.cards : Object.values(d.cards || {});
        openViewDialog({ name: d.deckName || "Deck", cards, submittedAt: d.at, whenLabel: d.source === "list" ? "Submitted" : "Played" }, who);
    } else if (action === "copy") {
        copyText(deckImportText(d), "Deck copied — paste it into the Deck Builder's Import");
    } else if (action === "open") {
        const host = window.ccTnHost;
        if (!host || !host.openDeckInBuilder) { copyText(deckImportText(d), "Deck copied — paste it into the Deck Builder's Import"); return; }
        if (host.openDeckInBuilder({ name: `${d.deckName || "Deck"} (${who})`, leaderKey: d.leaderKey, leaderKey2: d.leaderKey2, deckText: d.deckText })) closeDetail();
    }
}

// Leader pictures + names for the top decks (looked up once, then the details redraw).
let leaderLookup = false;
async function ensureLeaderArt(t) {
    const wanted = Object.values(t.topDecks || {}).map(d => d && d.leaderKey).filter(n => n && !(n in state.leaderArt));
    if (!wanted.length || leaderLookup) return;
    leaderLookup = true;
    try {
        const found = await lookupCards(wanted, { withImages: true });
        wanted.forEach(n => { const info = found.get(n); state.leaderArt[n] = info ? { name: info.name || "", imageUrl: info.imageUrl || "" } : null; });
    } catch { wanted.forEach(n => { state.leaderArt[n] = null; }); }
    finally { leaderLookup = false; refreshDetail(); }
}

// Fill in missing top decks from this browser (see publishTopDecks). Retried at most
// every two minutes per tournament.
function maybePublishTopDecks(t) {
    if (!t || t.status !== "complete" || !showsTopDecks(t) || !state.me.uid) return;
    const missing = placings(t).some(p => !(t.topDecks || {})[p.uid]);
    if (!missing) return;
    const last = state.publishTried.get(t.id) || 0;
    if (Date.now() - last < 120000) return;
    state.publishTried.set(t.id, Date.now());
    publishTopDecks(t.id, t).catch(() => {});
}

function openDetail(id, scrollTo = "") {
    const t = getTournament(id);
    if (!t) return;
    state.openDetail = id;
    $("tnDetailTitle").textContent = t.name;
    $("tnDetailBody").innerHTML = detailHtml(t);
    $("tnDetailOverlay").hidden = false;
    ensureBanNames(bannedOf(t));
    ensureLeaderArt(t);
    maybePublishTopDecks(t);
    if (scrollTo) requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView({ block: "start" }));
}

function refreshDetail() {
    if (!state.openDetail || $("tnDetailOverlay").hidden) return;
    const t = getTournament(state.openDetail);
    if (!t) return;
    const body = $("tnDetailBody");
    const overlay = $("tnDetailOverlay");
    const scroll = overlay.scrollTop;
    const bracketScroll = body.querySelector(".tn-bracket-scroll")?.scrollLeft || 0;
    body.innerHTML = detailHtml(t);
    overlay.scrollTop = scroll;
    const bracket = body.querySelector(".tn-bracket-scroll");
    if (bracket) bracket.scrollLeft = bracketScroll;
    ensureLeaderArt(t);
}

function closeDetail() {
    state.openDetail = null;
    $("tnDetailOverlay").hidden = true;
}

$("tnDetailClose").addEventListener("click", closeDetail);
$("tnDetailOverlay").addEventListener("click", (event) => { if (event.target === $("tnDetailOverlay")) closeDetail(); });
$("tnDetailBody").addEventListener("click", (event) => {
    const action = event.target.closest("[data-act]");
    if (action) { handleAction(action); return; }
    const person = event.target.closest("[data-profile]");
    if (person) {
        import("../profileDialog.js?v=1").then(m => m.openProfile(person.dataset.profile, person.dataset.name)).catch(() => {});
        return;
    }
    const view = event.target.closest("[data-bkview]");
    if (view) { state.bracketView = view.dataset.bkview; refreshDetail(); return; }
    const top = event.target.closest("[data-top]");
    if (top) {
        const t = getTournament(state.openDetail);
        if (t) topDeckAction(t, top.dataset.top, top.dataset.uid);
        return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
        const url = `${location.origin}${location.pathname}?view=tournaments&t=${encodeURIComponent(copy.dataset.copy)}`;
        copyText(url, "Link copied");
    }
});

// ── create / edit form ───────────────────────────────────────────────────────

const radio = (name) => document.querySelector(`input[name='${name}']:checked`).value;
const setRadio = (name, value) => {
    const el = document.querySelector(`input[name='${name}'][value='${value}']`);
    if (el) el.checked = true;
};

function renderCollectionPicker() {
    const query = $("tnCollectionSearch").value.trim().toLowerCase();
    const items = state.collections.filter(c => !query || c.name.toLowerCase().includes(query) || c.slug.includes(query));
    $("tnCollectionList").innerHTML = items.map(c => `
        <label><input type="checkbox" value="${esc(c.slug)}" ${state.picked.has(c.slug) ? "checked" : ""}> ${esc(c.name)}</label>`).join("")
        || `<div class="tn-hint">No collections match.</div>`;
    const n = state.picked.size;
    $("tnCollectionCount").textContent = n ? `${n} collection${n === 1 ? "" : "s"} selected` : "Pick at least one collection.";
}

// ── ban list editor ──────────────────────────────────────────────────────────

function renderBanChips() {
    const box = $("tnBanChips");
    if (!box) return;
    box.innerHTML = state.banned.length
        ? state.banned.map(n => {
            const name = state.banNames[n];
            const unknown = state.banUnknown.has(n);
            return `<span class="tn-chip ban${unknown ? " unknown" : ""}" title="${unknown ? "Not found in the card library" : ""}">${name ? `${esc(name)} <small>${esc(n)}</small>` : esc(n)}<button type="button" data-unban="${esc(n)}" aria-label="Unban ${esc(n)}">✕</button></span>`;
        }).join("")
        : `<span class="tn-hint">No banned cards.</span>`;
    renderBanResults();
}

async function resolveBanNames() {
    await ensureBanNames(state.banned);
}

function addBans(text) {
    const numbers = String(text || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    numbers.forEach(n => {
        if (!state.banned.some(b => b.toLowerCase() === n.toLowerCase())) { state.banned.push(n); added++; }
    });
    renderBanChips();
    if (added) resolveBanNames();
    return added;
}

// The card search needs the whole library's names, so it only loads on request.
let searchCards = null;
let searchLoading = false;
async function ensureSearchLibrary() {
    if (searchCards || searchLoading) return;
    searchLoading = true;
    $("tnBanResults").innerHTML = `<div class="tn-hint">Loading the card library…</div>`;
    try {
        const library = await import("../firebase/cardLibraryService.js?v=collections-14");
        const result = await library.loadSharedCards({
            light: true,
            onProgress: ({ cards }) => { searchCards = cards; renderBanResults(); }
        });
        searchCards = result.cards || searchCards || [];
    } catch {
        $("tnBanResults").innerHTML = `<div class="tn-hint">Couldn't load the card library — you can still type card numbers above.</div>`;
    } finally {
        searchLoading = false;
        renderBanResults();
    }
}

function renderBanResults() {
    const box = $("tnBanResults");
    if (!box || !$("tnBanSearchBox").open) return;
    const query = $("tnBanSearch").value.trim().toLowerCase();
    if (!searchCards) { if (!searchLoading) box.innerHTML = ""; return; }
    if (query.length < 2) { box.innerHTML = `<div class="tn-hint">Type at least two letters.</div>`; return; }
    const seen = new Set();
    const hits = [];
    for (const card of searchCards) {
        const number = String(card.cardNumber || card.id || "");
        if (!number || seen.has(number)) continue;
        if (String(card.name || "").toLowerCase().includes(query) || number.toLowerCase().includes(query)) {
            seen.add(number);
            hits.push(card);
            if (hits.length >= 40) break;
        }
    }
    box.innerHTML = hits.length ? hits.map(card => {
        const number = String(card.cardNumber || card.id);
        const isBanned = state.banned.some(b => b.toLowerCase() === number.toLowerCase());
        return `<div class="tn-ban-row"><span><b>${esc(card.name || number)}</b> <small>${esc(number)} · ${esc(collectionName(card.collection || window.COLLECTION_DEFAULT || ""))}</small></span>
            <button type="button" class="tn-btn tn-btn-small${isBanned ? "" : " tn-btn-danger"}" data-ban-toggle="${esc(number)}" data-name="${esc(card.name || "")}">${isBanned ? "Unban" : "Ban"}</button></div>`;
    }).join("") : `<div class="tn-hint">No cards match "${esc(query)}".</div>`;
}

$("tnBanAdd").addEventListener("click", () => {
    const input = $("tnBanInput");
    addBans(input.value);
    input.value = "";
    input.focus();
});
$("tnBanInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); $("tnBanAdd").click(); }
});
$("tnBanChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-unban]");
    if (!button) return;
    state.banned = state.banned.filter(n => n !== button.dataset.unban);
    renderBanChips();
});
$("tnBanSearchBox").addEventListener("toggle", () => { if ($("tnBanSearchBox").open) { ensureSearchLibrary(); renderBanResults(); } });
$("tnBanSearch").addEventListener("input", renderBanResults);
$("tnBanResults").addEventListener("click", (event) => {
    const button = event.target.closest("[data-ban-toggle]");
    if (!button) return;
    const number = button.dataset.banToggle;
    const index = state.banned.findIndex(b => b.toLowerCase() === number.toLowerCase());
    if (index >= 0) state.banned.splice(index, 1);
    else {
        state.banned.push(number);
        if (button.dataset.name) state.banNames[number] = button.dataset.name;
    }
    renderBanChips();
});

// ── round length (presets + custom) ──────────────────────────────────────────

function fillRoundLengthOptions() {
    $("tnRoundLength").innerHTML = ROUND_LENGTHS.map(o => `<option value="${o.minutes}">${o.label}</option>`).join("")
        + `<option value="custom">Custom…</option>`;
}

function setRoundLength(minutes) {
    const select = $("tnRoundLength");
    if (ROUND_LENGTHS.some(o => o.minutes === Number(minutes))) {
        select.value = String(minutes);
    } else {
        select.value = "custom";
        const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
        $("tnRoundCustomUnit").value = String(unit);
        $("tnRoundCustomValue").value = String(minutes / unit);
    }
    syncForm();
}

function readRoundLength() {
    const select = $("tnRoundLength");
    if (select.value !== "custom") return Number(select.value);
    return Math.round(Number($("tnRoundCustomValue").value) * Number($("tnRoundCustomUnit").value));
}

// ── showing / hiding the parts of the form that depend on other choices ──────

function updateRulesHint() {
    const draft = radio("tnMatchType") === "draft";
    const swiss = radio("tnFormat") === "swiss";
    $("tnRulesHint").textContent =
        (draft ? "Every match is a Draft Battle, so both players need time to open packs and build a deck — pick a longer round. "
               : "Players choose a deck before each match; it must only use cards from the chosen pool. ")
        + (swiss ? "Swiss runs about log₂(players) rounds, so everyone plays every round."
                 : "Single elimination needs about log₂(players) rounds; byes fill an uneven bracket.");
}

function syncForm() {
    const draft = radio("tnMatchType") === "draft";
    const swiss = radio("tnFormat") === "swiss";
    $("tnDraftSection").hidden = !draft;
    $("tnDeckSection").hidden = draft;
    $("tnSwissRoundsField").hidden = !swiss;
    $("tnDeckDeadlineField").hidden = draft || !$("tnRequireDeck").checked;
    $("tnRoundCustom").hidden = $("tnRoundLength").value !== "custom";
    const clock = Number($("tnClock").value) || 0;
    $("tnTimeoutHint").textContent =
        ($("tnTimeoutRule").value === "organiser"
            ? "When a round runs out with a match still level, you'll get a red alert to pick the winner — the next round waits for you. "
            : "When a round runs out with a match still level, a coin flip picks the winner. ")
        + "A player ahead in a best-of series, or the only one who showed up, wins either way. You can change any result later. "
        + (clock ? `Each player gets ${clock} minutes per game, ticking only on their own turn — run out and you lose that game.`
                 : "No game clock: games can take as long as they need.");
    updateRulesHint();
}

function setLocked(locked) {
    $("tnLockedNote").hidden = !locked;
    document.querySelectorAll("#tnCreateForm [data-lock]").forEach(box => {
        box.classList.toggle("locked", locked);
        box.querySelectorAll("input, select, button").forEach(el => { el.disabled = locked; });
    });
}

function fillForm(t) {
    const editing = Boolean(t);
    const startDefault = new Date(Date.now() + 60 * 60 * 1000);
    startDefault.setMinutes(Math.ceil(startDefault.getMinutes() / 5) * 5, 0, 0);
    const startMs = editing ? Number(t.startAt) : startDefault.getTime();

    $("tnName").value = editing ? t.name : "";
    $("tnDescription").value = editing ? (t.description || "") : "";
    setRadio("tnMatchType", editing ? t.matchType : "regular");
    setRadio("tnFormat", editing ? t.format : "elimination");
    setRadio("tnBestOf", editing ? bestOfOf(t) : 1);

    const slugs = editing ? collectionsOf(t) : [];
    state.picked = new Set(slugs);
    $("tnAllCollections").checked = !slugs.length;
    $("tnCollectionPicker").hidden = !slugs.length;
    $("tnCollectionSearch").value = "";

    state.banned = editing ? bannedOf(t).slice() : [];
    $("tnBanInput").value = "";
    $("tnBanSearch").value = "";
    $("tnBanSearchBox").open = false;

    $("tnStart").value = toLocalInput(startMs);
    $("tnStart").min = toLocalInput(Date.now() + 60 * 1000);
    fillRoundLengthOptions();
    setRoundLength(editing ? Number(t.roundMinutes) : 1440);
    $("tnRoundMode").value = editing && t.roundMode === "full" ? "full" : "asap";
    $("tnTimeoutRule").value = editing && timeoutRuleOf(t) === "organiser" ? "organiser" : "coin";
    const clock = editing ? clockMinutesOf(t) : DEFAULT_CLOCK_MINUTES;
    const clockChoices = CLOCK_OPTIONS.includes(clock) ? CLOCK_OPTIONS : [...CLOCK_OPTIONS, clock].sort((a, b) => a - b);
    $("tnClock").innerHTML = clockChoices.map(m => `<option value="${m}">${m ? `${m} minutes each` : "Off — no clock"}</option>`).join("");
    $("tnClock").value = String(clock);
    $("tnSwissRounds").value = editing && t.roundsSetting ? String(t.roundsSetting) : "";

    $("tnMinPlayers").value = editing ? minPlayersOf(t) : 2;
    $("tnMaxPlayers").value = editing ? Number(t.maxPlayers) : 16;
    $("tnLateJoin").checked = editing ? Boolean(t.lateJoin) : false;
    $("tnJoinSelf").checked = true;
    $("tnShowTopDecks").checked = editing ? showsTopDecks(t) : true;
    $("tnJoinSelfRow").hidden = editing;

    $("tnPrivate").checked = editing ? isPrivate(t) : false;
    $("tnPassword").value = "";
    $("tnPassword").placeholder = editing && t.hasPassword ? "Leave empty to keep the current password" : "No password";
    $("tnPasswordHint").textContent = editing && t.hasPassword
        ? "— there's a password now; type a new one to change it"
        : "— optional; players must enter it to join";
    $("tnClearPassword").checked = false;
    $("tnClearPasswordRow").hidden = !(editing && t.hasPassword);

    $("tnRequireDeck").checked = editing ? Boolean(t.requireDeck) : false;
    const deadlineDefault = Math.max(Date.now() + 5 * 60 * 1000, startMs - 60 * 60 * 1000);
    $("tnDeckDeadline").value = toLocalInput(editing && t.deckDeadline ? Number(t.deckDeadline) : deadlineDefault);

    const draft = editing ? draftSettingsOf(t) : DRAFT_DEFAULTS;
    $("tnDraftPacks").value = draft.packs;
    $("tnDraftMinutes").value = draft.minutes;
    $("tnDraftDeckSize").value = draft.deckSize;
}

function openForm(t = null) {
    if (!t && !requireSignIn("Sign in to create a tournament.")) return;
    state.editing = t ? t.id : null;
    $("tnCreateError").hidden = true;
    $("tnCreateTitle").textContent = t ? "Edit tournament" : "Create a tournament";
    $("tnCreateSubmit").textContent = t ? "Save changes" : "Create tournament";
    fillForm(t);
    setLocked(Boolean(t && t.status !== "registration"));
    syncForm();
    renderCollectionPicker();
    renderBanChips();
    if (state.banned.length) resolveBanNames();
    $("tnCreateOverlay").hidden = false;
    $("tnName").focus();
}

function closeForm() { $("tnCreateOverlay").hidden = true; }

function readForm() {
    const draft = radio("tnMatchType") === "draft";
    const swiss = radio("tnFormat") === "swiss";
    const all = $("tnAllCollections").checked;
    const rounds = $("tnSwissRounds").value.trim();
    const deadline = $("tnDeckDeadline").value;
    return {
        name: $("tnName").value,
        description: $("tnDescription").value,
        matchType: radio("tnMatchType"),
        format: radio("tnFormat"),
        bestOf: Number(radio("tnBestOf")),
        collections: all ? [] : [...state.picked],
        banned: state.banned.slice(),
        startAt: new Date($("tnStart").value).getTime(),
        roundMinutes: readRoundLength(),
        roundMode: $("tnRoundMode").value,
        timeoutRule: $("tnTimeoutRule").value,
        clockMinutes: Number($("tnClock").value) || 0,
        roundsSetting: swiss && rounds ? Number(rounds) : undefined,
        minPlayers: Number($("tnMinPlayers").value),
        maxPlayers: Number($("tnMaxPlayers").value),
        lateJoin: $("tnLateJoin").checked,
        showTopDecks: $("tnShowTopDecks").checked,
        private: $("tnPrivate").checked,
        requireDeck: !draft && $("tnRequireDeck").checked,
        deckDeadline: deadline ? new Date(deadline).getTime() : NaN,
        draft: draft ? {
            packs: Number($("tnDraftPacks").value),
            minutes: Number($("tnDraftMinutes").value),
            deckSize: Number($("tnDraftDeckSize").value)
        } : undefined
    };
}

$("tnCreateBtn").addEventListener("click", () => openForm());
$("tnCreateClose").addEventListener("click", closeForm);
$("tnCreateCancel").addEventListener("click", closeForm);
$("tnCreateOverlay").addEventListener("click", (event) => { if (event.target === $("tnCreateOverlay")) closeForm(); });

$("tnAllCollections").addEventListener("change", (event) => {
    $("tnCollectionPicker").hidden = event.target.checked;
});
$("tnCollectionSearch").addEventListener("input", renderCollectionPicker);
$("tnCollectionList").addEventListener("change", (event) => {
    const box = event.target.closest("input[type='checkbox']");
    if (!box) return;
    if (box.checked) state.picked.add(box.value); else state.picked.delete(box.value);
    renderCollectionPicker();
});
document.querySelectorAll("input[name='tnMatchType'], input[name='tnFormat'], #tnRequireDeck, #tnRoundLength, #tnTimeoutRule, #tnClock")
    .forEach(input => input.addEventListener("change", syncForm));

$("tnCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("tnCreateError");
    errorBox.hidden = true;
    if (!requireSignIn(state.editing ? "Sign in to edit this tournament." : "Sign in to create a tournament.")) return;

    const all = $("tnAllCollections").checked;
    if (!all && !state.picked.size) {
        errorBox.textContent = "Pick at least one collection, or choose All collections.";
        errorBox.hidden = false;
        return;
    }

    const submit = $("tnCreateSubmit");
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = state.editing ? "Saving…" : "Creating…";
    try {
        const form = readForm();
        const password = $("tnPassword").value.trim();
        if (state.editing) {
            const id = state.editing;
            await updateTournament(id, form, { password, clearPassword: $("tnClearPassword").checked && !password });
            closeForm();
            toast("Changes saved.");
        } else {
            const id = await createTournament(firebaseUserOrId(), state.me.name, { ...form, join: $("tnJoinSelf").checked, password });
            closeForm();
            toast("Tournament created — it's on the list now.");
            state.filter = "all";
            document.querySelectorAll(".tn-filter").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
            // Show it straight away rather than waiting for the live update.
            setTimeout(() => { if (getTournament(id)) openDetail(id); }, 600);
        }
    } catch (error) {
        errorBox.textContent = isPermissionError(error)
            ? "Couldn't save — tournament permissions aren't enabled on the database yet (or you can't edit this one)."
            : error.message;
        errorBox.hidden = false;
    } finally {
        submit.disabled = false;
        submit.textContent = label;
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Close only the top-most dialog.
    const order = [
        ["tnDeckViewOverlay", closeViewDialog],
        ["tnPasswordOverlay", () => $("tnPasswordCancel").click()],
        ["tnDeckOverlay", closeSubmitDialog],
        ["tnCreateOverlay", closeForm],
        ["tnManageOverlay", () => manage.close()],
        ["tnDetailOverlay", closeDetail]
    ];
    const open = order.find(([id]) => !$(id).hidden);
    if (open) open[1]();
});

// ── data ─────────────────────────────────────────────────────────────────────

async function loadCollectionChoices() {
    const names = {};
    (window.BUILTIN_COLLECTIONS || []).forEach(c => { if (c && c.slug) names[c.slug] = c.name || c.slug; });
    try {
        const library = await import("../firebase/cardLibraryService.js?v=collections-14");
        const registry = library.loadSharedCollections ? await library.loadSharedCollections() : [];
        (registry || []).forEach(c => { if (c && c.slug) names[c.slug] = c.name || names[c.slug] || c.slug; });
    } catch { /* the built-in list is enough */ }

    delete names["all-access"];     // a virtual view, not a real card pool
    state.collectionNames = names;
    state.collections = Object.entries(names)
        .map(([slug, name]) => ({ slug, name }))
        .sort((a, b) => (a.slug === "everything-else") - (b.slug === "everything-else") || a.name.localeCompare(b.name));
    renderCollectionPicker();
    renderList();
}

// Tournaments only move forward when a participant's browser nudges them (there is
// no server), so every participant keeps their own tournaments ticking.
let syncing = false;
async function syncMine() {
    if (syncing || !state.me.uid) return;
    const now = Date.now();
    const targets = state.list.filter(t => (isMember(t) || isCreator(t))
        && (t.status === "running" || (t.status === "registration" && now >= Number(t.startAt))));
    if (!targets.length) return;
    syncing = true;
    try {
        for (const t of targets) {
            try { await syncTournament(t.id, state.me.uid); }
            catch (error) { console.warn("Tournament sync failed:", error); }
        }
    } finally { syncing = false; }
}

function onList(list) {
    state.list = list;
    state.loaded = true;
    state.denied = false;
    setNotice("");
    renderList();
    refreshDetail();
    manage.refresh();
    if (tabVisible()) {
        syncMine();
        list.filter(t => t.status === "complete" && (isMember(t) || isCreator(t))).forEach(maybePublishTopDecks);
    }

    // ?t=<id> opens that tournament straight away (the "Copy link" button).
    openPendingLink();
}

function onListError(error) {
    state.loaded = true;
    state.list = [];
    if (isPermissionError(error)) {
        state.denied = true;
        setNotice(`<b>Tournaments aren't switched on yet.</b> The database rules for tournaments haven't been published.
            Admin: open Firebase Console → Realtime Database → Rules, paste in <code>database.rules.json</code> and press Publish.`);
    } else {
        setNotice("Couldn't load tournaments right now. Check your connection and refresh.");
    }
    renderList();
}

// ?t=<id> (a "Copy link" link) or an alert asking for a tournament opens it (and the
// organiser's match list for "pick the winner") as soon as it has loaded.
function openPendingLink() {
    if (!state.deepLinkId || state.deepLinked || !state.list.some(t => t.id === state.deepLinkId)) return;
    if (!viewActive()) return;
    state.deepLinked = true;
    const t = getTournament(state.deepLinkId);
    closeDetail();
    manage.close();
    if (state.deepLinkManage && isCreator(t)) manage.open(t.id, state.deepLinkManage === "matches" ? "matches" : "players");
    else openDetail(state.deepLinkId);
}

/** Open one tournament (from an alert): its details, or the organiser's panel. */
export function openTournament(id, manageTab = "") {
    state.deepLinkId = String(id || "");
    state.deepLinkManage = manageTab || "";
    state.deepLinked = false;
    if (state.loaded) openPendingLink();
}

// The tab is part of the main page now: only redraw / nudge while it's on screen
// (the corner alerts keep tournaments moving everywhere else).
function viewActive() {
    const view = document.getElementById("tournamentsView");
    return Boolean(view && view.classList.contains("active"));
}
function tabVisible() {
    return viewActive() && document.visibilityState !== "hidden";
}

let started = false;
/** Called by the app every time the Tournaments tab is shown. */
export function show() {
    if (!started) { started = true; init(); return; }
    refreshIdentity();
    renderList();
    refreshDetail();
    manage.refresh();
    syncMine();
    openPendingLink();
}

async function init() {
    document.addEventListener("cc-account-change", () => { refreshIdentity(); renderList(); refreshDetail(); manage.refresh(); syncMine(); });

    try {
        await signInGuest();
        firebaseUser = await waitForUser();
    } catch { /* browsing still works without a connection to auth */ }
    refreshIdentity();

    loadCollectionChoices();
    watchTournaments(onList, onListError);

    // Keep countdowns fresh and nudge the tournaments I'm in (while on screen).
    setInterval(() => { if (tabVisible()) { renderList(); refreshDetail(); manage.refresh(); syncMine(); } }, 30000);
    document.addEventListener("visibilitychange", () => {
        if (tabVisible()) { renderList(); syncMine(); }
    });
}
