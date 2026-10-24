// ===== Version iPhone : stockage local (IndexedDB) à la place des services Claude =====
(() => {
  const DB_NAME = "cellier-confitures", DOCS = "docs", BLOBS = "blobs";
  const docs = new Map();          // chemin "collection/id" -> objet
  const blobUrls = new Map();      // id d'image -> URL locale
  const listeners = new Set();
  let idb = null;

  const openIdb = () => new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains(DOCS)) d.createObjectStore(DOCS); if (!d.objectStoreNames.contains(BLOBS)) d.createObjectStore(BLOBS); };
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = idb.transaction(store, mode), s = t.objectStore(store); const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  const allEntries = (store) => new Promise((res, rej) => {
    const out = []; const rq = idb.transaction(store).objectStore(store).openCursor();
    rq.onsuccess = () => { const c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
    rq.onerror = () => rej(rq.error);
  });

  const ready = (async () => {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    idb = await openIdb();
    for (const [k, v] of await allEntries(DOCS)) docs.set(k, v);
    for (const [k, v] of await allEntries(BLOBS)) { try { blobUrls.set(k, URL.createObjectURL(new Blob([v.buf], { type: v.type }))); } catch (e) {} }
  })();

  window.__assetUrl = (id) => blobUrls.get(id) || "";

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const merge = (a, b) => { const out = { ...a }; for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k]; return out; };
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
  const docSnap = (path) => { const v = docs.get(path); return { id: path.slice(path.lastIndexOf("/") + 1), exists: !!v, data: () => (v ? clone(v) : undefined), metadata: { fromCache: false, hasPendingWrites: false } }; };
  const colSnap = (col) => {
    const list = [...docs.keys()].filter(k => parentOf(k) === col).sort().map(docSnap);
    return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const notify = (path) => {
    queueMicrotask(() => listeners.forEach(l => {
      try { if (l.kind === "doc" && l.path === path) l.next(docSnap(path)); if (l.kind === "col" && l.path === parentOf(path)) l.next(colSnap(l.path)); } catch (e) { console.error(e); }
    }));
  };
  const write = async (path, value) => {
    if (value === null) { docs.delete(path); await tx(DOCS, "readwrite", s => s.delete(path)); }
    else { docs.set(path, clone(value)); await tx(DOCS, "readwrite", s => s.put(clone(value), path)); }
    notify(path);
  };

  const docRef = (path) => ({
    id: path.slice(path.lastIndexOf("/") + 1), path,
    async get() { await ready; return docSnap(path); },
    async set(data) { await ready; await write(path, data); },
    async update(data) { await ready; if (!docs.has(path)) throw { code: "invalid_argument", message: "Document absent" }; await write(path, merge(docs.get(path), data)); },
    async delete() { await ready; await write(path, null); },
    onSnapshot(next) { const l = { kind: "doc", path, next }; listeners.add(l); ready.then(() => listeners.has(l) && next(docSnap(path))); return () => listeners.delete(l); },
    collection: (sub) => colRef(path + "/" + sub),
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(path + "/" + (id || newId())),
    async add(data) { const r = docRef(path + "/" + newId()); await r.set(data); return r; },
    async get() { await ready; return colSnap(path); },
    onSnapshot(next) { const l = { kind: "col", path, next }; listeners.add(l); ready.then(() => listeners.has(l) && next(colSnap(path))); return () => listeners.delete(l); },
  });
  const db = { doc: docRef, collection: colRef };

  const assets = {
    async upload(blob) {
      await ready;
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, "0")).join("");
      const buf = await blob.arrayBuffer(), type = blob.type || "image/png";
      await tx(BLOBS, "readwrite", s => s.put({ buf, type }, id));
      const url = URL.createObjectURL(new Blob([buf], { type })); blobUrls.set(id, url);
      return { id, url, sizeBytes: buf.byteLength, contentType: type };
    },
    async delete(id) { await ready; await tx(BLOBS, "readwrite", s => s.delete(id)); const had = blobUrls.delete(id); return { deleted: had }; },
    async list() { return { assets: [], usage: {} }; },
  };

  // ----- Enregistrer un fichier : feuille avec un bouton (le partage iOS exige un geste) -----
  const MIME = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", json: "application/json" };
  function sheet(title, text, okLabel) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div"); wrap.className = "local-sheet";
      wrap.innerHTML = `<div class="local-card" role="dialog" aria-modal="true"><h2></h2><p></p><div class="local-actions"><button type="button" class="btn" data-a="no">Annuler</button><button type="button" class="btn primary" data-a="ok"></button></div></div>`;
      wrap.querySelector("h2").textContent = title; wrap.querySelector("p").textContent = text; wrap.querySelector('[data-a="ok"]').textContent = okLabel;
      (document.querySelector("dialog[open]") || document.body).appendChild(wrap);
      wrap.addEventListener("click", (e) => { const a = e.target.closest("[data-a]"); if (!a) return; resolve({ ok: a.dataset.a === "ok", close: () => wrap.remove(), wrap }); });
    });
  }
  const downloads = {
    async save({ filename, data }) {
      const ext = (filename.split(".").pop() || "").toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || "application/octet-stream" });
      const file = new File([blob], filename, { type: blob.type });
      for (;;) {
        const r = await sheet("Fichier prêt", `${filename} (${Math.max(1, Math.round(blob.size / 1024))} Ko). Enregistrez-le dans Fichiers, envoyez-le ou imprimez-le.`, "Enregistrer ou partager");
        if (!r.ok) { r.close(); throw { code: "declined", message: "Annulé" }; }
        try {
          if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); r.close(); return { status: "saved" }; }
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
          r.close(); return { status: "saved" };
        } catch (e) { r.close(); if (!(e && e.name === "AbortError")) throw { code: "unavailable", message: String(e) }; }
      }
    },
  };

  const user = { can: async () => true, canEdit: async () => true, isOwner: async () => true, id: async () => "local", me: async () => ({ id: "local", name: "" }), profiles: async () => ({}) };
  const caps = { db, assets, downloads, user };
  window.claude = { use: async (name) => { await ready.catch(() => {}); return idb ? (caps[name] || null) : null; } };

  // ----- Sauvegarde / restauration complète -----
  const b64 = (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (str) => { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  async function backup() {
    await ready;
    const out = { app: "cellier-confitures", version: 1, date: new Date().toISOString(), docs: Object.fromEntries(docs), blobs: {} };
    for (const [id, v] of await allEntries(BLOBS)) out.blobs[id] = { type: v.type, data: b64(v.buf) };
    const day = new Date().toISOString().slice(0, 10);
    try { await downloads.save({ filename: `Sauvegarde-cellier-${day}.json`, data: JSON.stringify(out) }); } catch (e) {}
  }
  async function restore(fileObj) {
    let data;
    try { data = JSON.parse(await fileObj.text()); } catch (e) { alertSheet("Fichier illisible", "Choisissez un fichier de sauvegarde .json créé par l'application."); return; }
    if (!data || data.app !== "cellier-confitures" || typeof data.docs !== "object") { alertSheet("Ce n'est pas une sauvegarde du cellier", "Choisissez un fichier « Sauvegarde-cellier-….json »."); return; }
    const nDocs = Object.keys(data.docs).length;
    const r = await sheet("Remplacer vos données ?", `La sauvegarde du ${new Date(data.date).toLocaleDateString("fr-CH")} (${nDocs} éléments) va remplacer tout ce qui est enregistré sur cet appareil.`, "Remplacer mes données");
    r.close(); if (!r.ok) return;
    await ready;
    await tx(DOCS, "readwrite", s => s.clear()); await tx(BLOBS, "readwrite", s => s.clear());
    await tx(DOCS, "readwrite", s => { for (const [k, v] of Object.entries(data.docs)) s.put(v, k); });
    await tx(BLOBS, "readwrite", s => { for (const [k, v] of Object.entries(data.blobs || {})) s.put({ type: v.type, buf: unb64(v.data) }, k); });
    location.reload();
  }
  async function alertSheet(t, m) { const r = await sheet(t, m, "OK"); r.close(); }

  document.addEventListener("DOMContentLoaded", () => {
    const tools = document.querySelector(".tools"); if (!tools) return;
    const bk = document.createElement("button"); bk.className = "btn"; bk.id = "backupBtn"; bk.textContent = "Sauvegarder";
    const rs = document.createElement("label"); rs.className = "btn"; rs.htmlFor = "restoreInput"; rs.textContent = "Restaurer"; rs.setAttribute("role", "button"); rs.tabIndex = 0;
    const inp = document.createElement("input"); inp.type = "file"; inp.id = "restoreInput"; inp.accept = ".json,application/json"; inp.hidden = true;
    bk.onclick = backup;
    inp.onchange = () => { const f = inp.files && inp.files[0]; inp.value = ""; if (f) restore(f); };
    tools.prepend(bk, rs, inp);
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
