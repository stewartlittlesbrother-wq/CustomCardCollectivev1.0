// Playmat Studio (Settings -> Playmat). Pick a picture, crop it to the exact shape
// of your side of the board with the real zones drawn on top, adjust how it looks,
// choose how the zones sit on it, and check the computer and phone layouts.
//
// Saving renders the crop (filters baked in) at the board's shape, so the game,
// account sync and opponents keep using the one data URL in localStorage
// `custom-img-playmat-v1`, exactly as before. Display options live in
// `custom-img-playmat-style-v1`. The original picture + crop settings are kept in
// IndexedDB on this device so the playmat can be re-edited later.

const PLAYMAT_KEY = "custom-img-playmat-v1";
const STYLE_KEY = "custom-img-playmat-style-v1";

// Your side of the board, in board pixels (measured from the game's layout).
const DESKTOP = { w: 1240, h: 404 };
const PHONE = { w: 925, h: 207 };
const DESKTOP_ZONES = [
  { name: "Life", r: [10, 10, 128, 384] },
  { name: "DON!! deck", r: [146, 206, 118, 188] },
  { name: "", r: [292, 21, 118, 168], card: true }, { name: "", r: [427, 21, 118, 168], card: true },
  { name: "Characters", r: [562, 21, 118, 168], card: true },
  { name: "", r: [697, 21, 118, 168], card: true }, { name: "", r: [832, 21, 118, 168], card: true },
  { name: "Cost area (DON!!)", r: [272, 206, 698, 188] },
  { name: "Leader", r: [978, 10, 122, 188] },
  { name: "Stage", r: [1108, 10, 122, 188] },
  { name: "Deck", r: [978, 206, 122, 188] },
  { name: "Trash", r: [1108, 206, 122, 188] }
];
const PHONE_ZONES = [
  { name: "", r: [1, 1, 88, 121] }, { name: "", r: [94, 1, 88, 121] },
  { name: "Characters", r: [187, 1, 88, 121] },
  { name: "", r: [280, 1, 88, 121] }, { name: "", r: [373, 1, 88, 121] },
  { name: "Stage", r: [465, 0, 88, 123] },
  { name: "Deck", r: [558, 0, 88, 123] },
  { name: "Trash", r: [651, 0, 88, 123] },
  { name: "Life", r: [744, 0, 88, 207] },
  { name: "Leader", r: [837, 0, 88, 123] },
  { name: "Cost area (DON!!)", r: [0, 128, 739, 79] },
  { name: "DON!!", r: [837, 128, 88, 79] }
];

// Saved size: 1.5x the board, sharp on big screens but small enough to send to an
// opponent at the start of every online game.
const OUT = { w: 1860, h: 606 };
const MAX_BYTES = 900 * 1024;
const MAX_SOURCE_SIDE = 2600;

const BUILT_INS = [
  { name: "Zoro", src: "images/basic/zoro-bg.png" },
  { name: "Mihawk", src: "images/basic/mihawk-bg.png" },
  { name: "Perona", src: "images/basic/perona-bg.jpg" },
  { name: "Brook", src: "images/basic/brook-bg.png" },
  { name: "Night sea", src: "images/basic/750341.jpg.webp" },
  { name: "Bleach", src: "images/basic/golds-bleach-set.jpg" }
];

const ZONE_STYLES = [
  { id: "glass", label: "Dark glass", hint: "The normal look — cards stand out the most." },
  { id: "light", label: "Light glass", hint: "More of your playmat shows through the zones." },
  { id: "outline", label: "Outlines only", hint: "Just the zone borders — the whole picture shows." }
];
const ZONE_BG = { glass: "rgba(15, 20, 28, .42)", light: "rgba(15, 20, 28, .16)", outline: "transparent" };

const DEFAULT_LOOK = { brightness: 100, contrast: 100, saturation: 100, blur: 0, darken: 0, vignette: 0 };

// ── storage ──────────────────────────────────────────────────────────────────

export function readPlaymatStyle() {
  try {
    const raw = JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") || {};
    return { zones: ZONE_BG[raw.zones] !== undefined ? raw.zones : "glass", bothSides: Boolean(raw.bothSides) };
  } catch { return { zones: "glass", bothSides: false }; }
}

const DB_NAME = "cc-playmat-studio";
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction("state").objectStore("state").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function dbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch { /* re-editing just starts from the saved playmat */ }
}

