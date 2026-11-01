import * as auth from "./auth.js";
import * as sp from "./spotify.js";
import * as store from "./store.js";
import { CONFIG } from "./config.js";
import { getBpm } from "./deezer.js";
import { findDuplicates, planReorder, planRemoval, spreadShuffle, normalize } from "./match.js";
import { $, $$, esc, fmtDuration, fmtDate, status, progress, modal, alertBox, confirmBox, promptBox, saveFile, safeFileName } from "./ui.js";
import { initImport, refreshImportTargets } from "./importer.js";

// ---------------- Zustand ----------------
export const S = {
  user: null,
  playlists: [],
  pl: null,          // Metadaten der aktuellen Playlist
  canEdit: false,
  original: [],      // Reihenfolge wie in Spotify
  ordered: [],       // aktuelle (evtl. sortierte) Reihenfolge aller Titel
  view: [],          // ordered nach Filter
  sel: new Set(),    // ausgewählte Track-Objekte
  dups: new Set(),
  sortKey: null,
  sortAsc: {},
  enrichGen: 0,
  rowOf: new Map(),
  lastClicked: null,
};

// ---------------- Allgemein ----------------
let busyDepth = 0;
export async function withBusy(fn) {
  busyDepth++;
  document.body.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    handleError(e);
  } finally {
    busyDepth--;
    if (!busyDepth) document.body.classList.remove("busy");
    progress(0, null);
  }
}

export function handleError(e) {
  console.error(e);
  if (e instanceof auth.AuthRequiredError) {
    showLogin();
    status("Bitte neu anmelden.", "err");
    return;
  }
  status(`Fehler: ${e.message || e}`, "err");
  alertBox("Fehler", e.message || String(e));
}

function showLogin() {
  $("#viewApp").hidden = true;
  $("#selBar").hidden = true;
  $("#btnBackups").hidden = true;
  $("#viewLogin").hidden = false;
  $("#userName").textContent = "";
  $("#loginRedirect").textContent = auth.getRedirectUri();
}

function showApp() {
  $("#viewLogin").hidden = true;
  $("#viewApp").hidden = false;
  $("#btnBackups").hidden = false;
}

const isOwnerOf = (p) => !!(S.user && p && p.ownerId === S.user.id);
const canEditPl = (p) => isOwnerOf(p) || !!(p && p.collaborative);

// ---------------- Playlists ----------------
async function loadPlaylists(selectId) {
  status("Lade Playlists…", "info");
  S.playlists = await sp.myPlaylists();
  renderPlaylistSelect(selectId);
  refreshImportTargets();
  status(`${S.playlists.length} Playlists geladen.`, "ok");
}

function plLabel(p) {
  const tag = isOwnerOf(p) ? "" : p.collaborative ? " [kollaborativ]" : ` [von ${p.ownerName}]`;
  const cnt = p.total != null ? ` (${p.total})` : "";
  const dupName = S.playlists.filter((x) => x.name === p.name).length > 1 ? ` · ${p.id.slice(0, 4)}` : "";
  return `${p.name}${cnt}${tag}${dupName}`;
}

function renderPlaylistSelect(selectId) {
  const sel = $("#selPlaylist");
  const own = S.playlists.filter((p) => canEditPl(p));
  const other = S.playlists.filter((p) => !canEditPl(p));
  const opt = (p) => `<option value="${esc(p.id)}">${esc(plLabel(p))}</option>`;
  sel.innerHTML =
    `<option value="">– Playlist wählen –</option>` +
    (own.length ? `<optgroup label="Eigene & kollaborative">${own.map(opt).join("")}</optgroup>` : "") +
    (other.length ? `<optgroup label="Gespeichert (nur lesbar, falls Spotify es erlaubt)">${other.map(opt).join("")}</optgroup>` : "");
  if (selectId) sel.value = selectId;
}

function hasUnsavedOrder() {
  return S.canEdit && orderChanged();
}

async function openPlaylist(id) {
  if (hasUnsavedOrder()) {
    const ok = await confirmBox("Ungespeicherte Sortierung", "Die neue Reihenfolge wurde noch nicht in Spotify gespeichert. Verwerfen?", "Verwerfen", "danger");
    if (!ok) { $("#selPlaylist").value = S.pl ? S.pl.id : ""; return; }
  }
  await withBusy(() => loadTracks(id));
}

