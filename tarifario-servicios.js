// =====================================================
// TARIFARIO → SERVICIOS
// Las tarifas aprobadas (Tarifario final) alimentan el catálogo de Servicios:
//   · Operadores: si el operador no existe en Servicios, se crea (con su contacto y políticas).
//   · Servicios: cada servicio del tarifario crea o actualiza su servicio del catálogo,
//     con el tipo de actividad que tiene en Clasificar. Los nuevos se crean OCULTOS (inactivos)
//     para completar descripción, horarios y traducciones antes de mostrarlos al cliente.
//   · Precios: rack = precio TC; neto = neto del operador con IVA (si aplica).
//     Se usa la temporada vigente hoy; si hoy no hay ninguna, la próxima que empieza.
//     Así el precio cambia solo cuando cambia la temporada.
//   · Propiedades no se tocan.
// La actualización es automática (al cambiar algo del tarifario y al entrar al panel)
// y solo la hace un administrador. La pestaña "Servicios" del Tarifario muestra qué se envía.
// Usa utilidades de panel.js, servicios.js y tarifario.js.
// Mientras el panel siga tomando los precios de servicio_precios (hasta la etapa 3 del plan),
// esta copia se mantiene. Las categorías usan la equivalencia de Tarifario › Ajustes (tar_categorias).
// =====================================================

const tarSync = {
  plan: null, planHora: 0, cargando: false, corriendo: false, pendiente: false, propio: false,
  error: null, faltaSql: false,
  vinculos: new Map(),     // servicio_id del catálogo → { temporadas, fecha, operador, servicio }
  opVinculados: new Set(), // operador_id del catálogo que vienen del tarifario
  inicial: false, espera: null
};

// ---------- Detectar cambios del tarifario para actualizar Servicios solo ----------
const tarFromOriginal = db.from.bind(db);
db.from = function (tabla) {
  const q = tarFromOriginal(tabla);
  if (["tar_tarifas", "tar_fichas", "tar_operadores", "tar_ajustes", "tar_categorias"].includes(tabla)) {
    ["insert", "update", "upsert", "delete"].forEach((m) => {
      const original = q[m]?.bind(q);
      if (original) q[m] = (...args) => { tarProgramarSync(); return original(...args); };
    });
  }
  return q;
};

function tarProgramarSync() {
  if (tarSync.propio || !tarEsAdmin()) return;
  clearTimeout(tarSync.espera);
  tarSync.espera = setTimeout(() => tarSincronizar({ silencioso: true }), 4000);
}

// Al entrar al panel (una vez por carga): así el precio cambia solo cuando empieza otra temporada
document.addEventListener("tablero-actualizado", () => {
  if (tarSync.inicial || !tarEsAdmin()) return;
  tarSync.inicial = true;
  tarSincronizar({ silencioso: true });
});

// También poco después de que el administrador inicia sesión
function tarSyncInicio() {
  if (tarSync.inicial || !tarEsAdmin()) return;
  tarSync.inicial = true;
  setTimeout(() => tarSincronizar({ silencioso: true }), 3000);
}
new MutationObserver(tarSyncInicio).observe($("usuarioNombre"), { childList: true, characterData: true, subtree: true });
tarSyncInicio(); // por si el perfil ya se cargó antes que este archivo

// ---------- Categorías: tarifario → tipos de cliente de Servicios ----------
const TAR_SINONIMOS = [
  ["adulto", "adultos", "adult", "adults"],
  ["nino", "ninos", "nina", "ninas", "child", "children", "kid", "kids"],
  ["adulto mayor", "adultos mayores", "senior", "seniors", "ciudadano de oro", "ciudadanos de oro", "tercera edad"],
  ["estudiante", "estudiantes", "student", "students"]
];
const tarNormCat = (s) => tarNorm(String(s ?? "").replace(/\(.*?\)/g, ""));
const tarSingular = (s) => s.replace(/(es|s)$/, "");
function tarCategoriaCliente(nombre) {
  // Primero la equivalencia que definió el administrador (categoria_id vacío = no se muestra)
  const m = tar.mapaCategorias?.get(tarNorm(nombre));
  if (m) return m.categoria_id ? app.categorias.find((c) => c.id === Number(m.categoria_id)) || null : null;
  const n = tarNormCat(nombre);
  const grupo = TAR_SINONIMOS.find((g) => g.includes(n)) || [n];
  return app.categorias.find((c) => grupo.includes(tarNormCat(c.nombre)))
    || app.categorias.find((c) => tarSingular(tarNormCat(c.nombre)) === tarSingular(n));
}

