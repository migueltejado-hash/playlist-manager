// Kleine UI-Helfer: Dialoge, Status, Dateien.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

let statusTimer = null;
export function status(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.parentElement.className = "statusbar " + kind;
  clearTimeout(statusTimer);
}

export function progress(done, total) {
  const box = $("#progress");
  if (total == null || done >= total) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("#progressBar").style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
}

// Modal mit Buttons. buttons: [{label, value, kind}] -> Promise<value>
export function modal({ title, html = "", buttons = [{ label: "OK", value: true, kind: "primary" }], onOpen, dismissValue = null }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><div class="body">${html}</div>
      <div class="btns">${buttons.map((b, i) => `<button class="btn ${b.kind || ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(dismissValue); };
    back.addEventListener("click", (e) => {
      if (e.target === back) return close(dismissValue);
      const b = e.target.closest("button[data-i]");
      if (b) {
        const def = buttons[+b.dataset.i];
        const v = typeof def.value === "function" ? def.value(back) : def.value;
        if (v !== undefined) close(v);
      }
    });
    document.addEventListener("keydown", onKey);
    $("#modalRoot").appendChild(back);
    if (onOpen) onOpen(back);
    const focus = back.querySelector("input,select,button.primary");
    if (focus) setTimeout(() => focus.focus(), 30);
  });
}

export const alertBox = (title, text) => modal({ title, html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>` });

export const confirmBox = (title, text, okLabel = "OK", kind = "primary") =>
  modal({
    title,
    html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>`,
    buttons: [{ label: "Abbrechen", value: false }, { label: okLabel, value: true, kind }],
    dismissValue: false,
  });

export function promptBox(title, label, defaultValue = "") {
  return modal({
    title,
    html: `<label class="muted small">${esc(label)}</label><input id="promptInput" value="${esc(defaultValue)}" />`,
    buttons: [
      { label: "Abbrechen", value: null },
      { label: "OK", kind: "primary", value: (root) => root.querySelector("#promptInput").value.trim() || undefined },
    ],
    onOpen: (root) => {
      const inp = root.querySelector("#promptInput");
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && inp.value.trim()) root.querySelector("button.primary").click(); });
      setTimeout(() => inp.select(), 40);
    },
  });
}

export async function saveFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const isTouch = matchMedia("(pointer: coarse)").matches;
  if (isTouch && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function safeFileName(s) {
  return (s || "playlist").replace(/[\\/*?:"<>|]+/g, "").trim().slice(0, 80) || "playlist";
}
