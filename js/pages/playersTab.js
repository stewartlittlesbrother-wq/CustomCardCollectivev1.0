// Players tab (inside the main app): your profile with the ranked-ladder switch,
// your friends (requests, who's online, invite to a game, find people) and the
// ranked ladder. Accounts only - guests get a "sign in" card.
//
// app.js loads this module the first time the tab opens and calls show() every
// time it does. Data lives in js/firebase/profileService.js.

import * as profiles from "../firebase/profileService.js?v=1";
import { openProfile, profileBodyHtml, avatarHtml, paintLeaderArt, injectProfileStyles } from "../profileDialog.js?v=1";
import { createRoom } from "../firebase/multiplayerService.js?v=quick-1";
import { waitForUser } from "../firebase/firebaseApp.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const st = {
    me: null,               // { uid, name } of the signed-in account
    profile: null,
    profileLoaded: false,
    friends: {},
    inbox: [],
    statuses: {},
    ladder: [],
    ladderLoaded: false,
    ladderError: "",
    denied: false,          // database rules not published yet
    search: { text: "", results: null, busy: false },
    message: ""
};
let root = null;
let started = false;
let unsubs = [];
let unsubStatus = null;
let statusKeys = "";

const visible = () => Boolean(document.querySelector("#playersView.view.active"));
function account() {
    const a = window.ccAccount && window.ccAccount.user;
    return a ? { uid: a.uid, name: a.displayName || "Player" } : null;
}

// ── entry ────────────────────────────────────────────────────────────────────

export function show() {
    root = document.getElementById("plRoot");
    if (!root) return;
    injectProfileStyles();
    if (!started) {
        started = true;
        document.addEventListener("cc-account-change", connect);
        root.addEventListener("click", onClick);
        root.addEventListener("submit", onSubmit);
        root.addEventListener("change", onChange);
        setInterval(() => { if (visible()) refreshLadder(); }, 60000);
        connect();
    } else if (account()?.uid !== st.me?.uid) {
        connect();
    }
    refreshLadder();
    render();
}

function stopAll() {
    unsubs.forEach(u => { try { u(); } catch { /* gone */ } });
    unsubs = [];
    if (unsubStatus) { try { unsubStatus(); } catch { /* gone */ } }
    unsubStatus = null;
    statusKeys = "";
}

function permission(error) {
    if (profiles.isPermissionError(error)) { st.denied = true; render(); }
}

function connect() {
    stopAll();
    st.me = account();
    st.profile = null;
    st.profileLoaded = false;
    st.friends = {};
    st.inbox = [];
    st.statuses = {};
    st.denied = false;
    if (!st.me) { render(); return; }
    profiles.ensureProfile(st.me.uid, st.me.name).catch(permission);
    unsubs.push(profiles.watchProfile(st.me.uid, (p) => { st.profile = p; st.profileLoaded = true; render(); }, permission));
    unsubs.push(profiles.watchFriends(st.me.uid, (f) => { st.friends = f || {}; watchFriendStatuses(); render(); }, permission));
    unsubs.push(profiles.watchInbox(st.me.uid, (items) => { st.inbox = items || []; render(); }, permission));
    render();
}

function watchFriendStatuses() {
    const uids = Object.keys(st.friends).sort();
    const key = uids.join(",");
    if (key === statusKeys) return;
    statusKeys = key;
    if (unsubStatus) { try { unsubStatus(); } catch { /* gone */ } }
    unsubStatus = uids.length ? profiles.watchStatuses(uids, (states) => { st.statuses = states; render(); }) : null;
}

let ladderLoading = false;
async function refreshLadder() {
    if (ladderLoading) return;
    ladderLoading = true;
    try {
        st.ladder = await profiles.leaderboard(50);
        st.ladderError = "";
    } catch (error) {
        st.ladderError = profiles.isPermissionError(error) ? "denied" : "Couldn't load the ladder right now.";
    } finally {
        st.ladderLoaded = true;
        ladderLoading = false;
        render();
    }
}

// ── drawing ──────────────────────────────────────────────────────────────────

