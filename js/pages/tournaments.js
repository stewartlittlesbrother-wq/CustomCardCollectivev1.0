import { signInGuest, waitForUser } from "../firebase/firebaseApp.js";
import {
    createTournament,
    watchTournaments,
    joinTournament,
    leaveTournament,
    cancelTournament,
    syncTournament,
    enterMatch,
    isPermissionError
} from "../firebase/tournamentService.js?v=tour-1";
import {
    ROUND_LENGTHS,
    MAX_PLAYER_OPTIONS,
    formatDuration,
    collectionsOf,
    playerCount,
    isOpenForSignup,
    myStatus,
    playersInOrder,
    pairingsOf,
    getRound,
    swissStandings,
    nameOf
} from "../core/tournamentEngine.js?v=tour-1";

// ── state ────────────────────────────────────────────────────────────────────

const state = {
    list: [],
    filter: "all",
    loaded: false,
    denied: false,
    me: { uid: "", name: "", signedIn: false },
    collections: [],            // [{ slug, name }]
    collectionNames: {},        // slug -> display name
    picked: new Set(),          // collections ticked in the create form
    openDetail: null            // id of the tournament shown in the details dialog
};
let firebaseUser = null;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

// ── formatting ───────────────────────────────────────────────────────────────

function fmtDate(ms) {
    return new Date(Number(ms)).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
}

function relative(ms, now = Date.now()) {
    const diff = Number(ms) - now;
    const abs = Math.abs(diff);
    const minutes = Math.round(abs / 60000);
    let text;
    if (minutes < 1) return "now";
    if (minutes < 60) text = `${minutes} min`;
    else if (minutes < 48 * 60) { const h = Math.round(minutes / 60); text = `${h} hour${h === 1 ? "" : "s"}`; }
    else { const d = Math.round(minutes / 1440); text = `${d} day${d === 1 ? "" : "s"}`; }
    return diff >= 0 ? `in ${text}` : `${text} ago`;
}

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

function statusInfo(t, now) {
    if (t.status === "cancelled") return { cls: "cancelled", text: "Cancelled" };
    if (t.status === "complete") return { cls: "done", text: "Finished" };
    if (t.status === "running") return { cls: "running", text: `Round ${t.currentRound} of ${t.totalRounds}` };
    if (now >= Number(t.startAt)) return { cls: "running", text: "Starting…" };
    return isOpenForSignup(t, now)
        ? { cls: "open", text: "Open for sign-up" }
        : { cls: "open", text: "Full" };
}

// ── toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message, isError = false) {
    const el = $("tnToast");
    el.textContent = message;
    el.className = "tn-toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

// ── "where do I stand" strip ─────────────────────────────────────────────────

