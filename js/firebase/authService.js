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
    updatePassword,
    EmailAuthProvider,
    linkWithCredential,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    ref,
    get,
    set
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const auth = getAuth(app);

// The name a player SET (updateDisplayName writes it to users/<uid>/profile/
// displayName). Firebase Auth's own `displayName` is NOT reliable as the source
// of truth: a Google sign-in re-syncs the provider profile on each login (which
// can wipe a custom name back to the Google/email one), and the Auth profile
// write doesn't always propagate cross-device. So we cache the DB value on auth
// change and PREFER it in getAccount() - otherwise a saved name would keep
// reverting to the email prefix for those users.
let cachedProfileName = null;   // { uid, displayName } | null

async function loadProfileName(uid) {
    try {
        const snap = await get(ref(database, `users/${uid}/profile/displayName`));
        return snap.exists() ? String(snap.val() || "").trim() : "";
    } catch (_) {
        return "";
    }
}

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
    // Every email tied to this account: the primary plus each linked provider's
    // (e.g. the real Gmail from a Google sign-in). Used for admin detection, which
    // must still work after a username/password login was linked and possibly
    // changed the primary email to the synthetic <username>@... address.
    const emails = [...new Set(
        [u.email, ...((u.providerData || []).map(p => p && p.email))]
            .filter(Boolean).map(e => String(e).toLowerCase())
    )];
    // Prefer the name the player actually SET (DB profile), then Auth's own
    // displayName, then a last-resort email prefix. Without the DB value first,
    // a saved name reverts to the email name whenever Auth's displayName is stale.
    const savedName = (cachedProfileName && cachedProfileName.uid === u.uid)
        ? cachedProfileName.displayName
        : "";
    return {
        uid: u.uid,
        displayName: savedName || u.displayName || (u.email ? u.email.split("@")[0] : "Player"),
        email: u.email || "",
        emails,
        photoURL: u.photoURL || "",
        provider: (u.providerData?.[0]?.providerId) || ""
    };
}

// Fire `cb(account|null)` now and whenever sign-in state changes. When signed
// in, the player's SAVED name lives in the DB profile, so fetch it and - if it
// differs from what Auth reported - fire once more with the corrected account.
export function onAccountChange(cb) {
    return onAuthStateChanged(auth, async () => {
        const account = getAccount();
        cb(account);
        if (!account) {
            cachedProfileName = null;
            return;
        }
        const dbName = await loadProfileName(account.uid);
        if (dbName) {
            const changed = dbName !== account.displayName;
            cachedProfileName = { uid: account.uid, displayName: dbName };
            if (changed) cb(getAccount());
        }
    });
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
    try {
        await set(ref(database, `usernames/${username.trim().toLowerCase()}`), cred.user.uid);
        await set(ref(database, `users/${cred.user.uid}/profile/username`), username.trim());
    } catch (_) {}
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

// ── Account management (Settings) ────────────────────────────────────────────

// Details the Settings panel needs: name, sign-in methods, whether a
// username/password login exists, and the username (if any).
export async function getAccountDetails() {
    const u = auth.currentUser;
    if (!isRealAccount(u)) return null;
    const providers = (u.providerData || []).map(p => p.providerId);
    let username = "";
    try {
        const snap = await get(ref(database, `users/${u.uid}/profile/username`));
        if (snap.exists()) username = snap.val();
    } catch (_) {}
    // The saved name (DB) is authoritative over Auth's own displayName, so the
    // Settings input shows what the player actually set - not the email prefix.
    const savedName = await loadProfileName(u.uid);
    if (savedName) cachedProfileName = { uid: u.uid, displayName: savedName };
    return {
        uid: u.uid,
        displayName: savedName || u.displayName || (u.email ? u.email.split("@")[0] : "Player"),
        providers,
        hasPassword: providers.includes("password"),
        hasGoogle: providers.includes("google.com"),
        username
    };
}

// Change the name shown in game, chat and everywhere else. This is the display
// name only; it does NOT change the username you log in with.
export async function updateDisplayName(name) {
    const u = auth.currentUser;
    if (!isRealAccount(u)) throw new Error("You're not signed in.");
    const clean = String(name || "").trim();
    if (clean.length < 1 || clean.length > 30) throw new Error("Name must be 1–30 characters.");
    await updateProfile(u, { displayName: clean });
    try { await set(ref(database, `users/${u.uid}/profile/displayName`), clean); } catch (_) {}
    // Cache it right away so getAccount() reflects the new name immediately, even
    // before the next auth-change fetch (and even if Auth's own displayName is
    // later re-synced away by a provider).
    cachedProfileName = { uid: u.uid, displayName: clean };
    return clean;
}

// Change the password on an account that already has a username/password login.
export async function changePassword(newPassword) {
    const u = auth.currentUser;
    if (!isRealAccount(u)) throw new Error("You're not signed in.");
    if (!newPassword || newPassword.length < 6) throw new Error("Password must be at least 6 characters.");
    try {
        await updatePassword(u, newPassword);
    } catch (e) {
        if (e && e.code === "auth/requires-recent-login") {
            throw new Error("For security, sign out and back in, then change your password.");
        }
        throw new Error(friendlyAuthError(e));
    }
}

// Give an account (typically a Google sign-in) an OPTIONAL username + password
// login, by linking an email/password credential. Afterwards they can log in
// either way. Also used to set a username on an account that has none yet.
export async function setUsernameLogin(username, password) {
    const u = auth.currentUser;
    if (!isRealAccount(u)) throw new Error("You're not signed in.");
    if (!validUsername(username)) throw new Error("Username must be 3–20 letters, numbers or underscores.");
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");
    // Refuse a username someone else already claimed.
    try {
        const taken = await get(ref(database, `usernames/${username.trim().toLowerCase()}`));
        if (taken.exists() && taken.val() !== u.uid) throw new Error("That username is already taken.");
    } catch (e) { if (e && e.message && e.message.includes("taken")) throw e; }

    const credential = EmailAuthProvider.credential(usernameToEmail(username), password);
    try {
        await linkWithCredential(u, credential);
    } catch (e) {
        if (e && e.code === "auth/requires-recent-login") {
            throw new Error("For security, sign out and back in, then set your username.");
        }
        if (e && (e.code === "auth/email-already-in-use" || e.code === "auth/credential-already-in-use")) {
            throw new Error("That username is already taken.");
        }
        if (e && e.code === "auth/provider-already-linked") {
            // Already has a password login; just (re)set the password instead.
            await changePassword(password);
        } else {
            throw new Error(friendlyAuthError(e));
        }
    }
    try {
        await set(ref(database, `usernames/${username.trim().toLowerCase()}`), u.uid);
        await set(ref(database, `users/${u.uid}/profile/username`), username.trim());
    } catch (_) {}
    return username.trim();
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
