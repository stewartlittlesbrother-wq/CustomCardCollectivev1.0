// Tournament rules - PURE functions only (no Firebase, no DOM), so the exact same
// logic runs in the browser and in the Node tests.
//
// A tournament is one plain JSON document:
//   {
//     name, description, createdBy, createdByName, createdAt,
//     collections: ["slug", ...]   // card pool; empty = every collection
//     banned:      ["CARD-001", ...] // banned card numbers
//     matchType:   "regular" | "draft",
//     format:      "elimination" | "swiss",
//     bestOf:      1 | 3 | 5,      // games per match (first to win the majority)
//     startAt:     ms epoch,       // when round 1 may begin
//     roundMinutes: number,        // how long each round lasts (days are fine)
//     roundMode:   "asap" | "full",// next round when everyone is done / only when time is up
//     timeoutRule: "coin" | "organiser", // a level match whose round ran out: coin flip,
//                                  // or wait for the organiser (absent = the old seed rule)
//     clockMinutes: number,        // chess clock per player in each game (0/absent = off)
//     roundsSetting: number,       // swiss only: custom number of rounds (absent = automatic)
//     minPlayers, maxPlayers,
//     lateJoin:    boolean,        // may people join after it has started?
//     private:     boolean,        // unlisted - only people with the link see it
//     hasPassword: boolean, pwSalt // join password (the secret hash lives elsewhere)
//     requireDeck: boolean, deckDeadline: ms   // regular matches: decklist submission
//     draft:       { packs, minutes, deckSize } // draft matches
//     status:      "registration" | "running" | "complete" | "cancelled",
//     players:     { [uid]: { name, joinedAt, deckAt? } },
//     kicked:      { [uid]: { name, at, reason? } },   // removed by the organiser
//     totalRounds, currentRound,   // set when it starts
//     rounds: { r1: { startedAt, endsAt, pairings: { m1: Pairing, ... } }, ... },
//     winner, completedAt          // set when it finishes
//   }
//   Pairing = { a: uid, b?: uid, bye?: true,
//               checkedIn?: { [uid]: ms },
//               games?: { g1: { winner: uid, at }, g2: ... },   // one entry per game played
//               timedOut?: ms,  // round ran out undecided; waiting for the organiser
//               result?: { winner, reason, at } }               // winner: uid | "none"
//
// Round / pairing / game keys are "r1" / "m1" / "g1" (never bare integers) because
// Firebase turns integer-keyed objects into arrays and would hand back holes.
//
// Rounds are asynchronous: players have `roundMinutes` (it can be days) to play their
// match - all games of the series - whenever they like. A round ends when every match
// has a result OR its timer runs out (then unplayed matches are settled by the
// forfeit rules). There is no server, so the rules are applied by whichever
// participant's browser looks at the tournament next - see tick().

export const ROUND_LENGTHS = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 2880, label: "2 days" },
  { minutes: 4320, label: "3 days" },
  { minutes: 10080, label: "7 days" },
  { minutes: 20160, label: "14 days" }
];
export const MIN_ROUND_MINUTES = 5;
export const MAX_ROUND_MINUTES = 60 * 24 * 60;     // 60 days

// What happens to a match that's level when its round runs out.
export const TIMEOUT_RULES = ["coin", "organiser"];
// Chess clock per player for each game (minutes; 0 = no clock).
export const CLOCK_OPTIONS = [0, 10, 15, 18, 20, 25, 30, 45, 60];
export const DEFAULT_CLOCK_MINUTES = 18;

export const MAX_PLAYER_OPTIONS = [4, 8, 16, 32, 64];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS_LIMIT = 256;
export const BEST_OF_OPTIONS = [1, 3, 5];
export const MAX_BANNED = 400;

export const DRAFT_DEFAULTS = { packs: 10, minutes: 15, deckSize: 40 };
export const DRAFT_LIMITS = {
  packs: { min: 1, max: 30 },
  minutes: { min: 3, max: 180 },
  deckSize: { min: 20, max: 60 }
};

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
export function gameKey(n) { return `g${n}`; }
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
// Every game of a best-of series gets its own room (game 1 keeps the original code).
export function roomCodeFor(tournamentId, round, pairingId, game = 1) {
  const suffix = Number(game) > 1 ? `|g${game}` : "";
  const a = hashString(`${tournamentId}|${round}|${pairingId}${suffix}|a`).toString(36);
  const b = hashString(`${tournamentId}|${round}|${pairingId}${suffix}|b`).toString(36);
  return (a + b).replace(/[^a-z0-9]/g, "").toUpperCase().padEnd(6, "0").slice(0, 6);
}