async function loadTracks(id) {
  S.enrichGen++;
  S.sel.clear();
  S.dups.clear();
  S.sortKey = null;
  S.original = S.ordered = S.view = [];
  renderTable();
  if (!id) { S.pl = null; updateUi(); return; }

  status("Lade Playlist…", "info");
  let meta;
  try {
    meta = await sp.playlistMeta(id);
  } catch (e) {
    if (e.status === 404) throw new Error("Playlist nicht gefunden (falsche ID oder privat).");
    throw e;
  }
  S.pl = meta;
  S.canEdit = canEditPl(meta);

  let items;
  try {
    items = await sp.playlistItems(id, (n, total) => { status(`Lade Titel… ${n}/${total ?? "?"}`, "info"); progress(n, total); });
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      updateUi();
      $("#plInfo").textContent = `„${meta.name}“ von ${meta.ownerName}`;
      await alertBox(
        "Titel nicht lesbar",
        "Spotify erlaubt Apps im Development Mode seit Februar 2026 nur noch, Titel aus eigenen oder kollaborativen Playlists zu lesen.\n\n" +
          "Workaround: Playlist in der Spotify-App öffnen, alle Titel markieren (Desktop: Strg+A) und per „Zu Playlist hinzufügen“ in eine eigene Playlist kopieren. Diese kannst du hier dann bearbeiten."
      );
      status("Fremde Playlist – Titel von Spotify gesperrt.", "err");
      return;
    }
    throw e;
  }
  S.original = items;
  S.ordered = items.slice();
  applyFilter();
  updateUi();
  status(`${items.length} Titel geladen${S.canEdit ? "" : " (nur lesen)"}.`, "ok");
  enrich();
}

// ---------------- Ansicht ----------------
function getFilter() {
  const num = (id) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : null; };
  return { text: normalize($("#fText").value), bpmMin: num("#fBpmMin"), bpmMax: num("#fBpmMax"), yMin: num("#fYearMin"), yMax: num("#fYearMax") };
}

function filterActive() {
  const f = getFilter();
  return !!(f.text || f.bpmMin != null || f.bpmMax != null || f.yMin != null || f.yMax != null);
}

function applyFilter() {
  const f = getFilter();
  S.view = S.ordered.filter((t) => {
    if (f.text && !normalize(`${t.name} ${t.artist} ${t.album || ""}`).includes(f.text)) return false;
    if ((f.bpmMin != null || f.bpmMax != null) && t.bpm == null) return false;
    if (f.bpmMin != null && t.bpm < f.bpmMin) return false;
    if (f.bpmMax != null && t.bpm > f.bpmMax) return false;
    if ((f.yMin != null || f.yMax != null) && t.year == null) return false;
    if (f.yMin != null && t.year < f.yMin) return false;
    if (f.yMax != null && t.year > f.yMax) return false;
    return true;
  });
  for (const t of [...S.sel]) if (!S.view.includes(t)) S.sel.delete(t);
  renderTable();
  updateUi();
}

function orderChanged() {
  if (S.ordered.length !== S.original.length) return false;
  for (let i = 0; i < S.ordered.length; i++) if (S.ordered[i] !== S.original[i]) return true;
  return false;
}

function rowHtml(t, i) {
  const badges =
    (t.explicit ? `<span class="badge e">E</span>` : "") +
    (t.local ? `<span class="badge">lokal</span>` : "") +
    (t.type === "episode" ? `<span class="badge">Podcast</span>` : "") +
    (!t.playable && !t.local ? `<span class="badge w" title="In deinem Land nicht abspielbar">nicht verfügbar</span>` : "");
  const bpm = t.bpm != null ? t.bpm : t.bpmState === "pending" ? `<span class="bpm-pending">…</span>` : "–";
  const cls = [S.sel.has(t) ? "sel" : "", S.dups.has(t) ? "dup" : "", !t.playable && !t.local ? "na" : ""].join(" ");
  return `<tr data-i="${i}" class="${cls}">
    <td class="c-num">${i + 1}</td>
    <td><div class="t-name">${esc(t.name)}${badges}</div><div class="t-artist">${esc(t.artist)}</div></td>
    <td class="c-bpm">${bpm}</td><td class="c-year">${t.year ?? "–"}</td><td class="c-dur">${fmtDuration(t.durationMs)}</td></tr>`;
}

function renderTable() {
  const tb = $("#tbody");
  tb.innerHTML = S.view.map(rowHtml).join("");
  S.rowOf = new Map();
  [...tb.children].forEach((tr, i) => S.rowOf.set(S.view[i], tr));
  $("#emptyHint").hidden = S.view.length > 0;
  $("#emptyHint").textContent = S.pl ? (S.ordered.length ? "Keine Titel passen zum Filter." : "Keine Titel.") : "Wähle oben eine Playlist.";
}

