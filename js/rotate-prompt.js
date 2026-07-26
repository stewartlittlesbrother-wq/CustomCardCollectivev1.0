// Shared "rotate your device" overlay for portrait phones.
// Mobile is only supported in landscape, so on a portrait touch device we
// cover the page with a prompt asking the user to rotate. Self-injects its
// own styles + markup so a single <script> include works on every page,
// regardless of which stylesheet that page uses.
(function () {
    function inject() {
        if (document.getElementById("rotateDevicePrompt")) return;

        const style = document.createElement("style");
        style.textContent = `
            #rotateDevicePrompt { display: none; }
            @media (orientation: portrait) and (max-width: 900px) and (pointer: coarse) {
                #rotateDevicePrompt {
                    display: flex;
                    position: fixed;
                    inset: 0;
                    z-index: 100000;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 16px;
                    padding: 32px;
                    text-align: center;
                    background: #0d0f12;
                    color: #f6f2ea;
                    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
                }
                #rotateDevicePrompt .rotate-icon {
                    font-size: 3rem;
                    animation: rotateHintSpin 1.8s ease-in-out infinite;
                }
                #rotateDevicePrompt h2 { margin: 0; font-size: 1.3rem; }
                #rotateDevicePrompt p {
                    margin: 0; max-width: 320px; opacity: 0.75; line-height: 1.5;
                }
            }
            @keyframes rotateHintSpin {
                0%, 100% { transform: rotate(0deg); }
                50% { transform: rotate(90deg); }
            }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement("div");
        overlay.id = "rotateDevicePrompt";
        overlay.innerHTML = `
            <div class="rotate-icon">↻</div>
            <h2>Please rotate your device</h2>
            <p>This simulator is designed for landscape orientation. Turn your device sideways to continue.</p>
        `;
        document.body.appendChild(overlay);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", inject);
    } else {
        inject();
    }
})();
