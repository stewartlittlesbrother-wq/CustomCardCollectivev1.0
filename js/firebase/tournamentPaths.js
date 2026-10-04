// Where tournament data lives in the Realtime Database.
//
//   tournaments/<id>                 the tournament document (public)
//   tournamentSecrets/<id>/pwHash    the join password's hash (nobody can read it)
//   tournamentJoin/<id>/<uid>        a player's proof they know the password (only they can read it)
//   tournamentDecks/<id>/<uid>       a player's submitted deck list (that player + the organiser can read it)
//
// DEVELOPMENT ONLY - never active on the real site. On localhost, ?tbase=<db path>
// (remembered for the tab, so it survives going lobby -> game) puts all of it under a
// scratch database path, so the feature can be tested without touching real data.

function devBasePath() {
    try {
        if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "";
        const fromUrl = new URLSearchParams(location.search).get("tbase");
        if (fromUrl) sessionStorage.setItem("cc_tbase", fromUrl);
        return (sessionStorage.getItem("cc_tbase") || "").replace(/^\/+|\/+$/g, "");
    } catch { return ""; }
}

const dev = devBasePath();

export const BASE_PATH = dev || "tournaments";
export const DECKS_PATH = dev ? `${dev}/__decks` : "tournamentDecks";
export const SECRETS_PATH = dev ? `${dev}/__secrets` : "tournamentSecrets";
export const JOIN_PATH = dev ? `${dev}/__join` : "tournamentJoin";