function render() {
    if (!root || !visible()) return;
    const scrollers = [...root.querySelectorAll("[data-keep-scroll]")].map(el => [el.dataset.keepScroll, el.scrollTop]);
    const searchFocused = document.activeElement && document.activeElement.id === "plSearch";
    root.innerHTML = `
    <div class="pl-page">
      <div class="pl-head">
        <div><h1>Players</h1><p>Your profile, your friends and the ranked ladder.</p></div>
      </div>
      ${st.denied || st.ladderError === "denied" ? `<div class="pl-notice"><b>Profiles, friends and the ladder aren't switched on yet.</b>
        The site owner needs to publish the database rules: Firebase Console → Realtime Database → Rules, paste in <code>database.rules.json</code> and press Publish.</div>` : ""}
      ${st.message ? `<div class="pl-notice ok">${esc(st.message)}</div>` : ""}
      ${st.me ? `<div class="pl-cols">
          <section class="pl-card" aria-labelledby="plMeTitle"><h2 id="plMeTitle">My profile</h2>${myProfileHtml()}</section>
          <section class="pl-card" aria-labelledby="plFriendsTitle"><h2 id="plFriendsTitle">Friends</h2>${friendsHtml()}</section>
        </div>` : signInHtml()}
      <section class="pl-card" aria-labelledby="plLadderTitle">
        <div class="pl-cardhead"><h2 id="plLadderTitle">Ranked ladder</h2>
          <span class="pl-hint">Only Quick match games between two ranked players count. Everyone starts at ${profiles.START_RATING}.</span></div>
        ${ladderHtml()}
      </section>
    </div>`;
    scrollers.forEach(([key, top]) => { const el = root.querySelector(`[data-keep-scroll="${key}"]`); if (el) el.scrollTop = top; });
    const search = root.querySelector("#plSearch");
    if (search) { search.value = st.search.text; if (searchFocused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); } }
    paintLeaderArt(root);
}

function signInHtml() {
    return `<section class="pl-card pl-signin">
        <h2>Get your player profile</h2>
        <p>Sign in (or make a free account) to get a profile with your record, most-played leaders and tournament trophies, a ranked ladder rating, and friends you can invite to games.</p>
        <button type="button" class="pf-btn primary" data-pl="signin">Sign in</button>
    </section>`;
}

