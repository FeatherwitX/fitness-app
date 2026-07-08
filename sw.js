// Service Worker for offline caching — v3
// Features: GIF LRU (200 cap) + 15-day TTL eviction via IndexedDB
const CACHE_NAME = 'qinglian-v3';
const MAX_GIF_CACHE = 200;
const GIF_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
const STATIC_TTL_MS = 24 * 60 * 60 * 1000; // 1 day, revalidate static assets daily
const EVICTION_INTERVAL_MS = 60 * 60 * 1000; // throttle eviction to once per hour
let lastEvictionCheck = 0;

const CACHE_URLS = [
  'browser.html',
  'workout.html',
  'history.html',
  'styles.css',
  'exercises.json',
  'manifest.json'
];

// ===== IndexedDB for GIF access timestamps =====
const DB_NAME = 'qinglian-db';
const STORE = 'gif-meta';
const STATIC_STORE = 'static-meta';

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(STATIC_STORE)) db.createObjectStore(STATIC_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(url, timestamp) {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(timestamp, url);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch(e) { /* IndexedDB unavailable, skip */ }
}

async function dbGetAll() {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); resolve([]); };
    });
  } catch(e) { return []; }
}

async function dbGetAllKeys() {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror = () => { db.close(); resolve([]); };
    });
  } catch(e) { return []; }
}

async function dbDelete(url) {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(url);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch(e) { /* skip */ }
}

async function dbStaticPut(url, timestamp) {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STATIC_STORE, 'readwrite');
      tx.objectStore(STATIC_STORE).put(timestamp, url);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch(e) { /* skip */ }
}

async function dbStaticGet(url) {
  try {
    const db = await dbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(STATIC_STORE, 'readonly');
      const req = tx.objectStore(STATIC_STORE).get(url);
      req.onsuccess = () => { db.close(); resolve(req.result || 0); };
      req.onerror = () => { db.close(); resolve(0); };
    });
  } catch(e) { return 0; }
}

// ===== GIF eviction: TTL + count-based LRU =====
async function evictGifs(cache) {
  const now = Date.now();
  if (now - lastEvictionCheck < EVICTION_INTERVAL_MS) return;
  lastEvictionCheck = now;

  // 1. TTL: remove GIFs not accessed within 15 days
  const keys = await dbGetAllKeys();
  const values = await dbGetAll();
  const expired = [];
  for (let i = 0; i < keys.length; i++) {
    if (now - values[i] > GIF_TTL_MS) expired.push(keys[i]);
  }
  for (const url of expired) {
    await cache.delete(url);
    await dbDelete(url);
  }
  if (expired.length) console.log('[SW] TTL evicted', expired.length, 'GIFs (older than 15 days)');

  // 2. Count-based LRU: trim to MAX_GIF_CACHE if still over limit
  const cacheKeys = await cache.keys();
  const gifKeys = cacheKeys.filter(k => k.url.includes('/gifs/'));
  if (gifKeys.length > MAX_GIF_CACHE) {
    const toRemove = gifKeys.slice(0, gifKeys.length - MAX_GIF_CACHE);
    for (const k of toRemove) {
      await cache.delete(k);
      await dbDelete(k.url);
    }
    console.log('[SW] LRU trimmed', toRemove.length, 'GIFs (over', MAX_GIF_CACHE, 'limit)');
  }
}

// ===== Lifecycle =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ===== Fetch handler =====
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // --- GIF files: stale-while-revalidate with TTL + LRU eviction ---
  if (url.includes('/gifs/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        // Update access timestamp on cache hit (refresh TTL)
        if (cached) {
          dbPut(url, Date.now());
          return cached;
        }
        // Cache miss: fetch from network
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, clone);
              dbPut(url, Date.now());
              // Run eviction (throttled internally)
              evictGifs(cache);
            });
          }
          return response;
        }).catch(() => {
          // Network failed and not cached: let img onerror handle it
          return new Response('', { status: 404 });
        });
      })
    );
    return;
  }

  // --- Static assets (HTML/CSS/JS/JSON): cache-first with daily TTL revalidation ---
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Serve cached immediately; revalidate in background if older than TTL
        const now = Date.now();
        dbStaticGet(url).then(ts => {
          if (!ts || now - ts > STATIC_TTL_MS) {
            fetch(event.request).then(response => {
              if (response.ok && /\.(css|js|html|json)$/.test(url)) {
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
                dbStaticPut(url, Date.now());
              }
            }).catch(() => {});
          }
        });
        return cached;
      }
      return fetch(event.request).then(response => {
        if (response.ok && /\.(css|js|html|json)$/.test(url)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => { cache.put(event.request, clone); dbStaticPut(url, Date.now()); });
        }
        return response;
      }).catch(() => new Response('', { status: 404 }));
    })
  );
});
