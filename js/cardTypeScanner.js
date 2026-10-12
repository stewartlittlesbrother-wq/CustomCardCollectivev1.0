// Card types scanner: reads the types line ("Human / Karakura Town",
// "Demigod/Leyndell, Royal Capital") printed under a card's name.
//
// Why the old fixed-box scan misread: card makers put that line at slightly
// different heights, it can be white-on-dark, dark-on-light, faint purple on a
// purple band, or sit on no band at all, and the card number shares its row. So:
//   1. find the card on the picture (trim page margins)
//   2. find the NAME (the biggest, boldest text line at the bottom) - the types sit
//      in the band right under it; a couple of fixed bands are kept as fall-backs
//   3. find the band's background colour and how far it stretches sideways (the
//      little pill the types are printed on), which leaves the card number out
//   4. make two clean versions of the line (contrast-stretched grey, and "distance
//      from the background colour" - which catches faint text) and read each
//   5. clean the reading (drop the card number / stray marks), split on "/", and
//      snap each part to a dictionary of types the set already uses (other cards'
//      types + "[Name] type" mentions in effect texts)
//   6. keep the best-scoring reading; its score is the confidence (0-100)

let tesseractPromise = null;
function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) {
        tesseractPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
            script.onload = () => resolve(window.Tesseract);
            script.onerror = () => { tesseractPromise = null; reject(new Error("The text reader couldn't load.")); };
            document.head.appendChild(script);
        });
    }
    return tesseractPromise;
}

// A few readers side by side, so several cards can be scanned at once (scanTypes
// calls made in parallel share them). The first one is enough to start; the
// others join in the background.
export const READERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
let readerPromise = null;
async function getReader() {
    if (!readerPromise) {
        readerPromise = (async () => {
            const Tesseract = await loadTesseract();
            const scheduler = Tesseract.createScheduler();
            const addReader = async () => {
                const worker = await Tesseract.createWorker("eng");
                await worker.setParameters({
                    tessedit_pageseg_mode: "7",   // a single line of text
                    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /,.'&!?-()",
                    preserve_interword_spaces: "1"
                });
                scheduler.addWorker(worker);
            };
            await addReader();
            for (let i = 1; i < READERS; i++) addReader().catch(() => {});
            return scheduler;
        })().catch((error) => { readerPromise = null; throw error; });
    }
    return readerPromise;
}

// ── image helpers ────────────────────────────────────────────────────────────

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const colorDist = (d, i, c) => Math.sqrt((d[i] - c[0]) ** 2 + (d[i + 1] - c[1]) ** 2 + (d[i + 2] - c[2]) ** 2);

// Card pictures can be 3000+ px wide; reading pixels of those took seconds per
// card. ~900 px still leaves the types line ~40 px tall, plenty for the reader.
const MAX_WIDTH = 900;
function toCanvas(image) {
    const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
    const scale = Math.min(1, MAX_WIDTH / iw);
    const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, w, h);
    return canvas;
}

// The card inside the picture: trim near-white page margins.
function cardBox(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const rowInk = new Array(h).fill(0), colInk = new Array(w).fill(0);
    const step = Math.max(1, Math.floor(Math.min(w, h) / 300));
    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            if (lum(d, (y * w + x) * 4) < 235) { rowInk[y]++; colInk[x]++; }
        }
    }
    const need = 3;
    const top = rowInk.findIndex(v => v > need), left = colInk.findIndex(v => v > need);
    const bottom = h - 1 - [...rowInk].reverse().findIndex(v => v > need);
    const right = w - 1 - [...colInk].reverse().findIndex(v => v > need);
    if (top < 0 || left < 0 || bottom <= top || right <= left) return { x: 0, y: 0, w, h };
    return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Per-row "edge energy" (share of neighbouring pixels with a big brightness jump). */
function rowEnergy(canvas, x0, y0, w, h, threshold) {
    const d = canvas.getContext("2d").getImageData(x0, y0, w, h).data;
    const energy = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
        let e = 0;
        for (let x = 1; x < w; x++) {
            const i = (y * w + x) * 4;
            if (Math.abs(lum(d, i) - lum(d, i - 4)) > threshold) e++;
        }
        energy[y] = e / w;
    }
    return energy;
}