function refreshRow(t) {
  const tr = S.rowOf.get(t);
  if (!tr) return;
  const i = +tr.dataset.i;
  const tmp = document.createElement("tbody");
  tmp.innerHTML = rowHtml(t, i);
  const nr = tmp.firstElementChild;
  tr.replaceWith(nr);
  S.rowOf.set(t, nr);
}

function updateUi() {
  const has = !!S.pl;
  $$(".needs-edit").forEach((b) => (b.disabled = !has || !S.canEdit));
  $("#btnSaveOrder").disabled = !has || !S.canEdit || !orderChanged();
  for (const id of ["#btnClone", "#btnOpen", "#btnExport", "#btnUnfollow", "#btnViewAsPlaylist", "#btnDuplicates"]) $(id).disabled = !has;
  $$("[data-sort]").forEach((b) => b.classList.toggle("active", b.dataset.sort === S.sortKey));
  if (has) {
    const owner = isOwnerOf(S.pl) ? "eigene Playlist" : S.pl.collaborative ? "kollaborativ" : `von ${S.pl.ownerName} – nur lesen`;
    const bpmKnown = S.original.filter((t) => t.bpm != null).length;
    $("#plInfo").textContent = `${S.original.length} Titel · ${owner} · BPM bekannt: ${bpmKnown}/${S.original.length}` + (orderChanged() ? " · ⚠ Reihenfolge geändert (nicht gespeichert)" : "");
  } else $("#plInfo").textContent = "";

  const n = S.sel.size;
  $("#selBar").hidden = n === 0;
  document.body.classList.toggle("has-selbar", n > 0);
  $("#selCount").textContent = `${n} ausgewählt`;
  $("#selUp").disabled = $("#selDown").disabled = !S.canEdit || n !== 1;
  $("#selRemove").disabled = !S.canEdit || n === 0;
}

// ---------------- Sortieren ----------------
const sorters = {
  bpm: (t) => t.bpm,
  year: (t) => t.year,
  name: (t) => (t.name || "").toLocaleLowerCase("de"),
  artist: (t) => (t.artist || "").toLocaleLowerCase("de"),
  added: (t) => (t.addedAt ? Date.parse(t.addedAt) : null),
};
const defaultAsc = { bpm: true, year: true, name: true, artist: true, added: false };

function sortBy(key) {
  if (!S.pl) return;
  if (key === "original") {
    S.ordered = S.original.slice();
    S.sortKey = null;
    status("Original-Reihenfolge.", "ok");
  } else if (key === "shuffle") {
    S.ordered = spreadShuffle(S.original);
    S.sortKey = "shuffle";
    status("Gemischt (kein Interpret direkt hintereinander, soweit möglich).", "ok");
  } else {
    const asc = S.sortKey === key ? !S.sortAsc[key] : defaultAsc[key];
    S.sortAsc[key] = asc;
    S.sortKey = key;
    const f = sorters[key];
    const known = S.original.filter((t) => f(t) != null);
    const missing = S.original.filter((t) => f(t) == null);
    known.sort((a, b) => {
      const x = f(a), y = f(b);
      const c = typeof x === "string" ? x.localeCompare(y, "de") : x - y;
      return asc ? c : -c;
    });
    S.ordered = known.concat(missing);
    status(`Sortiert nach ${key} ${asc ? "↑" : "↓"} (fehlende Werte am Ende).`, "ok");
  }
  applyFilter();
}

// ---------------- BPM-Anreicherung ----------------
async function enrich() {
  const gen = ++S.enrichGen;
  const todo = S.original.filter((t) => t.bpm == null && !t.local && t.type === "track");
  todo.forEach((t) => (t.bpmState = "pending"));
  renderTable();
  let done = 0, errors = 0;
  const t0 = Date.now();
  for (const t of todo) {
    if (gen !== S.enrichGen) return;
    try {
      const r = await getBpm(t);
      t.bpm = r.bpm;
      t.bpmState = "done";
    } catch (e) {
      errors++;
      t.bpmState = "error";
      if (errors === 5) console.warn("Deezer-Fehler", e);
    }
    if (gen !== S.enrichGen) return;
    done++;
    refreshRow(t);
    if (done % 10 === 0 || done === todo.length) {
      status(`BPM-Analyse ${done}/${todo.length}${errors ? ` · ${errors} Fehler` : ""}`, "info");
      progress(done, todo.length);
      updateUi();
    }
  }
  if (gen !== S.enrichGen) return;
  progress(0, null);
  updateUi();
  if (todo.length && (Date.now() - t0 > 1500 || errors)) {
    status(errors ? `BPM fertig – ${errors} Abfragen fehlgeschlagen (werden beim nächsten Laden erneut versucht).` : "BPM-Analyse fertig.", errors ? "err" : "ok");
  }
  else if (todo.length) status(`${S.original.length} Titel geladen${S.canEdit ? "" : " (nur lesen)"}.`, "ok");
  if (todo.length && S.sortKey === "bpm") { S.sortAsc.bpm = !S.sortAsc.bpm; sortBy("bpm"); }
}

