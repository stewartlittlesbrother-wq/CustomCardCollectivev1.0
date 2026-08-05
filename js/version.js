// Build number, shown in the top-left of every page.
//
// Bumped by +1 on every change to this project, so you can tell at a glance
// whether the site you're looking at is the latest upload. If the number in the
// corner is lower than expected after a deploy, you're seeing a cached or older
// build - hard-refresh (Ctrl+Shift+R) or check the upload actually went through.
//
// ⬇ BUMP THIS ON EVERY CHANGE ⬇
const APP_VERSION = 67;

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
