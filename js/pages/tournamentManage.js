// The organiser's panel: who has joined (with kick buttons), every match (with "set the
// winner"), and every submitted deck list.

import { $, esc, fmtDate, relative, toast, copyText, downloadText, safeFilename } from "./tournamentUi.js?v=tour-3";
import {
    kickFromTournament,
    setMatchResult,
    startNow,
    cancelTournament,
    deleteTournament,
    isPermissionError
} from "../firebase/tournamentService.js?v=tour-5";
import { watchDecks, deckListText } from "../firebase/tournamentDecks.js?v=tour-3";
import { openViewDialog } from "./tournamentDeckUi.js?v=tour-3";
import {
    playersInOrder,
    playerCount,
    minPlayersOf,
    bestOfOf,
    deckRequired,
    myStatus,
    nameOf,
    getRound,
    pairingsOf,
    seriesScore,
    canEditResult
} from "../core/tournamentEngine.js?v=tour-3";

/**
 * ctx: {
 *   getTournament(id) -> the latest tournament document (or undefined)
 *   openEdit(t)       -> open the settings form for t
 * }
 */
export function createManage(ctx) {
    const state = { id: null, tab: "players", decks: {}, decksError: false, unsubDecks: null };

    const current = () => (state.id ? ctx.getTournament(state.id) : null);

    function stopDecks() {
        if (state.unsubDecks) { try { state.unsubDecks(); } catch { /* already gone */ } }
        state.unsubDecks = null;
    }

    function watchDeckLists(t) {
        stopDecks();
        state.decks = {};
        state.decksError = false;
        state.unsubDecks = watchDecks(t.id, (map) => { state.decks = map; render(); }, () => { state.decksError = true; render(); });
    }

    // ── tabs ────────────────────────────────────────────────────────────────

    function statusText(t, uid) {
        const s = myStatus(t, uid);
        switch (s.state) {
            case "registered": return "Signed up";
            case "play": return `Round ${s.round}: playing ${s.opponentName}${bestOfOf(t) > 1 ? ` (game ${s.game}, ${s.myWins}–${s.oppWins})` : ""}`;
            case "waiting": return `Round ${s.round}: ${s.won ? "won" : "lost"} — waiting for the round`;
            case "bye": return `Round ${s.round}: bye`;
            case "eliminated": return `Eliminated${s.lostInRound ? ` in round ${s.lostInRound}` : ""}`;
            case "champion": return "🏆 Champion";
            case "finished": return s.rank ? `Finished #${s.rank}` : "Finished";
            case "late": return "Joined late — paired next round";
            default: return "";
        }
    }

    function playersTab(t) {
        const now = Date.now();
        const needDeck = deckRequired(t);
        const active = t.status === "registration" || t.status === "running";
        const players = playersInOrder(t);

        const rows = players.map(p => {
            const entry = (t.players || {})[p.uid] || {};
            const deck = needDeck
                ? (entry.deckAt ? `<span class="ok">✓ ${esc(fmtDate(entry.deckAt))}</span>` : `<span class="bad">✗ none yet</span>`)
                : "";
            const youTag = p.uid === t.createdBy ? ` <span class="tn-chip">organiser</span>` : "";
            const kick = (t.status === "registration" || t.status === "running")
                ? `<button type="button" class="tn-btn tn-btn-small tn-btn-danger" data-kick="${esc(p.uid)}">Remove</button>` : "";
            return `<tr>
                <td>${p.seed + 1}</td>
                <td>${esc(p.name)}${youTag}</td>
                <td>${esc(fmtDate(p.joinedAt))}</td>
                ${needDeck ? `<td>${deck}</td>` : ""}
                <td>${esc(t.status === "registration" ? "" : statusText(t, p.uid))}</td>
                <td class="right">${kick}</td></tr>`;
        }).join("");

        const removed = Object.entries(t.kicked || {}).map(([uid, k]) =>
            `<li>${esc((k && k.name) || "Player")}${k && k.reason ? ` — ${esc(k.reason)}` : ""} <small>(${esc(fmtDate(k && k.at))})</small></li>`).join("");

        const buttons = [];
        if (active) buttons.push(`<button type="button" class="tn-btn tn-btn-small" data-do="edit">⚙ Edit settings</button>`);
        if (t.status === "registration") buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-primary" data-do="start">▶ Start now</button>`);
        if (active) buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-danger" data-do="cancel">Cancel tournament</button>`);
        if (!active) buttons.push(`<button type="button" class="tn-btn tn-btn-small tn-btn-danger" data-do="delete">🗑 Delete tournament</button>`);

        return `
            <div class="tn-meta">
                <span>👥 <b>${playerCount(t)}</b> joined</span>
                <span>Fewest <b>${minPlayersOf(t)}</b></span>
                <span>Most <b>${esc(t.maxPlayers)}</b></span>
                ${t.status === "registration" ? `<span>🗓 Starts <b>${esc(fmtDate(t.startAt))}</b> (${esc(relative(t.startAt, now))})</span>` : ""}
            </div>
            <div class="tn-actions">${buttons.join("")}</div>
            ${players.length
                ? `<div class="tn-table-wrap"><table class="tn-table"><thead><tr><th>#</th><th>Player</th><th>Joined</th>${needDeck ? "<th>Deck list</th>" : ""}<th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
                : `<div class="tn-empty">Nobody has joined yet.</div>`}
            ${removed ? `<section><h3>Removed players</h3><ul class="tn-rules">${removed}</ul></section>` : ""}
            <p class="tn-hint">Removing a player takes them out straight away${t.status === "running" ? ": their current match goes to their opponent" : ""}, and they can't join again.</p>`;
    }

    function matchesTab(t) {
        if (t.status === "registration") {
            return `<div class="tn-empty">Pairings are drawn when the tournament starts. Once it has, you can set the winner of any match here.</div>`;
        }
        const bestOf = bestOfOf(t);
        let html = "";
        for (let n = Number(t.currentRound || 0); n >= 1; n--) {
            const round = getRound(t, n);
            if (!round) continue;
            const editable = canEditResult(t, n);
            const rows = pairingsOf(round).map(p => {
                const name = (uid) => esc(nameOf(t, uid));
                if (p.bye) {
                    return `<div class="tn-pairing"><span class="side">${name(p.a)}</span><span class="vs">BYE</span><span class="side right lose">—</span></div>`;
                }
                const done = p.result && p.result.winner && p.result.winner !== "none";
                const cls = (uid) => (done ? (p.result.winner === uid ? "win" : "lose") : "");
                const score = seriesScore(p);
                const middle = bestOf > 1 ? `${score.a}–${score.b}` : "VS";
                let status = "";
                if (p.result) {
                    status = p.result.winner === "none" ? "Draw — nobody scores"
                        : `${nameOf(t, p.result.winner)} won${p.result.reason === "organiser" ? " (set by you)" : ""}`;
                } else {
                    status = "Not decided yet";
                }
                const controls = editable ? `
                    <div class="tn-pairing-controls">
                        <button type="button" class="tn-btn tn-btn-small" data-result data-round="${n}" data-pairing="${esc(p.id)}" data-winner="${esc(p.a)}">${name(p.a)} wins</button>
                        <button type="button" class="tn-btn tn-btn-small" data-result data-round="${n}" data-pairing="${esc(p.id)}" data-winner="${esc(p.b)}">${name(p.b)} wins</button>
                        ${t.format === "swiss" ? `<button type="button" class="tn-btn tn-btn-small" data-result data-round="${n}" data-pairing="${esc(p.id)}" data-winner="none">Draw</button>` : ""}
                        ${p.result && n === Number(t.currentRound) ? `<button type="button" class="tn-btn tn-btn-small tn-btn-danger" data-result data-round="${n}" data-pairing="${esc(p.id)}" data-winner="">Re-open</button>` : ""}
                    </div>` : "";
                return `<div class="tn-pairing">
                    <span class="side ${cls(p.a)}">${name(p.a)}${done && p.result.winner === p.a ? " ✓" : ""}</span>
                    <span class="vs">${middle}</span>
                    <span class="side right ${cls(p.b)}">${name(p.b)}${done && p.result.winner === p.b ? " ✓" : ""}</span>
                    <div class="note">${esc(status)}</div>${controls}</div>`;
            }).join("");
            const ends = n === Number(t.currentRound) && t.status === "running" ? `ends ${fmtDate(round.endsAt)}` : "";
            html += `<div class="tn-round"><div class="tn-round-head">Round ${n}<span>${esc(ends)}</span></div>${rows}</div>`;
        }
        const note = t.format === "elimination"
            ? "In a knockout you can change any match of the current round. Earlier rounds are locked, because the bracket has already moved on."
            : "In Swiss you can change a match in any round — the standings update straight away.";
        return `<p class="tn-hint">${esc(note)} Setting a winner ends that match; if it was the last open match the round moves on.</p>${html}`;
    }

    function decksTab(t) {
        const players = playersInOrder(t);
        const needDeck = deckRequired(t);
        const submitted = state.decks || {};
        const rows = players.map(p => {
            const sub = submitted[p.uid];
            if (!sub) {
                return `<tr><td>${esc(p.name)}</td><td colspan="3">${needDeck ? `<span class="bad">Not submitted</span>` : `<span class="muted">—</span>`}</td><td></td></tr>`;
            }
            const cards = (Array.isArray(sub.cards) ? sub.cards : Object.values(sub.cards || {})).filter(c => !c.leader)
                .reduce((a, c) => a + (Number(c.qty) || 0), 0);
            return `<tr><td>${esc(p.name)}</td><td>${esc(sub.name)}</td><td>${cards} cards</td><td>${esc(fmtDate(sub.submittedAt))}</td>
                <td class="right"><button type="button" class="tn-btn tn-btn-small" data-deck-view="${esc(p.uid)}">View</button>
                <button type="button" class="tn-btn tn-btn-small" data-deck-copy="${esc(p.uid)}">Copy</button></td></tr>`;
        }).join("");

        const total = players.filter(p => submitted[p.uid]).length;
        const intro = needDeck
            ? `<p class="tn-hint">${total} of ${players.length} players have submitted a deck list${Number(t.deckDeadline) ? ` (deadline ${esc(fmtDate(t.deckDeadline))})` : ""}.</p>`
            : `<p class="tn-hint">This tournament doesn't require deck lists.</p>`;
        if (state.decksError) {
            return `${intro}<div class="tn-error">Couldn't load the deck lists (only the organiser can see them).</div>`;
        }
        return `${intro}
            <div class="tn-actions">
                <button type="button" class="tn-btn tn-btn-small" data-do="decks-copy"${total ? "" : " disabled"}>Copy all lists</button>
                <button type="button" class="tn-btn tn-btn-small" data-do="decks-download"${total ? "" : " disabled"}>Download all (.txt)</button>
            </div>
            ${players.length ? `<div class="tn-table-wrap"><table class="tn-table"><thead><tr><th>Player</th><th>Deck</th><th>Size</th><th>Submitted</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="tn-empty">Nobody has joined yet.</div>`}`;
    }

    function allDecksText(t) {
        return playersInOrder(t)
            .filter(p => state.decks[p.uid])
            .map(p => `=== ${p.name} — ${state.decks[p.uid].name} ===\n${deckListText(state.decks[p.uid])}`)
            .join("\n\n");
    }

    // ── rendering ───────────────────────────────────────────────────────────

    function render() {
        const t = current();
        if (!t) { close(); return; }
        $("tnManageTitle").textContent = `Manage — ${t.name}`;
        $("tnManageTabs").querySelectorAll(".tn-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === state.tab));
        $("tnDecksTab").hidden = false;
        const body = $("tnManageBody");
        const scroll = body.scrollTop;
        body.innerHTML = state.tab === "matches" ? matchesTab(t) : state.tab === "decks" ? decksTab(t) : playersTab(t);
        body.scrollTop = scroll;
    }

    function open(id, tab = "players") {
        state.id = id;
        state.tab = tab;
        const t = current();
        if (!t) return;
        $("tnManageOverlay").hidden = false;
        if (tab === "decks") watchDeckLists(t); else stopDecks();
        render();
    }

    function close() {
        stopDecks();
        state.id = null;
        $("tnManageOverlay").hidden = true;
    }

    function isOpen() { return Boolean(state.id) && !$("tnManageOverlay").hidden; }

    // ── actions ─────────────────────────────────────────────────────────────

    async function run(promise, okMessage) {
        try { await promise; if (okMessage) toast(okMessage); }
        catch (error) {
            toast(isPermissionError(error) ? "That wasn't allowed by the database rules." : (error.message || "Something went wrong."), true);
        }
    }

    $("tnManageTabs").addEventListener("click", (event) => {
        const button = event.target.closest("[data-tab]");
        const t = current();
        if (!button || !t) return;
        state.tab = button.dataset.tab;
        if (state.tab === "decks") watchDeckLists(t); else stopDecks();
        render();
    });

    $("tnManageBody").addEventListener("click", (event) => {
        const t = current();
        if (!t) return;

        const kick = event.target.closest("[data-kick]");
        if (kick) {
            const uid = kick.dataset.kick;
            const name = nameOf(t, uid);
            const running = t.status === "running";
            if (!window.confirm(`Remove ${name} from "${t.name}"?${running ? " Their current match goes to their opponent." : ""} They won't be able to rejoin.`)) return;
            run(kickFromTournament(t.id, uid, "Removed by the organiser"), `${name} was removed.`);
            return;
        }

        const result = event.target.closest("[data-result]");
        if (result) {
            const winner = result.dataset.winner === "" ? null : result.dataset.winner;
            const round = Number(result.dataset.round);
            const text = winner === null ? "Re-open this match so it can be played again?"
                : winner === "none" ? "Record this match as a draw (nobody scores)?"
                : `Set ${nameOf(t, winner)} as the winner of this match?`;
            if (!window.confirm(text)) return;
            run(setMatchResult(t.id, round, result.dataset.pairing, winner), winner === null ? "Match re-opened." : "Result saved.");
            return;
        }

        const viewDeck = event.target.closest("[data-deck-view]");
        if (viewDeck) {
            const sub = state.decks[viewDeck.dataset.deckView];
            if (sub) openViewDialog(sub, nameOf(t, viewDeck.dataset.deckView));
            return;
        }
        const copyDeck = event.target.closest("[data-deck-copy]");
        if (copyDeck) {
            const sub = state.decks[copyDeck.dataset.deckCopy];
            if (sub) copyText(deckListText(sub), "Deck list copied");
            return;
        }

        const action = event.target.closest("[data-do]");
        if (!action) return;
        switch (action.dataset.do) {
            case "edit": ctx.openEdit(t); break;
            case "start": {
                const missing = deckRequired(t)
                    ? playersInOrder(t).filter(p => !(t.players[p.uid] || {}).deckAt).length : 0;
                const warn = missing ? `\n\n${missing} player${missing === 1 ? " hasn't" : "s haven't"} submitted a deck list and will be removed.` : "";
                if (window.confirm(`Start "${t.name}" now with ${playerCount(t)} player${playerCount(t) === 1 ? "" : "s"}?${warn}`)) {
                    run(startNow(t.id), "Tournament started.");
                }
                break;
            }
            case "cancel":
                if (window.confirm(`Cancel "${t.name}" for everyone? This can't be undone.`)) run(cancelTournament(t.id), "Tournament cancelled.");
                break;
            case "delete":
                if (window.confirm(`Permanently delete "${t.name}" and all its deck lists? This can't be undone.`)) {
                    run(deleteTournament(t.id).then(close), "Tournament deleted.");
                }
                break;
            case "decks-copy": copyText(allDecksText(t), "All deck lists copied"); break;
            case "decks-download": downloadText(`${safeFilename(t.name)}-deck-lists.txt`, allDecksText(t)); break;
        }
    });

    $("tnManageClose").addEventListener("click", close);
    $("tnManageOverlay").addEventListener("click", (event) => { if (event.target === $("tnManageOverlay")) close(); });

    return { open, close, refresh: () => { if (isOpen()) render(); }, isOpen };
}
