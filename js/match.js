// Text-Normalisierung, Import-Parser und Treffer-Bewertung (reine Logik, ohne DOM -> testbar)

export const LEADING_INDEX_RE = /^\s*(?:\d{1,3}\s*[.)](?!\d)\s*|\d{1,3}\s+[-–]\s+|[*•]\s+|-\s+)/;
export const BLACKLIST_RE = /\b(continuous mix|mixed|live|radio edit|short edit|single edit|tribute|cover|karaoke|instrumental|acapella|a cappella)\b/i;
export const PREFERRED_RE = /\b(original mix|extended|club mix|12"? mix|full length|original version)\b/i;
export const HARD_EXCLUDE_RE = /\b(live at|live from|live in|continuous mix|dj mix|karaoke version|made famous by|in the style of)\b/i;
export const TRACK_URI_RE = /(?:spotify:track:|open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/)([A-Za-z0-9]{22})/;

export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/\bfeat\.?|\bft\.?|\bfeaturing\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Entfernt Versionszusätze, die Suchtreffer verfälschen – aber nicht Teile des echten Titels.
// "Song - 2011 Remaster", "Song - Remastered 2009", "Song (feat. X)", "Song - Radio Edit"
const VERSION_WORDS =
  "remaster(?:ed)?|version|edit|mix|live|mono|stereo|single|radio|demo|bonus|deluxe|anniversary|re-?recorded|acoustic|instrumental|original|extended|club|dub|vip";
const DASH_SUFFIX_RE = new RegExp(`\\s+[-–—]\\s+(?:[^-–—]*\\b(?:${VERSION_WORDS})\\b[^-–—]*)$`, "i");
const BRACKET_RE = new RegExp(`\\s*[(\\[][^)\\]]*\\b(?:feat\\.?|ft\\.?|with|${VERSION_WORDS})\\b[^)\\]]*[)\\]]`, "gi");

export function cleanTitle(title) {
  const t = (title || "").replace(BRACKET_RE, "").replace(DASH_SUFFIX_RE, "").trim();
  return t || (title || "").trim();
}

function tokens(s) {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

// Wort-Überdeckung 0..1 (Dice-Koeffizient)
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---------- Import-Parser ----------
function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectCsv(lines) {
  if (!lines.length) return null;
  const head = lines[0].replace(/^﻿/, "");
  for (const delim of [";", ",", "\t"]) {
    if (!head.includes(delim)) continue;
    const cols = splitCsvLine(head, delim).map((c) => c.toLowerCase());
    const ti = cols.findIndex((c) => /^(titel|title|track|song|name|track name)$/.test(c));
    const ai = cols.findIndex((c) => /^(k(ue|ü)nstler|artist|artists|interpret|artist name\(s\)|artist name)$/.test(c));
    const ui = cols.findIndex((c) => /(spotify_uri|track uri|uri|spotify)/.test(c));
    if (ti >= 0 || ui >= 0) return { delim, ti, ai, ui };
  }
  return null;
}

// Ergebnis: [{ raw, artist, title, uri }]
export function parseImportText(text) {
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const csv = detectCsv(lines);
  const out = [];
  if (csv) {
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line, csv.delim);
      const uriM = csv.ui >= 0 ? TRACK_URI_RE.exec(c[csv.ui] || "") : null;
      const title = csv.ti >= 0 ? c[csv.ti] || "" : "";
      const artist = csv.ai >= 0 ? c[csv.ai] || "" : "";
      if (!title && !uriM) continue;
      out.push({ raw: line, artist, title, uri: uriM ? `spotify:track:${uriM[1]}` : "" });
    }
    return out;
  }
  for (const line of lines) {
    const uriM = TRACK_URI_RE.exec(line);
    if (uriM) {
      out.push({ raw: line, artist: "", title: "", uri: `spotify:track:${uriM[1]}` });
      continue;
    }
    const l = line.replace(LEADING_INDEX_RE, "").replace(/\s+\(\d+\s*BPM.*?\)\s*$/i, "").trim();
    // "Artist - Title" (erste Trennung mit Leerzeichen um den Strich)
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(l);
    if (m) out.push({ raw: line, artist: m[1].trim(), title: m[2].trim(), uri: "" });
    else out.push({ raw: line, artist: "", title: l, uri: "" });
  }
  return out;
}

