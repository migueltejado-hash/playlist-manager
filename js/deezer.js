// BPM über die öffentliche Deezer-API (ohne Login).
// Deezer sendet keine CORS-Header -> Abfrage per JSONP (offiziell unterstützt: output=jsonp).
import { CONFIG } from "./config.js";
import { getMeta, setMeta } from "./store.js";
import { normalize, cleanTitle, similarity } from "./match.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
let lastCall = 0;
let gate = Promise.resolve();

function jsonp(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const cb = `__dz_${Date.now().toString(36)}_${++seq}`;
    const script = document.createElement("script");
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      // Späte Antworten nach Timeout ins Leere laufen lassen
      window[cb] = () => {};
      setTimeout(() => { delete window[cb]; }, 30000);
      script.remove();
    };
    const timer = setTimeout(() => { if (!done) { finish(); reject(new Error("Deezer-Timeout")); } }, timeoutMs);
    window[cb] = (data) => { if (!done) { finish(); resolve(data); } };
    script.onerror = () => { if (!done) { finish(); reject(new Error("Deezer nicht erreichbar")); } };
    script.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
    document.head.appendChild(script);
  });
}

// Drosselung: alle Aufrufe laufen nacheinander mit Mindestabstand
function throttled(fn) {
  const run = gate.then(async () => {
    const wait = lastCall + CONFIG.DEEZER_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  gate = run.catch(() => {});
  return run;
}

export class DeezerError extends Error {}

// Liefert Daten, null bei "nicht gefunden", wirft bei echten Fehlern
export async function dzGet(path) {
  const url = "https://api.deezer.com" + path;
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await throttled(() => jsonp(url));
    if (data && data.error) {
      const code = data.error.code;
      if (code === 4) { await sleep(5500); continue; } // Quota (kommt als "Erfolg" verpackt)
      if (code === 800 || code === 801 || code === 803) return null; // keine Daten / nicht gefunden
      throw new DeezerError(`Deezer: ${data.error.message || "Fehler"} (Code ${code})`);
    }
    return data;
  }
  throw new DeezerError("Deezer: Abfragelimit überschritten");
}

async function searchCandidates(track) {
  const title = cleanTitle(track.name);
  const artist = (track.artists && track.artists[0]) || track.artist || "";
  const queries = [`artist:"${artist}" track:"${title}"`, `${artist} ${title}`];
  const dur = (track.durationMs || 0) / 1000;
  for (const q of queries) {
    const r = await dzGet(`/search?q=${encodeURIComponent(q)}&limit=10`);
    let c = (r && r.data) || [];
    c = c
      .map((d) => {
        const aSim = similarity(normalize(artist), normalize((d.artist && d.artist.name) || ""));
        const tSim = similarity(normalize(title), normalize(cleanTitle(d.title || "")));
        const dDiff = dur ? Math.abs((d.duration || 0) - dur) : 0;
        return { d, score: aSim * 50 + tSim * 40 + (dur ? Math.max(0, 10 - dDiff) : 5), dDiff };
      })
      .filter((x) => x.score >= 55 && (!dur || x.dDiff <= 12))
      .sort((a, b) => b.score - a.score);
    if (c.length) return c.map((x) => x.d);
  }
  return [];
}

function metaKey(track) {
  return track.id ? "sp:" + track.id : "q:" + normalize(track.artist) + "|" + normalize(track.name);
}

// Ergebnis: { bpm: Zahl|null, source: "isrc"|"search"|null }
export async function getBpm(track) {
  if (track.local || track.type !== "track") return { bpm: null, source: null };
  const key = metaKey(track);
  const cached = await getMeta(key);
  if (cached) {
    const stale =
      cached.bpm == null &&
      Date.now() - (cached.ts || 0) > CONFIG.META_NOTFOUND_RETRY_DAYS * 86400000;
    if (!stale) return cached;
  }

  let bpm = null;
  let source = null;

  // 1) Exakter Treffer über ISRC
  if (track.isrc) {
    const d = await dzGet(`/track/isrc:${encodeURIComponent(track.isrc)}`);
    if (d && d.id) {
      const v = Number(d.bpm) || 0;
      if (v > 0) { bpm = Math.round(v); source = "isrc"; }
    }
  }
  // 2) Fallback: Suche mit Abgleich von Interpret, Titel und Dauer
  if (bpm == null) {
    const cands = await searchCandidates(track);
    for (const c of cands.slice(0, 3)) {
      const d = await dzGet(`/track/${c.id}`);
      const v = d ? Number(d.bpm) || 0 : 0;
      if (v > 0) { bpm = Math.round(v); source = "search"; break; }
    }
  }

  const result = { bpm, source, ts: Date.now() };
  await setMeta(key, result); // nur bei Erfolg oder sauberem "nicht gefunden" – Fehler werfen vorher
  return result;
}

// ---------- Deezer-Playlists lesen (öffentlich) ----------
export function parseDeezerPlaylistId(input) {
  const m = /deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/i.exec(input) || /^(\d{4,})$/.exec(input.trim());
  return m ? m[1] : null;
}

export async function deezerPlaylist(id, onProgress) {
  const meta = await dzGet(`/playlist/${id}`);
  if (!meta) throw new DeezerError("Deezer-Playlist nicht gefunden oder privat.");
  const out = [];
  let index = 0;
  for (;;) {
    const page = await dzGet(`/playlist/${id}/tracks?limit=100&index=${index}`);
    const data = (page && page.data) || [];
    for (const d of data) {
      out.push({
        artist: (d.artist && d.artist.name) || "",
        title: d.title || "",
        durationMs: (d.duration || 0) * 1000,
        isrc: d.isrc || "",
      });
    }
    if (onProgress) onProgress(out.length, meta.nb_tracks);
    if (!page || !page.next || !data.length) break;
    index += data.length;
  }
  return { name: meta.title || "Deezer-Playlist", tracks: out };
}