function runs(on, minLength) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= on.length; i++) {
        if (i < on.length && on[i]) { if (start < 0) start = i; continue; }
        if (start >= 0) { if (i - start >= minLength) out.push([start, i]); start = -1; }
    }
    return out;
}

/** The card's name line: the biggest, boldest text line near the bottom. */
function findName(canvas, box) {
    const y0 = Math.round(box.y + box.h * 0.83), y1 = Math.round(box.y + box.h * 0.965);
    const x0 = Math.round(box.x + box.w * 0.18), x1 = Math.round(box.x + box.w * 0.82);
    const energy = rowEnergy(canvas, x0, y0, x1 - x0, y1 - y0, 40);
    const peak = Math.max(...energy);
    if (!(peak > 0.02)) return null;
    const on = energy.map(e => e > peak * 0.22);
    for (let i = 1; i < on.length - 1; i++) if (!on[i] && on[i - 1] && on[i + 1]) on[i] = true;
    const lines = runs(on, Math.max(3, Math.round(box.h * 0.008))).map(([a, b]) => {
        let sum = 0;
        for (let i = a; i < b; i++) sum += energy[i];
        return { top: y0 + a, bottom: y0 + b, height: b - a, energy: sum / (b - a) };
    });
    if (!lines.length) return null;
    // Big text has both height and density; "CHARACTER" is small, the art is sparse.
    return lines.reduce((best, l) => (l.height * Math.sqrt(l.energy) > best.height * Math.sqrt(best.energy) ? l : best));
}

/** The most common colour in a region (quantised) - the background. */
function dominantColor(d, w, h, x0 = 0, x1 = w) {
    const counts = new Map();
    for (let y = 0; y < h; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    let best = 0, bestKey = 0;
    counts.forEach((n, key) => { if (n > best) { best = n; bestKey = key; } });
    // Average the real pixels of that bucket for a true colour.
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < h; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
            if (key === bestKey) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        }
    }
    return n ? [r / n, g / n, b / n] : [255, 255, 255];
}

// Otsu threshold for values 0-255.
function otsu(values) {
    const hist = new Array(256).fill(0);
    values.forEach(v => { hist[Math.max(0, Math.min(255, Math.round(v)))]++; });
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) ** 2;
        if (between > best) { best = between; threshold = t; }
    }
    return threshold;
}

/**
 * Prepare one band (y range, card pixels) for reading. Works out the background
 * colour, trims sideways to the band the text is printed on, tightens the rows to
 * the text, and returns two cleaned images: { gray, dist, height } or null.
 */