// ---------------- Auswahl ----------------
function onRowClick(e) {
  const tr = e.target.closest("tr[data-i]");
  if (!tr) return;
  const i = +tr.dataset.i;
  const t = S.view[i];
  if (e.shiftKey && S.lastClicked != null) {
    const [a, b] = [Math.min(S.lastClicked, i), Math.max(S.lastClicked, i)];
    for (let k = a; k <= b; k++) S.sel.add(S.view[k]);
    renderTable();
  } else {
    if (S.sel.has(t)) S.sel.delete(t); else S.sel.add(t);
    tr.classList.toggle("sel", S.sel.has(t));
  }
  S.lastClicked = i;
  updateUi();
}

const selectedInOriginalOrder = () => S.original.filter((t) => S.sel.has(t));

// ---------------- Aktionen ----------------
async function backup(reason) {
  if (!S.pl || !S.original.length) return;
  await store.addBackup(S.pl, S.original, reason);
}

async function actPlay() {
  const t = S.view.find((x) => S.sel.has(x));
  if (!t || !t.uri) return;
  try {
    await sp.playInContext(S.pl.id, t.uri);
    status(`▶ ${t.artist} – ${t.name}`, "ok");
  } catch (e) {
    if (e instanceof auth.AuthRequiredError) return handleError(e);
    status(e.status === 404 ? "Kein aktives Spotify-Gerät – öffne Spotify…" : "Wiedergabe über API nicht möglich – öffne Spotify…", "info");
    window.open(t.id ? `https://open.spotify.com/track/${t.id}?context=spotify:playlist:${S.pl.id}` : `https://open.spotify.com/playlist/${S.pl.id}`, "_blank", "noopener");
  }
}

async function actMove(delta) {
  if (S.sel.size !== 1) return;
  if (orderChanged() || filterActive()) {
    return alertBox("Nicht möglich", "Verschieben geht nur in der Original-Reihenfolge ohne Filter. Bitte „⏪ Original“ wählen und Filter löschen – oder die Sortierung zuerst speichern.");
  }
  const t = [...S.sel][0];
  const idx = S.original.indexOf(t);
  const to = idx + delta;
  if (to < 0 || to >= S.original.length) return;
  await withBusy(async () => {
    const snap = await sp.reorder(S.pl.id, idx, delta < 0 ? to : to + 1, S.pl.snapshot);
    if (snap) S.pl.snapshot = snap;
    S.original.splice(idx, 1);
    S.original.splice(to, 0, t);
    S.ordered = S.original.slice();
    applyFilter();
    S.rowOf.get(t)?.scrollIntoView({ block: "nearest" });
    status(`Verschoben auf Position ${to + 1}.`, "ok");
  });
}

async function actRemove() {
  const sel = selectedInOriginalOrder();
  if (!sel.length) return;
  if (sel.some((t) => t.local || !t.uri)) return alertBox("Nicht möglich", "Lokale Dateien und nicht verfügbare Einträge können über die Spotify-API nicht entfernt werden. Bitte abwählen.");
  const preview = sel.slice(0, 8).map((t) => `• ${t.artist} – ${t.name}`).join("\n") + (sel.length > 8 ? `\n… und ${sel.length - 8} weitere` : "");
  if (!(await confirmBox("Titel entfernen", `${sel.length} Titel aus „${S.pl.name}“ entfernen?\n\n${preview}\n\nVorher wird automatisch ein Backup angelegt.`, "Entfernen", "danger"))) return;

  await withBusy(async () => {
    await backup(`Vor dem Entfernen von ${sel.length} Titel(n)`);
    const idx = sel.map((t) => S.original.indexOf(t));
    const plan = planRemoval(S.original, idx);
    status("Entferne Titel…", "info");
    let snap = await sp.removeAllOccurrences(S.pl.id, plan.uris, S.pl.snapshot);
    // Doppelte Vorkommen, die nicht markiert waren, wieder an ihre Position setzen
    for (let k = 0; k < plan.reinserts.length; k++) {
      const r = plan.reinserts[k];
      status(`Stelle nicht markierte Duplikate wieder her… ${k + 1}/${plan.reinserts.length}`, "info");
      snap = await sp.insertItemAt(S.pl.id, r.uri, r.position);
    }
    await loadTracks(S.pl.id);
    status(`${sel.length} Titel entfernt.` + (plan.reinserts.length ? ` ${plan.reinserts.length} nicht markierte Duplikate wurden neu eingefügt (Datum „hinzugefügt“ ist dort neu).` : ""), "ok");
  });
}

