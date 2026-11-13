// App do painel e da gestão: instalar, avisos (notificações) e funcionar sem internet.
// Sem internet: as telas abrem a partir da cópia guardada; os dados da gestão ficam salvos no próprio aparelho.
const CACHE = "inga-app-v1";
const SHELL = ["/gestao", "/admin", "/logo-inga-400.png", "/admin-icon-192.png", "/favicon-64.png", "/admin.webmanifest"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // páginas do app: tenta a internet; sem conexão, usa a última cópia
  if (req.mode === "navigate" && /^\/(gestao|admin)/.test(url.pathname)) {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname.startsWith("/admin") ? "/admin" : "/gestao", cp)); }
      return r;
    }).catch(() => caches.match(url.pathname.startsWith("/admin") ? "/admin" : "/gestao")));
    return;
  }
  // imagens e ícones do app: cópia guardada primeiro
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(url.pathname).then((m) => m || fetch(req)));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Pousada Ingá", {
    body: d.body || "",
    icon: "/admin-icon-192.png",
    badge: "/admin-icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || "/gestao" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/gestao", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes("/gestao") && "focus" in c) { await c.focus(); if ("navigate" in c) await c.navigate(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});
