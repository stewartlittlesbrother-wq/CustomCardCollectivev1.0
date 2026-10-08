// A player's profile, as a dialog (click a name on the Players tab, in a lobby or
// in a tournament) and as the "My profile" card on the Players tab. Shows the
// record, ladder rating, most-played leaders, tournament trophies and recent games,
// with Add friend / Invite to a game buttons.

import * as profiles from "./firebase/profileService.js?v=1";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hue(text) {
    let h = 0;
    for (const ch of String(text || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
}
export function avatarHtml(name, size = 48) {
    const initial = String(name || "?").trim().charAt(0).toUpperCase() || "?";
    return `<span class="pf-avatar" style="--pf-h:${hue(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px" aria-hidden="true">${esc(initial)}</span>`;
}

function ago(ms) {
    const minutes = Math.round((Date.now() - Number(ms || 0)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days < 60 ? `${days} days ago` : new Date(Number(ms)).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

const placeIcon = (place) => (place === 1 ? "🥇" : place === 2 ? "🥈" : place <= 4 ? "🥉" : "🎖");

/** Leader pictures: the app (index.html) hands out card art by number. */
export function paintLeaderArt(scope) {
    scope.querySelectorAll("[data-leader-art]").forEach((box) => {
        const key = box.dataset.leaderArt;
        if (!key || box.dataset.painted || typeof window.ccCardArt !== "function") return;
        box.dataset.painted = "1";
        Promise.resolve(window.ccCardArt(key)).then((url) => {
            if (!url) return;
            const img = new Image();
            img.alt = "";
            img.loading = "lazy";
            img.src = url;
            box.appendChild(img);
        }).catch(() => {});
    });
}

/** The body of a profile (no buttons). */
export function profileBodyHtml(p, { online = null } = {}) {
    const wins = Number(p.wins) || 0, losses = Number(p.losses) || 0, games = wins + losses;
    const pct = games ? Math.round((wins / games) * 100) : 0;
    const leaders = Object.values(p.leaders || {}).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 3);
    const trophies = Object.values(p.trophies || {}).sort((a, b) => (a.place || 9) - (b.place || 9) || (b.at || 0) - (a.at || 0)).slice(0, 8);
    const recent = Object.values(p.recent || {}).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 10);
    const ladder = p.ladder && Number.isFinite(Number(p.rating));
    const since = p.since ? new Date(Number(p.since)).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";

    return `
      <div class="pf-top">
        ${avatarHtml(p.name, 56)}
        <div class="pf-who">
          <strong class="pf-name">${esc(p.name)}</strong>
          <span class="pf-sub">${online === true ? `<span class="pf-online">● Online</span> · ` : ""}${since ? `Playing since ${esc(since)}` : ""}</span>
        </div>
      </div>
      <div class="pf-stats">
        <div><b>${wins}–${losses}</b><span>Online record${games ? ` · ${pct}% wins` : ""}</span></div>
        <div><b>${ladder ? Number(p.rating) : "—"}</b><span>${ladder ? `Ladder rating · ${Number(p.ladderWins) || 0}–${Number(p.ladderLosses) || 0}` : "Not on the ladder"}</span></div>
        <div><b>${Number(p.tournamentWins) || 0}</b><span>Tournament wins</span></div>
      </div>
      <section class="pf-sec"><h4>Most played leaders</h4>
        ${leaders.length ? `<div class="pf-leaders">${leaders.map(l => `
          <div class="pf-leader"><span class="pf-leader-art" data-leader-art="${esc(l.key)}"></span>
            <span><strong>${esc(l.name || l.key)}</strong><small>${Number(l.n) || 0} game${Number(l.n) === 1 ? "" : "s"}</small></span></div>`).join("")}</div>`
          : `<p class="pf-empty">No online games yet.</p>`}
      </section>
      <section class="pf-sec"><h4>Tournament trophies</h4>
        ${trophies.length ? `<ul class="pf-trophies">${trophies.map(t => `
          <li><span aria-hidden="true">${placeIcon(Number(t.place) || 9)}</span><b>${esc(t.label || "")}</b> ${esc(t.name || "Tournament")}<small>${t.players ? `${Number(t.players)} players · ` : ""}${esc(ago(t.at))}</small></li>`).join("")}</ul>`
          : `<p class="pf-empty">No top finishes yet.</p>`}
      </section>
      <section class="pf-sec"><h4>Recent games</h4>
        ${recent.length ? `<ul class="pf-recent">${recent.map(g => `
          <li><span class="pf-res ${g.won ? "w" : "l"}">${g.won ? "W" : "L"}</span>
            <span class="pf-vs"><span>vs <b>${esc(g.opp || "Opponent")}</b></span><small>${esc(g.leaderName || g.leader || "")}${g.oppLeaderName || g.oppLeader ? ` vs ${esc(g.oppLeaderName || g.oppLeader)}` : ""}${g.quick ? " · Quick match" : ""}</small></span>
            <span class="pf-when">${g.delta !== undefined ? `<b class="${g.delta >= 0 ? "up" : "down"}">${g.delta >= 0 ? "+" : ""}${Number(g.delta)}</b>` : ""}<small>${esc(ago(g.at))}</small></span></li>`).join("")}</ul>`
          : `<p class="pf-empty">No online games yet.</p>`}
      </section>`;
}

// ── the dialog ───────────────────────────────────────────────────────────────

function me() {
    const account = window.ccAccount && window.ccAccount.user;
    return account ? { uid: account.uid, name: account.displayName || "Player" } : null;
}

/**
 * Open a player's profile. `opts.onInvite(uid, name)` is called for "Invite to a
 * game" (the Players tab supplies it); without it that button isn't shown.
 */
export async function openProfile(uid, fallbackName = "", opts = {}) {
    if (!uid) return;
    injectProfileStyles();
    document.getElementById("pfDialog")?.remove();
    const root = document.createElement("div");
    root.id = "pfDialog";
    root.className = "pf-overlay";
    root.innerHTML = `<div class="pf-dialog" role="dialog" aria-modal="true" aria-label="Player profile">
        <button type="button" class="pf-x" data-pf="close" aria-label="Close">×</button>
        <div class="pf-body"><p class="pf-empty">Loading ${esc(fallbackName || "profile")}…</p></div></div>`;
    document.body.appendChild(root);
    const close = () => { document.removeEventListener("keydown", onKey); root.remove(); };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    root.addEventListener("click", (event) => {
        if (event.target === root || event.target.closest("[data-pf='close']")) close();
    });

    const body = root.querySelector(".pf-body");
    let profile = null;
    try { profile = await profiles.getProfile(uid); }
    catch (error) {
        body.innerHTML = `<p class="pf-empty">${profiles.isPermissionError(error)
            ? "Player profiles aren't switched on yet (the site's database rules need publishing)."
            : "Couldn't load this profile right now."}</p>`;
        return;
    }
    if (!profile) {
        body.innerHTML = `<div class="pf-top">${avatarHtml(fallbackName || "?", 56)}<div class="pf-who"><strong class="pf-name">${esc(fallbackName || "Player")}</strong>
            <span class="pf-sub">No profile — this player is playing as a guest (or hasn't signed in since profiles arrived).</span></div></div>`;
        return;
    }

    const self = me();
    let friend = null;
    if (self && self.uid !== uid) {
        try { friend = await profiles.getFriend(self.uid, uid); } catch { friend = null; }
    }
    let online = null;
    const stop = profiles.watchStatuses([uid], (states) => {
        const next = Boolean(states[uid] && states[uid].online);
        if (next !== online) { online = next; draw(); }
    });
    const draw = () => {
        const actions = [];
        if (self && self.uid !== uid) {
            if (friend && friend.status === "friend") {
                actions.push(`<span class="pf-tag">✓ Friends</span>`);
                if (opts.onInvite) actions.push(`<button type="button" class="pf-btn primary" data-pf="invite">Invite to a game</button>`);
            } else if (friend && friend.status === "sent") {
                actions.push(`<span class="pf-tag">Friend request sent</span>`);
            } else {
                actions.push(`<button type="button" class="pf-btn primary" data-pf="add">Add friend</button>`);
            }
        }
        body.innerHTML = profileBodyHtml(profile, { online }) + (actions.length ? `<div class="pf-actions">${actions.join("")}</div><p class="pf-msg" hidden></p>` : "");
        paintLeaderArt(body);
    };
    draw();
    root.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-pf]");
        if (!button || !self) return;
        const msg = body.querySelector(".pf-msg");
        if (button.dataset.pf === "add") {
            button.disabled = true;
            try {
                await profiles.sendFriendRequest(self.uid, self.name, uid, profile.name);
                friend = { status: "sent" };
                draw();
            } catch (error) {
                button.disabled = false;
                if (msg) { msg.hidden = false; msg.textContent = profiles.isPermissionError(error) ? "Friends aren't switched on yet." : (error.message || "Couldn't send the request."); }
            }
        } else if (button.dataset.pf === "invite" && opts.onInvite) {
            close();
            opts.onInvite(uid, profile.name);
        }
    });
    const observer = new MutationObserver(() => { if (!document.body.contains(root)) { stop(); observer.disconnect(); } });
    observer.observe(document.body, { childList: true });
}