// ---------- Temporada que se usa: la vigente hoy; si no hay, la próxima; si no, la última ----------
const tarRangoCompleto = (t) => [t.fecha_inicio || `${t.anio}-01-01`, t.fecha_fin || `${t.anio}-12-31`];
function tarVigente(filas, hoy) {
  const r = filas.map((t) => { const [ini, fin] = tarRangoCompleto(t); return { t, ini, fin }; });
  const cubre = r.filter((x) => x.ini <= hoy && hoy <= x.fin).sort((a, b) => b.ini.localeCompare(a.ini));
  if (cubre.length) return { t: cubre[0].t, cuando: "vigente" };
  const futuras = r.filter((x) => x.ini > hoy).sort((a, b) => a.ini.localeCompare(b.ini));
  if (futuras.length) return { t: futuras[0].t, cuando: "proxima" };
  return { t: r.sort((a, b) => b.fin.localeCompare(a.fin))[0].t, cuando: "pasada" };
}
const tarEtiquetaTemporada = (t) => `${t.temporada} · ${tarRango(t) || `todo ${t.anio}`}`;

// ---------- Cargar todo lo necesario ----------
async function tarSyncCargar() {
  const Y = new Date().getFullYear();
  const tarifas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await tarFromOriginal("tar_tarifas").select("*").eq("aprobada", true)
      .in("anio", [Y - 1, Y, Y + 1]).order("id").range(desde, desde + 999);
    if (error) throw error;
    tarifas.push(...data);
    if (data.length < 1000) break;
  }
  const [op, fi, aj, prueba1, prueba2, mc] = await Promise.all([
    tarFromOriginal("tar_operadores").select("*"),
    tarFromOriginal("tar_fichas").select("*"),
    tarFromOriginal("tar_ajustes").select("*"),
    tarFromOriginal("tar_fichas").select("servicio_id").limit(1),
    tarFromOriginal("tar_operadores").select("operador_id").limit(1),
    tarFromOriginal("tar_categorias").select("*")
  ]);
  if (!mc.error) tar.mapaCategorias = new Map(mc.data.map((x) => [x.clave, x]));
  for (const r of [op, fi, aj]) if (r.error) throw r.error;
  tarSync.faltaSql = !!(prueba1.error || prueba2.error);
  aj.data.forEach((a) => (tar.ajustes[a.clave] = Number(a.valor)));
  await cargarCatalogos();
  return { tarifas: tarifas.map(tarNormalizar), operadores: op.data, fichas: fi.data };
}

