// Tournament rules - PURE functions only (no Firebase, no DOM), so the exact same
// logic runs in the browser and in the Node tests.
//
// A tournament is one plain JSON document:
//   {
//     name, createdBy, createdByName, createdAt,
//     collections: ["slug", ...]   // card pool; empty = every collection
//     matchType:   "regular" | "draft",
//     format:      "elimination" | "swiss",
//     startAt:     ms epoch,       // when round 1 may begin
//     roundMinutes: number,        // how long each round lasts
//     maxPlayers:  number,
//     status:      "registration" | "running" | "complete" | "cancelled",
//     players:     { [uid]: { name, joinedAt } },
//     totalRounds, currentRound,   // set when it starts
//     rounds: { r1: { startedAt, endsAt, pairings: { m1: Pairing, ... } }, ... },
//     winner, completedAt          // set when it finishes
//   }
//   Pairing = { a: uid, b?: uid, bye?: true,
//               checkedIn?: { [uid]: ms }, result?: { winner, reason, at } }
//
// Round / pairing keys are "r1" / "m1" (never bare integers) because Firebase turns
// integer-keyed objects into arrays and would hand back holes.
//
// Rounds are asynchronous: players have `roundMinutes` to play their match whenever
// they like. A round ends when every match has a result OR its timer runs out (then
// unplayed matches are settled by forfeit rules). There is no server, so the rules
// are applied by whichever participant's browser looks at the tournament next - see
// tick().

export const ROUND_LENGTHS = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 2880, label: "2 days" },
  { minutes: 4320, label: "3 days" },
  { minutes: 10080, label: "7 days" }
];

export const MAX_PLAYER_OPTIONS = [4, 8, 16, 32, 64];
export const MIN_PLAYERS = 2;

// ── small helpers ────────────────────────────────────────────────────────────

const clone = (value) => JSON.parse(JSON.stringify(value));

