// Import aus Text/CSV/Deezer mit Trefferprüfung
import * as sp from "./spotify.js";
import { parseImportText, buildQueries, rankCandidates, TRACK_URI_RE } from "./match.js";
import { deezerPlaylist, parseDeezerPlaylistId } from "./deezer.js";
import { $, esc, fmtDuration, status, progress, alertBox, confirmBox, saveFile } from "./ui.js";

let ctx = null;
let rows = []; // { entry, cands: [], choice: index|-1, include: bool }

const OK = 75;
const UNSURE = 45;

export function initImport(c) {
  ctx = c;
  $("#impFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("#impText").value = await f.text();
    if (!$("#impName").value) $("#impName").value = f.name.replace(/\.(txt|csv|tsv)$/i, "");
    e.target.value = "";
  });
  $("#impClear").onclick = () => { $("#impText").value = ""; rows = []; renderRows(); };
  $("#impDeezerLoad").onclick = loadDeezer;
  $("#impMatch").onclick = () => ctx.withBusy(runMatching);
  $("#impOnlyUnsure").onchange = renderRows;
  $("#impExportMissing").onclick = exportMissing;
  $("#impRun").onclick = () => ctx.withBusy(runImport);
  for (const r of document.querySelectorAll('input[name="impTarget"]')) {
    r.onchange = () => {
      const ex = document.querySelector('input[name="impTarget"]:checked').value === "existing";
      $("#impNewFields").hidden = ex;
      $("#impExistingFields").hidden = !ex;
    };
  }
  $("#impList").addEventListener("change", (e) => {
    const i = +e.target.dataset.i;
    if (!Number.isFinite(i) || !rows[i]) return;
    if (e.target.matches("select")) { rows[i].choice = +e.target.value; rows[i].include = rows[i].choice >= 0; }
    if (e.target.matches("input[type=checkbox]")) rows[i].include = e.target.checked;
    rows[i].include = rows[i].include && rows[i].choice >= 0;
    renderRow(i);
    renderSummary();
  });
}

export function refreshImportTargets() {
  if (!ctx) return;
  const own = ctx.S.playlists.filter((p) => ctx.canEditPl(p));
  $("#impExisting").innerHTML = own.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.total != null ? ` (${p.total})` : ""}</option>`).join("");
}

// Deezer-Playlist -> Textfeld (mit ISRC als Kommentar-Hinweis intern)
let deezerEntries = null;
async function loadDeezer() {
  const id = parseDeezerPlaylistId($("#impDeezer").value);
  if (!id) return alertBox("Ungültig", "Bitte einen Deezer-Playlist-Link wie https://www.deezer.com/de/playlist/123456 einfügen.");
  await ctx.withBusy(async () => {
    status("Lade Deezer-Playlist…", "info");
    const pl = await deezerPlaylist(id, (n, t) => { progress(n, t); status(`Deezer: ${n}/${t ?? "?"} Titel`, "info"); });
    deezerEntries = pl.tracks.map((t) => ({ raw: `${t.artist} - ${t.title}`, artist: t.artist, title: t.title, uri: "", isrc: t.isrc, durationMs: t.durationMs }));
    $("#impText").value = deezerEntries.map((e) => e.raw).join("\n");
    $("#impText").dataset.source = "deezer";
    if (!$("#impName").value) $("#impName").value = pl.name;
    status(`${pl.tracks.length} Titel aus Deezer übernommen – jetzt „Treffer suchen“.`, "ok");
  });
}

async function findCandidates(entry) {
  if (entry.uri) {
    const id = TRACK_URI_RE.exec(entry.uri)[1];
    const t = await sp.api(`/tracks/${id}`, { query: { market: "from_token" } });
    const c = sp.parseEntry({ item: t }, 0);
    return [{ ...c, score: 100 }];
  }
  let all = [];
  for (const q of buildQueries(entry)) {
    const res = await sp.searchTracks(q, 10);
    all = all.concat(res);
    const ranked = rankCandidates(entry, all);
    if (ranked.length && ranked[0].score >= 90) return ranked;
  }
  return rankCandidates(entry, all);
}

async function runMatching() {
  const text = $("#impText").value;
  let entries = parseImportText(text);
  // Deezer-Daten (ISRC, Dauer) übernehmen, solange der Text unverändert ist
  if ($("#impText").dataset.source === "deezer" && deezerEntries && deezerEntries.map((e) => e.raw).join("\n") === text.trim()) entries = deezerEntries;
  else delete $("#impText").dataset.source;
  if (!entries.length) return alertBox("Keine Einträge", "Bitte Titel einfügen (eine Zeile pro Song) oder eine Datei laden.");
  if (entries.length > 1500 && !(await confirmBox("Große Liste", `${entries.length} Einträge – die Suche dauert einige Minuten. Fortfahren?`, "Fortfahren"))) return;

  rows = [];
  $("#impReviewCard").hidden = false;
  for (let i = 0; i < entries.length; i++) {
    let cands = [];
    try { cands = await findCandidates(entries[i]); } catch (e) {
      if (e.name === "AuthRequiredError") throw e;
      console.warn("Suche fehlgeschlagen", entries[i], e);
    }
    const best = cands.length ? cands[0].score : 0;
    rows.push({ entry: entries[i], cands, choice: cands.length ? 0 : -1, include: best >= UNSURE });
    if (i % 5 === 0 || i === entries.length - 1) {
      progress(i + 1, entries.length);
      status(`Suche Treffer… ${i + 1}/${entries.length}`, "info");
      renderRows();
    }
  }
  renderRows();
  $("#impTargetCard").hidden = false;
  const s = summary();
  status(`Fertig: ${s.ok} sicher, ${s.unsure} unsicher, ${s.none} nicht gefunden.`, s.none || s.unsure ? "info" : "ok");
}

function rowClass(r) {
  const sc = r.choice >= 0 ? r.cands[r.choice].score : 0;
  return r.choice < 0 ? "none" : sc >= OK ? "ok" : sc >= UNSURE ? "unsure" : "none";
}

function rowHtml(r, i) {
  const cls = rowClass(r);
  const icon = cls === "ok" ? "✓" : cls === "unsure" ? "?" : "✗";
  const opts = r.cands.map((c, k) => `<option value="${k}" ${k === r.choice ? "selected" : ""}>${c.score}% · ${esc(c.artist)} – ${esc(c.name)} (${fmtDuration(c.durationMs)})</option>`).join("");
  return `<div class="imp-row ${cls}" data-row="${i}">
    <div class="st"><input type="checkbox" data-i="${i}" ${r.include ? "checked" : ""} ${r.cands.length ? "" : "disabled"} title="importieren"><div>${icon}</div></div>
    <div><div class="src">${esc(r.entry.raw)}</div>
    ${r.cands.length ? `<select data-i="${i}">${opts}<option value="-1" ${r.choice < 0 ? "selected" : ""}>– keinen übernehmen –</option></select>` : `<div class="small muted">Kein Treffer gefunden</div>`}</div></div>`;
}

function renderRows() {
  const only = $("#impOnlyUnsure").checked;
  $("#impList").innerHTML = rows.map((r, i) => (only && rowClass(r) === "ok" ? "" : rowHtml(r, i))).join("");
  renderSummary();
}

function renderRow(i) {
  const el = $(`#impList [data-row="${i}"]`);
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = rowHtml(rows[i], i);
  el.replaceWith(tmp.firstElementChild);
}

