/* =====================================================================
   Trabajador en segundo plano · Reportes Ama de Llaves (Home Vacations CR)
   · Recibe las notificaciones aunque el sistema esté cerrado o el celular en reposo.
   · Al tocar una notificación abre el sistema en el caso correspondiente.
   · Permite instalar el sitio como app. No guarda copias viejas del sistema:
     siempre carga la versión más reciente de GitHub (solo usa la copia si no hay internet).
   ===================================================================== */
const VERSION = 'v1';
const CACHE = 'ama-llaves-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './iconos/icono-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Primero internet; si no hay conexión, la última copia guardada de la página
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) { const c = await caches.open(CACHE); c.put('./', r.clone()); }
      return r;
    } catch (err) {
      return (await caches.match('./')) || Response.error();
    }
  })());
});

/* ---------- Notificación recibida ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  const nuevo = /^Nuevo reporte/i.test(d.body || '');
  const titulo = (nuevo ? '🔔 ' : '📬 ') + (d.title || 'Reportes Ama de Llaves');
  e.waitUntil((async () => {
    await self.registration.showNotification(titulo, {
      body: d.body || 'Hay una novedad en un reporte',
      icon: './iconos/icono-192.png',
      badge: './iconos/badge-96.png',
      tag: d.tag || 'ama-llaves',
      renotify: true,
      requireInteraction: nuevo,          // los reportes nuevos se quedan en pantalla hasta tocarlos
      vibrate: [250, 120, 250, 120, 250],
      timestamp: Date.now(),
      data: { url: d.url || './', reporte_id: d.reporte_id || null }
    });
    if (d.badge && self.navigator.setAppBadge) { try { await self.navigator.setAppBadge(d.badge); } catch (err) {} }
    // Si el sistema está abierto, que actualice la campana y los casos
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      c.postMessage({ tipo: 'push', reporte_id: d.reporte_id || null });
  })());
});

/* ---------- Tocar la notificación: abre el caso ---------- */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { url, reporte_id } = e.notification.data || {};
  e.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const abierta = ventanas.find(c => c.url.startsWith(self.registration.scope));
    if (abierta) {
      await abierta.focus();
      if (reporte_id) abierta.postMessage({ tipo: 'abrir-caso', reporte_id });
      return;
    }
    await self.clients.openWindow(new URL(url || './', self.registration.scope).href);
  })());
});
