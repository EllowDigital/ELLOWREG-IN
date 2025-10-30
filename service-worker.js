const CACHE_VERSION = 'emrs-admin-cache-v1';
const APP_SHELL = [
    '/',
    '/admin.html',
    '/index.html',
    '/verify.html',
    '/manifest.json',
    '/assets/favicon/favicon-16x16.png',
    '/assets/favicon/favicon-32x32.png',
    '/assets/favicon/android-chrome-192x192.png',
    '/assets/favicon/android-chrome-512x512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => null)
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_VERSION)
                        .map((staleKey) => caches.delete(staleKey))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);
    if (url.origin === self.location.origin && request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('/admin.html')))
        );
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) {
                    return cached;
                }
                return fetch(request).then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
                    }
                    return response;
                });
            })
        );
    }
});
