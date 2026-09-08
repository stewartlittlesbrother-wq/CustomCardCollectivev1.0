// Account system for the simulator.
//
// Real accounts (Google or username/password) let a player OWN the cards they
// make and (in a later step) sync their decks/settings across devices. This
// module wraps Firebase Auth on the SAME app the multiplayer code uses
// (firebaseApp.js), so there's one auth session for the whole site.
//
// Coexistence with multiplayer's anonymous auth:
//   - Multiplayer (firebaseApp.js ensureAuth) only signs in ANONYMOUSLY when
//     nobody is already signed in. So once a real account is signed in, matches
//     run as that account. Guests still get an anonymous uid for matches.
//   - Real sign-ins use LOCAL persistence so you stay logged in across visits;
//     that call is made per sign-in so it doesn't disturb the anonymous flow.
//
// Firebase console setup REQUIRED before this works (Authentication ▸ Sign-in
// method): enable "Google" and "Email/Password", and add your site's domain
// (e.g. stewartlittlesbrother-wq.github.io and localhost) under Authorized
// domains for Google sign-in.

import { app, database } from "./firebaseApp.js";
import {
    getAuth,
    setPersistence,
    browserLocalPersistence,
    GoogleAuthProvider,
    signInWithPopup,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    updateProfile,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    ref,
    get,
    set
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const auth = getAuth(app);

// Username/password accounts map a username onto a synthetic email, because
// Firebase Email/Password auth keys on email. The user never sees this address.
const USERNAME_EMAIL_DOMAIN = "cc-users.web.app";
function usernameToEmail(username) {
    return `${String(username).trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;
}
function validUsername(username) {
    return /^[a-zA-Z0-9_]{3,20}$/.test(String(username || "").trim());
}

async function useLocalPersistence() {
    try { await setPersistence(auth, browserLocalPersistence); } catch (_) {}
}

// ── Public API ──────────────────────────────────────────────────────────────

// A "real" account is one that is signed in and NOT anonymous.
export function isRealAccount(user = auth.currentUser) {
    return Boolean(user && !user.isAnonymous);
}

export function getAccount() {
    const u = auth.currentUser;
    if (!isRealAccount(u)) return null;
    return {
        uid: u.uid,
        displayName: u.displayName || (u.email ? u.email.split("@")[0] : "Player"),
        email: u.email || "",
        photoURL: u.photoURL || "",
        provider: (u.providerData?.[0]?.providerId) || ""
    };
}

// Fire `cb(account|null)` now and whenever sign-in state changes.
export function onAccountChange(cb) {
    return onAuthStateChanged(auth, () => cb(getAccount()));
}

export async function signInWithGoogle() {
    await useLocalPersistence();
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    await ensureProfile(cred.user, cred.user.displayName || "Player");
    return getAccount();
}

export async function signUpWithUsername(username, password) {
    if (!validUsername(username)) {
        throw new Error("Username must be 3–20 letters, numbers or underscores.");
    }
    if (!password || password.length < 6) {
        throw new Error("Password must be at least 6 characters.");
    }
    await useLocalPersistence();
    let cred;
    try {
        cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    } catch (e) {
        if (e && e.code === "auth/email-already-in-use") {
            throw new Error("That username is already taken.");
        }
        throw new Error(friendlyAuthError(e));
    }
    try { await updateProfile(cred.user, { displayName: username.trim() }); } catch (_) {}
    await ensureProfile(cred.user, username.trim());
    // Record the username so it shows as taken and is discoverable later.
    try { await set(ref(database, `usernames/${username.trim().toLowerCase()}`), cred.user.uid); } catch (_) {}
    return getAccount();
}

export async function signInWithUsername(username, password) {
    if (!username || !password) throw new Error("Enter your username and password.");
    await useLocalPersistence();
    try {
        await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    } catch (e) {
        if (e && (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found")) {
            throw new Error("Wrong username or password.");
        }
        throw new Error(friendlyAuthError(e));
    }
    return getAccount();
}

export async function signOutAccount() {
    try { await signOut(auth); } catch (_) {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Make sure /users/<uid>/profile exists so we have a home for their data.
async function ensureProfile(user, displayName) {
    try {
        const profileRef = ref(database, `users/${user.uid}/profile`);
        const snap = await get(profileRef);
        if (!snap.exists()) {
            await set(profileRef, {
                displayName: displayName || "Player",
                createdAt: Date.now()
            });
        }
    } catch (_) { /* profile is best-effort; auth still succeeds */ }
}

function friendlyAuthError(e) {
    const code = e && e.code ? String(e.code) : "";
    if (code.includes("network")) return "Network error — check your connection.";
    if (code === "auth/too-many-requests") return "Too many attempts. Try again in a bit.";
    if (code === "auth/popup-closed-by-user") return "Sign-in was cancelled.";
    if (code === "auth/operation-not-allowed") {
        return "This sign-in method isn't enabled in Firebase yet.";
    }
    return (e && e.message) ? e.message.replace(/^Firebase:\s*/, "") : "Something went wrong.";
}
