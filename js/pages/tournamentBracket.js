// The knockout bracket, drawn as a tree: one column per round (Round 1 ... Final)
// and a Champion slot, with lines joining each match to the one its winner goes
// on to. Rounds that haven't been drawn yet show the winners already known.
// Positions are worked out from the bracket's shape (see bracketModel), so the
// tree is plain absolutely-placed boxes plus one SVG of connectors.

import { bracketModel, nameOf, bestOfOf } from "../core/tournamentEngine.js?v=tab-1";
import { esc } from "./tournamentUi.js?v=tour-3";

const COL_W = 196;     // a match box
const GAP_X = 44;      // between rounds (the connectors live here)
const BOX_H = 58;      // two player rows
const GAP_Y = 16;      // between first-round matches
const HEAD = 30;       // round titles
const CHAMP_W = 176;
const UNIT = BOX_H + GAP_Y;

const colX = (i) => i * (COL_W + GAP_X);
// Match j of round i (both 0-based) sits midway between the two matches feeding it.
const centerY = (i, j) => HEAD + UNIT * 2 ** i * (j + 0.5);

function rowHtml(t, m, uid, score, side, meUid, series) {
    if (m.bye && side === "b") return `<div class="tn-bk-row bye"><span class="n">Bye</span></div>`;
    if (!uid) return `<div class="tn-bk-row tbd"><span class="n">${m.drawn ? "—" : "TBD"}</span></div>`;
    const cls = [m.winner ? (m.winner === uid ? "win" : "lose") : "", uid === meUid ? "me" : ""].filter(Boolean).join(" ");
    const name = nameOf(t, uid);
    const showScore = series && m.drawn && !m.bye && (m.scoreA + m.scoreB) > 0;
    const right = showScore ? `<span class="s">${esc(score)}</span>` : (m.winner === uid ? `<span class="s">✓</span>` : "");
    return `<div class="tn-bk-row ${cls}"><span class="n" title="${esc(name)}">${esc(name)}${uid === meUid ? " <small>(you)</small>" : ""}</span>${right}</div>`;
}

/** The bracket tree for a knockout tournament (HTML string). */
export function bracketHtml(t, meUid = "") {
    const model = bracketModel(t);
    const rounds = model.rounds;
    if (!rounds.length) return "";
    const series = bestOfOf(t) > 1;
    const last = rounds.length - 1;
    const height = HEAD + UNIT * (model.size / 2);
    const width = colX(rounds.length) + CHAMP_W;

    let lines = "";
    rounds.forEach((round, i) => {
        if (i === 0) return;
        round.matches.forEach((match, j) => {
            [2 * j, 2 * j + 1].forEach(k => {
                const feeder = rounds[i - 1].matches[k];
                if (!feeder) return;
                const x1 = colX(i - 1) + COL_W, y1 = centerY(i - 1, k);
                const x2 = colX(i), y2 = centerY(i, j), xm = x1 + GAP_X / 2;
                const cls = meUid && feeder.winner === meUid ? "me" : (feeder.winner ? "done" : "");
                lines += `<path d="M${x1} ${y1}H${xm}V${y2}H${x2}"${cls ? ` class="${cls}"` : ""}/>`;
            });
        });
    });
    const fx = colX(last) + COL_W, fy = centerY(last, 0);
    const champCls = meUid && model.champion === meUid ? "me" : (model.champion ? "done" : "");
    lines += `<path d="M${fx} ${fy}H${colX(rounds.length) + 8}"${champCls ? ` class="${champCls}"` : ""}/>`;

    const heads = rounds.map((r, i) => `<div class="tn-bk-head" style="left:${colX(i)}px;width:${COL_W}px">${esc(r.label)}</div>`).join("")
        + `<div class="tn-bk-head" style="left:${colX(rounds.length) + 8}px;width:${CHAMP_W - 8}px">Champion</div>`;

    const boxes = rounds.map((round, i) => round.matches.map((m, j) => {
        const mine = meUid && (m.a === meUid || m.b === meUid);
        const cls = ["tn-bk-match", m.live ? "live" : "", mine ? "mine" : "", m.drawn ? "" : "future"].filter(Boolean).join(" ");
        const top = centerY(i, j) - BOX_H / 2;
        return `<div class="${cls}" style="left:${colX(i)}px;top:${top}px;width:${COL_W}px;height:${BOX_H}px">`
            + rowHtml(t, m, m.a, m.scoreA, "a", meUid, series)
            + rowHtml(t, m, m.b, m.scoreB, "b", meUid, series)
            + `</div>`;
    }).join("")).join("");

    const champ = `<div class="tn-bk-champ${model.champion ? " won" : ""}${meUid && model.champion === meUid ? " me" : ""}" style="left:${colX(rounds.length) + 8}px;top:${fy - 26}px;width:${CHAMP_W - 8}px">`
        + (model.champion ? `<span aria-hidden="true">🏆</span><b title="${esc(nameOf(t, model.champion))}">${esc(nameOf(t, model.champion))}</b>` : `<span aria-hidden="true">🏆</span><span>To be decided</span>`)
        + `</div>`;

    return `<div class="tn-bracket-scroll" tabindex="0" aria-label="Bracket. The List view has the same results as text.">
        <div class="tn-bracket" style="width:${width}px;height:${height}px">
            <svg class="tn-bk-lines" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines}</svg>
            ${heads}${boxes}${champ}
        </div>
    </div>
    <p class="tn-hint tn-bk-legend"><span class="sw live"></span> being played now <span class="sw mine"></span> your matches <span class="sw done"></span> decided</p>`;
}