function myProfileHtml() {
    if (!st.profileLoaded) return `<p class="pf-empty">Setting up your profile…</p>`;
    if (!st.profile) return `<p class="pf-empty">${st.denied ? "Your profile appears here once profiles are switched on." : "Setting up your profile…"}</p>`;
    const p = st.profile;
    return `<div class="pl-me">${profileBodyHtml(p, { online: true })}</div>
      <label class="pl-switch">
        <input type="checkbox" id="plLadderToggle"${p.ladder ? " checked" : ""}>
        <span><b>Play ranked</b><small>${p.ladder
            ? `You're on the ladder at ${Number(p.rating) || profiles.START_RATING}. Quick match games against other ranked players change your rating.`
            : "Join the ladder: Quick match games against other ranked players will change your rating (you start at 1000)."}</small></span>
      </label>
      <button type="button" class="pl-link" data-pl="profile" data-uid="${esc(st.me.uid)}" data-name="${esc(p.name)}">See how others see your profile</button>`;
}

function friendsHtml() {
    const requests = st.inbox.filter(i => i.type === "friendRequest" && !(st.friends[i.fromUid] && st.friends[i.fromUid].status === "friend"));
    const list = Object.entries(st.friends).map(([uid, f]) => ({ uid, ...f, online: Boolean(st.statuses[uid] && st.statuses[uid].online) }))
        .sort((a, b) => (a.status === "friend" ? 0 : 1) - (b.status === "friend" ? 0 : 1) || Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));

    const search = st.search.results;
    const results = search === null ? "" : (search.length ? `<ul class="pl-list">${search.map(r => {
        const mine = r.uid === st.me.uid;
        const f = st.friends[r.uid];
        const action = mine ? `<span class="pf-tag">You</span>`
            : f && f.status === "friend" ? `<span class="pf-tag">✓ Friends</span>`
            : f && f.status === "sent" ? `<span class="pl-muted">Request sent</span>`
            : `<button type="button" class="pf-btn primary" data-pl="add" data-uid="${esc(r.uid)}" data-name="${esc(r.name)}">Add friend</button>`;
        return `<li>${avatarHtml(r.name, 32)}<button type="button" class="pl-name" data-pl="profile" data-uid="${esc(r.uid)}" data-name="${esc(r.name)}">${esc(r.name)}${r.username ? ` <small>@${esc(r.username)}</small>` : ""}</button>${action}</li>`;
    }).join("")}</ul>` : `<p class="pf-empty">Nobody found. Try their exact username, or the start of their name.</p>`);

    const req = requests.length ? `<div class="pl-sub"><h3>Friend requests</h3><ul class="pl-list">${requests.map(i => `
        <li>${avatarHtml(i.fromName, 32)}<button type="button" class="pl-name" data-pl="profile" data-uid="${esc(i.fromUid)}" data-name="${esc(i.fromName)}">${esc(i.fromName)}</button>
          <span class="pl-row-actions"><button type="button" class="pf-btn primary" data-pl="accept" data-id="${esc(i.id)}">Accept</button>
          <button type="button" class="pf-btn" data-pl="decline" data-id="${esc(i.id)}">Decline</button></span></li>`).join("")}</ul></div>` : "";

    const friends = list.length ? `<ul class="pl-list" data-keep-scroll="friends">${list.map(f => `
        <li>${avatarHtml(f.name, 32)}
          <button type="button" class="pl-name" data-pl="profile" data-uid="${esc(f.uid)}" data-name="${esc(f.name)}">${esc(f.name)}
            <small class="${f.status === "friend" && f.online ? "on" : ""}">${f.status === "sent" ? "Request sent" : f.online ? "● Online" : "Offline"}</small></button>
          <span class="pl-row-actions">
            ${f.status === "friend" ? `<button type="button" class="pf-btn primary" data-pl="invite" data-uid="${esc(f.uid)}" data-name="${esc(f.name)}">Invite to a game</button>` : ""}
            <button type="button" class="pf-btn" data-pl="remove" data-uid="${esc(f.uid)}" data-name="${esc(f.name)}" aria-label="${f.status === "sent" ? "Cancel request to" : "Remove"} ${esc(f.name)}">${f.status === "sent" ? "Cancel" : "Remove"}</button>
          </span></li>`).join("")}</ul>`
        : `<p class="pf-empty">No friends yet — find someone below, or click a player's name in a lobby or tournament.</p>`;

    return `${req}
      <div class="pl-sub"><h3>Your friends</h3>${friends}</div>
      <div class="pl-sub"><h3>Find a player</h3>
        <form class="pl-search" id="plSearchForm">
          <input id="plSearch" type="search" maxlength="40" placeholder="Username or name" autocomplete="off" aria-label="Username or name">
          <button type="submit" class="pf-btn">${st.search.busy ? "Searching…" : "Search"}</button>
        </form>${results}</div>`;
}

