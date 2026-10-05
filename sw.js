const CACHE = "today48-v1";

const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./game.js",
  "./engine.mjs",
  "./manifest.json",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

// GitHub Pages redirects the folder URL. cache.put rejects redirected responses,
// so store a fresh response with the same body.
async function store(cache, request, response) {
  const body = await response.blob();
  await cache.put(
    request,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        FILES.map(async (path) => {
          const response = await fetch(path, { cache: "reload" });
          if (!response.ok) throw new Error(path);
          await store(cache, path, response);
        }),
      );
      await self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      const fresh = fetch(event.request)
        .then(async (response) => {
          if (response.ok) await store(cache, event.request, response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) return cached;
      const response = await fresh;
      if (response) return response;
      if (event.request.mode === "navigate") {
        return (await cache.match("./index.html")) || (await cache.match("./"));
      }
      return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })(),
  );
});