// ── image helpers ────────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That picture couldn't be opened."));
    img.src = src;
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Keep the original picture reasonably sized (it's only stored on this device).
async function shrinkSource(dataUrl) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1 && dataUrl.length < 4 * 1024 * 1024) return { src: dataUrl, img };
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const src = canvas.toDataURL("image/webp", 0.9);
  return { src, img: await loadImage(src) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Canvas filters aren't available in every browser (older Safari): there the look
// is applied by hand - a pixel pass for brightness/contrast/colour and a
// shrink-and-stretch for blur.
const CANVAS_FILTERS = (() => {
  try { return typeof document.createElement("canvas").getContext("2d").filter === "string"; } catch { return false; }
})();

function adjustPixels(c, w, h, look) {
  const b = look.brightness / 100, k = look.contrast / 100, s = look.saturation / 100;
  if (b === 1 && k === 1 && s === 1) return;
  const data = c.getImageData(0, 0, w, h);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    let r = p[i] * b, g = p[i + 1] * b, bl = p[i + 2] * b;
    r = (r - 128) * k + 128; g = (g - 128) * k + 128; bl = (bl - 128) * k + 128;
    const grey = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    p[i] = grey + (r - grey) * s; p[i + 1] = grey + (g - grey) * s; p[i + 2] = grey + (bl - grey) * s;
  }
  c.putImageData(data, 0, 0);
}

function blurByScaling(c, w, h, amount) {
  const f = 1 / (1 + amount * 0.7);
  const tmp = document.createElement("canvas");
  tmp.width = Math.max(1, Math.round(w * f));
  tmp.height = Math.max(1, Math.round(h * f));
  const t = tmp.getContext("2d");
  t.imageSmoothingQuality = "high";
  t.drawImage(c.canvas, 0, 0, tmp.width, tmp.height);
  c.imageSmoothingQuality = "high";
  c.drawImage(tmp, 0, 0, w, h);
}

// ── the studio ───────────────────────────────────────────────────────────────

let host = null;   // { onSaved, toast, sync }