async function actSaveOrder() {
  if (!orderChanged()) return;
  let ops;
  try { ops = planReorder(S.original, S.ordered); } catch (e) { return handleError(e); }
  const hasLocal = S.original.some((t) => t.local || !t.uri);
  const minutes = Math.max(1, Math.round((ops.length * 0.35) / 60));
  const filterNote = filterActive() ? "\n\nHinweis: Der Filter blendet nur aus – gespeichert wird die Reihenfolge ALLER Titel." : "";

  let mode = "lossless";
  if (ops.length > CONFIG.REORDER_FAST_THRESHOLD && !hasLocal) {
    mode = await modal({
      title: "Reihenfolge speichern",
      html: `<p>Für „${esc(S.pl.name)}“ sind <b>${ops.length}</b> Verschiebungen nötig.</p>
        <p><b>Verlustfrei</b>: Datum „hinzugefügt“ bleibt erhalten, dauert ca. ${minutes} Min.</p>
        <p><b>Schnell</b>: Playlist wird neu geschrieben – Datum „hinzugefügt“ geht verloren.</p>${esc(filterNote)}<p class="muted small">Vorher wird ein Backup angelegt.</p>`,
      buttons: [{ label: "Abbrechen", value: null }, { label: "Schnell", value: "fast" }, { label: "Verlustfrei", value: "lossless", kind: "primary" }],
    });
    if (!mode) return;
  } else if (!(await confirmBox("Reihenfolge speichern", `Neue Reihenfolge dauerhaft in „${S.pl.name}“ übernehmen? (${ops.length} Verschiebungen, verlustfrei)${filterNote}\n\nVorher wird ein Backup angelegt.`, "Speichern"))) return;

  await withBusy(async () => {
    await backup("Vor dem Speichern einer neuen Reihenfolge");
    if (mode === "fast") {
      await sp.replaceAll(S.pl.id, S.ordered.map((t) => t.uri), (d, n) => { progress(d, n); status(`Schreibe Playlist… ${d}/${n}`, "info"); });
    } else {
      let snap = S.pl.snapshot;
      for (let k = 0; k < ops.length; k++) {
        snap = (await sp.reorder(S.pl.id, ops[k].rangeStart, ops[k].insertBefore, snap)) || snap;
        if (k % 5 === 0 || k === ops.length - 1) { progress(k + 1, ops.length); status(`Speichere Reihenfolge… ${k + 1}/${ops.length}`, "info"); }
      }
      S.pl.snapshot = snap;
    }
    S.original = S.ordered.slice();
    S.sortKey = null;
    applyFilter();
    status("Reihenfolge in Spotify gespeichert.", "ok");
  });
}

async function createFromTracks(name, tracks, description) {
  const uris = tracks.filter((t) => t.uri && !t.local && t.uri.startsWith("spotify:")).map((t) => t.uri);
  if (!uris.length) throw new Error("Keine übertragbaren Titel (lokale Dateien können nicht kopiert werden).");
  status(`Erstelle „${name}“…`, "info");
  const pl = await sp.createPlaylist(name, description, false);
  await sp.addItems(pl.id, uris, (d, n) => { progress(d, n); status(`Füge Titel hinzu… ${d}/${n}`, "info"); });
  return { pl, count: uris.length, skipped: tracks.length - uris.length };
}

