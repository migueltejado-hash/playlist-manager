// Lokale Datenhaltung im Browser (IndexedDB): Metadaten-Cache und Backups.
import { CONFIG } from "./config.js";

const DB_NAME = "playlist-manager";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("backups")) {
        const s = db.createObjectStore("backups", { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---------- Metadaten-Cache ----------
const memMeta = new Map();

export async function getMeta(key) {
  if (memMeta.has(key)) return memMeta.get(key);
  const v = await tx("meta", "readonly", (s) => reqP(s.get(key)));
  if (v) memMeta.set(key, v);
  return v || null;
}

export async function setMeta(key, value) {
  memMeta.set(key, value);
  await tx("meta", "readwrite", (s) => { s.put(value, key); });
}

export async function clearMeta() {
  memMeta.clear();
  await tx("meta", "readwrite", (s) => { s.clear(); });
}

export async function countMeta() {
  return tx("meta", "readonly", (s) => reqP(s.count()));
}

// ---------- Backups ----------
export async function addBackup(playlist, tracks, reason) {
  const rec = {
    ts: Date.now(),
    playlistId: playlist.id,
    playlistName: playlist.name,
    reason,
    items: tracks.map((t) => ({ uri: t.uri, name: t.name, artist: t.artist, local: !!t.local })),
  };
  const id = await tx("backups", "readwrite", (s) => reqP(s.add(rec)));
  await pruneBackups();
  return id;
}

export async function listBackups() {
  const all = await tx("backups", "readonly", (s) => reqP(s.getAll()));
  return all.sort((a, b) => b.ts - a.ts);
}

export async function getBackup(id) {
  return tx("backups", "readonly", (s) => reqP(s.get(id)));
}

export async function deleteBackup(id) {
  await tx("backups", "readwrite", (s) => { s.delete(id); });
}

async function pruneBackups() {
  const all = await listBackups();
  const excess = all.slice(CONFIG.MAX_BACKUPS);
  for (const b of excess) await deleteBackup(b.id);
}
