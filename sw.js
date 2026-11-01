// Service Worker: Network-first für die eigenen App-Dateien -> Updates kommen ohne Versions-Hochzählen an,
// offline wird die zuletzt geladene Version aus dem Cache geliefert. Fremde Domains (Spotify, Deezer) werden nie gecacht.
const CACHE = "pm-shell-v1";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/auth.js", "js/config.js", "js/deezer.js", "js/importer.js", "js/match.js", "js/spotify.js", "js/store.js", "js/ui.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // OAuth-Rückkehr (?code=…) nie aus dem Cache bedienen
  if (url.searchParams.has("code")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});