function summary() {
  const s = { ok: 0, unsure: 0, none: 0, selected: 0 };
  for (const r of rows) { s[rowClass(r)]++; if (r.include && r.choice >= 0) s.selected++; }
  return s;
}

function renderSummary() {
  const s = summary();
  $("#impSummary").textContent = rows.length ? `${rows.length} Einträge · ✓ ${s.ok} sicher · ? ${s.unsure} unsicher · ✗ ${s.none} nicht gefunden · ${s.selected} zum Import ausgewählt` : "";
}

async function exportMissing() {
  const miss = rows.filter((r) => !(r.include && r.choice >= 0)).map((r) => r.entry.raw);
  if (!miss.length) return alertBox("Alles gefunden", "Es gibt keine fehlenden oder abgewählten Einträge.");
  await saveFile("nicht_gefunden.txt", "text/plain;charset=utf-8", miss.join("\n"));
}

async function runImport() {
  const picked = rows.filter((r) => r.include && r.choice >= 0).map((r) => r.cands[r.choice].uri);
  if (!picked.length) return alertBox("Nichts ausgewählt", "Es ist kein Titel zum Import ausgewählt.");
  const target = document.querySelector('input[name="impTarget"]:checked').value;
  let uris = picked;
  let plId;

  if (target === "existing") {
    plId = $("#impExisting").value;
    if (!plId) return alertBox("Keine Ziel-Playlist", "Bitte eine eigene Playlist wählen.");
    if ($("#impSkipExisting").checked) {
      status("Prüfe vorhandene Titel…", "info");
      const existing = new Set((await sp.playlistItems(plId)).map((t) => t.uri));
      uris = uris.filter((u) => !existing.has(u));
    }
  } else {
    const name = $("#impName").value.trim();
    if (!name) return alertBox("Name fehlt", "Bitte einen Namen für die neue Playlist eingeben.");
    const pl = await sp.createPlaylist(name, $("#impDesc").value.trim(), $("#impPublic").checked);
    plId = pl.id;
  }
  if ($("#impSkipExisting").checked) uris = [...new Set(uris)];
  if (!uris.length) return alertBox("Nichts zu tun", "Alle ausgewählten Titel sind bereits in der Ziel-Playlist.");

  await sp.addItems(plId, uris, (d, n) => { progress(d, n); status(`Importiere… ${d}/${n}`, "info"); });
  await ctx.loadPlaylists();
  status(`${uris.length} Titel importiert.`, "ok");
  await alertBox("Import fertig", `${uris.length} Titel wurden importiert${picked.length !== uris.length ? ` (${picked.length - uris.length} übersprungen, da schon vorhanden/doppelt)` : ""}.\n\nDie Playlist findest du im Reiter „Verwalten“.`);
}
