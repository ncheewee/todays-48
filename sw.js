const CACHE = "today48-v7";

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

// GitHub Pages redirects the folder URL, and cache.put rejects redirected
// responses. It also sends Vary: Accept-Encoding, which can hide a saved
// copy from the home-screen launch. Store a plain copy of the body.
async function store(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.delete("Vary");
  const body = await response.blob();
  await cache.put(
    request,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
}

async function fromCache(cache, request) {
  const options = { ignoreVary: true, ignoreSearch: true };
  const hit = await cache.match(request, options);
  if (hit) return hit;
  if (request.mode !== "navigate") return undefined;
  return (await cache.match("./index.html", options)) || (await cache.match("./", options));
}

function refresh(cache, request) {
  return fetch(request)
    .then(async (response) => {
      if (response.ok) await store(cache, request, response);
    })
    .catch(() => {});
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
      const cached = await fromCache(cache, event.request);
      if (cached) {
        event.waitUntil(refresh(cache, event.request));
        return cached;
      }
      try {
        const response = await fetch(event.request);
        if (response.ok) await store(cache, event.request, response.clone());
        return response;
      } catch {
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })(),
  );
});
