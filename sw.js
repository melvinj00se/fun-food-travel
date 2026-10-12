// Offline support: keep a copy of the app so it opens without a connection.
// Local files: network-first (new version shows up as soon as you're online).
// CDN files: cache-first (they're versioned/immutable, no need to re-fetch).
const CACHE = "fft-v8";
const LOCAL_SHELL = [
  "./", "index.html", "app.js", "ai.js", "links.js", "db.js",
  "search.js", "social.js", "cloud.js", "styles.css",
  "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
  "screenshot-wide.png", "screenshot-narrow.png",
];
const CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm",
  "https://cdn.jsdelivr.net/npm/exifr@7/dist/lite.umd.js",
  "https://cdn.jsdelivr.net/npm/minisearch@7.1.1/dist/es/index.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await c.addAll(LOCAL_SHELL);
      // CDN files: best-effort so a slow CDN doesn't block install
      for (const url of CDN_URLS) {
        try { await c.add(url); } catch (err) { console.warn("CDN cache skip:", url, err); }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname === "api.anthropic.com") return;

  // CDN resources are versioned/immutable: cache-first
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }))
    );
    return;
  }

  // Local files: network-first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