function meStrip(t, now) {
    if (!isMember(t)) return "";
    const s = myStatus(t, state.me.uid, now);
    const pts = t.format === "swiss" ? " You score a point." : " You advance.";

    switch (s.state) {
        case "registered":
            return `<div class="tn-me"><div><strong>✅ You're in.</strong>
                <small>Round 1 starts ${fmtDate(t.startAt)} (${relative(t.startAt, now)}).</small></div></div>`;

        case "play": {
            const overdue = now > Number(s.dueAt);
            return `<div class="tn-me action"><div>
                <strong>⚔️ Round ${s.round} — you still need to play ${esc(s.opponentName)}</strong>
                <small>${overdue
                    ? "The round timer has run out — it will be settled as a forfeit."
                    : `Due ${fmtDate(s.dueAt)} (${relative(s.dueAt, now)}).`}
                    ${t.matchType === "draft" ? " Draft battle: you'll open packs and build a deck first." : ""}</small>
                </div>
                <button type="button" class="tn-btn tn-btn-primary" data-act="play" data-id="${esc(t.id)}">▶ Play match</button></div>`;
        }
        case "waiting":
            return `<div class="tn-me"><div>
                <strong>${s.won ? `✅ Round ${s.round} done — you won.` : `Round ${s.round} done — you lost.`}</strong>
                <small>Waiting for the rest of the round (ends ${fmtDate(s.dueAt)}). Nothing for you to do yet.</small></div></div>`;

        case "bye":
            return `<div class="tn-me"><div><strong>😴 Round ${s.round}: you have a bye.</strong>
                <small>Nothing to play this round.${pts}</small></div></div>`;

        case "eliminated":
            return `<div class="tn-me out"><div><strong>❌ Eliminated${s.lostInRound ? ` in round ${s.lostInRound}` : ""}.</strong>
                <small>Thanks for playing — you can still follow the bracket in Details.</small></div></div>`;

        case "champion":
            return `<div class="tn-me"><div><strong>🏆 You won this tournament!</strong></div></div>`;

        case "finished":
            return `<div class="tn-me"><div><strong>Finished${s.rank ? ` — you placed #${s.rank}` : ""}.</strong></div></div>`;

        case "cancelled":
            return `<div class="tn-me out"><div><strong>This tournament was cancelled.</strong>
                <small>${esc(t.cancelReason || "")}</small></div></div>`;

        default:
            return "";
    }
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

function sortRank(t, now) {
    const mine = isMember(t) ? myStatus(t, state.me.uid, now) : null;
    if (mine && mine.needsAction) return 0;                       // you owe a match
    if (t.status === "running" || (t.status === "registration" && now >= Number(t.startAt))) return 1;
    if (t.status === "registration") return 2;
    return 3;                                                     // finished / cancelled
}

function cardHtml(t, now) {
    const status = statusInfo(t, now);
    const mine = isMember(t);
    const s = mine ? myStatus(t, state.me.uid, now) : null;
    const open = isOpenForSignup(t, now);

    const startLine = t.status === "registration"
        ? `<span>🗓 Starts <b>${fmtDate(t.startAt)}</b> (${relative(t.startAt, now)})</span>`
        : `<span>🗓 Started <b>${fmtDate(t.startAt)}</b></span>`;

    const buttons = [];
    if (!mine && open) buttons.push(`<button type="button" class="tn-btn tn-btn-primary tn-btn-small" data-act="join" data-id="${esc(t.id)}">Join</button>`);
    if (mine && t.status === "registration" && now < Number(t.startAt)) {
        buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-act="leave" data-id="${esc(t.id)}">Leave</button>`);
    }
    buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-act="view" data-id="${esc(t.id)}">Details</button>`);
    if (isCreator(t) && (t.status === "registration" || t.status === "running")) {
        buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-danger" data-act="cancel" data-id="${esc(t.id)}">Cancel tournament</button>`);
    }

    return `<article class="tn-card${mine ? " mine" : ""}${s && s.needsAction ? " needs-action" : ""}" data-id="${esc(t.id)}">
        <div class="tn-card-top">
            <div>
                <h2 class="tn-card-title">${esc(t.name)}</h2>
                <p class="tn-by">Organised by ${esc(t.createdByName || "someone")}</p>
            </div>
            <span class="tn-status ${status.cls}">${esc(status.text)}</span>
        </div>
        <div class="tn-meta">
            ${startLine}
            <span>⏱ Each round lasts <b>${esc(formatDuration(t.roundMinutes))}</b></span>
            <span>👥 <b>${playerCount(t)}</b> / ${esc(t.maxPlayers)} players</span>
        </div>
        <div class="tn-chips">
            <span class="tn-chip format">${formatLabel(t)}</span>
            <span class="tn-chip type">${typeLabel(t)}</span>
            ${collectionChips(t)}
        </div>
        ${meStrip(t, now)}
        <div class="tn-actions">${buttons.join("")}</div>
    </article>`;
}

function renderList() {
    const list = $("tnList");
    if (!state.loaded) { list.innerHTML = `<div class="tn-empty">Loading tournaments…</div>`; return; }
    const now = Date.now();

    const shown = state.list
        .filter(t => matchesFilter(t, now))
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

async function doJoin(id) {
    if (!requireSignIn("Sign in to join tournaments.")) return;
    try {
        await joinTournament(id, firebaseUser || { uid: state.me.uid }, state.me.name);
        toast("You're in! Check back when it starts.");
    } catch (error) { toast(error.message, true); }
}

async function doLeave(id) {
    try { await leaveTournament(id, state.me.uid); toast("You've left the tournament."); }
    catch (error) { toast(error.message, true); }
}

async function doCancel(id) {
    const t = state.list.find(x => x.id === id);
    if (!t || !window.confirm(`Cancel "${t.name}" for everyone? This can't be undone.`)) return;
    try { await cancelTournament(id); toast("Tournament cancelled."); }
    catch (error) { toast(error.message, true); }
}

async function doPlay(id) {
    if (!requireSignIn("Sign in to play tournament matches.")) return;
    try {
        toast("Opening your match…");
        // Re-check first: a result may have just moved the tournament to a new round.
        const fresh = (await syncTournament(id, state.me.uid)) || state.list.find(x => x.id === id);
        const user = firebaseUser || { uid: state.me.uid };
        const { code, slot } = await enterMatch(id, fresh, user, state.me.name);
        window.location.href = `multiplayer.html?room=${encodeURIComponent(code)}&slot=${encodeURIComponent(slot)}`;
    } catch (error) { toast(error.message || "Couldn't open the match.", true); }
}

$("tnList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const id = button.dataset.id;
    switch (button.dataset.act) {
        case "join": doJoin(id); break;
        case "leave": doLeave(id); break;
        case "cancel": doCancel(id); break;
        case "play": doPlay(id); break;
        case "view": openDetail(id); break;
    }
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
        default: return "";
    }
}

function roundHtml(t, n) {
    const round = getRound(t, n);
    if (!round) return "";
    const rows = pairingsOf(round).map(p => {
        const done = p.result && p.result.winner && p.result.winner !== "none";
        const side = (uid, right) => {
            const cls = done ? (p.result.winner === uid ? "win" : "lose") : "";
            const me = uid === state.me.uid ? " (you)" : "";
            return `<span class="side ${cls}${right ? " right" : ""}">${esc(nameOf(t, uid))}${me}${done && p.result.winner === uid ? " ✓" : ""}</span>`;
        };
        const note = p.result ? reasonNote(p.result) : "";
        return `<div class="tn-pairing">
            ${side(p.a, false)}<span class="vs">${p.bye ? "BYE" : "VS"}</span>${p.bye ? `<span class="side right lose">—</span>` : side(p.b, true)}
            ${note && !p.bye ? `<div class="note">${esc(note)}</div>` : ""}
        </div>`;
    }).join("");
    const ends = t.status === "running" && n === t.currentRound ? `ends ${fmtDate(round.endsAt)}` : "";
    return `<div class="tn-round"><div class="tn-round-head">Round ${n}<span>${ends}</span></div>${rows}</div>`;
}

function standingsHtml(t) {
    const rows = swissStandings(t).map(r => `<tr class="${r.uid === state.me.uid ? "me" : ""}">
        <td>${r.rank}</td><td>${esc(r.name)}</td><td>${r.points}</td><td>${r.wins}–${r.losses}</td><td>${r.buchholz}</td></tr>`).join("");
    return `<table class="tn-table"><thead><tr><th>#</th><th>Player</th><th>Points</th><th>W–L</th><th>Opp. points</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rulesHtml(t) {
    const lines = [];
    lines.push(`Each round lasts <b>${esc(formatDuration(t.roundMinutes))}</b>. Play your match any time in that window by pressing <b>Play match</b> — whoever opens it first creates the room and the other joins.`);
    lines.push(t.format === "swiss"
        ? "Swiss: a win or a bye is 1 point. You're paired with someone on a similar score and never face the same person twice if it can be avoided. Highest points wins, then opponents' points, then sign-up order."
        : "Single elimination: win and you go through, lose and you're out. If the player count isn't a power of two, some players get a round-1 bye.");
    lines.push(t.format === "swiss"
        ? "If a round runs out: a player who showed up beats one who didn't. If neither played, nobody scores."
        : "If a round runs out: a player who showed up beats one who didn't. If neither (or both without finishing) the higher seed — the earlier sign-up — advances.");
    const slugs = collectionsOf(t);
    lines.push(t.matchType === "draft"
        ? `Draft battle: both players open packs from ${slugs.length ? "the chosen collections" : "every collection"}, then build a 40-card deck on a 15-minute timer.`
        : `Regular matches: decks may only contain cards from ${slugs.length ? "the chosen collections" : "any collection"}.`);
    return `<ul class="tn-rules">${lines.map(l => `<li>${l}</li>`).join("")}</ul>`;
}

function detailHtml(t) {
    const now = Date.now();
    const status = statusInfo(t, now);
    const players = playersInOrder(t).map(p => {
        const cls = p.uid === t.winner ? "champ" : p.uid === state.me.uid ? "me" : "";
        return `<span class="tn-player ${cls}">${p.uid === t.winner ? "🏆 " : ""}${esc(p.name)}${p.uid === state.me.uid ? " (you)" : ""}</span>`;
    }).join("") || `<span class="tn-hint">Nobody has joined yet.</span>`;

    let rounds = "";
    if (t.rounds) {
        for (let n = Number(t.currentRound || 0); n >= 1; n--) rounds += roundHtml(t, n);
    }

    return `
        <div class="tn-meta">
            <span class="tn-status ${status.cls}">${esc(status.text)}</span>
            <span>🗓 ${t.status === "registration" ? "Starts" : "Started"} <b>${fmtDate(t.startAt)}</b></span>
            <span>⏱ Rounds: <b>${esc(formatDuration(t.roundMinutes))}</b></span>
            <span>👥 <b>${playerCount(t)}</b> / ${esc(t.maxPlayers)}</span>
        </div>
        <div class="tn-chips"><span class="tn-chip format">${formatLabel(t)}</span><span class="tn-chip type">${typeLabel(t)}</span>${collectionChips(t, 99)}</div>
        ${meStrip(t, now)}
        <section><h3>How it works</h3>${rulesHtml(t)}</section>
        <section><h3>Players (${playerCount(t)})</h3><div class="tn-players">${players}</div></section>
        ${t.format === "swiss" && t.rounds ? `<section><h3>Standings</h3>${standingsHtml(t)}</section>` : ""}
        ${rounds ? `<section><h3>${t.format === "swiss" ? "Rounds" : "Bracket"}</h3>${rounds}</section>` : ""}
        <div class="tn-actions"><button type="button" class="tn-btn tn-btn-small" data-copy="${esc(t.id)}">🔗 Copy link</button></div>`;
}

function openDetail(id) {
    const t = state.list.find(x => x.id === id);
    if (!t) return;
    state.openDetail = id;
    $("tnDetailTitle").textContent = t.name;
    $("tnDetailBody").innerHTML = detailHtml(t);
    $("tnDetailOverlay").hidden = false;
}

function refreshDetail() {
    if (!state.openDetail || $("tnDetailOverlay").hidden) return;
    const t = state.list.find(x => x.id === state.openDetail);
    if (t) $("tnDetailBody").innerHTML = detailHtml(t);
}

function closeDetail() {
    state.openDetail = null;
    $("tnDetailOverlay").hidden = true;
}

$("tnDetailClose").addEventListener("click", closeDetail);
$("tnDetailOverlay").addEventListener("click", (event) => { if (event.target === $("tnDetailOverlay")) closeDetail(); });
$("tnDetailBody").addEventListener("click", (event) => {
    const play = event.target.closest("[data-act='play']");
    if (play) { doPlay(play.dataset.id); return; }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
        const url = `${location.origin}${location.pathname}?t=${encodeURIComponent(copy.dataset.copy)}`;
        navigator.clipboard?.writeText(url).then(() => toast("Link copied"), () => toast(url));
    }
});

// ── create dialog ────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, "0"); }
function toLocalInput(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderCollectionPicker() {
    const query = $("tnCollectionSearch").value.trim().toLowerCase();
    const items = state.collections.filter(c => !query || c.name.toLowerCase().includes(query) || c.slug.includes(query));
    $("tnCollectionList").innerHTML = items.map(c => `
        <label><input type="checkbox" value="${esc(c.slug)}" ${state.picked.has(c.slug) ? "checked" : ""}> ${esc(c.name)}</label>`).join("")
        || `<div class="tn-hint">No collections match.</div>`;
    const n = state.picked.size;
    $("tnCollectionCount").textContent = n ? `${n} collection${n === 1 ? "" : "s"} selected` : "Pick at least one collection.";
}

function updateRulesHint() {
    const draft = document.querySelector("input[name='tnMatchType']:checked").value === "draft";
    const swiss = document.querySelector("input[name='tnFormat']:checked").value === "swiss";
    $("tnRulesHint").textContent =
        (draft ? "Every match is a Draft Battle, so both players need time to open packs and build a deck — pick a longer round. "
               : "Players choose a deck before each match; it must only use cards from the chosen pool. ")
        + (swiss ? "Swiss runs about log₂(players) rounds, so everyone plays every round."
                 : "Single elimination needs about log₂(players) rounds; byes fill an uneven bracket.");
}

function openCreate() {
    if (!requireSignIn("Sign in to create a tournament.")) return;
    $("tnCreateForm").reset();
    $("tnCreateError").hidden = true;
    state.picked = new Set();
    $("tnCollectionPicker").hidden = true;
    $("tnCollectionSearch").value = "";

    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5, 0, 0);
    $("tnStart").value = toLocalInput(start);
    $("tnStart").min = toLocalInput(new Date(Date.now() + 60 * 1000));

    $("tnRoundLength").innerHTML = ROUND_LENGTHS
        .map(o => `<option value="${o.minutes}"${o.minutes === 1440 ? " selected" : ""}>${o.label}</option>`).join("");
    $("tnMaxPlayers").innerHTML = MAX_PLAYER_OPTIONS
        .map(n => `<option value="${n}"${n === 16 ? " selected" : ""}>${n} players</option>`).join("");

    renderCollectionPicker();
    updateRulesHint();
    $("tnCreateOverlay").hidden = false;
    $("tnName").focus();
}

function closeCreate() { $("tnCreateOverlay").hidden = true; }

$("tnCreateBtn").addEventListener("click", openCreate);
$("tnCreateClose").addEventListener("click", closeCreate);
$("tnCreateCancel").addEventListener("click", closeCreate);
$("tnCreateOverlay").addEventListener("click", (event) => { if (event.target === $("tnCreateOverlay")) closeCreate(); });

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
document.querySelectorAll("input[name='tnMatchType'], input[name='tnFormat']")
    .forEach(input => input.addEventListener("change", updateRulesHint));

$("tnCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("tnCreateError");
    errorBox.hidden = true;
    if (!requireSignIn("Sign in to create a tournament.")) return;

    const all = $("tnAllCollections").checked;
    if (!all && !state.picked.size) {
        errorBox.textContent = "Pick at least one collection, or choose All collections.";
        errorBox.hidden = false;
        return;
    }

    const submit = $("tnCreateSubmit");
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
        const id = await createTournament(firebaseUser || { uid: state.me.uid }, state.me.name, {
            name: $("tnName").value,
            collections: all ? [] : [...state.picked],
            matchType: document.querySelector("input[name='tnMatchType']:checked").value,
            format: document.querySelector("input[name='tnFormat']:checked").value,
            startAt: new Date($("tnStart").value).getTime(),
            roundMinutes: Number($("tnRoundLength").value),
            maxPlayers: Number($("tnMaxPlayers").value),
            join: $("tnJoinSelf").checked
        });
        closeCreate();
        toast("Tournament created — it's on the list now.");
        state.filter = "all";
        document.querySelectorAll(".tn-filter").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
        // Show it straight away rather than waiting for the live update.
        setTimeout(() => { if (state.list.some(t => t.id === id)) openDetail(id); }, 600);
    } catch (error) {
        errorBox.textContent = isPermissionError(error)
            ? "Couldn't create it — tournament permissions aren't enabled on the database yet."
            : error.message;
        errorBox.hidden = false;
    } finally {
        submit.disabled = false;
        submit.textContent = "Create tournament";
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeCreate();
    closeDetail();
});

// ── data ─────────────────────────────────────────────────────────────────────

async function loadCollectionChoices() {
    const names = {};
    (window.BUILTIN_COLLECTIONS || []).forEach(c => { if (c && c.slug) names[c.slug] = c.name || c.slug; });
    try {
        const library = await import("../firebase/cardLibraryService.js?v=collections-13");
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
    syncMine();

    // ?t=<id> opens that tournament straight away (the "Copy link" button).
    const wanted = new URLSearchParams(location.search).get("t");
    if (wanted && !state.deepLinked && list.some(t => t.id === wanted)) {
        state.deepLinked = true;
        openDetail(wanted);
    }
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

async function init() {
    document.addEventListener("cc-account-change", () => { refreshIdentity(); renderList(); refreshDetail(); syncMine(); });

    try {
        await signInGuest();
        firebaseUser = await waitForUser();
    } catch { /* browsing still works without a connection to auth */ }
    refreshIdentity();

    loadCollectionChoices();
    watchTournaments(onList, onListError);

    // Keep countdowns fresh and nudge the tournaments I'm in.
    setInterval(() => { renderList(); refreshDetail(); syncMine(); }, 30000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") { renderList(); syncMine(); }
    });
}

init();