export function formatDuration(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  if (m < 1440) {
    const h = m / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`;
  }
  const d = m / 1440;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"}`;
}

export function roundKey(n) { return `r${n}`; }
export function pairingKey(i) { return `m${i}`; }
const pairingIndex = (key) => Number(String(key).slice(1)) || 0;

// Deterministic randomness: the same tournament + round always shuffles the same
// way, so two browsers that both compute a round produce IDENTICAL pairings.
export function hashString(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seedText) {
  const rng = mulberry32(hashString(seedText));
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A 6-character multiplayer room code that is the same for both players of a
// pairing, so whoever arrives first creates the room and the other simply joins it.
export function roomCodeFor(tournamentId, round, pairingId) {
  const a = hashString(`${tournamentId}|${round}|${pairingId}|a`).toString(36);
  const b = hashString(`${tournamentId}|${round}|${pairingId}|b`).toString(36);
  return (a + b).replace(/[^a-z0-9]/g, "").toUpperCase().padEnd(6, "0").slice(0, 6);
}

// ── players ──────────────────────────────────────────────────────────────────

/** Players in sign-up order (earliest first). Index = seed (0 is the top seed). */
export function playersInOrder(t) {
  return Object.entries(t.players || {})
    .map(([uid, p]) => ({ uid, name: (p && p.name) || "Player", joinedAt: Number(p && p.joinedAt) || 0 }))
    .sort((x, y) => x.joinedAt - y.joinedAt || (x.uid < y.uid ? -1 : 1))
    .map((p, seed) => ({ ...p, seed }));
}

export function playerCount(t) { return Object.keys(t.players || {}).length; }

export function collectionsOf(t) {
  const raw = t && t.collections;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean);
}

export function elimRounds(n) { return n <= 1 ? 0 : Math.ceil(Math.log2(n)); }
export function swissRounds(n) { return n <= 1 ? 0 : Math.max(1, Math.ceil(Math.log2(n))); }
export function roundCountFor(format, n) {
  return format === "swiss" ? swissRounds(n) : elimRounds(n);
}

export function isOpenForSignup(t, now = Date.now()) {
  return t.status === "registration" && now < Number(t.startAt) && playerCount(t) < Number(t.maxPlayers);
}

// ── rounds & pairings ────────────────────────────────────────────────────────

export function getRound(t, n) { return (t.rounds && t.rounds[roundKey(n)]) || null; }

export function pairingsOf(round) {
  return Object.entries((round && round.pairings) || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((x, y) => pairingIndex(x.id) - pairingIndex(y.id));
}

export function isRoundResolved(round) {
  const list = pairingsOf(round);
  return list.length > 0 && list.every(p => p.result && p.result.winner);
}

function byePairing(uid, now) {
  return { a: uid, bye: true, result: { winner: uid, reason: "bye", at: now } };
}

// ── starting ─────────────────────────────────────────────────────────────────

function eliminationRoundOne(order, now) {
  const n = order.length;
  const size = 2 ** elimRounds(n);
  const byes = size - n;
  const pairings = {};
  let m = 1;
  for (let i = 0; i < byes; i++) pairings[pairingKey(m++)] = byePairing(order[i].uid, now);
  for (let i = byes; i < n; i += 2) {
    pairings[pairingKey(m++)] = { a: order[i].uid, b: order[i + 1].uid };
  }
  return pairings;
}

function swissRoundOne(order, now) {
  const pairings = {};
  let m = 1;
  const list = order.slice();
  let byePlayer = null;
  if (list.length % 2 === 1) byePlayer = list.pop();
  for (let i = 0; i < list.length; i += 2) {
    pairings[pairingKey(m++)] = { a: list[i].uid, b: list[i + 1].uid };
  }
  if (byePlayer) pairings[pairingKey(m++)] = byePairing(byePlayer.uid, now);
  return pairings;
}

function startTournament(t, now, tournamentId) {
  const players = playersInOrder(t);
  if (players.length < MIN_PLAYERS) {
    t.status = "cancelled";
    t.cancelReason = "Not enough players signed up";
    return;
  }
  t.totalRounds = roundCountFor(t.format, players.length);
  t.status = "running";
  t.currentRound = 1;
  const order = seededShuffle(players, `${tournamentId || t.name || "t"}|round|1`);
  const pairings = t.format === "swiss" ? swissRoundOne(order, now) : eliminationRoundOne(order, now);
  t.rounds = t.rounds || {};
  t.rounds[roundKey(1)] = {
    startedAt: now,
    endsAt: now + Number(t.roundMinutes) * 60000,
    pairings
  };
}

// ── results ──────────────────────────────────────────────────────────────────

/** Record a played match's winner. Ignores unknown matches, stale reports and
 *  winners who aren't in the pairing. Returns true if it changed anything. */
export function applyResult(t, round, pairingId, winnerUid, reason = "played", now = Date.now()) {
  const r = getRound(t, round);
  const p = r && r.pairings && r.pairings[pairingId];
  if (!p || p.result) return false;
  if (winnerUid !== p.a && winnerUid !== p.b) return false;
  p.result = { winner: winnerUid, reason, at: now };
  return true;
}

function seedOf(t, uid) {
  const p = playersInOrder(t).find(x => x.uid === uid);
  return p ? p.seed : Number.MAX_SAFE_INTEGER;
}

/** Settle every unfinished match in a round whose timer has run out.
 *   - exactly one player showed up  -> they win (forfeit)
 *   - elimination, both/neither     -> the higher seed (earlier sign-up) advances
 *   - swiss, both/neither           -> nobody scores */
function settleExpired(t, round, now) {
  let any = false;
  Object.values(round.pairings || {}).forEach(p => {
    if (p.result) return;
    const here = Object.keys(p.checkedIn || {}).filter(u => u === p.a || u === p.b);
    if (here.length === 1) {
      p.result = { winner: here[0], reason: "forfeit", at: now };
    } else if (t.format === "elimination") {
      const winner = seedOf(t, p.a) <= seedOf(t, p.b) ? p.a : p.b;
      p.result = { winner, reason: "seed", at: now };
    } else {
      p.result = { winner: "none", reason: "timeout", at: now };
    }
    any = true;
  });
  return any;
}

// ── swiss ────────────────────────────────────────────────────────────────────

/** Points, tiebreaks and rank for everyone. Win or bye = 1 point. */
export function swissStandings(t) {
  const players = playersInOrder(t);
  const rows = new Map(players.map(p => [p.uid, {
    uid: p.uid, name: p.name, seed: p.seed, points: 0, wins: 0, losses: 0, byes: 0,
    opponents: [], buchholz: 0
  }]));

  for (let n = 1; n <= Number(t.totalRounds || 0); n++) {
    const round = getRound(t, n);
    pairingsOf(round).forEach(p => {
      const a = rows.get(p.a);
      if (!a) return;
      if (p.bye) { a.points += 1; a.byes += 1; return; }
      const b = rows.get(p.b);
      if (!b) return;
      a.opponents.push(p.b);
      b.opponents.push(p.a);
      if (!p.result) return;
      if (p.result.winner === p.a) { a.points += 1; a.wins += 1; b.losses += 1; }
      else if (p.result.winner === p.b) { b.points += 1; b.wins += 1; a.losses += 1; }
    });
  }
  rows.forEach(row => {
    row.buchholz = row.opponents.reduce((sum, u) => sum + ((rows.get(u) || {}).points || 0), 0);
  });
  const sorted = [...rows.values()].sort((x, y) =>
    y.points - x.points || y.buchholz - x.buchholz || x.seed - y.seed);
  sorted.forEach((row, i) => { row.rank = i + 1; });
  return sorted;
}

function swissNextPairings(t, round, now, tournamentId) {
  const standings = swissStandings(t);
  const played = new Map(standings.map(s => [s.uid, new Set(s.opponents)]));
  const hadBye = new Set(standings.filter(s => s.byes > 0).map(s => s.uid));

  let pool = standings.map(s => s.uid);
  let byeUid = null;
  if (pool.length % 2 === 1) {
    // The bye goes to the lowest-ranked player who hasn't had one yet.
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!hadBye.has(pool[i])) { byeUid = pool[i]; break; }
    }
    if (byeUid === null) byeUid = pool[pool.length - 1];
    pool = pool.filter(u => u !== byeUid);
  }

  // Pair top-down; backtrack to avoid rematches, and only allow a rematch if there
  // is no other way to pair everyone.
  const solve = (list, allowRematch) => {
    if (list.length === 0) return [];
    const [first, ...rest] = list;
    for (let i = 0; i < rest.length; i++) {
      const other = rest[i];
      if (!allowRematch && played.get(first).has(other)) continue;
      const remaining = rest.filter((_, j) => j !== i);
      const tail = solve(remaining, allowRematch);
      if (tail) return [[first, other], ...tail];
    }
    return null;
  };
  const pairs = solve(pool, false) || solve(pool, true) || [];

  const pairings = {};
  let m = 1;
  pairs.forEach(([a, b]) => { pairings[pairingKey(m++)] = { a, b }; });
  if (byeUid) pairings[pairingKey(m++)] = byePairing(byeUid, now);
  return pairings;
}