function prepareBand(canvas, box, top, bottom) {
    const x0 = Math.round(box.x + box.w * 0.08), x1 = Math.round(box.x + box.w * 0.92);
    const w = x1 - x0, h = Math.max(4, bottom - top);
    if (top < 0 || top + h > canvas.height) return null;
    const d = canvas.getContext("2d").getImageData(x0, top, w, h).data;
    const cx0 = Math.round(w * 0.38), cx1 = Math.round(w * 0.62);
    const bg = dominantColor(d, w, h, cx0, cx1);

    // How far the background reaches left / right of the centre on the middle rows:
    // walk outwards, allowing short "text" interruptions, until a long run of other
    // colours (the pill's edge, the frame, the card number) begins.
    // Rows from top to bottom of the band, not just the middle: tight bold lettering
    // leaves no background between letters at mid-height, which used to end the
    // walk inside a word ("Goddess/Pilgrim" came out as "ss/Pilgrim"). The padding
    // above and below the text is background all the way across the pill.
    const probeRows = [0.1, 0.22, 0.35, 0.5, 0.65, 0.78, 0.9].map(f => Math.min(h - 1, Math.floor(h * f)));
    const isBg = (x) => probeRows.some(y => colorDist(d, (y * w + x) * 4, bg) < 48);
    const maxGap = Math.max(8, Math.round(h * 2));
    const walk = (dir) => {
        let x = Math.round(w / 2), last = x, gap = 0;
        while (x > 0 && x < w - 1) {
            x += dir;
            if (isBg(x)) { last = x; gap = 0; } else if (++gap > maxGap) break;
        }
        return last;
    };
    let left = walk(-1), right = walk(1);
    if (right - left < w * 0.15) { left = Math.round(w * 0.12); right = Math.round(w * 0.88); }

    // Text mask by distance from the background, then the rows that have text.
    const bw = right - left;
    const dist = new Float32Array(bw * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < bw; x++) dist[y * bw + x] = Math.min(255, colorDist(d, (y * w + left + x) * 4, bg));
    }
    const t = Math.max(40, otsu(Array.from(dist)));
    const rowInk = new Array(h).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < bw; x++) if (dist[y * bw + x] > t) rowInk[y]++;
    const inkRows = rowInk.map(n => n > bw * 0.01);
    const textRuns = runs(inkRows, 2);
    if (!textRuns.length) return null;
    // The run with the most ink is the text line.
    const [ra, rb] = textRuns.reduce((best, r) => {
        const ink = (r2) => rowInk.slice(r2[0], r2[1]).reduce((s, n) => s + n, 0);
        return ink(r) > ink(best) ? r : best;
    });
    const pad = Math.max(2, Math.round((rb - ra) * 0.3));
    const ya = Math.max(0, ra - pad), yb = Math.min(h, rb + pad);
    const textHeight = rb - ra;
    if (textHeight < 3) return null;

    // Scale so the text is ~42 px tall, which suits the reader.
    const scale = Math.max(1, Math.min(8, 42 / textHeight));
    const outW = Math.round(bw * scale), outH = Math.round((yb - ya) * scale);
    const make = (fill) => {
        const c = document.createElement("canvas");
        c.width = outW + 40;
        c.height = outH + 30;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        const tmp = document.createElement("canvas");
        tmp.width = bw;
        tmp.height = yb - ya;
        const tctx = tmp.getContext("2d");
        const img = tctx.createImageData(bw, yb - ya);
        fill(img.data);
        tctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(tmp, 0, 0, bw, yb - ya, 20, 15, outW, outH);
        return c;
    };
    // 1) distance from the background: text black, background white.
    const distImg = make((out) => {
        for (let y = ya, p = 0; y < yb; y++) {
            for (let x = 0; x < bw; x++, p += 4) {
                const v = dist[y * bw + x] > t ? 0 : 255;
                out[p] = out[p + 1] = out[p + 2] = v;
                out[p + 3] = 255;
            }
        }
    });
    // 2) contrast-stretched grey, flipped so the text is dark.
    const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    const vals = [];
    for (let y = ya; y < yb; y++) for (let x = 0; x < bw; x++) vals.push(lum(d, (y * w + left + x) * 4));
    const sorted = vals.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
    const span = Math.max(1, hi - lo);
    const flip = bgLum < 128;
    const grayImg = make((out) => {
        for (let p = 0, i = 0; i < vals.length; i++, p += 4) {
            let v = ((vals[i] - lo) / span) * 255;
            v = Math.max(0, Math.min(255, v));
            if (flip) v = 255 - v;
            out[p] = out[p + 1] = out[p + 2] = v;
            out[p + 3] = 255;
        }
    });
    return { dist: distImg, gray: grayImg, textHeight, bg };
}

// ── text clean-up & dictionary ───────────────────────────────────────────────

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}
export const similarity = (a, b) => {
    const x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
};

/**
 * The types a set already uses: other cards' types, and "[Name] type" mentions in
 * effect texts. Map(normalised -> { text, n }).
 */