async function actClone(useView = false) {
  const tracks = useView ? S.view : S.original;
  if (!tracks.length) return alertBox("Keine Titel", "Es sind keine Titel geladen.");
  const name = await promptBox(useView ? "Ansicht als neue Playlist" : "Playlist klonen", `Name der neuen Playlist (${tracks.length} Titel):`, useView ? `${S.pl.name} (Auswahl)` : `${S.pl.name} (Kopie)`);
  if (!name) return;
  await withBusy(async () => {
    const r = await createFromTracks(name, tracks, `Erstellt mit Playlist Manager aus „${S.pl.name}“.`);
    await loadPlaylists(r.pl.id);
    await loadTracks(r.pl.id);
    status(`„${name}“ mit ${r.count} Titeln erstellt${r.skipped ? ` (${r.skipped} lokale übersprungen)` : ""}.`, "ok");
  });
}

async function actEmpty() {
  if (!(await confirmBox("Playlist leeren", `ALLE ${S.original.length} Titel aus „${S.pl.name}“ entfernen?\n\nVorher wird ein Backup angelegt.`, "Leeren", "danger"))) return;
  await withBusy(async () => {
    await backup("Vor dem Leeren");
    await sp.replaceAll(S.pl.id, []);
    await loadTracks(S.pl.id);
    await loadPlaylists(S.pl.id);
    status("Playlist geleert. Wiederherstellen über 🗂 Backups.", "ok");
  });
}

async function actUnfollow() {
  const own = isOwnerOf(S.pl);
  const text = own
    ? `„${S.pl.name}“ aus deiner Bibliothek löschen?\n\nBei Spotify bedeutet das „Entfolgen“; die Playlist lässt sich ~90 Tage über spotify.com/account/recover-playlists wiederherstellen. Zusätzlich wird hier ein Backup angelegt.`
    : `„${S.pl.name}“ aus deiner Bibliothek entfernen (entfolgen)?`;
  if (!(await confirmBox(own ? "Playlist löschen" : "Entfolgen", text, own ? "Löschen" : "Entfolgen", "danger"))) return;
  await withBusy(async () => {
    if (S.original.length) await backup("Vor dem Löschen der Playlist");
    await sp.unfollowPlaylist(S.pl.id);
    S.pl = null;
    await loadTracks(null);
    await loadPlaylists();
    status("Playlist entfernt.", "ok");
  });
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function actExport() {
  const fmt = await modal({
    title: "Exportieren",
    html: `<p>„${esc(S.pl.name)}“ – ${S.view.length} Titel (aktuelle Ansicht inkl. Sortierung/Filter).</p>`,
    buttons: [{ label: "Abbrechen", value: null }, { label: "TXT", value: "txt" }, { label: "JSON-Backup", value: "json" }, { label: "CSV (Excel)", value: "csv", kind: "primary" }],
  });
  if (!fmt) return;
  const base = safeFileName(S.pl.name);
  if (fmt === "csv") {
    const head = ["Position", "Titel", "Kuenstler", "Album", "BPM", "Jahr", "Dauer", "ISRC", "Hinzugefuegt", "Spotify_URI"];
    const rows = S.view.map((t, i) => [i + 1, t.name, t.artist, t.album, t.bpm ?? "", t.year ?? "", fmtDuration(t.durationMs), t.isrc, t.addedAt ? t.addedAt.slice(0, 10) : "", t.uri]);
    const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
    await saveFile(`${base}.csv`, "text/csv;charset=utf-8", csv);
  } else if (fmt === "txt") {
    await saveFile(`${base}.txt`, "text/plain;charset=utf-8", S.view.map((t) => `${t.artist} - ${t.name}`).join("\n"));
  } else {
    const data = { app: "playlist-manager", version: 1, exportedAt: new Date().toISOString(), playlist: { id: S.pl.id, name: S.pl.name }, items: S.view.map((t) => ({ uri: t.uri, name: t.name, artist: t.artist, isrc: t.isrc, bpm: t.bpm, year: t.year, local: t.local })) };
    await saveFile(`${base}.json`, "application/json", JSON.stringify(data, null, 1));
  }
  status("Export erstellt.", "ok");
}

function actDuplicates() {
  const idx = findDuplicates(S.original);
  S.dups = new Set(idx.map((i) => S.original[i]));
  S.sel = new Set([...S.dups].filter((t) => S.view.includes(t)));
  renderTable();
  updateUi();
  status(idx.length ? `${idx.length} Duplikate gefunden und markiert (das jeweils erste Vorkommen bleibt). „Entfernen“ löscht nur die markierten.` : "Keine Duplikate gefunden.", idx.length ? "info" : "ok");
}

// ---------------- Backups ----------------
async function showBackups() {
  const list = await store.listBackups();
  const html = list.length
    ? list.map((b) => `<div class="backup-item"><b>${esc(b.playlistName)}</b> · ${b.items.length} Titel<br><span class="muted small">${fmtDate(b.ts)} – ${esc(b.reason || "")}</span>
        <div class="row wrap"><button class="btn small" data-act="new" data-id="${b.id}">Als neue Playlist</button>
        <button class="btn small" data-act="dl" data-id="${b.id}">⬇ JSON</button>
        <button class="btn small danger" data-act="del" data-id="${b.id}">Löschen</button></div></div>`).join("")
    : `<p class="muted">Noch keine Backups. Sie entstehen automatisch vor jeder Änderung (Sortieren, Entfernen, Leeren, Löschen).</p>`;
  const result = await modal({
    title: "🗂 Backups (nur auf diesem Gerät)",
    html: `<p class="muted small">Gespeichert im Browser dieses Geräts. Für dauerhafte Sicherung zusätzlich als JSON herunterladen.</p>${html}
      <div class="row"><label class="btn small file-btn">⬆ JSON-Backup importieren<input type="file" id="bkImport" accept=".json,application/json" hidden></label></div>`,
    buttons: [{ label: "Schließen", value: null }],
    onOpen: (root) => {
      root.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b) return;
        root.dispatchEvent(new CustomEvent("pick", { detail: { act: b.dataset.act, id: +b.dataset.id } }));
      });
      root.addEventListener("pick", (e) => { root.remove(); backupAction(e.detail); });
      root.querySelector("#bkImport").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        root.remove();
        try {
          const j = JSON.parse(await f.text());
          const items = (j.items || []).filter((x) => x && x.uri);
          if (!items.length) throw new Error("Keine Titel in der Datei gefunden.");
          await restoreAsNew((j.playlist && j.playlist.name) || f.name.replace(/\.json$/i, ""), items);
        } catch (err) { handleError(err); }
      });
    },
  });
  return result;
}