// ---------- Plan: qué hay que crear o cambiar en Servicios ----------
function tarSyncPlan(d) {
  const hoy = aTexto(new Date());
  const tc = Number(tar.ajustes.tipo_cambio) || 0;
  const r2 = (n) => Math.round(n * 100) / 100;

  // Servicios del tarifario (operador + servicio) con tarifas aprobadas
  const grupos = new Map();
  d.tarifas.forEach((t) => {
    const k = `${t.operador_id}|${tarNorm(t.servicio)}`;
    const g = grupos.get(k) || { operador_id: Number(t.operador_id), servicio: t.servicio, clave: tarNorm(t.servicio), filas: [] };
    g.filas.push(t);
    grupos.set(k, g);
  });

  // Operadores que se necesitan
  const conTarifas = new Set([...grupos.values()].map((g) => g.operador_id));
  const ops = d.operadores.filter((o) => conTarifas.has(Number(o.id))).map((o) => {
    let cat = o.operador_id ? app.operadores.find((x) => x.id === Number(o.operador_id)) : null;
    if (!cat) cat = app.operadores.find((x) => tarNorm(x.nombre) === tarNorm(o.nombre));
    return {
      tar: o, cat, crear: !cat,
      vincular: !tarSync.faltaSql && (!cat || Number(o.operador_id) !== cat.id),
      contacto: cat && !cat.contacto && o.contacto ? o.contacto : null
    };
  });
  const opDe = (id) => ops.find((o) => Number(o.tar.id) === Number(id));

  const usados = new Set();
  const items = [...grupos.values()].sort((a, b) =>
    tarNombreOp(a.operador_id).localeCompare(tarNombreOp(b.operador_id), "es") || a.servicio.localeCompare(b.servicio, "es")
  ).map((g) => {
    const op = opDe(g.operador_id);
    const ficha = d.fichas.find((f) => Number(f.operador_id) === g.operador_id && f.clave === g.clave);
    let srv = ficha?.servicio_id ? app.servicios.find((s) => s.id === Number(ficha.servicio_id)) : null;
    if (!srv) srv = app.servicios.find((s) => !usados.has(s.id) && tarNorm(s.nombre) === g.clave
      && (!s.operador_id || (op?.cat && s.operador_id === op.cat.id)));
    if (srv) usados.add(srv.id);

    const avisos = [], precios = [], temporadas = new Set();
    const porCategoria = new Map();
    g.filas.forEach((t) => { const k = tarNormCat(t.categoria); porCategoria.set(k, [...(porCategoria.get(k) || []), t]); });
    [...porCategoria.values()].sort((a, b) => tarOrdenCat(a[0].categoria, b[0].categoria)).forEach((filas) => {
      const { t, cuando } = tarVigente(filas, hoy);
      const categoria = tarCategoriaCliente(t.categoria);
      if (!categoria) {
        if (!tar.mapaCategorias?.has(tarNorm(t.categoria))) avisos.push(`La categoría "${t.categoria}" no tiene equivalencia (Tarifario › Ajustes): no se envía.`);
        return;
      }
      let rack = t.tc, neto = tarCosto(t);
      if (t.moneda === "CRC") {
        if (!tc) return avisos.push(`${t.categoria}: la tarifa está en colones y falta el tipo de cambio en Tarifario › Ajustes.`);
        rack = r2(rack / tc); neto = r2(neto / tc);
      }
      temporadas.add(tarEtiquetaTemporada(t) + (cuando === "proxima" ? " (próxima)" : cuando === "pasada" ? " (ya terminó)" : ""));
      const actual = srv ? app.precios.find((p) => p.servicio_id === srv.id && p.categoria_id === categoria.id) : null;
      const cambia = !actual || Number(actual.precio) !== rack || Number(actual.neto) !== neto;
      precios.push({ categoria, rack, neto, t, actual, cambia });
    });

    const tipo_id = ficha?.tipo_id ? Number(ficha.tipo_id) : null;
    if (!tipo_id) avisos.push("Sin tipo de actividad: asígnalo en Tarifario › Comparar › Clasificar servicios.");
    const cambiosSrv = {};
    if (srv && tipo_id && srv.tipo_id !== tipo_id) cambiosSrv.tipo_id = tipo_id;
    if (srv && op?.cat && srv.operador_id !== op.cat.id) cambiosSrv.operador_id = op.cat.id;
    const temps = [...temporadas];
    const vinculoNuevo = !ficha || Number(ficha.servicio_id) !== srv?.id || JSON.stringify(ficha.sync_info?.temporadas || []) !== JSON.stringify(temps);

    return {
      g, op, ficha, srv, crear: !srv, tipo_id, cambiosSrv, precios, avisos, temporadas: temps,
      incluye: ficha?.incluye || null, vinculoNuevo,
      pendiente: !srv || Object.keys(cambiosSrv).length > 0 || precios.some((p) => p.cambia) || (!tarSync.faltaSql && vinculoNuevo)
    };
  });

  return { ops, items, hoy, pendientes: ops.some((o) => o.crear || o.contacto || o.vincular) || items.some((i) => i.pendiente) };
}

