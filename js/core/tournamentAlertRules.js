// Which tournament alerts a player should be shown right now - PURE (no DOM, no
// Firebase) so it runs the same in the browser and in the Node tests. The red pop-ups
// themselves live in ../tournamentAlerts.js.
//
// alertsFor(tournaments, uid, now) returns a list of
//   { key, group, tone, icon, title, body, action: { label, tid, manage? }, at, sticky }
//   key    - unique; once the player dismisses it, it isn't shown again
//   group  - alerts in the same group replace each other (only the newest one shows),
//            e.g. "30% left" is replaced by "10% left" for the same match
//   sticky - keeps coming back (after a short snooze) until the problem is solved,
//            e.g. the organiser still has to pick a winner
//   at     - when the alert "happened" (newest first)

import {
  myStatus,
  getRound,
  pairingsOf,
  awaitingOrganiser,
  deckRequired,
  nameOf,
  timeoutRuleOf,
  swissStandings
} from "./tournamentEngine.js?v=tab-1";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "Due in a day / an hour / 10 minutes" reminders...
export const TIME_MARKS = [
  { id: "1d", ms: DAY, words: "1 day" },
  { id: "1h", ms: HOUR, words: "1 hour" },
  { id: "10m", ms: 10 * MINUTE, words: "10 minutes" }
];
// ...and "this much of the round left" reminders.
export const PERCENT_MARKS = [30, 20, 10, 4, 3, 2, 1];

// Old news isn't worth a pop-up: finished/cancelled/removed only within this long.
const RECENT = 3 * DAY;

