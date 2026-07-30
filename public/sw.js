// Service Worker。
// - ナビゲーション(HTML) と 共有下絵マニフェスト(custom/index.json) は network-first：
//   オンライン時は常に最新を取得（＝新デプロイ・新しい共有下絵がすぐ届く）、
//   オフライン時はキャッシュにフォールバック。
// - それ以外の同一オリジン GET（ハッシュ付き JS/CSS、png 等）は cache-first。
const CACHE_NAME = "dino-coloring-v7";
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// network-first: 取得できたらキャッシュ更新、失敗時はキャッシュへフォールバック
function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return res;
    })
    .catch(() => caches.match(req).then((c) => c || caches.match("./index.html")));
}

// cache-first: あればキャッシュ、無ければ取得してキャッシュ
function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return res;
    });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  const url = new URL(req.url);
  const isNavigation = req.mode === "navigate";
  const isManifest = url.pathname.endsWith("/custom/index.json");

  if (isNavigation || isManifest) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});