export function buildQueries(entry) {
  const t = cleanTitle(entry.title).replace(/"/g, "");
  const a = (entry.artist || "").split(/,|&| x | vs\.? /i)[0].replace(/"/g, "").trim();
  const q = [];
  if (entry.isrc) q.push(`isrc:${entry.isrc}`);
  if (a && t) q.push(`track:"${t}" artist:"${a}"`);
  q.push(`${a} ${t}`.trim());
  return [...new Set(q)];
}

// Bewertet einen Spotify-Kandidaten 0..100 gegen die Eingabe
export function scoreCandidate(entry, cand) {
  const inputTitle = entry.title || "";
  const inputAll = `${entry.artist} ${inputTitle}`;
  const name = cand.name || "";
  if (HARD_EXCLUDE_RE.test(name) && !HARD_EXCLUDE_RE.test(inputAll)) return 0;

  const tSim = similarity(cleanTitle(inputTitle), cleanTitle(name));
  const aSim = entry.artist ? Math.max(...(cand.artists.length ? cand.artists : [cand.artist]).map((x) => similarity(entry.artist, x)), similarity(entry.artist, cand.artist)) : 0.6;
  let score = tSim * 55 + aSim * 40;

  if (entry.durationMs && cand.durationMs) {
    const diff = Math.abs(entry.durationMs - cand.durationMs) / 1000;
    score += diff <= 3 ? 5 : diff <= 10 ? 2 : -10;
  } else score += 2;

  if (BLACKLIST_RE.test(`${name} ${cand.album || ""}`) && !BLACKLIST_RE.test(inputAll)) score -= 30;
  if (PREFERRED_RE.test(name)) score += 4;
  if (entry.isrc && cand.isrc && entry.isrc.toUpperCase() === cand.isrc.toUpperCase()) score = 100;
  if (!cand.playable) score -= 15;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function rankCandidates(entry, cands) {
  const seen = new Set();
  return cands
    .filter((c) => c.uri && !seen.has(c.uri) && seen.add(c.uri))
    .map((c) => ({ ...c, score: scoreCandidate(entry, c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ---------- Duplikate ----------
function textKey(t) {
  return normalize(t.artists && t.artists[0] ? t.artists[0] : t.artist) + "|" + normalize(cleanTitle(t.name));
}

// Liefert die Indizes aller Vorkommen ab dem zweiten.
// Gleiche URI oder gleicher ISRC = sicher doppelt; gleicher Interpret+Titel nur bei ähnlicher Dauer (±4 s).
export function findDuplicates(tracks) {
  const byUri = new Map();
  const byIsrc = new Map();
  const byText = new Map();
  const dups = [];
  tracks.forEach((t, i) => {
    if (!t || (!t.uri && !t.name)) return;
    const tk = textKey(t);
    const isrc = (t.isrc || "").toUpperCase();
    let isDup = false;
    if (t.uri && !t.local && byUri.has(t.uri)) isDup = true;
    else if (isrc && byIsrc.has(isrc)) isDup = true;
    else if (tk !== "|" && byText.has(tk)) {
      const f = tracks[byText.get(tk)];
      isDup = Math.abs((t.durationMs || 0) - (f.durationMs || 0)) <= 4000;
    }
    if (isDup) { dups.push(i); return; }
    if (t.uri && !t.local && !byUri.has(t.uri)) byUri.set(t.uri, i);
    if (isrc && !byIsrc.has(isrc)) byIsrc.set(isrc, i);
    if (tk !== "|" && !byText.has(tk)) byText.set(tk, i);
  });
  return dups;
}

// ---------- Reihenfolge-Algorithmen ----------
// Minimale Folge von Einzel-Verschiebungen, um "current" in "target" zu überführen.
// Elemente werden per Identität (Objekt-Referenz) verglichen.
export function planReorder(current, target) {
  const cur = current.slice();
  const ops = [];
  for (let i = 0; i < target.length; i++) {
    if (cur[i] === target[i]) continue;
    const j = cur.indexOf(target[i], i + 1);
    if (j < 0) throw new Error("Ziel-Reihenfolge passt nicht zur Playlist");
    ops.push({ rangeStart: j, insertBefore: i });
    const [x] = cur.splice(j, 1);
    cur.splice(i, 0, x);
  }
  return ops;
}

// Plan für das Entfernen ausgewählter Positionen, wenn die API nur "alle Vorkommen" löschen kann:
// alle Vorkommen der URIs löschen, die NICHT ausgewählten Vorkommen danach an ihrer Position wieder einfügen.
export function planRemoval(tracks, selectedIdx) {
  const sel = new Set(selectedIdx);
  const uris = [...new Set(selectedIdx.map((i) => tracks[i].uri).filter(Boolean))];
  const uriSet = new Set(uris);
  const finalList = tracks.filter((_, i) => !sel.has(i));
  const reinserts = [];
  finalList.forEach((t, pos) => {
    if (uriSet.has(t.uri)) reinserts.push({ uri: t.uri, position: pos });
  });
  return { uris, reinserts, finalList };
}

// Mischen, ohne dass derselbe Interpret direkt hintereinander kommt (soweit mathematisch möglich)
export function spreadShuffle(tracks, rnd = Math.random) {
  const art = (t) => normalize(t.artists && t.artists[0] ? t.artists[0] : t.artist);
  const groups = new Map();
  for (const t of tracks) {
    const k = art(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const g of groups.values()) {
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
  }
  const out = [];
  let last = null;
  let remaining = tracks.length;
  while (remaining > 0) {
    const entries = [...groups.entries()].filter(([, g]) => g.length);
    let allowed = entries.filter(([k]) => k !== last);
    if (!allowed.length) allowed = entries; // nicht vermeidbar
    const [maxK, maxG] = entries.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    let pick;
    if (maxK !== last && maxG.length * 2 >= remaining) pick = maxK; // sonst Sackgasse
    else {
      const total = allowed.reduce((s, [, g]) => s + g.length, 0);
      let r = rnd() * total;
      pick = allowed[allowed.length - 1][0];
      for (const [k, g] of allowed) { r -= g.length; if (r < 0) { pick = k; break; } }
    }
    out.push(groups.get(pick).pop());
    last = pick;
    remaining--;
  }
  return out;
}
