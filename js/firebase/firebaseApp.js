import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
    getDatabase
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged,
    setPersistence,
    browserSessionPersistence,
    inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebaseConfig.js";

const app = initializeApp(firebaseConfig);

export const database = getDatabase(app);

const auth = getAuth(app);

// Previously this module handed out a plain `{ uid }` object and never actually
// authenticated. Realtime Database security rules that require `auth != null`
// therefore rejected every write with PERMISSION_DENIED.
//
// We now perform a real Firebase Anonymous sign-in, which yields a genuine auth
// token the rules accept.
//
// Persistence MUST be session (sessionStorage), not in-memory. A match keys each
// player's private state by their uid (players/pX/uid -> private/<uid>), and the
// lobby and the game board are separate page loads. In-memory auth is destroyed
// on navigation, so a player arrived at the game with a BRAND NEW uid and
// subscribed to private/<newUid>, which never exists - that player then had no
// hand/deck/life and appeared permanently stuck behind the game state.
//
// sessionStorage is scoped per browser TAB and survives navigation within that
// tab, which gives us both properties we need: the uid is stable from lobby to
// game, while two tabs remain two independent players.
//
// NOTE: this requires Anonymous sign-in to be enabled in the Firebase console
// (Authentication -> Sign-in method -> Anonymous). If lobby creation still fails
// with PERMISSION_DENIED after this change, enable that provider and confirm the
// database rules allow authenticated reads/writes under /matches and /lobbies.
let authReadyPromise = null;

function ensureAuth() {
    if (!authReadyPromise) {
        authReadyPromise = setPersistence(auth, browserSessionPersistence)
            // Fall back to in-memory only if sessionStorage is unavailable
            // (e.g. hardened privacy settings); the uid is then per page load.
            .catch(() => setPersistence(auth, inMemoryPersistence).catch(() => {}))
            .then(() => auth.currentUser || signInAnonymously(auth).then(c => c.user))
            .then(user => user || auth.currentUser);
    }
    return authReadyPromise;
}

export function signInGuest() {
    return ensureAuth();
}

export function waitForUser() {
    if (auth.currentUser) {
        return Promise.resolve(auth.currentUser);
    }

    return ensureAuth().then(() => {
        if (auth.currentUser) return auth.currentUser;

        return new Promise(resolve => {
            const unsubscribe = onAuthStateChanged(auth, user => {
                if (user) {
                    unsubscribe();
                    resolve(user);
                }
            });
        });
    });
}