export function buildVocabulary(cards) {
    const vocab = new Map();
    const add = (value, weight) => {
        const text = String(value || "").replace(/\s+/g, " ").trim();
        const key = norm(text);
        if (!key || key.length < 2 || key.length > 40) return;
        const prev = vocab.get(key);
        vocab.set(key, { text: prev ? prev.text : text, n: (prev ? prev.n : 0) + weight });
    };
    (cards || []).forEach(card => {
        String(card.type || "").split("/").forEach(part => add(part, 2));
        const effects = String(card.effects || "") + " " + String(card.trigger || "");
        const re = /[\[{]([^\]\[{}]{2,40})[\]}]\s*(?:(?:or|and|,)\s*[\[{][^\]\[{}]{2,40}[\]}]\s*)*type/gi;
        let m;
        while ((m = re.exec(effects))) {
            (m[0].match(/[\[{]([^\]\[{}]{2,40})[\]}]/g) || []).forEach(name => add(name.slice(1, -1), 1));
        }
    });
    return vocab;
}

// A token that is a number (card number "SOULS1-036", copy limit "4") rather than
// part of a type: ordinals ("3rd", "1st") and names like "Class-1A" have digits too.
// A single digit right after a word belongs to it ("Grade 1 Sorcerer", "Team 7").
const numberish = (tok, previous) => {
    const t = tok.replace(/[^A-Za-z0-9-]/g, "");
    if (/^\d{1,2}(st|nd|rd|th)$/i.test(t)) return false;
    if (/^\d$/.test(t)) return !/^[A-Za-z]{3,}$/.test(previous || "");
    return /\d{2}/.test(t) || /^\d+$/.test(t);
};

/** Clean one stretch of text into type parts (drops numbers, stray marks...). */
function cleanParts(text) {
    // Numbers end the types: keep the longest stretch of tokens without one.
    const tokens = String(text || "").replace(/[|\\]/g, "/").replace(/\//g, " / ").split(/\s+/).filter(Boolean)
        // A lone "f", "l" or "I" between two words is a "/" the reader got wrong.
        .map((tok, i, all) => (/^[flI]$/.test(tok) && i > 0 && /[A-Za-z]{2}/.test(all[i - 1]) && /^[A-Z0-9]/.test(all[i + 1] || "") ? "/" : tok));
    let bestRun = [], run = [];
    const letters = (list) => list.join("").replace(/[^A-Za-z]/g, "").length;
    tokens.concat(["00"]).forEach((tok, i, all) => {
        if (numberish(tok, all[i - 1])) { if (letters(run) > letters(bestRun)) bestRun = run; run = []; } else run.push(tok);
    });
    const joined = bestRun.join(" ")
        .replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9.)!'?]+$/g, "")
        .replace(/\s*\/\s*/g, "/");
    return joined.split("/")
        .map(p => p.replace(/\s+/g, " ").replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9.)!'?]+$/g, "").trim())
        .map(p => p.replace(/(\s+[A-Za-z]{1,2}\.?)+$/g, (m) => (/^\s+[A-Z][a-z]?$/.test(m) ? m : "")))   // stray letters at the end
        .map(p => p.replace(/^[A-Za-z]\s+[^A-Za-z0-9\s]+\s+(?=[A-Z0-9])/, "")                            // ...and at the start ("C ( The Seven...",
            .replace(/^(?:[^A-Z0-9\s]{1,3}\s+)+(?=[A-Z0-9])/, ""))                                       //    "y Demigod", "c ( Jujutsu")
        .filter(p => p.replace(/[^A-Za-z]/g, "").length >= 2 && !NOT_TYPES.has(norm(p)));
}
// Labels printed near the name that are not types.
const NOT_TYPES = new Set(["character", "leader", "event", "stage", "don", "doncard", "counter", "trigger"]);

// Big gaps separate the types from the card number / frame marks. Every chunk is a
// candidate (and the whole line, in case the gap was just wide lettering).
function candidateTexts(raw) {
    const text = String(raw || "").replace(/[ \t]+$/g, "");
    const chunks = text.split(/\s{3,}/).map(c => c.trim()).filter(Boolean);
    return chunks.length > 1 ? [text, ...chunks] : [text];
}

/** Clean a raw reading into type parts, without a dictionary (keeps the chunk with the most letters). */
export function partsFromText(raw) {
    const options = candidateTexts(raw).map(cleanParts);
    const letters = (parts) => parts.join("").replace(/[^A-Za-z]/g, "").length;
    return options.slice(1).reduce((best, parts) => (letters(parts) > letters(best) ? parts : best), options.length > 1 ? options[1] : options[0]);
}

