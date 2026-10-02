// Offline support: keep a copy of the app so it opens without a connection.
// Network first, so a new version shows up as soon as you're online.
const CACHE = "fft-v1";
const SHELL = [
  "./", "index.html", "app.js", "ai.js", "links.js", "db.js", "styles.css",
  "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
  "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm",
  "https://cdn.jsdelivr.net/npm/exifr@7/dist/lite.umd.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache AI calls or anything that isn't a plain GET of the app itself.
  if (e.request.method !== "GET" || url.hostname === "api.anthropic.com") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