// ── settings accessors (everything has a safe default for older documents) ───

export function bestOfOf(t) {
  const n = Number(t && t.bestOf);
  return BEST_OF_OPTIONS.includes(n) ? n : 1;
}
export const winsNeeded = (bestOf) => Math.floor(Number(bestOf) / 2) + 1;
export function minPlayersOf(t) { return Math.max(MIN_PLAYERS, Number(t && t.minPlayers) || MIN_PLAYERS); }
export function toList(raw) {
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean).map(String);
}
export function collectionsOf(t) { return toList(t && t.collections); }
export function bannedOf(t) { return toList(t && t.banned); }
export function deckRequired(t) { return Boolean(t && t.matchType !== "draft" && t.requireDeck); }
export function isPrivate(t) { return Boolean(t && t.private); }
export function draftSettingsOf(t) {
  const d = (t && t.draft) || {};
  const pick = (key) => {
    const lim = DRAFT_LIMITS[key];
    const n = Math.round(Number(d[key]));
    return Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, n)) : DRAFT_DEFAULTS[key];
  };
  return { packs: pick("packs"), minutes: pick("minutes"), deckSize: pick("deckSize") };
}
export function isKicked(t, uid) { return Boolean(uid && t && t.kicked && t.kicked[uid]); }
/** "coin" | "organiser" | "seed" (tournaments made before the setting existed). */
export function timeoutRuleOf(t) {
  return TIMEOUT_RULES.includes(t && t.timeoutRule) ? t.timeoutRule : "seed";
}
/** Minutes on each player's chess clock per game (0 = no clock). */
export function clockMinutesOf(t) {
  const n = Math.round(Number(t && t.clockMinutes));
  return Number.isFinite(n) && n > 0 && n <= 180 ? n : 0;
}

/** The coin flip for a match - the same in every browser, so they all agree. */
export function coinFlipWinner(tournamentId, round, pairingId, p) {
  return hashString(`${tournamentId}|r${round}|${pairingId}|coin`) % 2 === 0 ? p.a : p.b;
}

/** Matches of the current round waiting for the organiser to pick a winner. */
export function awaitingOrganiser(t) {
  if (!t || t.status !== "running") return [];
  return pairingsOf(getRound(t, t.currentRound)).filter(p => p.timedOut && !p.result && !p.bye);
}

// ── players ──────────────────────────────────────────────────────────────────

/** Active players in sign-up order (earliest first). Index = seed (0 is the top seed). */
export function playersInOrder(t) {
  return Object.entries(t.players || {})
    .map(([uid, p]) => ({ uid, name: (p && p.name) || "Player", joinedAt: Number(p && p.joinedAt) || 0 }))
    .sort((x, y) => x.joinedAt - y.joinedAt || (x.uid < y.uid ? -1 : 1))
    .map((p, seed) => ({ ...p, seed }));
}

export function playerCount(t) { return Object.keys(t.players || {}).length; }

export function elimRounds(n) { return n <= 1 ? 0 : Math.ceil(Math.log2(n)); }
export function swissRounds(n) { return n <= 1 ? 0 : Math.max(1, Math.ceil(Math.log2(n))); }
export function roundCountFor(format, n) {
  return format === "swiss" ? swissRounds(n) : elimRounds(n);
}

/** How many rounds this tournament will have once it starts with `n` players. */
export function plannedRounds(t, n) {
  if (t.format === "swiss") {
    const custom = Math.round(Number(t.roundsSetting));
    if (Number.isFinite(custom) && custom >= 1) return custom;
  }
  return roundCountFor(t.format, n);
}

// ── joining ──────────────────────────────────────────────────────────────────

export function isOpenForSignup(t, now = Date.now()) {
  return t.status === "registration" && now < Number(t.startAt) && playerCount(t) < Number(t.maxPlayers);
}

function everSeated(t) {
  const seen = new Set();
  Object.values(t.rounds || {}).forEach(r => Object.values((r && r.pairings) || {}).forEach(p => {
    if (p.a) seen.add(p.a);
    if (p.b) seen.add(p.b);
  }));
  return seen;
}

/** Round-1 byes (elimination) / current-round byes (swiss) that a late joiner could take. */
export function freeByeSlots(t) {
  if (t.status !== "running") return 0;
  const round = getRound(t, t.currentRound);
  const slots = pairingsOf(round).filter(p => p.bye && p.result && p.result.reason === "bye").length;
  const seen = everSeated(t);
  const waiting = Object.keys(t.players || {}).filter(u => !seen.has(u)).length;
  return Math.max(0, slots - waiting);
}

