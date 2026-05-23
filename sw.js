const CACHE_NAME = 'screenwriter-v1';
// Add all the files you want cached for offline use
const assets = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-256.png',
  './icons/icon-512.png'
  // Add paths to your style.css or script.js files here if you have them separate
];

// Install Service Worker and cache assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching app assets');
      return cache.addAll(assets);
    })
  );
});

// Activate Service Worker and clean up old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Clearing old cache', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
});

// Fetch assets from cache first, fallback to network
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    })
  );
});