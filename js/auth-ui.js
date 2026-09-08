// Account UI: the sign-in popup, the nav account chip, and a small global
// (window.ccAccount) the rest of the app reads to gate guest actions and stamp
// card ownership. Classic script so any page can include it; it dynamically
// imports the ES-module authService only when needed.
//
// Account model (per the app owner's spec):
//   - You must have an account to ADD anything new to the sim (new cards, new
//     collections). Guests can still browse, build decks and play.
//   - The popup appears on load until you sign in or pick "Play as guest"
//     (remembered so it doesn't nag every visit).
(function () {
    "use strict";

    const GUEST_ACK_KEY = "cc_guest_ack";

    // Capture this script's URL NOW (document.currentScript is only valid during
    // initial execution) so the later dynamic import() resolves against it.
    const SCRIPT_URL = (document.currentScript && document.currentScript.src) || "";

    // Public state other scripts read. `user` is {uid,displayName,...} or null.
    const ccAccount = {
        user: null,
        ready: false,
        isSignedIn() { return Boolean(this.user); },
        uid() { return this.user ? this.user.uid : ""; },
        // Gate a "create new content" action. Returns true if allowed; otherwise
        // shows the sign-in popup with a reason and returns false.
        requireAccount(reason) {
            if (this.isSignedIn()) return true;
            openPopup(reason || "Make a free account to add new cards and collections.");
            return false;
        }
    };
    window.ccAccount = ccAccount;

    let servicePromise = null;
    function service() {
        if (!servicePromise) {
            // Cache-bust with the app version so a deploy pulls the new module.
            const v = (window.APP_VERSION ? `?v=${window.APP_VERSION}` : "");
            // Resolve the module URL against THIS script's URL so it works from
            // any page depth (index.html at root, html/*.html one level down).
            const moduleUrl = SCRIPT_URL
                ? new URL(`firebase/authService.js${v}`, SCRIPT_URL).href
                : `js/firebase/authService.js${v}`;
            servicePromise = import(moduleUrl);
        }
        return servicePromise;
    }

    // ── Styles (injected so this works on any page) ──────────────────────────
    function injectStyles() {
        if (document.getElementById("cc-auth-styles")) return;
        const css = `
        .cc-auth-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(6,8,12,.72);backdrop-filter:blur(3px);padding:16px;}
        .cc-auth-modal{width:min(420px,100%);background:#12151c;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.6);padding:22px 22px 18px;color:#eef1f6;font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}
        .cc-auth-modal h2{margin:0 0 4px;font-size:1.35rem;}
        .cc-auth-sub{margin:0 0 16px;color:#9aa3b2;font-size:.9rem;}
        .cc-auth-btn{width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;font-weight:700;cursor:pointer;font-size:.95rem;display:flex;align-items:center;justify-content:center;gap:9px;}
        .cc-auth-btn:hover{background:rgba(255,255,255,.12);}
        .cc-auth-btn.google{background:#fff;color:#1a1a1a;border-color:#fff;}
        .cc-auth-btn.primary{background:#d33;border-color:#d33;}
        .cc-auth-btn.primary:hover{background:#e64545;}
        .cc-auth-or{display:flex;align-items:center;gap:10px;color:#6b7482;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;margin:14px 0;}
        .cc-auth-or::before,.cc-auth-or::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.12);}
        .cc-auth-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
        .cc-auth-field label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a1;}
        .cc-auth-field input{padding:10px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font-size:.95rem;}
        .cc-auth-toggle{margin-top:12px;text-align:center;font-size:.85rem;color:#9aa3b2;}
        .cc-auth-toggle button{background:none;border:none;color:#5aa2ff;cursor:pointer;font-weight:700;padding:0;font-size:.85rem;}
        .cc-auth-guest{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.1);}
        .cc-auth-guest .warn{color:#e6b64c;font-size:.8rem;margin:0 0 8px;line-height:1.35;}
        .cc-auth-guest .cc-auth-btn{background:transparent;border-style:dashed;color:#c3cad6;}
        .cc-auth-error{color:#ff8a8a;font-size:.82rem;margin:2px 0 8px;min-height:1em;}
        .cc-auth-close{position:absolute;top:12px;right:14px;background:none;border:none;color:#8b93a1;font-size:1.2rem;cursor:pointer;}
        .cc-account-chip{display:inline-flex;align-items:center;gap:8px;font:600 13px system-ui,sans-serif;color:#dfe4ec;}
        .cc-account-chip .name{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .cc-account-chip button{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#dfe4ec;border-radius:8px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;}
        .cc-account-chip button:hover{background:rgba(255,255,255,.16);}
        .cc-account-chip .avatar{width:24px;height:24px;border-radius:50%;background:#3a4a6a;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;overflow:hidden;}
        .cc-account-chip .avatar img{width:100%;height:100%;object-fit:cover;}
        `;
        const style = document.createElement("style");
        style.id = "cc-auth-styles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ── Popup ────────────────────────────────────────────────────────────────
    let overlayEl = null;
    let mode = "login"; // "login" | "signup"

    function openPopup(reasonText) {
        injectStyles();
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
        const overlay = document.createElement("div");
        overlay.className = "cc-auth-overlay";
        overlay.innerHTML = `
          <div class="cc-auth-modal" role="dialog" aria-modal="true" style="position:relative">
            <button class="cc-auth-close" aria-label="Close">✕</button>
            <h2>Welcome</h2>
            <p class="cc-auth-sub">${escapeHtml(reasonText || "Sign in to save your decks, settings and the cards you make — and to own your cards.")}</p>
            <button class="cc-auth-btn google" data-act="google">Continue with Google</button>
            <div class="cc-auth-or">or</div>
            <div class="cc-auth-error" data-err></div>
            <div class="cc-auth-field"><label>Username</label><input data-f="username" autocomplete="username" maxlength="20" placeholder="3–20 letters/numbers"></div>
            <div class="cc-auth-field"><label>Password</label><input data-f="password" type="password" autocomplete="current-password" placeholder="At least 6 characters"></div>
            <button class="cc-auth-btn primary" data-act="userpass"><span data-submit-label>Log in</span></button>
            <div class="cc-auth-toggle"><span data-toggle-text>New here?</span> <button data-act="toggle" data-toggle-label>Create an account</button></div>
            <div class="cc-auth-guest">
              <p class="warn">⚠ As a guest you can play and build decks, but you <strong>can't create new cards or collections</strong>, and nothing you change is saved to your account. Making an account is free.</p>
              <button class="cc-auth-btn" data-act="guest">Play as guest</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        overlayEl = overlay;
        mode = "login";
        wirePopup(overlay);
    }

    function closePopup() {
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    }

    function setMode(overlay, next) {
        mode = next;
        overlay.querySelector("[data-submit-label]").textContent = next === "signup" ? "Create account" : "Log in";
        overlay.querySelector("[data-toggle-text]").textContent = next === "signup" ? "Already have one?" : "New here?";
        overlay.querySelector("[data-toggle-label]").textContent = next === "signup" ? "Log in" : "Create an account";
        const pw = overlay.querySelector('[data-f="password"]');
        if (pw) pw.setAttribute("autocomplete", next === "signup" ? "new-password" : "current-password");
    }

    function wirePopup(overlay) {
        const errEl = overlay.querySelector("[data-err]");
        const showErr = (msg) => { errEl.textContent = msg || ""; };
        const busy = (on) => overlay.querySelectorAll("button").forEach(b => b.disabled = on);

        overlay.querySelector(".cc-auth-close").addEventListener("click", () => {
            // Closing without choosing is treated as "continue as guest for now".
            markGuest();
            closePopup();
        });
        overlay.addEventListener("click", (e) => { if (e.target === overlay) { markGuest(); closePopup(); } });

        overlay.querySelector('[data-act="toggle"]').addEventListener("click", () => {
            showErr("");
            setMode(overlay, mode === "signup" ? "login" : "signup");
        });

        overlay.querySelector('[data-act="google"]').addEventListener("click", async () => {
            showErr(""); busy(true);
            try {
                const svc = await service();
                await svc.signInWithGoogle();
                clearGuest();
                closePopup();
            } catch (e) { showErr(e.message || "Google sign-in failed."); busy(false); }
        });

        overlay.querySelector('[data-act="userpass"]').addEventListener("click", async () => {
            showErr("");
            const username = overlay.querySelector('[data-f="username"]').value.trim();
            const password = overlay.querySelector('[data-f="password"]').value;
            busy(true);
            try {
                const svc = await service();
                if (mode === "signup") await svc.signUpWithUsername(username, password);
                else await svc.signInWithUsername(username, password);
                clearGuest();
                closePopup();
            } catch (e) { showErr(e.message || "Sign-in failed."); busy(false); }
        });

        overlay.querySelector('[data-act="guest"]').addEventListener("click", () => {
            markGuest();
            closePopup();
        });

        overlay.querySelector('[data-f="password"]').addEventListener("keydown", (e) => {
            if (e.key === "Enter") overlay.querySelector('[data-act="userpass"]').click();
        });
    }

    function markGuest() { try { localStorage.setItem(GUEST_ACK_KEY, "1"); } catch (_) {} }
    function clearGuest() { try { localStorage.removeItem(GUEST_ACK_KEY); } catch (_) {} }
    function guestAcked() { try { return localStorage.getItem(GUEST_ACK_KEY) === "1"; } catch (_) { return false; } }

    // ── Nav chip ─────────────────────────────────────────────────────────────
    function renderChip() {
        const host = document.querySelector(".nav-actions");
        if (!host) return;
        host.removeAttribute("aria-hidden");
        host.innerHTML = "";
        const chip = document.createElement("div");
        chip.className = "cc-account-chip";
        if (ccAccount.isSignedIn()) {
            const u = ccAccount.user;
            const initial = (u.displayName || "P").trim().charAt(0).toUpperCase();
            const avatar = u.photoURL
                ? `<span class="avatar"><img src="${escapeHtml(u.photoURL)}" alt=""></span>`
                : `<span class="avatar">${escapeHtml(initial)}</span>`;
            chip.innerHTML = `${avatar}<span class="name">${escapeHtml(u.displayName || "Player")}</span><button data-act="signout">Sign out</button>`;
            chip.querySelector('[data-act="signout"]').addEventListener("click", async () => {
                const svc = await service();
                await svc.signOutAccount();
                markGuest(); // after signing out you're a guest until you sign back in
            });
        } else {
            chip.innerHTML = `<button data-act="signin">Sign in</button>`;
            chip.querySelector('[data-act="signin"]').addEventListener("click", () => openPopup());
        }
        host.appendChild(chip);
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ── Boot ─────────────────────────────────────────────────────────────────
    function boot() {
        injectStyles();
        service().then(svc => {
            svc.onAccountChange((account) => {
                ccAccount.user = account;
                ccAccount.ready = true;
                renderChip();
                // Let app.js refresh gated UI (e.g. card edit buttons) on change.
                document.dispatchEvent(new CustomEvent("cc-account-change", { detail: account }));
                // Show the popup once on first load for a brand-new visitor who
                // is neither signed in nor has chosen to play as a guest.
                if (!account && !guestAcked() && !overlayEl) openPopup();
            });
        }).catch(err => {
            console.warn("Account system unavailable:", err);
            ccAccount.ready = true;
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
