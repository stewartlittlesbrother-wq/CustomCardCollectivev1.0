// Build number, shown in the top-left of every page.
//
// Bumped by +1 on every change to this project, so you can tell at a glance
// whether the site you're looking at is the latest upload. If the number in the
// corner is lower than expected after a deploy, you're seeing a cached or older
// build - hard-refresh (Ctrl+Shift+R) or check the upload actually went through.
//
// ⬇ BUMP THIS ON EVERY CHANGE ⬇
const APP_VERSION = 130;

(function showAppVersion() {
    const paint = () => {
        const existing = document.querySelectorAll(".app-version");

        if (existing.length) {
            // Pages that place the badge themselves (index.html puts it in the
            // brand) just get the text filled in.
            existing.forEach(node => {
                node.textContent = `v${APP_VERSION}`;
                node.title = `Build ${APP_VERSION}`;
            });
            return;
        }

        // Everywhere else, pin a small badge in the top-left corner. It sits
        // above the back links (which start ~16-20px down) and ignores pointer
        // events, so it can never block anything.
        const badge = document.createElement("div");
        badge.className = "app-version app-version-floating";
        badge.textContent = `v${APP_VERSION}`;
        badge.title = `Build ${APP_VERSION}`;
        badge.style.cssText = [
            "position:fixed",
            "top:2px",
            "left:6px",
            "z-index:2147483647",
            "pointer-events:none",
            "font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace",
            "letter-spacing:.04em",
            "color:rgba(255,255,255,.5)",
            "text-shadow:0 1px 2px rgba(0,0,0,.8)"
        ].join(";");
        document.body.appendChild(badge);
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", paint);
    } else {
        paint();
    }
})();

window.APP_VERSION = APP_VERSION;

// Lock mobile zoom. Every page uses a fixed-width viewport that already scales
// the whole layout to fit the screen, so pinch / double-tap zoom just let you
// drag a half-off-screen page around - which is the "annoying to use" part.
// Android Chrome honours `user-scalable=no` in the viewport meta; iOS Safari
// ignores it, so also block its pinch gesture events here. Normal one-finger
// scrolling and taps are untouched. Loaded on every page.
(function lockZoom() {
    ["gesturestart", "gesturechange", "gestureend"].forEach(evt =>
        document.addEventListener(evt, e => e.preventDefault(), { passive: false })
    );
})();

// ── Auto-update notice ──────────────────────────────────────────────────────
// When you push new code (and bump APP_VERSION above), every tab that's already
// open on the site polls THIS file in the background, sees the higher number,
// and shows a little "new version - Refresh" banner. Refresh reloads the page
// so the browser pulls the new build. No action needed on your part beyond the
// version bump you already do.
//
// Bootstrap note: a tab only gets this behaviour once it's running a copy of
// version.js that CONTAINS it - i.e. everyone gets the auto-notice starting the
// update AFTER this one (they'll hard-refresh once for it, then it's automatic).
(function autoUpdateNotice() {
    // The absolute URL of this very script, so the poll works from any page
    // depth (index.html at root, html/*.html one level down) without guessing.
    const selfSrc = (document.currentScript && document.currentScript.src) || "";
    if (!selfSrc || typeof APP_VERSION !== "number") return;

    // The cache-bust param a refresh added is only needed to force this fresh
    // load; drop it from the address bar now so URLs stay clean and shareable.
    try {
        const here = new URL(window.location.href);
        if (here.searchParams.has("ccv")) {
            here.searchParams.delete("ccv");
            window.history.replaceState(null, "", here.toString());
        }
    } catch (_) {}

    const versionUrl = selfSrc.split("?")[0];
    const REFRESH_KEY = "cc_update_refreshed_to";   // loop guard (session-scoped)
    let shown = false;
    let timer = null;

    async function fetchLatest() {
        // Unique query + no-store defeats both the browser and the GitHub Pages
        // CDN cache, so we always read the freshly-deployed number.
        const res = await fetch(`${versionUrl}?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return null;
        const text = await res.text();
        const m = text.match(/APP_VERSION\s*=\s*(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    async function check() {
        if (shown) return;
        try {
            const latest = await fetchLatest();
            if (!latest || latest <= APP_VERSION) return;
            // If we already tried to refresh up to this version this session and
            // we're somehow still on the old one, don't nag in a loop.
            const triedUpTo = parseInt(sessionStorage.getItem(REFRESH_KEY) || "0", 10);
            if (latest <= triedUpTo) return;
            showBanner(latest);
        } catch (_) { /* offline / blocked - just try again next tick */ }
    }

    async function doRefresh(latest) {
        try { sessionStorage.setItem(REFRESH_KEY, String(latest)); } catch (_) {}
        // Clear any Cache Storage (in case a service worker ever caches assets).
        try {
            if (window.caches && caches.keys) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (_) {}
        // A plain reload can still serve the CACHED html (and its cached scripts),
        // which is why the badge didn't move. Navigating to a brand-new URL (a
        // one-off ?ccv= param) is a guaranteed cache miss, so the freshly-deployed
        // html loads - and that html points at the bumped ?v= asset URLs, so the
        // whole build actually updates. `ccv` is stripped again on the next load.
        try {
            const url = new URL(window.location.href);
            url.searchParams.set("ccv", Date.now().toString(36));
            window.location.replace(url.toString());
        } catch (_) {
            window.location.reload();
        }
    }

    function showBanner(latest) {
        if (shown) return;
        shown = true;
        if (timer) { clearInterval(timer); timer = null; }

        const bar = document.createElement("div");
        bar.setAttribute("role", "status");
        bar.style.cssText = [
            "position:fixed", "left:50%", "bottom:16px", "transform:translateX(-50%)",
            "z-index:2147483647", "display:flex", "align-items:center", "gap:10px",
            "max-width:calc(100vw - 24px)", "box-sizing:border-box",
            "padding:9px 9px 9px 15px", "border-radius:12px",
            "background:rgba(20,22,28,.97)", "color:#fff",
            "border:1px solid rgba(255,255,255,.16)",
            "box-shadow:0 10px 30px rgba(0,0,0,.5)",
            "font:600 14px/1.3 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
        ].join(";");

        const label = document.createElement("span");
        label.textContent = `New version (v${latest}) available.`;
        label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.textContent = "Refresh";
        refresh.style.cssText = [
            "flex:none", "cursor:pointer", "border:none", "border-radius:8px",
            "padding:8px 14px", "font:700 14px/1 system-ui,sans-serif",
            "background:#3b82f6", "color:#fff"
        ].join(";");
        refresh.addEventListener("click", () => doRefresh(latest));

        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.textContent = "✕";
        dismiss.style.cssText = [
            "flex:none", "cursor:pointer", "border:none", "border-radius:8px",
            "padding:8px 11px", "font:700 15px/1 system-ui,sans-serif",
            "background:transparent", "color:rgba(255,255,255,.55)"
        ].join(";");
        // Dismiss just hides it for now; a still-newer push re-triggers the check.
        dismiss.addEventListener("click", () => {
            bar.remove();
            shown = false;
            try { sessionStorage.setItem(REFRESH_KEY, String(latest)); } catch (_) {}
        });

        bar.appendChild(label);
        bar.appendChild(refresh);
        bar.appendChild(dismiss);
        (document.body || document.documentElement).appendChild(bar);
    }

    // First look ~20s in (don't compete with initial load), then every 2 min,
    // plus whenever the tab is brought back to the foreground.
    setTimeout(() => { check(); timer = setInterval(check, 120000); }, 20000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
    });
})();
