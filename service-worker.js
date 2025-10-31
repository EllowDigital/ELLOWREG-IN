const purgeAllCaches = async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
};

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(purgeAllCaches());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await purgeAllCaches();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  event.respondWith(fetch(event.request, { cache: "no-store" }));
});