// ---------- Aplicar el plan ----------
async function tarSyncAplicar(plan) {
  const res = { operadores: 0, nuevos: 0, actualizados: 0, precios: 0 };
  const ahora = new Date().toISOString();
  tarSync.propio = true;
  try {
    for (const o of plan.ops) {
      if (o.crear) {
        const { data, error } = await db.from("operadores")
          .insert({ nombre: o.tar.nombre, contacto: o.tar.contacto || null, notas: o.tar.politicas || null, activo: true }).select().single();
        if (error) throw error;
        o.cat = data; res.operadores++;
      } else if (o.contacto) {
        const { error } = await db.from("operadores").update({ contacto: o.contacto }).eq("id", o.cat.id);
        if (error) throw error;
      }
      if (o.vincular) {
        const { error } = await db.from("tar_operadores").update({ operador_id: o.cat.id }).eq("id", o.tar.id);
        if (error) throw error;
      }
    }

    for (const it of plan.items) {
      if (!it.pendiente) continue;
      const opId = it.op?.cat?.id ?? null;
      let srv = it.srv;
      if (!srv) {
        const incluye = tarItems(it.incluye);
        const { data, error } = await db.from("servicios").insert({
          nombre: it.g.servicio, operador_id: opId, tipo_id: it.tipo_id, traducciones: {}, duracion_min: null, horarios: [],
          transporte: "opcional", descripcion: incluye.length ? `Incluye: ${incluye.join(", ")}.` : null, activo: false
        }).select().single();
        if (error) throw error;
        srv = data; res.nuevos++;
      } else {
        const c = { ...it.cambiosSrv };
        if (opId && srv.operador_id !== opId) c.operador_id = opId;
        if (Object.keys(c).length) {
          const { error } = await db.from("servicios").update(c).eq("id", srv.id);
          if (error) throw error;
          res.actualizados++;
        }
      }
      const cambian = it.precios.filter((p) => p.cambia || !it.srv);
      if (cambian.length) {
        const { error } = await db.from("servicio_precios").upsert(cambian.map((p) => ({
          servicio_id: srv.id, categoria_id: p.categoria.id, precio: p.rack, neto: p.neto, actualizado_en: ahora
        })));
        if (error) throw error;
        res.precios += cambian.length;
      }
      if (!tarSync.faltaSql && (it.vinculoNuevo || !it.srv)) {
        const { error } = await db.from("tar_fichas").upsert({
          operador_id: it.g.operador_id, servicio: it.g.servicio, clave: it.g.clave, servicio_id: srv.id,
          sync_info: { temporadas: it.temporadas, fecha: ahora }
        }, { onConflict: "operador_id,clave" });
        if (error) throw error;
      }
    }
  } finally {
    tarSync.propio = false;
  }
  return res;
}

// ---------- Sincronizar (automático o con el botón) ----------
async function tarSincronizar({ silencioso = false } = {}) {
  if (!tarEsAdmin()) return;
  if (tarSync.corriendo) { tarSync.pendiente = true; return; }
  tarSync.corriendo = true;
  try {
    const d = await tarSyncCargar();
    const plan = tarSyncPlan(d);
    let res = null;
    if (plan.pendientes) res = await tarSyncAplicar(plan);
    const d2 = res ? await tarSyncCargar() : d;
    tarSync.plan = tarSyncPlan(d2);
    tarSync.planHora = Date.now();
    tarGuardarVinculos(d2);
    tarSync.error = null;
    const hubo = res && (res.operadores || res.nuevos || res.actualizados || res.precios);
    if (hubo) {
      avisar(`Servicios actualizado desde el tarifario: ${[
        res.nuevos && `${res.nuevos} servicio(s) nuevo(s), ocultos hasta que completes su ficha en Tarifario › Catálogo`,
        res.precios && `${res.precios} precio(s)`,
        res.actualizados && `${res.actualizados} servicio(s) con tipo u operador corregido`,
        res.operadores && `${res.operadores} operador(es) nuevo(s)`
      ].filter(Boolean).join(", ")}.`);
    } else if (!silencioso) avisar("Servicios ya estaba al día con el tarifario.");
    tarRepintarDespuesSync();
  } catch (e) {
    tarSync.error = e;
    if (!silencioso) fallo(e, "No se pudo actualizar Servicios desde el tarifario.");
    else console.error("Tarifario → Servicios:", e);
  } finally {
    tarSync.corriendo = false;
    if (tarSync.pendiente) { tarSync.pendiente = false; tarProgramarSync(); }
  }
}

