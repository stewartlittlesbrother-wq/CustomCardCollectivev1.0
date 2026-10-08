// Ranked ladder maths (pure, unit tested). Plain Elo: everyone starts at 1000, and
// a game moves both players by up to K points depending on how expected the result
// was (beating a much higher-rated player is worth more).

export const START_RATING = 1000;
export const K_FACTOR = 32;

/** The chance the first player wins, by rating. */
export function expectedScore(mine, theirs) {
    return 1 / (1 + 10 ** ((Number(theirs) - Number(mine)) / 400));
}

/** My new rating after a game against `theirs`. */
export function eloAfter(mine, theirs, won, k = K_FACTOR) {
    return Math.round(Number(mine) + k * ((won ? 1 : 0) - expectedScore(mine, theirs)));
}