async function backupAction({ act, id }) {
  const b = await store.getBackup(id);
  if (!b) return;
  if (act === "dl") {
    await saveFile(`${safeFileName(b.playlistName)}_backup_${new Date(b.ts).toISOString().slice(0, 10)}.json`, "application/json",
      JSON.stringify({ app: "playlist-manager", version: 1, exportedAt: new Date(b.ts).toISOString(), playlist: { id: b.playlistId, name: b.playlistName }, items: b.items }, null, 1));
  } else if (act === "del") {
    if (await confirmBox("Backup löschen", `Backup von „${b.playlistName}“ (${fmtDate(b.ts)}) löschen?`, "Löschen", "danger")) await store.deleteBackup(id);
    showBackups();
  } else if (act === "new") {
    await restoreAsNew(b.playlistName, b.items, b.ts);
  }
}

async function restoreAsNew(name, items, ts = Date.now()) {
  const n = await promptBox("Backup wiederherstellen", "Name der neuen Playlist:", `${name} (Backup ${new Date(ts).toLocaleDateString("de-DE")})`);
  if (!n) return;
  await withBusy(async () => {
    const r = await createFromTracks(n, items, `Wiederhergestellt aus Backup vom ${fmtDate(ts)}.`);
    await loadPlaylists(r.pl.id);
    await loadTracks(r.pl.id);
    status(`Backup als „${n}“ wiederhergestellt (${r.count} Titel${r.skipped ? `, ${r.skipped} lokale übersprungen` : ""}).`, "ok");
  });
}

// ---------------- Einstellungen ----------------
async function showSettings() {
  const metaCount = await store.countMeta().catch(() => 0);
  await modal({
    title: "⚙ Einstellungen",
    html: `<label class="muted small">Spotify Client-ID</label><input id="setClientId" value="${esc(auth.getClientId())}" />
      <p class="muted small">Redirect URI für das Spotify Dashboard (exakt so eintragen):<br><code>${esc(auth.getRedirectUri())}</code></p>
      <p class="muted small">BPM-Cache: ${metaCount} Einträge</p>
      <div class="row wrap"><button class="btn small" id="setClearCache">BPM-Cache leeren</button>
      <button class="btn small danger" id="setLogout">Abmelden</button></div>
      <p class="muted small">Version ${CONFIG.APP_VERSION} · BPM-Daten: Deezer API</p>`,
    buttons: [
      { label: "Abbrechen", value: null },
      { label: "Speichern", kind: "primary", value: (root) => { auth.setClientId(root.querySelector("#setClientId").value); return true; } },
    ],
    onOpen: (root) => {
      root.querySelector("#setClearCache").onclick = async () => { await store.clearMeta(); status("BPM-Cache geleert.", "ok"); root.remove(); };
      root.querySelector("#setLogout").onclick = () => { auth.logout(); root.remove(); location.reload(); };
    },
  });
}

