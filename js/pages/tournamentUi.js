// Small helpers shared by the tournaments page and its dialogs.

export const $ = (id) => document.getElementById(id);

export const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function fmtDate(ms) {
    return new Date(Number(ms)).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
}

export function relative(ms, now = Date.now()) {
    const diff = Number(ms) - now;
    const abs = Math.abs(diff);
    const minutes = Math.round(abs / 60000);
    let text;
    if (minutes < 1) return "now";
    if (minutes < 60) text = `${minutes} min`;
    else if (minutes < 48 * 60) { const h = Math.round(minutes / 60); text = `${h} hour${h === 1 ? "" : "s"}`; }
    else { const d = Math.round(minutes / 1440); text = `${d} day${d === 1 ? "" : "s"}`; }
    return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const pad = (n) => String(n).padStart(2, "0");
/** A <input type="datetime-local"> value for a timestamp. */
export function toLocalInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let toastTimer = null;
export function toast(message, isError = false) {
    const el = $("tnToast");
    el.textContent = message;
    el.className = "tn-toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

export function copyText(text, doneMessage = "Copied") {
    const fallback = () => {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); toast(doneMessage); } catch { toast("Couldn't copy", true); }
        area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast(doneMessage), fallback);
    } else fallback();
}

export function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeFilename = (text) => String(text || "tournament").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tournament";
