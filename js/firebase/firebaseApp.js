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

export const app = initializeApp(firebaseConfig);

export const database = getDatabase(app);

const auth = getAuth(app);

// Shared auth instance, so the account system (authService.js) signs in on the
// SAME Firebase app as multiplayer instead of spinning up a second one.
export { auth };

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
        // Wait for Firebase to restore any persisted session BEFORE deciding what
        // to do — otherwise currentUser is briefly null on load and we'd sign in
        // anonymously (and downgrade persistence) even though a real account is
        // about to be restored.
        const ready = auth.authStateReady ? auth.authStateReady() : Promise.resolve();
        authReadyPromise = ready.then(() => {
            // A real, persisted account is already signed in: use it and DON'T
            // touch persistence. The account system signs in with LOCAL
            // persistence so it survives closing the site; the old unconditional
            // switch to session persistence here is what logged people out on
            // every close.
            if (auth.currentUser) return auth.currentUser;

            // No one is signed in — sign in anonymously for multiplayer. Use
            // session persistence so two tabs on one machine are two players;
            // fall back to in-memory if sessionStorage is blocked.
            return setPersistence(auth, browserSessionPersistence)
                .catch(() => setPersistence(auth, inMemoryPersistence).catch(() => {}))
                .then(() => signInAnonymously(auth).then(c => c.user));
        }).then(user => user || auth.currentUser);
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