// ---------------- Verdrahtung ----------------
function wire() {
  $("#btnLogin").onclick = () => auth.startLogin().catch(handleError);
  $("#btnSettings").onclick = showSettings;
  $("#btnBackups").onclick = showBackups;

  $$(".tab").forEach((b) => (b.onclick = () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
    $("#tabManage").hidden = b.dataset.tab !== "manage";
    $("#tabImport").hidden = b.dataset.tab !== "import";
    $("#selBar").hidden = b.dataset.tab !== "manage" || S.sel.size === 0;
  }));

  $("#selPlaylist").onchange = (e) => openPlaylist(e.target.value);
  $("#btnReloadPlaylists").onclick = () => withBusy(() => loadPlaylists(S.pl && S.pl.id));
  $("#btnLoadUrl").onclick = async () => {
    const raw = $("#inpUrl").value.trim();
    const m = /playlist[/:]([A-Za-z0-9]{22})/.exec(raw) || /^([A-Za-z0-9]{22})$/.exec(raw);
    if (!m) return alertBox("Ungültig", "Bitte einen Spotify-Playlist-Link oder eine 22-stellige Playlist-ID einfügen.");
    $("#inpUrl").value = "";
    await openPlaylist(m[1]);
    if (S.pl && !S.playlists.some((p) => p.id === S.pl.id)) {
      S.playlists.unshift({ ...S.pl, total: S.original.length });
      renderPlaylistSelect(S.pl.id);
    } else if (S.pl) $("#selPlaylist").value = S.pl.id;
  };
  $("#btnClone").onclick = () => actClone(false);
  $("#btnViewAsPlaylist").onclick = () => actClone(true);
  $("#btnOpen").onclick = () => S.pl && window.open(`https://open.spotify.com/playlist/${S.pl.id}`, "_blank", "noopener");
  $("#btnExport").onclick = actExport;
  $("#btnEmpty").onclick = actEmpty;
  $("#btnUnfollow").onclick = actUnfollow;
  $("#btnSaveOrder").onclick = actSaveOrder;
  $("#btnDuplicates").onclick = actDuplicates;

  $$("[data-sort]").forEach((b) => (b.onclick = () => sortBy(b.dataset.sort)));
  let ft;
  for (const id of ["#fText", "#fBpmMin", "#fBpmMax", "#fYearMin", "#fYearMax"]) $(id).addEventListener("input", () => { clearTimeout(ft); ft = setTimeout(applyFilter, 200); });
  $("#btnClearFilter").onclick = () => { for (const id of ["#fText", "#fBpmMin", "#fBpmMax", "#fYearMin", "#fYearMax"]) $(id).value = ""; applyFilter(); };

  $("#tbody").addEventListener("click", onRowClick);
  $("#tbody").addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    S.sel = new Set([S.view[+tr.dataset.i]]);
    renderTable(); updateUi(); actPlay();
  });
  $("#selPlay").onclick = actPlay;
  $("#selUp").onclick = () => actMove(-1);
  $("#selDown").onclick = () => actMove(1);
  $("#selRemove").onclick = actRemove;
  $("#selAll").onclick = () => { S.sel = new Set(S.view); renderTable(); updateUi(); };
  $("#selNone").onclick = () => { S.sel.clear(); S.dups.clear(); renderTable(); updateUi(); };
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input,textarea,select") || $("#modalRoot").children.length) return;
    if (e.key === "Delete" && S.sel.size && S.canEdit) actRemove();
  });
  window.addEventListener("beforeunload", (e) => { if (hasUnsavedOrder()) { e.preventDefault(); e.returnValue = ""; } });
}

async function boot() {
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  wire();
  initImport({ S, withBusy, loadPlaylists, handleError, isOwnerOf, canEditPl });
  $("#loginRedirect").textContent = auth.getRedirectUri();

  try {
    await auth.handleRedirectCallback();
  } catch (e) {
    showLogin();
    return alertBox("Anmeldung fehlgeschlagen", e.message);
  }
  if (!auth.isLoggedIn()) return showLogin();

  showApp();
  await withBusy(async () => {
    S.user = await sp.me();
    $("#userName").textContent = S.user.display_name || S.user.id;
    await loadPlaylists();
  });
}

boot();