// ── elimination ──────────────────────────────────────────────────────────────

function eliminationNextPairings(round) {
  const winners = pairingsOf(round).map(p => p.result.winner);
  const pairings = {};
  let m = 1;
  for (let i = 0; i + 1 < winners.length; i += 2) {
    pairings[pairingKey(m++)] = { a: winners[i], b: winners[i + 1] };
  }
  return pairings;
}

// ── advancing ────────────────────────────────────────────────────────────────

function finish(t, now) {
  t.status = "complete";
  t.completedAt = now;
  if (t.format === "swiss") {
    t.winner = (swissStandings(t)[0] || {}).uid || "";
  } else {
    const last = pairingsOf(getRound(t, t.currentRound));
    t.winner = last.length ? last[0].result.winner : "";
  }
}

function advance(t, now, tournamentId) {
  const round = getRound(t, t.currentRound);
  if (t.currentRound >= t.totalRounds) { finish(t, now); return; }
  const nextNumber = t.currentRound + 1;
  const pairings = t.format === "swiss"
    ? swissNextPairings(t, round, now, tournamentId)
    : eliminationNextPairings(round);
  t.rounds[roundKey(nextNumber)] = {
    startedAt: now,
    endsAt: now + Number(t.roundMinutes) * 60000,
    pairings
  };
  t.currentRound = nextNumber;
}

/**
 * The one entry point: bring a tournament up to date.
 *   - starts it when the start time has passed (or cancels it if too few signed up)
 *   - applies match results reported in `results` ({ "<round>/<pairingId>": winnerUid })
 *   - settles matches whose round timer ran out
 *   - moves to the next round (or finishes) once a round is fully settled
 * Returns { tournament, changed }. `tournament` is a NEW object; the input is never
 * mutated. Safe to run from any number of browsers at once (the Firebase transaction
 * keeps one result, and the shuffles are seeded, so they agree anyway).
 */
