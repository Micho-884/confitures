// Garde l'application et ses bibliothèques en mémoire pour l'utiliser hors connexion.
const CACHE = "cellier-v2";
const CORE = ["./", "./index.html", "./local-shim.js", "./manifest.webmanifest", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png"];
const CDN = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([
    ...CORE.map((u) => c.add(u).catch(() => {})),
    ...CDN.map((u) => fetch(u, { mode: "cors" }).then((r) => r.ok && c.put(u, r)).catch(() => {})),
  ])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  // Pages et fichiers de l'application : réseau d'abord (pour recevoir les mises à jour), mémoire sinon.
  if (own) {
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then((m) => m || (req.mode === "navigate" ? caches.match("./index.html") : undefined));
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; }
      // Site introuvable (404…) : on ouvre la version gardée en mémoire si elle existe.
      return fromCache().then((m) => m || r);
    }).catch(() => fromCache().then((m) => m || Response.error())));
    return;
  }
  // Bibliothèques et polices : mémoire d'abord.
  if (/cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url.host)) {
    e.respondWith(caches.match(req).then((m) => m || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; })));
  }
});