/**
 * Snap parts to the dictionary when close enough. A few junk words at either end
 * may be dropped when what's left is a near-perfect match ("Revolutionary Army
 * van nnn", "JH Morioh"). Returns [{ text, read, score }].
 */
export function snapParts(parts, vocab, minScore = 0.75) {
    const entries = vocab && vocab.size ? [...vocab.values()] : [];
    // Numbers must match exactly: "13th Division" is not a misread "12th Division".
    const digits = (text) => (String(text).match(/\d+/g) || []).join(",");
    const bestFor = (text) => {
        let best = null, bestScore = 0;
        const wanted = digits(text);
        for (const entry of entries) {
            if (digits(entry.text) !== wanted) continue;
            const score = similarity(text, entry.text);
            if (score > bestScore || (score === bestScore && best && entry.n > best.n)) { best = entry; bestScore = score; }
        }
        return { best, score: bestScore };
    };
    // Junk: starts lower-case, or is one or two letters.
    const junk = (word) => /^[a-z]/.test(word) || word.replace(/[^A-Za-z]/g, "").length <= 2;
    return parts.map(part => {
        let { best, score } = bestFor(part);
        const words = part.split(" ");
        for (let head = 0; head <= 2; head++) {
            if (head && !junk(words[head - 1])) break;
            for (let tail = 0; tail <= 3; tail++) {
                if (tail && !junk(words[words.length - tail])) break;
                if (!head && !tail) continue;
                if (head + tail >= words.length) break;
                const shorter = bestFor(words.slice(head, words.length - tail).join(" "));
                const adjusted = shorter.score - (head + tail) * 0.02;
                if (shorter.score >= 0.9 && adjusted > score) { best = shorter.best; score = adjusted; }
            }
        }
        if (best && score >= minScore) return { text: best.text, read: part, score };
        return { text: part, read: part, score: 0 };
    });
}