/** Can a new player still get in after the start? Needs the organiser's "late joining". */
export function canLateJoin(t) {
  if (t.status !== "running" || !t.lateJoin) return false;
  if (playerCount(t) >= Number(t.maxPlayers)) return false;
  if (t.format === "swiss") return Number(t.currentRound) < Number(t.totalRounds);
  return Number(t.currentRound) === 1 && freeByeSlots(t) > 0;
}

export function canJoin(t, uid, now = Date.now()) {
  if (isKicked(t, uid)) return false;
  return isOpenForSignup(t, now) || canLateJoin(t);
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

// ── best-of series ───────────────────────────────────────────────────────────

/** Games recorded so far for a pairing, in order. */
export function gamesOf(p) {
  return Object.entries((p && p.games) || {})
    .map(([key, g]) => ({ n: Number(String(key).slice(1)) || 0, winner: g && g.winner, at: g && g.at }))
    .sort((x, y) => x.n - y.n);
}

/** { a, b, played } - how many games each side has won. */
export function seriesScore(p) {
  const games = gamesOf(p);
  return {
    a: games.filter(g => g.winner === p.a).length,
    b: games.filter(g => g.winner === p.b).length,
    played: games.length
  };
}

/** The game number to play next in this pairing (1 for a fresh match). */
export function nextGameNo(p) { return gamesOf(p).length + 1; }

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

function removePlayer(t, uid, now, reason) {
  const p = (t.players || {})[uid];
  if (!p) return;
  t.kicked = t.kicked || {};
  t.kicked[uid] = { name: p.name || "Player", at: now, ...(reason ? { reason } : {}) };
  delete t.players[uid];
  if (!Object.keys(t.players).length) delete t.players;
}

// The database rules can't count players, so a few extra sign-ups can slip past the
// "most players" limit when several people join at once. Whenever the tournament moves
// forward, the latest joiners over the limit are dropped.
function trimToCapacity(t, now) {
  const max = Number(t.maxPlayers);
  if (!Number.isFinite(max)) return false;
  const extra = playersInOrder(t).slice(max);
  extra.forEach(p => removePlayer(t, p.uid, now, "The tournament was full"));
  return extra.length > 0;
}

function roundWindow(t, now) {
  return { startedAt: now, endsAt: now + Number(t.roundMinutes) * 60000 };
}

function startTournament(t, now, tournamentId) {
  // Decklists are mandatory: anyone who never handed one in is dropped.
  let dropped = 0;
  if (deckRequired(t)) {
    Object.entries(t.players || {}).forEach(([uid, p]) => {
      if (!p || !p.deckAt) { removePlayer(t, uid, now, "No deck list submitted"); dropped++; }
    });
  }
  trimToCapacity(t, now);
  const players = playersInOrder(t);
  if (players.length < minPlayersOf(t)) {
    t.status = "cancelled";
    t.cancelReason = dropped ? "Not enough players submitted a deck list" : "Not enough players signed up";
    return;
  }
  t.totalRounds = plannedRounds(t, players.length);
  t.status = "running";
  t.currentRound = 1;
  const order = seededShuffle(players, `${tournamentId || t.name || "t"}|round|1`);
  const pairings = t.format === "swiss" ? swissRoundOne(order, now) : eliminationRoundOne(order, now);
  t.rounds = t.rounds || {};
  t.rounds[roundKey(1)] = { ...roundWindow(t, now), pairings };
}

// ── results ──────────────────────────────────────────────────────────────────

/** Record a whole match's winner directly (forfeits, organiser decisions). Ignores
 *  unknown matches and winners who aren't in the pairing. True if it changed anything. */
export function applyResult(t, round, pairingId, winnerUid, reason = "played", now = Date.now()) {
  const r = getRound(t, round);
  const p = r && r.pairings && r.pairings[pairingId];
  if (!p || p.result) return false;
  if (winnerUid !== p.a && winnerUid !== p.b) return false;
  p.result = { winner: winnerUid, reason, at: now };
  return true;
}

/** Record one GAME of a match. When a player has won the majority of the series the
 *  match gets its result. Stale/duplicate reports (a game number that isn't next) are
 *  ignored, so the same result arriving from two browsers counts once. */
export function applyGame(t, round, pairingId, game, winnerUid, now = Date.now()) {
  const r = getRound(t, round);
  const p = r && r.pairings && r.pairings[pairingId];
  if (!p || p.result || p.bye) return false;
  if (winnerUid !== p.a && winnerUid !== p.b) return false;

  const wanted = Number(game) || nextGameNo(p);
  if (wanted !== nextGameNo(p)) return false;

  p.games = p.games || {};
  p.games[gameKey(wanted)] = { winner: winnerUid, at: now };

  const need = winsNeeded(bestOfOf(t));
  const score = seriesScore(p);
  if (score.a >= need) p.result = { winner: p.a, reason: "played", at: now };
  else if (score.b >= need) p.result = { winner: p.b, reason: "played", at: now };
  return true;
}

function seedOf(t, uid) {
  const p = playersInOrder(t).find(x => x.uid === uid);
  return p ? p.seed : Number.MAX_SAFE_INTEGER;
}

/** Settle every unfinished match in a round whose timer has run out.
 *   - one player is ahead in the series -> they win
 *   - exactly one player showed up      -> they win (forfeit)
 *   - otherwise (level / both / neither) it's the organiser's timeout rule:
 *       "coin"      -> a coin flip decides it
 *       "organiser" -> it waits (marked `timedOut`) until the organiser picks a winner;
 *                      the round can't move on before that
 *       older tournaments: elimination -> the higher seed advances, swiss -> nobody scores */
function settleExpired(t, round, roundNo, now, tournamentId) {
  let any = false;
  const rule = timeoutRuleOf(t);
  Object.entries(round.pairings || {}).forEach(([pairingId, p]) => {
    if (p.result) return;
    const score = seriesScore(p);
    const here = Object.keys(p.checkedIn || {}).filter(u => u === p.a || u === p.b);
    if (score.a !== score.b) {
      p.result = { winner: score.a > score.b ? p.a : p.b, reason: "lead", at: now };
    } else if (here.length === 1) {
      p.result = { winner: here[0], reason: "forfeit", at: now };
    } else if (rule === "coin") {
      p.result = { winner: coinFlipWinner(tournamentId, roundNo, pairingId, p), reason: "coin", at: now };
    } else if (rule === "organiser") {
      if (p.timedOut) return;
      p.timedOut = now;
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

/** Matches whose player was removed by the organiser are won by the other player. */
function resolveKicked(t, round, now) {
  let any = false;
  Object.values(round.pairings || {}).forEach(p => {
    if (p.result || p.bye) return;
    const ka = isKicked(t, p.a), kb = isKicked(t, p.b);
    if (!ka && !kb) return;
    let winner;
    if (ka && kb) winner = t.format === "swiss" ? "none" : p.a;
    else winner = ka ? p.b : p.a;
    p.result = { winner, reason: "kicked", at: now };
    any = true;
  });
  return any;
}

// ── swiss ────────────────────────────────────────────────────────────────────

/** Points, tiebreaks and rank for everyone. Win or bye = 1 point. Removed players stay
 *  in the table (greyed out, `kicked: true`) so the results they played still count. */
export function swissStandings(t) {
  const active = playersInOrder(t);
  const rows = new Map(active.map(p => [p.uid, {
    uid: p.uid, name: p.name, seed: p.seed, points: 0, wins: 0, losses: 0, byes: 0,
    opponents: [], buchholz: 0, kicked: false
  }]));
  Object.entries(t.kicked || {}).forEach(([uid, k]) => {
    rows.set(uid, {
      uid, name: (k && k.name) || "Player", seed: 10000 + rows.size, points: 0, wins: 0, losses: 0,
      byes: 0, opponents: [], buchholz: 0, kicked: true
    });
  });

  for (let n = 1; n <= Number(t.totalRounds || 0); n++) {
    const round = getRound(t, n);
    pairingsOf(round).forEach(p => {
      const a = rows.get(p.a);
      if (!a) return;
      if (p.bye) { if (p.result) { a.points += 1; a.byes += 1; } return; }
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
    Number(x.kicked) - Number(y.kicked) || y.points - x.points || y.buchholz - x.buchholz || x.seed - y.seed);
  sorted.forEach((row, i) => { row.rank = i + 1; });
  return sorted;
}

function swissNextPairings(t, round, now) {
  const standings = swissStandings(t).filter(s => !s.kicked);
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
    t.winner = (swissStandings(t).find(s => !s.kicked) || {}).uid || "";
  } else {
    const last = pairingsOf(getRound(t, t.currentRound));
    t.winner = last.length ? last[0].result.winner : "";
  }
}

function advance(t, now) {
  const round = getRound(t, t.currentRound);
  if (t.currentRound >= t.totalRounds) { finish(t, now); return; }
  const nextNumber = t.currentRound + 1;
  const pairings = t.format === "swiss"
    ? swissNextPairings(t, round, now)
    : eliminationNextPairings(round);
  t.rounds[roundKey(nextNumber)] = { ...roundWindow(t, now), pairings };
  t.currentRound = nextNumber;
}

/** A late joiner takes over a bye: the player who had it now plays them instead.
 *  (Only possible while the round with the bye is still being played.) */
function seatLateJoiners(t, now) {
  const round = getRound(t, t.currentRound);
  if (!round) return false;
  const seen = everSeated(t);
  const late = playersInOrder(t).filter(p => !seen.has(p.uid));
  let any = false;

  late.forEach(p => {
    const slotId = Object.keys(round.pairings || {}).find(id => {
      const q = round.pairings[id];
      return q.bye && q.result && q.result.reason === "bye";
    });
    const canSeatNow = t.format === "swiss" || t.currentRound === 1;
    if (slotId && canSeatNow) {
      const q = round.pairings[slotId];
      q.b = p.uid;
      delete q.bye;
      delete q.result;
      delete q.checkedIn;
      any = true;
    } else if (t.format === "elimination") {
      // The bracket is fixed and has no free slot: they can't be seated.
      removePlayer(t, p.uid, now, "The bracket was already full");
      any = true;
    }
    // Swiss with no spare bye: they're paired when the next round is drawn.
  });
  return any;
}

/**
 * The one entry point: bring a tournament up to date.
 *   - starts it when the start time has passed (or cancels it if too few signed up)
 *   - applies match results reported in `results`
 *       ({ "<round>/<pairingId>/<game>": winnerUid } - the game part is optional)
 *   - seats late joiners, resolves matches of removed players
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
    trimToCapacity(t, now);
    seatLateJoiners(t, now);

    Object.entries(results || {}).forEach(([key, winner]) => {
      const [round, pairingId, game] = key.split("/");
      applyGame(t, Number(round), pairingId, game, winner, now);
    });

    // A round can settle and the next one begin; loop in case that new round is
    // itself already settled (every match a bye). Bounded by the round count.
    for (let guard = 0; guard <= Number(t.totalRounds) + 1 && t.status === "running"; guard++) {
      const round = getRound(t, t.currentRound);
      if (!round) break;
      resolveKicked(t, round, now);
      if (now >= Number(round.endsAt)) settleExpired(t, round, t.currentRound, now, tournamentId);
      if (!isRoundResolved(round)) break;
      // "Full length" tournaments keep to their schedule even if everyone finished early.
      if (t.roundMode === "full" && now < Number(round.endsAt) && t.currentRound < t.totalRounds) break;
      advance(t, now);
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

// ── organiser tools ──────────────────────────────────────────────────────────

/** Remove a player (before or during the tournament). Run tick() afterwards: their
 *  current match is awarded to the opponent and the round moves on if that was the
 *  last open match. Returns { tournament, changed }. */
export function kickPlayer(input, uid, now = Date.now(), reason = "") {
  if (!(input.players || {})[uid]) return { tournament: input, changed: false };
  const t = clone(input);
  removePlayer(t, uid, now, reason);
  return { tournament: t, changed: true };
}

/** Can the organiser change this match's result? Yes - any match of any round that has
 *  been played, at any time (even after the tournament has finished). In a knockout a
 *  change to an earlier round carries forward through the bracket; see overrideResult. */
export function canEditResult(t, round) {
  const n = Number(round);
  if (t.status === "registration" || t.status === "cancelled") return false;
  return n >= 1 && n <= Number(t.currentRound);
}

// Knockout: `oldUid` won round `n` but the organiser has now given that match to
// `newUid`. Put `newUid` in `oldUid`'s place in the later rounds:
//   - their next match hasn't been decided -> just swap them in (games already played
//     by the old player are wiped, the match starts over)
//   - they LOST their next match            -> swap them in; that result stands
//   - they WON their next match             -> that match is re-opened for the new
//     player, and every round after it is redrawn once it's decided
// Returns a short description of what happened (for the confirmation message).
function carryForward(t, n, oldUid, newUid, now) {
  for (let k = n + 1; k <= Number(t.currentRound); k++) {
    const round = getRound(t, k);
    const entry = Object.entries((round && round.pairings) || {}).find(([, q]) => q.a === oldUid || q.b === oldUid);
    if (!entry) return "";
    const [, q] = entry;
    const side = q.a === oldUid ? "a" : "b";
    q[side] = newUid;
    if (q.checkedIn) delete q.checkedIn[oldUid];
    if (q.result && q.result.winner !== oldUid) {
      // The old player lost here: the new one takes the loss, nothing further changes.
      return `round ${k} stays as it is`;
    }
    const replay = Boolean(q.result) || Boolean(q.games);
    delete q.result;
    delete q.games;
    delete q.timedOut;
    if (!replay) return `they take that place in round ${k}`;
    // The old player had already won (or started) round k: it must be played again,
    // so the rounds after it no longer make sense.
    for (let later = k + 1; later <= Number(t.currentRound); later++) delete t.rounds[roundKey(later)];
    t.currentRound = k;
    round.endsAt = Math.max(Number(round.endsAt), now + Number(t.roundMinutes) * 60000);
    return `their round ${k} match is played again`;
  }
  return "";
}

/** What changing this match's result will do, in words - for the organiser's
 *  "are you sure?" question. "" when it's a plain change. */
export function resultChangeImpact(t, round, pairingId, winner) {
  const n = Number(round);
  const p = (getRound(t, n) || {}).pairings && getRound(t, n).pairings[pairingId];
  if (!p || t.format !== "elimination" || n >= Number(t.currentRound)) return "";
  const old = p.result && p.result.winner;
  if (!old || !winner || winner === old) return "";
  const next = pairingsOf(getRound(t, n + 1)).find(q => q.a === old || q.b === old);
  if (!next) return "";
  const newName = nameOf(t, winner), oldName = nameOf(t, old);
  if (next.result && next.result.winner !== old) {
    return `${newName} takes ${oldName}'s place in round ${n + 1} (where ${oldName} lost), so nothing else changes.`;
  }
  if (next.result || next.games) {
    const later = Number(t.currentRound) > n + 1 ? ` Rounds ${n + 2}+ are cleared and drawn again afterwards.` : "";
    return `${newName} takes ${oldName}'s place in round ${n + 1}, and that match will have to be played again.${later}`;
  }
  return `${newName} takes ${oldName}'s place in round ${n + 1}.`;
}

/**
 * The organiser decides a match. `winner` is one of the two players' uids, "none"
 * (Swiss only: a draw, nobody scores) or null to clear the result so the match can be
 * played again. Works for every round, also after the tournament has finished.
 * Returns { tournament, changed, error }.
 */
export function overrideResult(input, round, pairingId, winner, now = Date.now(), tournamentId = "") {
  const fail = (error) => ({ tournament: input, changed: false, error });
  const n = Number(round);
  const rd = getRound(input, n);
  const existing = rd && rd.pairings && rd.pairings[pairingId];
  if (!existing) return fail("That match doesn't exist.");
  if (existing.bye) return fail("A bye can't be changed.");
  if (!canEditResult(input, n)) return fail("That match can't be changed.");
  if (winner !== null && winner !== "none" && winner !== existing.a && winner !== existing.b) {
    return fail("Pick one of the two players in the match.");
  }
  if (winner === "none" && input.format !== "swiss") return fail("A knockout match needs a winner.");
  if (winner === null && n !== Number(input.currentRound)) return fail("Only the current round can be re-opened.");

  const t = clone(input);
  const p = t.rounds[roundKey(n)].pairings[pairingId];
  if (t.status === "complete") {
    // Changing a result after the end: the tournament is live again until tick()
    // finishes it once more (and works out the champion again).
    t.status = "running";
    delete t.winner;
    delete t.completedAt;
  }
  if (winner === null) {
    delete p.result;
    delete p.games;       // a re-opened match is played from scratch
    delete p.checkedIn;
    delete p.timedOut;
    // Give them a fresh window, or an expired round would settle it again at once.
    const rd2 = t.rounds[roundKey(n)];
    rd2.endsAt = Math.max(Number(rd2.endsAt), now + Number(t.roundMinutes) * 60000);
  } else {
    const old = p.result && p.result.winner;
    p.result = { winner, reason: "organiser", at: now };
    delete p.timedOut;
    if (t.format === "elimination" && old && old !== winner && old !== "none" && n < Number(t.currentRound)) {
      carryForward(t, n, old, winner, now);
    }
  }
  return { ...tick(t, now, {}, tournamentId), error: null, changed: true };
}

// ── validating / applying settings ───────────────────────────────────────────

const intIn = (value, min, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/**
 * Check and tidy the options a tournament is created or edited with. `raw` holds the
 * form values; returns { fields } (the clean values, ready to store) or { error }.
 * `ctx.existing` is the stored tournament when editing.
 */
export function cleanSettings(raw, ctx = {}) {
  const now = ctx.now || Date.now();
  const existing = ctx.existing || null;
  const started = Boolean(existing && existing.status !== "registration");
  const fail = (error) => ({ error });
  const f = {};

  f.name = String(raw.name || "").trim().slice(0, 60);
  if (!f.name) return fail("Give the tournament a name.");
  f.description = String(raw.description || "").trim().slice(0, 600);

  f.matchType = raw.matchType === "draft" ? "draft" : "regular";
  f.format = raw.format === "swiss" ? "swiss" : "elimination";
  f.bestOf = BEST_OF_OPTIONS.includes(Number(raw.bestOf)) ? Number(raw.bestOf) : 1;
  f.roundMode = raw.roundMode === "full" ? "full" : "asap";
  f.timeoutRule = raw.timeoutRule === "organiser" ? "organiser" : "coin";
  const clock = Math.round(Number(raw.clockMinutes));
  f.clockMinutes = Number.isFinite(clock) && clock > 0 ? Math.min(180, clock) : 0;
  f.collections = toList(raw.collections);
  f.banned = [...new Set(toList(raw.banned).map(s => s.trim()).filter(s => s && s.length <= 40))].slice(0, MAX_BANNED);

  f.startAt = Number(raw.startAt);
  if (!Number.isFinite(f.startAt)) return fail("Pick a start time.");
  const startChanged = !existing || f.startAt !== Number(existing.startAt);
  if (!started && startChanged && f.startAt < now + 60 * 1000) return fail("Pick a start time at least a minute from now.");

  const minutes = intIn(raw.roundMinutes, MIN_ROUND_MINUTES, MAX_ROUND_MINUTES);
  if (minutes === null) return fail(`Each round must last between ${MIN_ROUND_MINUTES} minutes and 60 days.`);
  f.roundMinutes = minutes;

  const max = intIn(raw.maxPlayers, MIN_PLAYERS, MAX_PLAYERS_LIMIT);
  if (max === null) return fail(`The most players allowed must be between ${MIN_PLAYERS} and ${MAX_PLAYERS_LIMIT}.`);
  const min = intIn(raw.minPlayers ?? MIN_PLAYERS, MIN_PLAYERS, MAX_PLAYERS_LIMIT);
  if (min === null) return fail(`The fewest players allowed must be at least ${MIN_PLAYERS}.`);
  if (min > max) return fail("The fewest players can't be more than the most players.");
  if (existing && playerCount(existing) > max) return fail(`${playerCount(existing)} players are already in - the maximum can't be lower than that.`);
  f.minPlayers = min;
  f.maxPlayers = max;

  f.lateJoin = Boolean(raw.lateJoin);
  f.private = Boolean(raw.private);

  // Swiss: an optional custom number of rounds.
  const custom = intIn(raw.roundsSetting, 1, 30);
  if (f.format === "swiss" && custom !== null) {
    if (existing && existing.status === "running" && custom < Number(existing.currentRound)) {
      return fail(`It's already round ${existing.currentRound} - it can't have fewer rounds than that.`);
    }
    f.roundsSetting = custom;
  }

  f.requireDeck = f.matchType === "regular" && Boolean(raw.requireDeck);
  if (f.requireDeck) {
    f.deckDeadline = Number(raw.deckDeadline);
    if (!Number.isFinite(f.deckDeadline)) return fail("Pick a deadline for submitting deck lists.");
    if (f.deckDeadline > f.startAt) return fail("The deck list deadline must be before the tournament starts.");
    const deadlineChanged = !existing || f.deckDeadline !== Number(existing.deckDeadline);
    if (!started && deadlineChanged && f.deckDeadline < now) return fail("The deck list deadline has already passed.");
  }

  if (f.matchType === "draft") {
    const d = raw.draft || {};
    const packs = intIn(d.packs ?? DRAFT_DEFAULTS.packs, DRAFT_LIMITS.packs.min, DRAFT_LIMITS.packs.max);
    const mins = intIn(d.minutes ?? DRAFT_DEFAULTS.minutes, DRAFT_LIMITS.minutes.min, DRAFT_LIMITS.minutes.max);
    const size = intIn(d.deckSize ?? DRAFT_DEFAULTS.deckSize, DRAFT_LIMITS.deckSize.min, DRAFT_LIMITS.deckSize.max);
    if (packs === null) return fail(`Packs per player must be between ${DRAFT_LIMITS.packs.min} and ${DRAFT_LIMITS.packs.max}.`);
    if (mins === null) return fail(`Deck building time must be between ${DRAFT_LIMITS.minutes.min} and ${DRAFT_LIMITS.minutes.max} minutes.`);
    if (size === null) return fail(`Draft deck size must be between ${DRAFT_LIMITS.deckSize.min} and ${DRAFT_LIMITS.deckSize.max} cards.`);
    f.draft = { packs, minutes: mins, deckSize: size };
  }

  return { fields: f };
}

// Fields an organiser can no longer change once round 1 has begun.
const LOCKED_AFTER_START = ["matchType", "format", "bestOf", "collections", "startAt", "requireDeck", "deckDeadline"];
// Every field cleanSettings produces - they're all replaced together on an edit.
const SETTING_KEYS = ["name", "description", "matchType", "format", "bestOf", "roundMode", "timeoutRule", "clockMinutes",
  "collections", "banned", "startAt", "roundMinutes", "minPlayers", "maxPlayers", "lateJoin", "private", "roundsSetting",
  "requireDeck", "deckDeadline", "draft"];

/** Apply an organiser's edits to a stored tournament. Returns { tournament, changed, error }. */
export function applySettings(input, raw, now = Date.now()) {
  if (input.status === "complete" || input.status === "cancelled") {
    return { tournament: input, changed: false, error: "This tournament is over - it can't be edited." };
  }
  const cleaned = cleanSettings(raw, { now, existing: input });
  if (cleaned.error) return { tournament: input, changed: false, error: cleaned.error };

  const t = clone(input);
  const fields = cleaned.fields;
  const started = t.status !== "registration";

  SETTING_KEYS.forEach(key => {
    if (started && LOCKED_AFTER_START.includes(key)) return;
    const value = fields[key];
    // Empty values aren't stored (Firebase drops them anyway).
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) delete t[key];
    else t[key] = value;
  });

  if (started) {
    // A change of round length applies to the round being played right now.
    const round = getRound(t, t.currentRound);
    if (round && t.status === "running") round.endsAt = Number(round.startedAt) + Number(t.roundMinutes) * 60000;
    // Swiss: a custom round count (or back to automatic).
    if (t.format === "swiss") {
      t.totalRounds = Math.max(Number(t.currentRound), plannedRounds(t, playerCount(t)));
    }
  }
  const changed = JSON.stringify(t) !== JSON.stringify(input);
  return { tournament: changed ? t : input, changed, error: null };
}

// ── what a player should see ────────────────────────────────────────────────

export function nameOf(t, uid) {
  const p = (t.players || {})[uid];
  if (p && p.name) return p.name;
  const k = (t.kicked || {})[uid];
  return (k && k.name) || "Player";
}

/**
 * Where does this player stand? Drives the "you need to play round 2" line.
 *   state: "none" | "registered" | "play" | "waiting" | "bye" | "eliminated"
 *          | "champion" | "finished" | "cancelled" | "kicked" | "late"
 *   needsAction: true when the player has a match they still have to play
 *   For a match: bestOf, game (the number to play next), myWins, oppWins.
 */
export function myStatus(t, uid, now = Date.now()) {
  const base = { state: "none", needsAction: false, round: null, pairingId: null,
                 opponentUid: null, opponentName: "", dueAt: null, lostInRound: null, rank: null,
                 bestOf: bestOfOf(t), game: 1, myWins: 0, oppWins: 0 };
  if (!uid) return base;
  if (isKicked(t, uid)) return { ...base, state: "kicked" };
  if (!(t.players || {})[uid]) return base;

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
    // Joined after the draw: they're paired when the next round is drawn.
    if (!everSeated(t).has(uid)) return { ...base, state: "late", dueAt: round ? round.endsAt : null };
    // Elimination: no pairing this round means they went out in an earlier round.
    let lostIn = null;
    for (let n = 1; n < roundNo; n++) {
      const found = pairingsOf(getRound(t, n)).find(p => (p.a === uid || p.b === uid));
      if (found && found.result && found.result.winner !== uid) lostIn = n;
    }
    return { ...base, state: "eliminated", lostInRound: lostIn };
  }

  const opponentUid = mine.bye ? null : (mine.a === uid ? mine.b : mine.a);
  const score = seriesScore(mine);
  const info = { ...base, round: roundNo, pairingId: mine.id, opponentUid,
                 opponentName: opponentUid ? nameOf(t, opponentUid) : "", dueAt: round.endsAt,
                 game: nextGameNo(mine),
                 myWins: mine.a === uid ? score.a : score.b,
                 oppWins: mine.a === uid ? score.b : score.a };

  if (mine.bye) return { ...info, state: "bye" };
  if (!mine.result) return { ...info, state: "play", needsAction: true };

  const won = mine.result.winner === uid;
  // Lost a knockout match: out of the tournament right now (don't wait for the
  // rest of the round to finish before telling them).
  if (!won && t.format === "elimination") return { ...info, state: "eliminated", lostInRound: roundNo, won };
  return { ...info, state: "waiting", won };
}