function tarGuardarVinculos(d) {
  tarSync.vinculos = new Map();
  d.fichas.filter((f) => f.servicio_id).forEach((f) => tarSync.vinculos.set(Number(f.servicio_id), {
    temporadas: f.sync_info?.temporadas || [], fecha: f.sync_info?.fecha,
    operador: d.operadores.find((o) => Number(o.id) === Number(f.operador_id))?.nombre ?? "", servicio: f.servicio
  }));
  tarSync.opVinculados = new Set(d.operadores.filter((o) => o.operador_id).map((o) => Number(o.operador_id)));
}

function tarRepintarDespuesSync() {
  if (!$("vistaServicios").hidden && !catalogo.editando) pintarCatalogo();
  if (!$("vistaTarifario").hidden && ["conexion", "catalogo"].includes(tar.pestana) && !tar.editando) tarPintar();
}

// ---------- Marcas que usa servicios.js ----------
function tarEtiquetaServicio(id) {
  const v = tarSync.vinculos.get(Number(id));
  return v ? ` <span class="tcmp-tipo" title="${escapar(`Del tarifario: ${v.operador} · ${v.temporadas.join(" / ")}`)}">📋 Tarifario</span>` : "";
}
function tarAvisoServicio(id) {
  const v = tarSync.vinculos.get(Number(id));
  if (!v) return "";
  return `<p class="aviso suave">Este servicio se actualiza desde el <strong>Tarifario</strong> (${escapar(v.operador)} · ${escapar(v.servicio)}).
    Temporada usada: ${escapar(v.temporadas.join(" / ") || "—")}. Rack = precio TC y neto = neto del operador con IVA.
    Si cambias aquí los precios de las categorías que vienen del tarifario, se reemplazan en la próxima actualización: para cambiarlos, hazlo en el Tarifario.</p>`;
}
function tarEtiquetaOperador(id) {
  return tarSync.opVinculados.has(Number(id)) ? ` <span class="tcmp-tipo">📋 Tarifario</span>` : "";
}

// =====================================================
// PESTAÑA "SERVICIOS" DEL TARIFARIO: revisar qué se envía
// =====================================================
async function tarSyncPreparar() {
  tarSync.cargando = true;
  try {
    const d = await tarSyncCargar();
    tarSync.plan = tarSyncPlan(d);
    tarSync.planHora = Date.now();
    tarGuardarVinculos(d);
    tarSync.error = null;
  } catch (e) {
    tarSync.error = e;
  } finally {
    tarSync.cargando = false;
  }
  if (!$("vistaTarifario").hidden && tar.pestana === "conexion" && !tar.editando) tarPintar();
}