let stylesInjected = false;
export function injectProfileStyles() {
    if (stylesInjected || document.getElementById("pf-styles")) return;
    stylesInjected = true;
    const s = document.createElement("style");
    s.id = "pf-styles";
    s.textContent = `
.pf-overlay { position: fixed; inset: 0; z-index: 9500; display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px;
  overflow-y: auto; background: rgba(4, 6, 8, .78); }
.pf-dialog { position: relative; width: min(560px, 100%); border-radius: 16px; border: 1px solid #263029; background: #101614; color: #f3f8f5;
  box-shadow: 0 30px 80px rgba(0, 0, 0, .6); font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; text-align: left; }
.pf-overlay button { font: inherit; cursor: pointer; min-height: 0; width: auto; box-shadow: none; filter: none; text-transform: none; }
.pf-overlay button:hover { filter: none; box-shadow: none; }
.pf-overlay .pf-x { position: absolute; top: 10px; right: 12px; background: none; border: 0; padding: 0 4px; color: #9db1a8; font-size: 26px; line-height: 1; }
.pf-overlay .pf-x:hover { color: #fff; }
.pf-body { padding: 20px 22px 22px; display: flex; flex-direction: column; gap: 16px; }
.pf-top { display: flex; align-items: center; gap: 14px; min-width: 0; padding-right: 26px; }
.pf-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 850; color: #fff;
  background: linear-gradient(135deg, hsl(var(--pf-h) 55% 42%), hsl(calc(var(--pf-h) + 40) 60% 30%)); box-shadow: 0 0 0 2px rgba(255, 255, 255, .12); }
.pf-who { display: flex; flex-direction: column; min-width: 0; }
.pf-name { font-size: 20px; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-sub { color: #9db1a8; font-size: 13px; }
.pf-online { color: #4dff9e; font-weight: 700; }
.pf-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.pf-stats > div { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 11px; border: 1px solid #263029; background: #0b110e; min-width: 0; }
.pf-stats b { font-size: 20px; font-variant-numeric: tabular-nums; }
.pf-stats span { color: #9db1a8; font-size: 12px; }
.pf-sec h4 { margin: 0 0 8px; font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: #4dff9e; }
.pf-empty { margin: 0; color: #8fa398; font-size: 13px; }
.pf-leaders { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.pf-leader { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px; border-radius: 10px; border: 1px solid #263029; background: #0b110e; }
.pf-leader-art { flex: none; width: 34px; aspect-ratio: 5 / 7; border-radius: 4px; overflow: hidden; background: #202a26; }
.pf-leader-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pf-leader > span:last-child { display: flex; flex-direction: column; min-width: 0; }
.pf-leader strong { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-leader small { color: #9db1a8; font-size: 11.5px; }
.pf-trophies, .pf-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pf-trophies li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; font-size: 13.5px; }
.pf-trophies b { color: #f3d58c; }
.pf-trophies small, .pf-recent small { color: #8fa398; font-size: 12px; }
.pf-recent li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1b2420; }
.pf-res { width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-weight: 850; font-size: 12px; }
.pf-res.w { background: rgba(16, 185, 129, .2); color: #4dff9e; }
.pf-res.l { background: rgba(224, 85, 90, .18); color: #ffb3b5; }
.pf-vs { display: flex; flex-direction: column; min-width: 0; }
.pf-vs b { font-weight: 750; }
.pf-vs small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-when { display: flex; flex-direction: column; align-items: flex-end; }
.pf-when b.up { color: #4dff9e; } .pf-when b.down { color: #ffb3b5; }
.pf-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pf-overlay .pf-btn, .pl-page .pf-btn { padding: 8px 14px; border-radius: 9px; border: 1px solid #263029; background: #161d1a; color: #f3f8f5; font-weight: 700; }
.pf-overlay .pf-btn.primary, .pl-page .pf-btn.primary { background: #0e9f70; border-color: transparent; color: #fff; }
.pf-overlay .pf-btn:disabled { opacity: .5; cursor: default; }
.pf-tag { padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(77, 255, 158, .4); color: #4dff9e; font-weight: 700; font-size: 13px; }
.pf-msg { margin: 0; color: #ffb3b5; font-size: 13px; }
@media (max-width: 520px) { .pf-stats, .pf-leaders { grid-template-columns: minmax(0, 1fr); } }`;
    document.head.appendChild(s);
}
