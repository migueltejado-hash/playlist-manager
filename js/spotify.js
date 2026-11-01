// Spotify Web API – Stand nach den Änderungen Februar 2026 (/tracks -> /items, /me/library usw.)
import { getAccessToken, refreshToken, AuthRequiredError } from "./auth.js";

const BASE = "https://api.spotify.com/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(status, message, path) {
    super(`${message} (HTTP ${status})`);
    this.status = status;
    this.path = path;
  }
}

export async function api(path, { method = "GET", query, body } = {}) {
  const url = new URL(path.startsWith("http") ? path : BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await getAccessToken();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ApiError(0, "Netzwerkfehler – keine Verbindung zu Spotify", path);
    }

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshToken();
      continue;
    }
    if (res.status === 401) throw new AuthRequiredError();
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("Retry-After") || "", 10);
      await sleep((Number.isFinite(ra) ? ra : 3 + attempt * 2) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      let msg = res.statusText || "Fehler";
      try {
        const j = await res.json();
        msg = (j.error && (j.error.message || j.error)) || msg;
      } catch {}
      throw new ApiError(res.status, msg, path);
    }
    const txt = await res.text();
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }
  throw new ApiError(429, "Zu viele Anfragen – bitte später erneut versuchen", path);
}

async function getAllPages(path, query, onPage) {
  const out = [];
  let page = await api(path, { query });
  while (page) {
    out.push(...(page.items || []));
    if (onPage) onPage(out.length, page.total);
    page = page.next ? await api(page.next) : null;
  }
  return out;
}

const chunk = (arr, n) => {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
};

// ---------- Nutzer & Playlists ----------
export const me = () => api("/me");

export async function myPlaylists() {
  const list = await getAllPages("/me/playlists", { limit: 50 });
  return list.filter(Boolean).map((p) => ({
    id: p.id,
    name: p.name || "Unbenannt",
    ownerId: p.owner && p.owner.id,
    ownerName: (p.owner && (p.owner.display_name || p.owner.id)) || "",
    collaborative: !!p.collaborative,
    public: p.public,
    // Feb 2026: "tracks" -> "items"; fehlt bei fremden Playlists
    total: (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? null,
    snapshot: p.snapshot_id,
  }));
}

export async function playlistMeta(id) {
  const p = await api(`/playlists/${id}`, {
    query: { fields: "id,name,description,owner(id,display_name),collaborative,public,snapshot_id" },
  });
  return {
    id: p.id,
    name: p.name || "Unbenannt",
    ownerId: p.owner && p.owner.id,
    ownerName: (p.owner && (p.owner.display_name || p.owner.id)) || "",
    collaborative: !!p.collaborative,
    public: p.public,
    snapshot: p.snapshot_id,
  };
}

export function parseEntry(entry, pos) {
  if (!entry) return null;
  const t = entry.item || entry.track || null;
  const isLocal = !!(entry.is_local || (t && t.is_local));
  if (!t) {
    return {
      pos, id: "", uri: "", name: "(nicht verfügbar)", artist: "", artists: [],
      durationMs: 0, year: null, isrc: "", explicit: false, local: false,
      playable: false, type: "unknown", addedAt: entry.added_at || null, bpm: null,
    };
  }
  const artists = (t.artists || (t.show ? [t.show] : [])).map((a) => a && a.name).filter(Boolean);
  const rd = (t.album && t.album.release_date) || t.release_date || "";
  const yr = /^(\d{4})/.exec(rd);
  return {
    pos,
    id: t.id || "",
    uri: t.uri || "",
    name: t.name || "(ohne Titel)",
    artist: artists.join(", ") || "Unbekannt",
    artists,
    album: (t.album && t.album.name) || "",
    durationMs: t.duration_ms || 0,
    year: yr ? parseInt(yr[1], 10) : null,
    isrc: (t.external_ids && t.external_ids.isrc) || "",
    explicit: !!t.explicit,
    local: isLocal,
    playable: t.is_playable !== false,
    type: t.type || "track",
    addedAt: entry.added_at || null,
    bpm: null,
  };
}

export async function playlistItems(id, onProgress) {
  const raw = await getAllPages(
    `/playlists/${id}/items`,
    { limit: 50, market: "from_token", additional_types: "track,episode" },
    onProgress
  );
  return raw.map((e, i) => parseEntry(e, i));
}

export async function createPlaylist(name, description = "", isPublic = false) {
  return api("/me/playlists", { method: "POST", body: { name, description, public: isPublic } });
}

export async function addItems(playlistId, uris, onProgress) {
  let snap = null;
  let done = 0;
  for (const part of chunk(uris, 100)) {
    const r = await api(`/playlists/${playlistId}/items`, { method: "POST", body: { uris: part } });
    snap = r && r.snapshot_id;
    done += part.length;
    if (onProgress) onProgress(done, uris.length);
  }
  return snap;
}

export async function insertItemAt(playlistId, uri, position) {
  const r = await api(`/playlists/${playlistId}/items`, { method: "POST", body: { uris: [uri], position } });
  return r && r.snapshot_id;
}

// Entfernt ALLE Vorkommen der URIs (Positionsangaben sind seit Feb 2026 nicht mehr dokumentiert)
export async function removeAllOccurrences(playlistId, uris, snapshotId) {
  let snap = snapshotId;
  for (const part of chunk(uris, 100)) {
    const body = { items: part.map((uri) => ({ uri })) };
    if (snap) body.snapshot_id = snap;
    const r = await api(`/playlists/${playlistId}/items`, { method: "DELETE", body });
    snap = r && r.snapshot_id;
  }
  return snap;
}

export async function reorder(playlistId, rangeStart, insertBefore, snapshotId, rangeLength = 1) {
  const body = { range_start: rangeStart, insert_before: insertBefore, range_length: rangeLength };
  if (snapshotId) body.snapshot_id = snapshotId;
  const r = await api(`/playlists/${playlistId}/items`, { method: "PUT", body });
  return r && r.snapshot_id;
}

// Überschreibt die komplette Playlist (verliert "hinzugefügt am")
export async function replaceAll(playlistId, uris, onProgress) {
  const first = uris.slice(0, 100);
  await api(`/playlists/${playlistId}/items`, { method: "PUT", body: { uris: first } });
  if (onProgress) onProgress(first.length, uris.length);
  let done = first.length;
  for (const part of chunk(uris.slice(100), 100)) {
    await api(`/playlists/${playlistId}/items`, { method: "POST", body: { uris: part } });
    done += part.length;
    if (onProgress) onProgress(done, uris.length);
  }
}

// Feb 2026: Follow/Unfollow über /me/library
export async function unfollowPlaylist(playlistId) {
  return api("/me/library", { method: "DELETE", query: { uris: `spotify:playlist:${playlistId}` } });
}

export async function followPlaylist(playlistId) {
  return api("/me/library", { method: "PUT", query: { uris: `spotify:playlist:${playlistId}` } });
}

// ---------- Suche ----------
export async function searchTracks(q, limit = 10) {
  const r = await api("/search", { query: { q, type: "track", limit: Math.min(limit, 10), market: "from_token" } });
  return ((r && r.tracks && r.tracks.items) || []).filter(Boolean).map((t, i) => parseEntry({ item: t }, i));
}

// ---------- Wiedergabe ----------
export async function playInContext(playlistId, trackUri) {
  return api("/me/player/play", {
    method: "PUT",
    body: { context_uri: `spotify:playlist:${playlistId}`, offset: { uri: trackUri } },
  });
}