export async function openPlaymatStudio(options = {}) {
  host = options;
  document.getElementById("pmStudio")?.remove();
  injectStyles();

  const style = readPlaymatStyle();
  const st = {
    img: null, src: "", builtIn: "",
    // Crop: zoom 1 = the picture just covers the board; x/y = where the picture's
    // centre sits, as a fraction of the board (0.5 = centred).
    zoom: 1, x: 0.5, y: 0.5, rotate: 0, flip: false,
    look: { ...DEFAULT_LOOK },
    zones: style.zones, bothSides: style.bothSides,
    view: "desktop", showZones: true, dirty: false
  };

  const root = document.createElement("div");
  root.id = "pmStudio";
  root.className = "pm-overlay";
  root.innerHTML = template();
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const canvas = $("#pmCanvas");
  const ctx = canvas.getContext("2d");

  // ── drawing ────────────────────────────────────────────────────────────
  const frame = () => (st.view === "phone" ? PHONE : DESKTOP);

  // Draw the playmat (crop + look) for the DESKTOP board shape into ctx at w x h.
  function paintMat(c, w, h) {
    c.save();
    c.fillStyle = "#0b0f14";
    c.fillRect(0, 0, w, h);
    if (st.img) {
      const L = st.look;
      if (CANVAS_FILTERS) {
        c.filter = `brightness(${L.brightness}%) contrast(${L.contrast}%) saturate(${L.saturation}%)` + (L.blur ? ` blur(${(L.blur * w) / DESKTOP.w}px)` : "");
      }
      const quarter = st.rotate % 180 !== 0;
      const iw = quarter ? st.img.naturalHeight : st.img.naturalWidth;
      const ih = quarter ? st.img.naturalWidth : st.img.naturalHeight;
      const cover = Math.max(w / iw, h / ih) * st.zoom;
      c.translate(st.x * w, st.y * h);
      c.rotate((st.rotate * Math.PI) / 180);
      if (st.flip) c.scale(-1, 1);
      // Blur pulls in transparent edges; draw a touch larger to hide them.
      const pad = L.blur ? 1 + (L.blur * 4) / Math.min(w, h) : 1;
      const dw = st.img.naturalWidth * cover * pad, dh = st.img.naturalHeight * cover * pad;
      c.drawImage(st.img, -dw / 2, -dh / 2, dw, dh);
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (CANVAS_FILTERS) c.filter = "none";
      else {
        adjustPixels(c, w, h, L);
        if (L.blur) blurByScaling(c, w, h, (L.blur * w) / DESKTOP.w);
      }
      if (L.darken) { c.fillStyle = `rgba(0,0,0,${L.darken / 100})`; c.fillRect(0, 0, w, h); }
      if (L.vignette) {
        const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${(L.vignette / 100) * 0.85})`);
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
      }
    } else {
      // The board's built-in look, so "no picture" previews honestly.
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#d8e7f6"); g.addColorStop(0.36, "#7da9cb"); g.addColorStop(0.68, "#2d6399"); g.addColorStop(1, "#183d68");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    c.restore();
  }

  let matCache = null;
  function render() {
    const f = frame();
    const scale = 2;   // crisp on high-DPI screens
    canvas.width = f.w * scale;
    canvas.height = f.h * scale;
    canvas.style.aspectRatio = `${f.w} / ${f.h}`;
    // The saved picture always has the computer board's shape; phones show its
    // middle band (the phone board is wider and shorter).
    matCache = matCache || document.createElement("canvas");
    matCache.width = DESKTOP.w * scale;
    matCache.height = DESKTOP.h * scale;
    paintMat(matCache.getContext("2d"), matCache.width, matCache.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (st.view === "phone") {
      const s = canvas.width / matCache.width;
      const dh = matCache.height * s;
      ctx.drawImage(matCache, 0, (canvas.height - dh) / 2, canvas.width, dh);
    } else {
      ctx.drawImage(matCache, 0, 0);
    }
    if (st.showZones) drawZones(scale);
    root.querySelector(".pm-stage").classList.toggle("empty", !st.img);
  }

  function drawZones(scale) {
    const zones = st.view === "phone" ? PHONE_ZONES : DESKTOP_ZONES;
    const fill = ZONE_BG[st.zones];
    ctx.save();
    ctx.scale(scale, scale);
    zones.forEach((z) => {
      const [x, y, w, h] = z.r;
      roundRect(ctx, x, y, w, h, 7);
      if (fill !== "transparent") { ctx.fillStyle = fill; ctx.fill(); }
      ctx.lineWidth = st.zones === "outline" ? 1.5 : 1;
      ctx.strokeStyle = st.zones === "outline" ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.65)";
      ctx.stroke();
      if (z.name) {
        ctx.font = "700 13px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.shadowColor = "rgba(0,0,0,.8)";
        ctx.shadowBlur = 3;
        ctx.textAlign = "center";
        ctx.fillText(z.name, x + w / 2, y + Math.min(h - 8, 20));
        ctx.shadowBlur = 0;
      }
    });
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ── controls ───────────────────────────────────────────────────────────
  function syncControls() {
    $("#pmZoom").value = String(Math.round(st.zoom * 100));
    $("#pmZoomOut").textContent = `${Math.round(st.zoom * 100)}%`;
    Object.keys(DEFAULT_LOOK).forEach((k) => {
      const input = root.querySelector(`[data-look="${k}"]`);
      if (input) input.value = String(st.look[k]);
      const out = root.querySelector(`[data-look-out="${k}"]`);
      if (out) out.textContent = k === "blur" ? `${st.look[k]}px` : `${st.look[k]}%`;
    });
    root.querySelectorAll("[data-zones]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.zones === st.zones)));
    root.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === st.view)));
    root.querySelectorAll("[data-builtin]").forEach((b) => b.classList.toggle("on", Boolean(st.builtIn) && b.dataset.builtin === st.builtIn));
    $("#pmShowZones").checked = st.showZones;
    $("#pmBothSides").checked = st.bothSides;
    $("#pmZoneHint").textContent = (ZONE_STYLES.find((z) => z.id === st.zones) || ZONE_STYLES[0]).hint;
    root.querySelectorAll(".pm-needs-image").forEach((el) => { el.disabled = !st.img; });
    $("#pmSave").disabled = !st.img;
  }
  const update = () => { syncControls(); render(); };
  const touched = () => { st.dirty = true; update(); };

  async function useSource(src, builtIn = "") {
    try {
      $("#pmStatus").textContent = "Loading picture…";
      const shrunk = builtIn ? { src, img: await loadImage(src) } : await shrinkSource(src);
      st.img = shrunk.img;
      st.src = shrunk.src;
      st.builtIn = builtIn;
      st.zoom = 1; st.x = 0.5; st.y = 0.5; st.rotate = 0; st.flip = false;
      st.dirty = true;
      $("#pmStatus").textContent = "Drag the picture to move it, scroll or pinch to zoom.";
      update();
    } catch (error) {
      $("#pmStatus").textContent = error.message || "That picture couldn't be opened.";
    }
  }

  async function useFile(file) {
    if (!file || !/^image\//.test(file.type)) { $("#pmStatus").textContent = "That isn't a picture — use a PNG, JPG or WebP."; return; }
    await useSource(await readFile(file));
  }

  // Drag to move, wheel / pinch to zoom.
  const pointers = new Map();
  let pinchStart = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!st.img) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: st.zoom };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev || !st.img) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, next);
    if (pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      st.zoom = clamp(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / (pinchStart.d || 1)), 0.1, 5);
      touched();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    // Both views map the board's width to the canvas width; the phone view shows a
    // middle band of the same picture, so vertical moves scale by the desktop height.
    const shownH = st.view === "phone" ? rect.width * (DESKTOP.h / DESKTOP.w) : rect.height;
    st.x += (next.x - prev.x) / rect.width;
    st.y += (next.y - prev.y) / shownH;
    touched();
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => {
    if (!st.img) return;
    e.preventDefault();
    st.zoom = clamp(st.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 0.1, 5);
    touched();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { if (!st.img) return; st.zoom = 1; st.x = 0.5; st.y = 0.5; touched(); });

  // Drop a picture anywhere on the studio; paste one with Ctrl+V.
  root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("dropping"); });
  root.addEventListener("dragleave", (e) => { if (e.target === root) root.classList.remove("dropping"); });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("dropping");
    useFile(e.dataTransfer?.files?.[0]);
  });
  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); useFile(item.getAsFile()); }
  };
  document.addEventListener("paste", onPaste);

  $("#pmFile").addEventListener("change", (e) => { useFile(e.target.files?.[0]); e.target.value = ""; });
  $("#pmZoom").addEventListener("input", (e) => { st.zoom = clamp(Number(e.target.value) / 100, 0.1, 5); touched(); });
  root.querySelectorAll("[data-look]").forEach((input) => input.addEventListener("input", () => {
    st.look[input.dataset.look] = Number(input.value);
    touched();
  }));

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    if (b.dataset.builtin) { useSource(b.dataset.builtin, b.dataset.builtin); return; }
    if (b.dataset.zones) { st.zones = b.dataset.zones; touched(); return; }
    if (b.dataset.view) { st.view = b.dataset.view; update(); return; }
    switch (b.dataset.act) {
      case "fill": st.zoom = 1; st.x = 0.5; st.y = 0.5; touched(); break;
      case "fit": {
        // Whole picture visible (bars at the sides or top/bottom).
        if (!st.img) break;
        const quarter = st.rotate % 180 !== 0;
        const iw = quarter ? st.img.naturalHeight : st.img.naturalWidth;
        const ih = quarter ? st.img.naturalWidth : st.img.naturalHeight;
        const cover = Math.max(DESKTOP.w / iw, DESKTOP.h / ih);
        const contain = Math.min(DESKTOP.w / iw, DESKTOP.h / ih);
        st.zoom = contain / cover; st.x = 0.5; st.y = 0.5;
        touched();
        break;
      }
      case "rotate": st.rotate = (st.rotate + 90) % 360; touched(); break;
      case "flip": st.flip = !st.flip; touched(); break;
      case "reset-look": st.look = { ...DEFAULT_LOOK }; touched(); break;
      case "close": close(); break;
      case "remove": removePlaymat(); break;
      case "save": save(); break;
    }
  });
  $("#pmShowZones").addEventListener("change", (e) => { st.showZones = e.target.checked; update(); });
  $("#pmBothSides").addEventListener("change", (e) => { st.bothSides = e.target.checked; st.dirty = true; });

  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  function close(force = false) {
    if (!force && st.dirty && !window.confirm("Close without saving your playmat changes?")) return;
    document.removeEventListener("paste", onPaste);
    document.removeEventListener("keydown", onKey);
    root.remove();
  }

  function removePlaymat() {
    if (!window.confirm("Remove your playmat? The board goes back to its normal look.")) return;
    try { localStorage.setItem(PLAYMAT_KEY, ""); } catch { /* ignore */ }
    host.sync?.(PLAYMAT_KEY);
    dbSet("current", null);
    host.onSaved?.();
    host.toast?.("Playmat removed");
    close(true);
  }

  async function save() {
    if (!st.img) return;
    const button = $("#pmSave");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const out = document.createElement("canvas");
      out.width = OUT.w;
      out.height = OUT.h;
      paintMat(out.getContext("2d"), OUT.w, OUT.h);
      let data = out.toDataURL("image/webp", 0.86);
      if (!data.startsWith("data:image/webp")) data = out.toDataURL("image/jpeg", 0.86);
      for (const q of [0.76, 0.66]) {
        if (data.length <= MAX_BYTES) break;
        data = out.toDataURL(data.startsWith("data:image/webp") ? "image/webp" : "image/jpeg", q);
      }
      if (data.length > MAX_BYTES) {
        // Still big (very busy picture): save at the board's own size.
        const small = document.createElement("canvas");
        small.width = DESKTOP.w; small.height = DESKTOP.h;
        small.getContext("2d").drawImage(out, 0, 0, DESKTOP.w, DESKTOP.h);
        data = small.toDataURL("image/webp", 0.72);
      }
      localStorage.setItem(PLAYMAT_KEY, data);
      localStorage.setItem(STYLE_KEY, JSON.stringify({ zones: st.zones, bothSides: st.bothSides }));
      host.sync?.(PLAYMAT_KEY);
      host.sync?.(STYLE_KEY);
      await dbSet("current", {
        src: st.builtIn ? "" : st.src, builtIn: st.builtIn,
        zoom: st.zoom, x: st.x, y: st.y, rotate: st.rotate, flip: st.flip, look: st.look, savedFor: data.length
      });
      host.onSaved?.();
      host.toast?.("Playmat saved — it shows in your next game");
      close(true);
    } catch (error) {
      console.warn(error);
      button.disabled = false;
      button.textContent = "Save playmat";
      $("#pmStatus").textContent = /quota/i.test(String(error && (error.name || error.message)))
        ? "Your browser's storage is full — try a simpler picture, or remove some saved data."
        : "Couldn't save the playmat. Try again, or use a smaller picture.";
    }
  }

  // ── start: re-open the last design, or the current playmat ──────────────
  syncControls();
  render();
  const saved = await dbGet("current");
  const currentMat = (() => { try { return localStorage.getItem(PLAYMAT_KEY) || ""; } catch { return ""; } })();
  if (options.file) {
    await useFile(options.file);
  } else if (saved && currentMat && (saved.src || saved.builtIn) && saved.savedFor === currentMat.length) {
    try {
      st.img = await loadImage(saved.builtIn || saved.src);
      st.src = saved.src; st.builtIn = saved.builtIn || "";
      Object.assign(st, { zoom: saved.zoom, x: saved.x, y: saved.y, rotate: saved.rotate || 0, flip: Boolean(saved.flip) });
      st.look = { ...DEFAULT_LOOK, ...(saved.look || {}) };
      $("#pmStatus").textContent = "Your saved playmat — drag to move it, scroll or pinch to zoom.";
    } catch { /* fall through to the plain picture */ }
  }
  if (!st.img && currentMat.startsWith("data:image/") && !options.file) {
    // A playmat made before the studio (or on another device): start from it.
    try {
      st.img = await loadImage(currentMat);
      st.src = currentMat;
      $("#pmStatus").textContent = "Your current playmat — drag to move it, scroll or pinch to zoom.";
    } catch { /* start empty */ }
  }
  update();
}

// ── markup & styles ──────────────────────────────────────────────────────────

function slider(key, label, min, max, step = 1) {
  return `<label class="pm-slider"><span>${label}<output data-look-out="${key}"></output></span>
    <input type="range" min="${min}" max="${max}" step="${step}" data-look="${key}" class="pm-needs-image"></label>`;
}

function template() {
  return `
  <div class="pm-dialog" role="dialog" aria-modal="true" aria-labelledby="pmTitle">
    <header class="pm-head">
      <div><h2 id="pmTitle">Playmat studio</h2><p>Your side of the board. Your opponent sees it on their screen too.</p></div>
      <button type="button" class="pm-x" data-act="close" aria-label="Close">×</button>
    </header>
    <div class="pm-body">
      <section class="pm-main">
        <div class="pm-viewbar">
          <div class="pm-seg" role="group" aria-label="Preview">
            <button type="button" data-view="desktop" aria-pressed="true">Computer</button>
            <button type="button" data-view="phone" aria-pressed="false">Phone</button>
          </div>
          <label class="pm-check"><input type="checkbox" id="pmShowZones" checked> Show zones</label>
        </div>
        <div class="pm-stage">
          <canvas id="pmCanvas" aria-label="Playmat preview — drag to move the picture, scroll to zoom"></canvas>
          <div class="pm-empty"><strong>Choose a picture</strong><span>Upload one, drop it here, paste it, or pick a background on the right.</span></div>
        </div>
        <p class="pm-status" id="pmStatus" aria-live="polite">Pick a picture to start.</p>
        <div class="pm-croprow">
          <label class="pm-zoom">Zoom <input type="range" id="pmZoom" min="10" max="500" step="1" value="100" class="pm-needs-image"> <output id="pmZoomOut">100%</output></label>
          <div class="pm-btns">
            <button type="button" data-act="fill" class="pm-needs-image" title="Cover the whole board">Fill</button>
            <button type="button" data-act="fit" class="pm-needs-image" title="Show the whole picture">Fit</button>
            <button type="button" data-act="rotate" class="pm-needs-image" title="Rotate 90°">⟳ Rotate</button>
            <button type="button" data-act="flip" class="pm-needs-image" title="Mirror left to right">⇋ Flip</button>
          </div>
        </div>
      </section>
      <aside class="pm-side">
        <section>
          <h3>Picture</h3>
          <label class="pm-upload">Upload a picture<input type="file" id="pmFile" accept="image/png,image/jpeg,image/webp" hidden></label>
          <p class="pm-hint">Wide pictures work best (about 3 × 1). You can also drop or paste one.</p>
          <div class="pm-builtins">${BUILT_INS.map((b) => `<button type="button" data-builtin="${b.src}" style="background-image:url('${b.src}')" title="${b.name}"><span>${b.name}</span></button>`).join("")}</div>
        </section>
        <section>
          <h3>Look <button type="button" class="pm-link pm-needs-image" data-act="reset-look">Reset</button></h3>
          ${slider("brightness", "Brightness", 40, 160)}
          ${slider("contrast", "Contrast", 50, 160)}
          ${slider("saturation", "Colour", 0, 200)}
          ${slider("darken", "Darken", 0, 80)}
          ${slider("vignette", "Dark edges", 0, 100)}
          ${slider("blur", "Blur", 0, 12)}
        </section>
        <section>
          <h3>Zones on top</h3>
          <div class="pm-seg pm-seg-3" role="group" aria-label="Zone style">
            ${ZONE_STYLES.map((z) => `<button type="button" data-zones="${z.id}" aria-pressed="false">${z.label}</button>`).join("")}
          </div>
          <p class="pm-hint" id="pmZoneHint"></p>
          <label class="pm-check"><input type="checkbox" id="pmBothSides"> Use it on the opponent's side too in Practice</label>
        </section>
      </aside>
    </div>
    <footer class="pm-foot">
      <button type="button" class="pm-ghost danger" data-act="remove">Remove playmat</button>
      <span class="pm-grow"></span>
      <button type="button" class="pm-ghost" data-act="close">Cancel</button>
      <button type="button" class="pm-primary" id="pmSave" data-act="save">Save playmat</button>
    </footer>
  </div>`;
}

function injectStyles() {
  if (document.getElementById("pm-studio-styles")) return;
  const s = document.createElement("style");
  s.id = "pm-studio-styles";
  s.textContent = `
.pm-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(4, 6, 8, .78); backdrop-filter: blur(3px); }
.pm-overlay.dropping .pm-stage { outline: 2px dashed var(--accent-neon, #4dff9e); outline-offset: 4px; }
.pm-dialog { width: min(1180px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface, #101614); color: var(--ink, #f3f8f5); border: 1px solid var(--line, #263029); border-radius: 14px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, .6); }
.pm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--line, #263029); }
.pm-head h2 { margin: 0; font-size: 20px; }
.pm-head p { margin: 2px 0 0; color: var(--muted, #9db1a8); font-size: 13px; }
.pm-x { background: none; border: 0; color: var(--muted, #9db1a8); font-size: 26px; line-height: 1; cursor: pointer; padding: 0 4px; }
.pm-x:hover { color: #fff; }
.pm-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; padding: 16px 20px; overflow: auto; }
.pm-main { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.pm-viewbar, .pm-croprow { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.pm-stage { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid #050505;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .08), 0 12px 28px rgba(0, 0, 0, .35); background: #0b0f14; }
.pm-stage canvas { display: block; width: 100%; height: auto; cursor: grab; touch-action: none; }
.pm-stage canvas:active { cursor: grabbing; }
.pm-empty { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  text-align: center; padding: 12px; background: rgba(5, 8, 10, .55); pointer-events: none; }
.pm-stage.empty .pm-empty { display: flex; }
.pm-empty span { color: var(--muted, #9db1a8); font-size: 13px; }
.pm-status { margin: 0; color: var(--muted, #9db1a8); font-size: 12.5px; min-height: 1.3em; }
.pm-zoom { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; flex: 1 1 260px; }
.pm-zoom input { flex: 1; accent-color: var(--accent, #10b981); }
.pm-zoom output { width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted, #9db1a8); }
.pm-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.pm-btns button, .pm-seg button, .pm-ghost { font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 7px 12px; border-radius: 8px;
  background: var(--surface-2, #161d1a); color: var(--ink, #f3f8f5); border: 1px solid var(--line, #263029); }
.pm-btns button:hover:not(:disabled), .pm-seg button:hover, .pm-ghost:hover { border-color: rgba(77, 255, 158, .45); }
.pm-overlay button:disabled { opacity: .45; cursor: default; }
.pm-seg { display: inline-flex; padding: 3px; gap: 3px; background: var(--bg, #07090a); border: 1px solid var(--line, #263029); border-radius: 10px; }
.pm-seg button { border-color: transparent; background: transparent; padding: 6px 12px; }
.pm-seg button[aria-pressed="true"] { background: var(--accent-strong, #0e9f70); color: #fff; border-color: transparent; }
.pm-seg-3 { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; }
.pm-seg-3 button { padding: 6px 4px; font-size: 12px; }
.pm-check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; cursor: pointer; }
.pm-check input { accent-color: var(--accent, #10b981); width: 16px; height: 16px; }
.pm-side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.pm-side section { display: flex; flex-direction: column; gap: 8px; }
.pm-side h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent-neon, #4dff9e);
  display: flex; align-items: center; justify-content: space-between; }
.pm-link { background: none; border: 0; color: var(--muted, #9db1a8); font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; cursor: pointer; text-decoration: underline; }
.pm-upload { display: block; text-align: center; cursor: pointer; padding: 10px 12px; border-radius: 9px; font-weight: 800; font-size: 14px;
  background: var(--accent-strong, #0e9f70); color: #fff; }
.pm-upload:hover { background: var(--accent, #10b981); }
.pm-hint { margin: 0; color: var(--muted, #9db1a8); font-size: 12px; line-height: 1.4; }
.pm-builtins { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.pm-builtins button { position: relative; aspect-ratio: 3 / 2; border-radius: 8px; border: 2px solid transparent; cursor: pointer;
  background: #0b0f14 center / cover no-repeat; overflow: hidden; padding: 0; }
.pm-builtins button span { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 4px; font-size: 11px; font-weight: 700; color: #fff;
  background: linear-gradient(transparent, rgba(0, 0, 0, .8)); text-align: left; }
.pm-builtins button.on, .pm-builtins button:hover { border-color: var(--accent-neon, #4dff9e); }
.pm-slider { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.pm-slider span { display: flex; justify-content: space-between; }
.pm-slider output { color: var(--muted, #9db1a8); font-variant-numeric: tabular-nums; }
.pm-slider input { accent-color: var(--accent, #10b981); width: 100%; }
.pm-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line, #263029); flex-wrap: wrap; }
.pm-grow { flex: 1; }
.pm-ghost.danger { color: #ff9b9e; }
.pm-ghost.danger:hover { border-color: rgba(224, 85, 90, .7); }
.pm-primary { font: inherit; font-weight: 800; font-size: 14px; padding: 9px 18px; border-radius: 9px; border: 0; cursor: pointer;
  background: var(--accent-strong, #0e9f70); color: #fff; }
.pm-primary:hover:not(:disabled) { background: var(--accent, #10b981); }
@media (max-width: 820px) {
  .pm-overlay { padding: 0; align-items: stretch; }
  .pm-dialog { max-height: none; height: 100%; border-radius: 0; }
  .pm-body { grid-template-columns: minmax(0, 1fr); padding: 12px 16px; }
  .pm-head, .pm-foot { padding-left: 16px; padding-right: 16px; }
}`;
  document.head.appendChild(s);
}