export function inWords(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 48 * 60) {
    const h = Math.round(minutes / 60);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(minutes / 1440);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The deadline marks a window has passed, with when each was passed. Marks that would
 *  fire straight away (a 1-hour round has "1 hour left" at its start) are skipped. */
export function passedMarks(startedAt, endsAt, now) {
  const total = Number(endsAt) - Number(startedAt);
  const left = Number(endsAt) - now;
  if (!(total > 0) || left <= 0) return [];
  const marks = [];
  TIME_MARKS.forEach(m => {
    if (total >= 2 * m.ms && left <= m.ms) marks.push({ id: m.id, at: Number(endsAt) - m.ms, words: `${m.words} left` });
  });
  PERCENT_MARKS.forEach(p => {
    const at = Number(startedAt) + total * (1 - p / 100);
    if (now >= at) marks.push({ id: `${p}pct`, at, words: `${p}% of the round left`, percent: p });
  });
  return marks.sort((a, b) => b.at - a.at);
}

const isMember = (t, uid) => Boolean(t.players && t.players[uid]);

/** The closest "1 day / 1 hour / 10 minutes to go" mark already reached, skipping marks
 *  that were already passed when the countdown began (`span` = its whole length). */
function tightestMark(left, span) {
  return [...TIME_MARKS].reverse().find(m => left <= m.ms && span >= m.ms * 1.5) || null;
}

function matchAlerts(t, uid, now, out) {
  const s = myStatus(t, uid, now);
  const round = getRound(t, t.currentRound);
  if (!round) return;
  const tid = t.id;
  const name = t.name || "Tournament";
  const group = `match|${tid}|${s.round}`;

  if (s.state === "bye") {
    out.push({ key: `bye|${tid}|${s.round}`, group, tone: "info", icon: "😴",
      title: `Round ${s.round} of ${name} has started`,
      body: "You have a bye this round — nothing to play.",
      action: { label: "View", tid }, at: Number(round.startedAt) || now });
    return;
  }
  if (s.state !== "play") return;

  const opponent = s.opponentName || "your opponent";
  const what = s.bestOf > 1 ? `game ${s.game} of ${s.bestOf} vs ${opponent}` : `your match vs ${opponent}`;
  const left = Number(round.endsAt) - now;

  if (left <= 0) {
    out.push({ key: `over|${tid}|${s.round}|${s.pairingId}`, group, tone: "urgent", icon: "⏰",
      title: `Time's up: round ${s.round} of ${name}`,
      body: timeoutRuleOf(t) === "organiser"
        ? `Your ${what.replace(/^your /, "")} wasn't finished. The organiser will pick the winner — you can still finish the game until they do.`
        : `Your ${what.replace(/^your /, "")} wasn't finished in time, so it's being settled now.`,
      action: { label: "Open", tid }, at: Number(round.endsAt) });
    return;
  }

  const marks = passedMarks(round.startedAt, round.endsAt, now);
  if (marks.length) {
    const m = marks[0];
    out.push({ key: `due|${tid}|${s.round}|${s.pairingId}|${m.id}`, group, tone: m.percent && m.percent <= 4 ? "urgent" : "warn",
      icon: "⏳",
      title: `${m.words[0].toUpperCase()}${m.words.slice(1)} — ${name}`,
      body: `You still need to play ${what} in round ${s.round}. It's due in ${inWords(left)}.`,
      action: { label: "Play", tid }, at: m.at });
    return;
  }

  out.push({ key: `round|${tid}|${s.round}`, group, tone: "info", icon: "⚔️",
    title: s.round === 1 ? `${name} has started` : `Round ${s.round} of ${name} has started`,
    body: `You play ${opponent}${s.bestOf > 1 ? ` (best of ${s.bestOf})` : ""}. Play any time in the next ${inWords(left)}.`,
    action: { label: "Play", tid }, at: Number(round.startedAt) || now });
}

function registrationAlerts(t, uid, now, out) {
  const tid = t.id;
  const name = t.name || "Tournament";
  const joinedAt = Number((t.players[uid] || {}).joinedAt) || 0;

  // Deck list still to hand in.
  if (deckRequired(t) && !t.players[uid].deckAt && now < Number(t.deckDeadline)) {
    const left = Number(t.deckDeadline) - now;
    const mark = tightestMark(left, Number(t.deckDeadline) - joinedAt);
    if (mark) {
      out.push({ key: `deck|${tid}|${mark.id}`, group: `deck|${tid}`, tone: "urgent", icon: "📄",
        title: `Submit your deck list — ${name}`,
        body: `It's due in ${inWords(left)}. Without one you'll be removed when the tournament starts.`,
        action: { label: "Submit", tid }, at: Number(t.deckDeadline) - mark.ms });
    }
  }

  // Starting soon.
  const untilStart = Number(t.startAt) - now;
  if (untilStart > 0) {
    const mark = tightestMark(untilStart, Number(t.startAt) - joinedAt);
    if (mark) {
      out.push({ key: `start|${tid}|${mark.id}`, group: `start|${tid}`, tone: "info", icon: "🗓",
        title: `${name} starts in ${inWords(untilStart)}`,
        body: "Round 1 is drawn at the start time — you'll get your opponent then.",
        action: { label: "View", tid }, at: Number(t.startAt) - mark.ms });
    }
  }
}

function finishedAlerts(t, uid, now, out) {
  const tid = t.id;
  const name = t.name || "Tournament";
  if (t.status === "complete" && now - Number(t.completedAt || 0) < RECENT) {
    const won = t.winner === uid;
    const rank = t.format === "swiss" ? (swissStandings(t).find(r => r.uid === uid) || {}).rank : null;
    out.push({ key: `done|${tid}|${t.completedAt}`, group: `done|${tid}`, tone: won ? "win" : "info", icon: "🏆",
      title: won ? `You won ${name}!` : `${name} has finished`,
      body: won ? "Congratulations — you're the champion." :
        `${t.winner ? `${nameOf(t, t.winner)} won.` : "It's over."}${rank ? ` You placed #${rank}.` : ""}`,
      action: { label: "Results", tid }, at: Number(t.completedAt) || now });
  }
  if (t.status === "cancelled" && Math.abs(now - Number(t.startAt || 0)) < 7 * DAY) {
    out.push({ key: `cancel|${tid}`, group: `done|${tid}`, tone: "info", icon: "✖",
      title: `${name} was cancelled`, body: t.cancelReason || "The tournament won't go ahead.",
      action: { label: "View", tid }, at: Number(t.startAt) || now });
  }
}

function organiserAlerts(t, uid, now, out) {
  if (t.createdBy !== uid) return;
  const tid = t.id;
  const name = t.name || "Tournament";
  const waiting = awaitingOrganiser(t);
  if (waiting.length) {
    const list = waiting.slice(0, 2).map(p => `${nameOf(t, p.a)} vs ${nameOf(t, p.b)}`).join(", ");
    out.push({ key: `decide|${tid}|${t.currentRound}`, group: `decide|${tid}`, tone: "urgent", icon: "⚖", sticky: true,
      title: `Pick the winner — ${name}`,
      body: `${waiting.length} match${waiting.length === 1 ? "" : "es"} in round ${t.currentRound} ran out of time (${list}${waiting.length > 2 ? ", …" : ""}). The next round can't start until you decide.`,
      action: { label: "Pick winners", tid, manage: "matches" },
      at: Math.max(...waiting.map(p => Number(p.timedOut) || 0)) || now });
  }
  // The organiser isn't playing: tell them a round started (players get their pairing).
  if (t.status === "running" && !isMember(t, uid) && !waiting.length && Number(t.currentRound) >= 1) {
    const round = getRound(t, t.currentRound);
    const open = pairingsOf(round).filter(p => !p.bye && !p.result).length;
    if (round && open && now < Number(round.endsAt) && now - Number(round.startedAt) < DAY) {
      out.push({ key: `orground|${tid}|${t.currentRound}`, group: `orground|${tid}`, tone: "info", icon: "📣",
        title: t.currentRound === 1 ? `${name} has started` : `Round ${t.currentRound} of ${name} has started`,
        body: `${open} match${open === 1 ? "" : "es"} to play, due in ${inWords(Number(round.endsAt) - now)}.`,
        action: { label: "View", tid }, at: Number(round.startedAt) });
    }
  }
}

/** Every alert for this player, newest first, at most one per group. */
export function alertsFor(tournaments, uid, now = Date.now()) {
  if (!uid) return [];
  const out = [];
  (tournaments || []).forEach(t => {
    if (!t || !t.id) return;
    const member = isMember(t, uid);
    const organiser = t.createdBy === uid;
    const kicked = t.kicked && t.kicked[uid];
    if (kicked && now - Number(kicked.at || 0) < RECENT) {
      out.push({ key: `kicked|${t.id}`, group: `kicked|${t.id}`, tone: "info", icon: "🚫",
        title: `You were removed from ${t.name || "a tournament"}`,
        body: kicked.reason || "The organiser removed you.",
        action: { label: "View", tid: t.id }, at: Number(kicked.at) || now });
    }
    if (!member && !organiser) return;
    if (organiser) organiserAlerts(t, uid, now, out);
    if (t.status === "complete" || t.status === "cancelled") { finishedAlerts(t, uid, now, out); return; }
    if (!member) return;
    if (t.status === "registration") registrationAlerts(t, uid, now, out);
    else if (t.status === "running") matchAlerts(t, uid, now, out);
  });
  const byGroup = new Map();
  out.sort((a, b) => b.at - a.at).forEach(a => { if (!byGroup.has(a.group)) byGroup.set(a.group, a); });
  return [...byGroup.values()];
}