function scoreParts(parts, words, vocab) {
    if (!parts.length) return { parts: [], snapped: [], score: 0, ocr: 0 };
    const snapped = snapParts(parts, vocab);
    // Reader confidence of just the words that ended up in the types.
    const inParts = norm(parts.join(" "));
    const kept = (words || []).filter(w => { const n = norm(w.text); return n.length >= 2 && inParts.includes(n); });
    const ocr = kept.length ? kept.reduce((sum, w) => sum + w.confidence, 0) / kept.length : 0;
    const letters = parts.join("").replace(/[^A-Za-z]/g, "").length;
    const oddness = parts.join("").replace(/[A-Za-z0-9 ,.'&!?()-]/g, "").length;
    const vocabShare = snapped.filter(p => p.score >= 0.75).length / snapped.length;
    const exact = snapped.every(p => p.score >= 0.92);
    let score = ocr * 0.7 + vocabShare * 25 + (exact ? 8 : 0) - oddness * 5 + Math.min(4, letters * 0.25);
    if (letters < 3) score -= 30;
    return { parts, snapped, score: Math.max(0, Math.min(100, Math.round(score))), ocr: Math.round(ocr) };
}

/** Score every way of reading the raw text and keep the best. */
function scoreReading(raw, words, vocab) {
    let best = { parts: [], snapped: [], score: 0, ocr: 0 };
    candidateTexts(raw).forEach(text => {
        const reading = scoreParts(cleanParts(text), words, vocab);
        if (reading.score > best.score) best = reading;
    });
    return best;
}

const typesKey = (reading) => reading.snapped.map(p => norm(p.text)).join("/");

/**
 * Pick the best of a card's readings ([{ raw, words }]) against a dictionary.
 * Two separate readings (another spot, or the other clean-up) that agree letter
 * for letter back each other up, which matters most when a set has no dictionary.
 */
function judge(readings, vocab) {
    const scored = readings.map(r => ({ ...scoreReading(r.raw, r.words, vocab), raw: r.raw })).filter(r => r.parts.length);
    if (!scored.length) return null;
    let best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    const agree = scored.filter(r => r !== best && typesKey(r) === typesKey(best)).length;
    if (agree) best = { ...best, agree, score: Math.min(100, best.score + AGREE_BONUS) };
    return best;
}
const AGREE_BONUS = 10;

function toResult(best, readings, extra) {
    if (!best) return { types: "", parts: [], raw: readings.length ? readings[0].raw : "", confidence: 0, ocr: 0, found: false, readings, ...extra };
    return {
        types: best.snapped.map(p => p.text).join("/"),
        parts: best.snapped,
        raw: best.raw,
        confidence: best.score,
        ocr: best.ocr,
        found: true,
        readings,
        ...extra
    };
}

/**
 * Judge a finished scan again against a (better) dictionary, without reading the
 * picture a second time. See learnVocabulary.
 */
export function rescoreTypes(scan, vocab) {
    const readings = (scan && scan.readings) || [];
    return toResult(judge(readings, vocab), readings, {});
}

/**
 * Sets with no types filled in have no dictionary to check readings against. But
 * types repeat: when several cards of a set were read with the same type, it is
 * almost certainly real. Returns the dictionary plus every type at least
 * `minCards` scans agree on (scans = results of scanTypes).
 */
export function learnVocabulary(scans, base = null, { minCards = 2, minOcr = 60 } = {}) {
    const vocab = new Map(base || []);
    const seen = new Map();
    (scans || []).forEach(scan => {
        if (!scan || !scan.found || (scan.ocr || 0) < minOcr) return;
        new Set(scan.parts.map(p => p.text)).forEach(text => {
            const key = norm(text);
            if (key.length < 3) return;
            const entry = seen.get(key) || { n: 0, spellings: new Map() };
            entry.n++;
            entry.spellings.set(text, (entry.spellings.get(text) || 0) + 1);
            seen.set(key, entry);
        });
    });
    seen.forEach((entry, key) => {
        if (entry.n < minCards || vocab.has(key)) return;
        const text = [...entry.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
        vocab.set(key, { text, n: entry.n });
    });
    return vocab;
}

// ── the scan ─────────────────────────────────────────────────────────────────

/**
 * Read a card's types from its picture.
 * Returns { types: "A/B", parts: [...], raw, confidence (0-100), ocr, found,
 *           readings (for rescoreTypes), debug? }.
 */
export async function scanTypes(image, { vocab = null, keepDebug = false, stopAt = 88 } = {}) {
    const reader = await getReader();
    const canvas = toCanvas(image);
    const box = cardBox(canvas);
    const name = findName(canvas, box);

    // Where to look: the usual spot first (right for ~80% of cards), then under the
    // name (cards that print the line higher or lower), then a bit lower.
    const bands = [[Math.round(box.y + box.h * 0.925), Math.round(box.y + box.h * 0.965)]];
    if (name) bands.push([name.bottom, Math.min(Math.round(box.y + box.h * 0.993), name.bottom + Math.round(name.height * 1.35))]);
    bands.push([Math.round(box.y + box.h * 0.938), Math.round(box.y + box.h * 0.978)]);

    let best = null;
    const readings = [], tried = [];
    const enough = () => best && (best.score >= stopAt || (best.agree && best.score >= stopAt - 8));
    for (const [top, bottom] of bands) {
        const prepared = prepareBand(canvas, box, top, bottom);
        if (!prepared) continue;
        for (const variant of ["dist", "gray"]) {
            const result = await reader.addJob("recognize", prepared[variant]);
            const raw = String(result?.data?.text || "").replace(/\n+/g, " ").trim();
            const words = (result?.data?.words || []).map(w => ({ text: w.text, confidence: Math.round(w.confidence) }));
            readings.push({ raw, words });
            if (keepDebug) tried.push({ raw, band: [top, bottom], variant, ...scoreReading(raw, words, vocab), image: prepared[variant] });
            best = judge(readings, vocab);
            if (enough()) break;
        }
        if (enough()) break;
    }
    return toResult(best, readings, keepDebug ? { debug: { box, name, tried, best } } : {});
}

export async function warmUp() { await getReader(); }