function ladderHtml() {
    if (st.ladderError === "denied") return `<p class="pf-empty">The ladder appears once profiles are switched on.</p>`;
    if (st.ladderError) return `<p class="pf-empty">${esc(st.ladderError)}</p>`;
    if (!st.ladderLoaded) return `<p class="pf-empty">Loading the ladder…</p>`;
    if (!st.ladder.length) return `<p class="pf-empty">Nobody is on the ladder yet — switch on "Play ranked" in your profile and play a Quick match.</p>`;
    const rows = st.ladder.map((p, i) => `
        <tr class="${st.me && p.uid === st.me.uid ? "me" : ""}">
          <td class="rank">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</td>
          <td><button type="button" class="pl-name inline" data-pl="profile" data-uid="${esc(p.uid)}" data-name="${esc(p.name)}">${avatarHtml(p.name, 26)}<span>${esc(p.name)}${st.me && p.uid === st.me.uid ? " <small>(you)</small>" : ""}</span></button></td>
          <td class="num"><b>${Number(p.ladderElo)}</b></td>
          <td class="num">${Number(p.ladderWins) || 0}–${Number(p.ladderLosses) || 0}</td>
          <td class="num muted">${Number(p.ladderPeak) || Number(p.ladderElo)}</td>
        </tr>`).join("");
    return `<div class="pl-table-wrap"><table class="pl-table">
        <thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col" class="num">Rating</th><th scope="col" class="num">W–L</th><th scope="col" class="num">Peak</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

// ── actions ──────────────────────────────────────────────────────────────────

function flash(message) {
    st.message = message;
    render();
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { st.message = ""; render(); }, 5000);
}

function failed(error, fallback) {
    if (profiles.isPermissionError(error)) { st.denied = true; render(); return; }
    flash(error && error.message ? error.message : fallback);
}

function savedClockSeconds() {
    try {
        const raw = localStorage.getItem("cc_mp_game_clock");
        const n = raw === null || raw === "" ? 18 : Number(raw);
        return Number.isFinite(n) && n > 0 ? n * 60 : 0;
    } catch { return 18 * 60; }
}

/** Make a room, invite a friend to it, and go to it (they get a red pop-up). */
export async function inviteFriend(uid, name) {
    const me = account();
    if (!me) return;
    try {
        const user = await waitForUser();
        const clock = savedClockSeconds();
        const created = await createRoom(user, {
            nickname: me.name,
            lobbyName: `${me.name} vs ${name}`.slice(0, 40),
            mode: "regular",
            settings: clock ? { clockSeconds: clock } : null
        });
        await profiles.sendInvite(me.uid, me.name, uid, created.roomCode);
        if (window.ccEnterRoom) window.ccEnterRoom(created.roomCode, "p1");
    } catch (error) {
        failed(error, "Couldn't send the invite.");
    }
}

async function onClick(event) {
    const button = event.target.closest("[data-pl]");
    if (!button || !root.contains(button)) return;
    const { uid, name, id } = button.dataset;
    switch (button.dataset.pl) {
        case "signin":
            if (window.ccAccount && window.ccAccount.requireAccount) window.ccAccount.requireAccount("Make a free account to get a profile, friends and a ladder rating.");
            break;
        case "profile":
            openProfile(uid, name, { onInvite: inviteFriend });
            break;
        case "add":
            button.disabled = true;
            try { await profiles.sendFriendRequest(st.me.uid, st.me.name, uid, name); flash(`Friend request sent to ${name}.`); }
            catch (error) { button.disabled = false; failed(error, "Couldn't send the request."); }
            break;
        case "accept": {
            const item = st.inbox.find(i => i.id === id);
            if (!item) return;
            button.disabled = true;
            try { await profiles.acceptFriend(st.me.uid, st.me.name, item.fromUid, item.fromName, item.id); flash(`You and ${item.fromName} are now friends.`); }
            catch (error) { button.disabled = false; failed(error, "Couldn't accept."); }
            break;
        }
        case "decline":
            try { await profiles.deleteInbox(st.me.uid, id); } catch (error) { failed(error, "Couldn't decline."); }
            break;
        case "remove":
            if (!window.confirm(`Remove ${name} from your friends?`)) return;
            try { await profiles.removeFriend(st.me.uid, uid); } catch (error) { failed(error, "Couldn't remove."); }
            break;
        case "invite":
            button.disabled = true;
            button.textContent = "Inviting…";
            await inviteFriend(uid, name);
            break;
    }
}

async function onSubmit(event) {
    if (event.target.id !== "plSearchForm") return;
    event.preventDefault();
    const text = (root.querySelector("#plSearch")?.value || "").trim();
    st.search = { text, results: st.search.results, busy: true };
    render();
    try {
        st.search.results = text.length < 2 ? [] : await profiles.searchPlayers(text);
    } catch (error) {
        st.search.results = [];
        failed(error, "Couldn't search right now.");
    } finally {
        st.search.busy = false;
        render();
    }
}

async function onChange(event) {
    if (event.target.id !== "plLadderToggle" || !st.me) return;
    const on = event.target.checked;
    try {
        await profiles.setLadderOptIn(st.me.uid, st.me.name, on);
        flash(on ? "You're on the ranked ladder. Play a Quick match to start climbing." : "You've left the ladder. Your rating is kept if you come back.");
        refreshLadder();
    } catch (error) {
        event.target.checked = !on;
        failed(error, "Couldn't change that right now.");
    }
}