function tarHtmlConexion() {
  if ((!tarSync.plan || Date.now() - tarSync.planHora > 5000) && !tarSync.cargando && !tarSync.corriendo) {
    tarSyncPreparar();
    if (!tarSync.plan) return `<p class="nota">Revisando el tarifario y Servicios…</p>`;
  }
  if (!tarSync.plan) return tarSync.error
    ? `<p class="aviso">No se pudo revisar la conexión: ${escapar(tarSync.error.message || String(tarSync.error))}</p>`
    : `<p class="nota">Revisando el tarifario y Servicios…</p>`;

  const p = tarSync.plan;
  const nuevos = p.items.filter((i) => i.crear).length;
  const conCambios = p.items.filter((i) => !i.crear && i.pendiente).length;
  const conAvisos = p.items.filter((i) => i.avisos.length).length;
  const opsNuevos = p.ops.filter((o) => o.crear);
  const tipo = (id) => (id ? tarNombreTipo(id) || "—" : `<span class="tar-ojo">Sin tipo</span>`);

  const filas = p.items.map((it) => {
    const destino = it.crear
      ? `<span class="tar-ojo"><strong>Nuevo</strong> · se crea oculto</span>`
      : `${escapar(it.srv.nombre)}<br><span class="nota">${it.srv.activo ? "Activo (lo ven los clientes)" : "Oculto para clientes"}</span>`;
    const precios = it.precios.map((x) => {
      const antes = x.actual && x.cambia ? `<span class="nota"> (antes ${dinero(x.actual.precio)} / ${dinero(x.actual.neto)})</span>` : "";
      return `<div class="${x.cambia ? "tsync-cambia" : ""}">${escapar(x.categoria.nombre)}: <strong>${dinero(x.rack)}</strong> <span class="nota">neto ${dinero(x.neto)}</span>${antes}</div>`;
    }).join("") || `<span class="nota">Ninguno</span>`;
    return `
      <tr class="${it.pendiente ? "tsync-pendiente" : ""}">
        <td><strong>${escapar(tarNombreOp(it.g.operador_id))}</strong></td>
        <td>${escapar(it.g.servicio)}</td>
        <td>${destino}</td>
        <td>${tipo(it.tipo_id)}${it.cambiosSrv.tipo_id ? `<br><span class="nota">se corrige en Servicios</span>` : ""}</td>
        <td>${it.temporadas.map((x) => `<div class="nota">${escapar(x)}</div>`).join("") || "—"}</td>
        <td>${precios}</td>
        <td>${it.avisos.length ? it.avisos.map((a) => `<div class="tar-ojo">${escapar(a)}</div>`).join("") : it.pendiente ? `<span class="tar-ojo">Por actualizar</span>` : `<span class="tcmp-bajo">Al día</span>`}</td>
      </tr>`;
  }).join("");

  return `
    ${tarSync.faltaSql ? `<div class="aviso"><p><strong>Falta preparar la base de datos:</strong> ejecuta una vez el script <strong>tarifario-servicios.sql</strong> en Supabase (SQL Editor). Hasta entonces los servicios se reconocen solo por el nombre.</p></div>` : ""}
    <div class="tar-ayuda">
      <p>Las tarifas <strong>aprobadas</strong> del Tarifario final se envían solas al catálogo de <strong>Servicios</strong> cada vez que cambias algo del tarifario y cada vez que un administrador entra al panel.</p>
      <p><strong>Rack</strong> = precio TC · <strong>Neto</strong> = neto del operador con IVA (si aplica) · se usa la <strong>temporada vigente hoy</strong> (${tarFechaCorta(p.hoy)}); si hoy no hay ninguna, la próxima que empieza. Las tarifas en colones se convierten a dólares con el tipo de cambio de Ajustes.</p>
      <p>Los servicios nuevos se crean <strong>ocultos</strong> en su tipo de actividad: complétalos en Servicios (descripción, horarios, traducciones) y márcalos como Activo para que los vean los clientes. Los operadores que no existan en Servicios se crean con su contacto y políticas. Propiedades no se modifica.</p>
    </div>
    <p class="tar-resumen">
      <span><strong>${p.items.length}</strong> servicios con tarifas aprobadas</span>
      <span class="${nuevos ? "tar-ojo" : ""}"><strong>${nuevos}</strong> por crear</span>
      <span class="${conCambios ? "tar-ojo" : ""}"><strong>${conCambios}</strong> por actualizar</span>
      <span class="${conAvisos ? "tar-alerta" : ""}"><strong>${conAvisos}</strong> con avisos</span>
      ${opsNuevos.length ? `<span class="tar-ojo"><strong>${opsNuevos.length}</strong> operador(es) por crear: ${opsNuevos.map((o) => escapar(o.tar.nombre)).join(", ")}</span>` : ""}
    </p>
    <div class="sec-botones">
      <button type="button" class="btn primario" data-tsync="ahora" ${tarSync.corriendo ? "disabled" : ""}>${p.pendientes ? "Actualizar Servicios ahora" : "Volver a revisar"}</button>
    </div>
    ${p.items.length ? `
      <div class="tabla-scroll">
        <table class="tabla tcmp-tabla">
          <thead><tr><th>Operador</th><th>Servicio en el tarifario</th><th>En Servicios</th><th>Tipo de actividad</th><th>Temporada usada</th><th>Precios (rack / neto)</th><th>Estado</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>` : `<div class="tar-vacio"><p><strong>Todavía no hay tarifas aprobadas.</strong></p><p>Cuando apruebes tarifas en Procesar aparecerán aquí y se enviarán a Servicios.</p></div>`}`;
}

$("tarContenido").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tsync]");
  if (!b || !tarEsAdmin()) return;
  await conBoton(b, () => tarSincronizar({ silencioso: false }));
});