export function tick(input, now, results = {}, tournamentId = "") {
  const t = clone(input);

  if (t.status === "registration") {
    if (now < Number(t.startAt)) return { tournament: input, changed: false };
    startTournament(t, now, tournamentId);
  }

  if (t.status === "running") {
    Object.entries(results || {}).forEach(([key, winner]) => {
      const [round, pairingId] = key.split("/");
      applyResult(t, Number(round), pairingId, winner, "played", now);
    });

    // A round can settle and the next one begin; loop in case that new round is
    // itself already settled (every match a bye). Bounded by the round count.
    for (let guard = 0; guard <= Number(t.totalRounds) + 1 && t.status === "running"; guard++) {
      const round = getRound(t, t.currentRound);
      if (!round) break;
      if (now >= Number(round.endsAt)) settleExpired(t, round, now);
      if (!isRoundResolved(round)) break;
      advance(t, now, tournamentId);
    }
  }

  const changed = JSON.stringify(t) !== JSON.stringify(input);
  return { tournament: changed ? t : input, changed };
}

/** Mark that a player has turned up for their match (counts against a no-show). */
export function checkIn(t, round, pairingId, uid, now = Date.now()) {
  const r = getRound(t, round);
  const p = r && r.pairings && r.pairings[pairingId];
  if (!p || (uid !== p.a && uid !== p.b)) return false;
  p.checkedIn = p.checkedIn || {};
  if (!p.checkedIn[uid]) p.checkedIn[uid] = now;
  return true;
}

// ── what a player should see ────────────────────────────────────────────────

export function nameOf(t, uid) {
  const p = (t.players || {})[uid];
  return (p && p.name) || "Player";
}

/**
 * Where does this player stand? Drives the "you need to play round 2" line.
 *   state: "none" | "registered" | "play" | "waiting" | "bye" | "eliminated"
 *          | "champion" | "finished" | "cancelled"
 *   needsAction: true when the player has a match they still have to play
 */
export function myStatus(t, uid, now = Date.now()) {
  const base = { state: "none", needsAction: false, round: null, pairingId: null,
                 opponentUid: null, opponentName: "", dueAt: null, lostInRound: null, rank: null };
  if (!uid || !(t.players || {})[uid]) return base;

  if (t.status === "cancelled") return { ...base, state: "cancelled" };
  if (t.status === "registration") return { ...base, state: "registered" };

  // Find this player's pairing in the current round.
  const roundNo = t.currentRound;
  const round = getRound(t, roundNo);
  const mine = pairingsOf(round).find(p => p.a === uid || p.b === uid);

  if (t.status === "complete") {
    if (t.winner === uid) return { ...base, state: "champion" };
    const rank = t.format === "swiss" ? (swissStandings(t).find(s => s.uid === uid) || {}).rank : null;
    return { ...base, state: "finished", rank };
  }

  // Running.
  if (!mine) {
    // Elimination: no pairing this round means they went out in an earlier round.
    let lostIn = null;
    for (let n = 1; n < roundNo; n++) {
      const found = pairingsOf(getRound(t, n)).find(p => (p.a === uid || p.b === uid));
      if (found && found.result && found.result.winner !== uid) lostIn = n;
    }
    return { ...base, state: "eliminated", lostInRound: lostIn };
  }

  const opponentUid = mine.bye ? null : (mine.a === uid ? mine.b : mine.a);
  const info = { ...base, round: roundNo, pairingId: mine.id, opponentUid,
                 opponentName: opponentUid ? nameOf(t, opponentUid) : "", dueAt: round.endsAt };

  if (mine.bye) return { ...info, state: "bye" };
  if (!mine.result) return { ...info, state: "play", needsAction: true };

  const won = mine.result.winner === uid;
  // Lost a knockout match: out of the tournament right now (don't wait for the
  // rest of the round to finish before telling them).
  if (!won && t.format === "elimination") return { ...info, state: "eliminated", lostInRound: roundNo, won };
  return { ...info, state: "waiting", won };
}
