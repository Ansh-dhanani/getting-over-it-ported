// Pre-cache the Unity WebGL build so repeat loads are near-instant and the
// HTTP disk cache doesn't evict the large data parts.
var CACHE_NAME = 'goi-v1';
var PRECACHE_URLS = [
  '/',
  '/index.html',
  '/logo.jpg',
  '/favicon.ico',
  '/u6_mian_brotli.loader.js',
  '/u6_mian_brotli.framework.js.unityweb',
  '/u6_mian_brotli.wasm.unityweb',
  '/parts/data.part1',
  '/parts/data.part2'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all(PRECACHE_URLS.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.warn('precache failed for', url, err);
        });
      }));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Only serve same-origin static assets from cache; let other requests through.
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;
  if (p.match(/^\/(parts|u6_mian_brotli\.(loader\.js|framework\.js\.unityweb|wasm\.unityweb)|logo\.jpg|favicon\.ico)/)) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          if (response && response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          }
          return response;
        });
      })
    );
  }
  // For everything else, network first, fall back to cache.
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
