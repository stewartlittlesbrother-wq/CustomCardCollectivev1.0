// Board background colour: the area around the playmat on the game board.
//
// One colour per player, saved on this device and synced to their account
// (userDataSync.js). Picked with red / green / blue sliders, a hex box or the
// browser's own colour picker. Used by the board (right-click the background,
// see setupBoardBackground in self.js) and by Settings (index.html). No colour
// saved = the built-in look.
(function () {
    const KEY = "custom-board-bg-v1";
    const DEFAULT = "#07090a";   // --sim-bg in self.css

    const clean = (value) => {
        const text = String(value || "").trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(text) ? text : "";
    };
    const toRgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const toHex = (rgb) => "#" + rgb.map(n => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, "0")).join("");

    function get() {
        try { return clean(localStorage.getItem(KEY)); } catch { return ""; }
    }

    function save(hex) {
        const value = clean(hex);
        try {
            if (value) localStorage.setItem(KEY, value);
            else localStorage.removeItem(KEY);
        } catch { /* storage blocked: the colour just won't stick */ }
        window.ccSyncPush?.(KEY);
    }

    // Paints the board page (self.css reads --custom-board-bg). Only the board calls it.
    function apply(hex = get()) {
        const root = document.documentElement;
        const value = clean(hex);
        root.classList.toggle("custom-board-bg", Boolean(value));
        if (value) root.style.setProperty("--custom-board-bg", value);
        else root.style.removeProperty("--custom-board-bg");
    }

    const STYLE = `
.bgpick input, .bgpick button { min-height: 0; }
.bgpick { display: flex; flex-direction: column; gap: 10px; min-width: 0; color: #eef6f2; font: 13px/1.3 Inter, ui-sans-serif, system-ui, sans-serif; }
.bgpick-top { display: flex; align-items: center; gap: 10px; }
.bgpick-swatch { width: 44px; height: 44px; flex: none; border-radius: 10px; border: 2px solid rgba(255,255,255,.25); box-shadow: inset 0 0 0 1px rgba(0,0,0,.4); }
.bgpick-hex { width: 92px; padding: 7px 8px; border: 1px solid #2b3a32; border-radius: 8px; background: #07090a; color: #eef6f2; font: 700 13px ui-monospace, Consolas, monospace; text-transform: lowercase; }
.bgpick-native { position: relative; display: inline-flex; align-items: center; padding: 7px 10px; border-radius: 8px; background: #1c2621; color: #eef6f2; font-weight: 700; cursor: pointer; }
.bgpick-native input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }
.bgpick-row { display: grid; grid-template-columns: 14px minmax(120px, 1fr) 58px; align-items: center; gap: 8px; }
.bgpick-row b { font-weight: 800; text-align: center; }
.bgpick-row input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 12px; margin: 0; padding: 0; border-radius: 999px; border: 1px solid rgba(255,255,255,.18); cursor: pointer; }
.bgpick-row input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 2px solid #111; box-shadow: 0 1px 4px rgba(0,0,0,.6); }
.bgpick-row input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid #111; }
.bgpick-row input[type=number] { width: 100%; box-sizing: border-box; padding: 5px 6px; border: 1px solid #2b3a32; border-radius: 7px; background: #07090a; color: #eef6f2; font: 700 13px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
.bgpick-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.bgpick-actions button { padding: 7px 12px; border: 0; border-radius: 8px; font: inherit; font-weight: 800; cursor: pointer; }
.bgpick-reset { background: #1c2621; color: #eef6f2; }
.bgpick-done { background: #10b981; color: #04120b; }
.bgpick-pop { position: fixed; z-index: 10004; width: 300px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 14px; border: 1px solid #2b3a32; border-radius: 12px; background: rgba(14, 20, 17, .98); box-shadow: 0 16px 40px rgba(0,0,0,.6); }
.bgpick-pop h3 { margin: 0; font-size: 14px; font-weight: 800; }
.board-bg-setting { flex-wrap: wrap; justify-content: space-between; cursor: default; }
.board-bg-setting > span { flex: 1 1 220px; }
.board-bg-picker { flex: 0 1 300px; min-width: min(240px, 100%); }
`;
    function addStyle() {
        if (document.getElementById("ccBoardBgStyle")) return;
        const style = document.createElement("style");
        style.id = "ccBoardBgStyle";
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    // The picker itself. onPreview(hex) fires while a slider is dragged,
    // onPick(hex) when a change is finished ("" = back to the default look).
    function createPicker({ value, onPreview, onPick, extraButtons = [] } = {}) {
        addStyle();
        let hex = clean(value) || DEFAULT;
        // Going Back to a page, the browser refills its text boxes by their ORDER,
        // after the page has set them. These boxes are added by script, so they shift
        // that order - the hex code ended up in the Deck Builder's deck name box.
        // The picker sets its own values, so keep every box out of the refill.
        const noRefill = (input) => { input.autocomplete = "off"; return input; };

        const root = document.createElement("div");
        root.className = "bgpick";

        const top = document.createElement("div");
        top.className = "bgpick-top";
        const swatch = document.createElement("div");
        swatch.className = "bgpick-swatch";
        const hexBox = noRefill(document.createElement("input"));
        hexBox.type = "text";
        hexBox.className = "bgpick-hex";
        hexBox.maxLength = 7;
        hexBox.spellcheck = false;
        hexBox.setAttribute("aria-label", "Hex colour");
        const native = document.createElement("label");
        native.className = "bgpick-native";
        native.textContent = "Pick…";
        const nativeInput = noRefill(document.createElement("input"));
        nativeInput.type = "color";
        nativeInput.setAttribute("aria-label", "Open the colour picker");
        native.appendChild(nativeInput);
        top.append(swatch, hexBox, native);
        root.appendChild(top);

        const channels = ["Red", "Green", "Blue"].map((name, i) => {
            const row = document.createElement("label");
            row.className = "bgpick-row";
            const letter = document.createElement("b");
            letter.textContent = name[0];
            const range = noRefill(document.createElement("input"));
            range.type = "range";
            range.min = "0";
            range.max = "255";
            range.setAttribute("aria-label", name);
            const number = noRefill(document.createElement("input"));
            number.type = "number";
            number.min = "0";
            number.max = "255";
            number.setAttribute("aria-label", `${name} (0-255)`);
            row.append(letter, range, number);
            root.appendChild(row);
            return { i, range, number };
        });

        const actions = document.createElement("div");
        actions.className = "bgpick-actions";
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "bgpick-reset";
        reset.textContent = "Reset to default";
        actions.append(reset, ...extraButtons);
        root.appendChild(actions);

        // Show `hex` everywhere; each slider's track shows the colours it can reach.
        function paint(skip) {
            const rgb = toRgb(hex);
            swatch.style.background = hex;
            if (skip !== hexBox) hexBox.value = hex;
            nativeInput.value = hex;
            channels.forEach(({ i, range, number }) => {
                if (skip !== range) range.value = String(rgb[i]);
                if (skip !== number) number.value = String(rgb[i]);
                const from = [...rgb]; from[i] = 0;
                const to = [...rgb]; to[i] = 255;
                range.style.background = `linear-gradient(to right, ${toHex(from)}, ${toHex(to)})`;
            });
        }
        const preview = (next, skip) => { hex = next; paint(skip); onPreview?.(hex); };
        const pick = () => onPick?.(hex);

        channels.forEach(({ i, range, number }) => {
            const fromInput = (input) => {
                const rgb = toRgb(hex);
                rgb[i] = Math.max(0, Math.min(255, parseInt(input.value, 10) || 0));
                preview(toHex(rgb), input);
            };
            range.addEventListener("input", () => fromInput(range));
            range.addEventListener("change", pick);
            number.addEventListener("input", () => { if (number.value !== "") fromInput(number); });
            number.addEventListener("change", () => { fromInput(number); paint(); pick(); });
        });
        hexBox.addEventListener("input", () => {
            const typed = clean(hexBox.value.startsWith("#") ? hexBox.value : "#" + hexBox.value);
            if (typed) preview(typed, hexBox);
        });
        hexBox.addEventListener("change", () => { paint(); pick(); });
        nativeInput.addEventListener("input", () => preview(clean(nativeInput.value) || hex));
        nativeInput.addEventListener("change", pick);
        reset.addEventListener("click", () => {
            hex = DEFAULT;
            paint();
            onPreview?.("");
            onPick?.("");
        });

        paint();
        root.setValue = (next) => { hex = clean(next) || DEFAULT; paint(); };
        return root;
    }

    // Settings page: the picker inline, saving as you go.
    function mount(container) {
        if (!container) return null;
        const picker = createPicker({ value: get(), onPick: save });
        container.replaceChildren(picker);
        document.addEventListener("cc-sync-applied", (event) => {
            if ((event.detail || []).includes(KEY)) picker.setValue(get());
        });
        return picker;
    }

    // Game board: a small floating panel at (x, y) that recolours the board live.
    function openPopover(x, y) {
        document.getElementById("boardBgPopover")?.remove();
        addStyle();
        const pop = document.createElement("div");
        pop.id = "boardBgPopover";
        pop.className = "bgpick-pop";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-label", "Background colour");

        const title = document.createElement("h3");
        title.textContent = "Background color";
        const done = document.createElement("button");
        done.type = "button";
        done.className = "bgpick-done";
        done.textContent = "Done";

        const picker = createPicker({
            value: get(),
            onPreview: (hex) => apply(hex),
            onPick: (hex) => { save(hex); apply(hex); },
            extraButtons: [done]
        });
        pop.append(title, picker);
        document.body.appendChild(pop);

        // Keep it on screen.
        const box = pop.getBoundingClientRect();
        pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
        pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;

        const close = () => {
            pop.remove();
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("keydown", onKey, true);
        };
        const outside = (event) => { if (!pop.contains(event.target)) close(); };
        const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
        // The board's own click handlers have nothing to do in here.
        ["pointerdown", "click", "contextmenu"].forEach(type =>
            pop.addEventListener(type, (event) => event.stopPropagation()));
        done.addEventListener("click", close);
        setTimeout(() => {
            document.addEventListener("pointerdown", outside, true);
            document.addEventListener("keydown", onKey, true);
        }, 0);
        return pop;
    }

    // Another tab (Settings) or the account changed it: follow along on the board.
    window.addEventListener("storage", (event) => {
        if (event.key === KEY && document.documentElement.classList.contains("cc-board-page")) apply();
    });
    document.addEventListener("cc-sync-applied", (event) => {
        if ((event.detail || []).includes(KEY) && document.documentElement.classList.contains("cc-board-page")) apply();
    });

    window.ccBoardBg = { KEY, DEFAULT, get, save, apply, createPicker, mount, openPopover };
})();
