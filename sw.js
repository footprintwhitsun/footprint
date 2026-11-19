/**
 * Service Worker: Offline Cache & Performance Accelerator
 * OKWESIWA CO LTD Enterprise POS & ERP
 */

const CACHE_NAME = 'okwesiwa-v6';
const STATIC_ASSETS = [
    '/currency.js',
    '/user-session.js',
    '/instant-nav.js',
    '/telemetry-guard.js',
    '/offline-queue.js'
];
const STATIC_ASSET_EXTS = ['.js', '.css', '.svg', '.png', '.ico', '.woff2'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('SW pre-cache warning:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle GET requests for non-API static assets (never cache authenticated HTML pages)
    if (event.request.method !== 'GET') return;
    if (event.request.mode === 'navigate') return;
    const acceptHeader = event.request.headers.get('accept') || '';
    if (acceptHeader.includes('text/html')) return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;
    const lowerPath = url.pathname.toLowerCase();
    const isStaticAsset = STATIC_ASSET_EXTS.some((ext) => lowerPath.endsWith(ext));
    if (!isStaticAsset) return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                const contentType = (networkResponse && networkResponse.headers && networkResponse.headers.get('content-type')) || '';
                if (networkResponse && networkResponse.status === 200 && !contentType.includes('text/html')) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
    );
});
