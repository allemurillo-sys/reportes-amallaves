// =====================================================
// TARIFARIO › COMPARAR (solo administradores)
// Junta en un mismo grupo las actividades iguales o parecidas de distintos operadores
// para comparar netos, precios de venta (Cash y TC) y lo que incluye cada uno.
// También agrega a cada servicio su tipo de actividad (Aventura, Naturaleza…),
// que sirve para filtrar el Tarifario final.
//
// La clasificación vive en la tabla tar_fichas (una ficha por operador + servicio)
// y no depende del año: al importar las tarifas del año siguiente se conserva.
// Usa las utilidades de panel.js, servicios.js (nombreTipo) y tarifario.js.
// =====================================================

tar.fichas = [];
tar.fichasError = null;
tar.comparar = {
  modo: "comparar",            // "comparar" | "clasificar"
  tipo: "", categoria: "Adulto", fecha: "", texto: "", solo2: true,
  // filtros de Clasificar
  operador: "", buscar: "", sinClasificar: false
};
tar.cmpServicios = [];          // servicios pintados en Clasificar (para saber a cuál pertenece cada casilla)
tar.cmpUltimoIncluye = null;    // última casilla "Incluye" usada (para los botones de elementos ya usados)

// ---------- Datos ----------
async function tarLeerFichas() {
  const { data, error } = await db.from("tar_fichas").select("*");
  tar.fichasError = error || null;
  tar.fichas = error ? [] : data.map((f) => ({
    ...f, operador_id: Number(f.operador_id), tipo_id: f.tipo_id == null ? null : Number(f.tipo_id)
  }));
}

const tarFicha = (operador_id, servicio) =>
  tar.fichas.find((f) => f.operador_id === Number(operador_id) && f.clave === tarNorm(servicio));
const tarTipos = () => app.tipos || [];
const tarTipoPorId = (id) => tarTipos().find((x) => x.id === Number(id));
const tarNombreTipo = (id) => { const tp = tarTipoPorId(id); return tp ? nombreTipo(tp) : ""; };
const tarTipoDe = (t) => tarFicha(t.operador_id, t.servicio)?.tipo_id ?? null;
const tarTipoOrden = (id) => { const i = tarTipos().findIndex((x) => x.id === Number(id)); return i < 0 ? 999 : i; };

// "Transporte, almuerzo; guía" → ["Transporte", "almuerzo", "guía"]
const tarItems = (texto) => String(texto ?? "").split(/[,;\n•]+/).map((s) => s.trim()).filter(Boolean);

// Guarda (o crea) la ficha de un servicio. cambios: { tipo_id?, comparar?, incluye? }
async function tarGuardarFicha(operador_id, servicio, cambios) {
  if (tar.fichasError) { avisar("Primero hay que ejecutar el script tarifario-comparar.sql en Supabase.", "error"); return false; }
  const fila = { operador_id: Number(operador_id), servicio, clave: tarNorm(servicio), ...cambios, actualizado: new Date().toISOString() };
  const { data, error } = await db.from("tar_fichas").upsert(fila, { onConflict: "operador_id,clave" }).select().single();
  if (error) { fallo(error); return false; }
  const nueva = { ...data, operador_id: Number(data.operador_id), tipo_id: data.tipo_id == null ? null : Number(data.tipo_id) };
  const i = tar.fichas.findIndex((f) => f.id === nueva.id);
  if (i < 0) tar.fichas.push(nueva); else tar.fichas[i] = nueva;
  return true;
}

// Si se cambia el nombre o el operador de un servicio en el editor, la ficha lo sigue
async function tarMoverFicha(opAntes, servAntes, opAhora, servAhora) {
  if (tar.fichasError) return;
  if (Number(opAntes) === Number(opAhora) && tarNorm(servAntes) === tarNorm(servAhora)) return;
  const vieja = tarFicha(opAntes, servAntes);
  if (!vieja || tarFicha(opAhora, servAhora)) return;
  await tarGuardarFicha(opAhora, servAhora, { tipo_id: vieja.tipo_id, comparar: vieja.comparar, incluye: vieja.incluye });
}

// Al importar un Excel con columnas "Tipo de actividad", "Comparar como" o "Incluye"
async function tarGuardarFichasImportadas(filas, ids) {
  const porServicio = new Map();
  filas.forEach((f) => {
    if (f.tipo_id == null && !f.comparar && !f.incluye) return;
    const operador_id = ids[tarNorm(f.operador)];
    const k = `${operador_id}|${tarNorm(f.servicio)}`;
    const c = porServicio.get(k) || { operador_id, servicio: f.servicio, cambios: {} };
    if (f.tipo_id != null) c.cambios.tipo_id = f.tipo_id;
    if (f.comparar) c.cambios.comparar = f.comparar;
    if (f.incluye) c.cambios.incluye = f.incluye;
    porServicio.set(k, c);
  });
  if (!porServicio.size) return 0;
  if (tar.fichasError) { avisar("Las tarifas se importaron, pero el tipo de actividad e Incluye no se guardaron: falta ejecutar tarifario-comparar.sql.", "error"); return 0; }
  let n = 0;
  for (const c of porServicio.values()) if (await tarGuardarFicha(c.operador_id, c.servicio, c.cambios)) n++;
  return n;
}

// Columna "Tipo de actividad" del Excel → id del tipo (undefined si no existe)
function tarTipoCelda(v) {
  const s = tarNorm(v);
  if (!s) return null;
  const sinIcono = (x) => tarNorm(String(x).replace(/^[^\p{L}\p{N}]+/u, ""));
  return tarTipos().find((tp) => tarNorm(tp.nombre) === sinIcono(s) || tarNorm(nombreTipo(tp)) === s)?.id;
}

// ---------- Parecido entre nombres (para sugerir grupos) ----------
const TAR_VACIAS = new Set("tour tours de del la las el los en y con a al the and of in on with by para por o or e".split(" "));
const tarPalabras = (s) => tarNorm(s).replace(/[^a-z0-9ñ]+/g, " ").split(" ").filter((w) => w.length > 1 && !TAR_VACIAS.has(w));

function tarParecido(a, b) {
  const A = new Set(tarPalabras(a)), B = new Set(tarPalabras(b));
  if (!A.size || !B.size) return { puntos: 0, comunes: [] };
  const comunes = [...A].filter((w) => B.has(w));
  return { puntos: comunes.length / Math.min(A.size, B.size) + comunes.length / (A.size + B.size), comunes };
}

// Sugerencia de "Comparar como" y de tipo para un servicio, a partir de otros servicios parecidos
// (de otros operadores o del mismo operador)
function tarSugerencia(s) {
  let mejor = null;
  tar.cmpTodos.forEach((o) => {
    if (o.operador_id === s.operador_id && tarNorm(o.servicio) === tarNorm(s.servicio)) return;
    const p = tarParecido(s.servicio, o.ficha?.comparar || o.servicio);
    if (p.puntos < 0.75) return;
    if (!mejor || p.puntos > mejor.p.puntos) mejor = { o, p };
  });
  const sug = {};
  if (mejor) {
    const { o, p } = mejor;
    sug.de = o;
    // Si el otro ya tiene grupo, se usa ese; si no, las palabras en común ("Rafting Balsa")
    sug.comparar = o.ficha?.comparar || s.servicio.split(/\s+/).filter((w) => p.comunes.includes(tarPalabras(w)[0])).join(" ") || o.servicio;
    if (o.ficha?.tipo_id) sug.tipo_id = o.ficha.tipo_id;
  }
  // El tipo también se puede tomar del catálogo de Servicios si hay uno con el mismo nombre
  const enCatalogo = (app.servicios || []).find((x) => tarNorm(x.nombre) === tarNorm(s.servicio) && x.tipo_id);
  if (enCatalogo) sug.tipo_id = enCatalogo.tipo_id;
  // Último recurso: el nombre del servicio contiene el nombre del tipo ("Termales Baldi" → Termales)
  if (!sug.tipo_id) {
    const palabras = tarPalabras(s.servicio).map((w) => w.slice(0, 5));
    const tp = tarTipos().find((x) => tarPalabras(x.nombre).some((w) => w.length >= 5 && palabras.includes(w.slice(0, 5))));
    if (tp) sug.tipo_id = tp.id;
  }
  return sug;
}

// Todos los servicios (operador + servicio) que tienen tarifas en el año elegido
function tarServiciosDelAnio() {
  const mapa = new Map();
  tar.tarifas.forEach((t) => {
    const k = `${t.operador_id}|${tarNorm(t.servicio)}`;
    const s = mapa.get(k) || { operador_id: t.operador_id, servicio: t.servicio, tarifas: 0, aprobadas: 0 };
    s.tarifas++; if (t.aprobada) s.aprobadas++;
    mapa.set(k, s);
  });
  return [...mapa.values()]
    .map((s) => ({ ...s, ficha: tarFicha(s.operador_id, s.servicio) }))
    .sort((a, b) => tarNombreOp(a.operador_id).localeCompare(tarNombreOp(b.operador_id), "es") || a.servicio.localeCompare(b.servicio, "es"));
}
const tarClasificado = (s) => s.ficha?.tipo_id && s.ficha?.comparar;

// =====================================================
// PESTAÑA COMPARAR
// =====================================================
function tarHtmlComparar() {
  tar.cmpTodos = tarServiciosDelAnio();
  const faltan = tar.cmpTodos.filter((s) => !tarClasificado(s)).length;
  const c = tar.comparar;
  const aviso = tar.fichasError ? `
    <div class="aviso tar-no-imprimir">
      <p><strong>Falta preparar la base de datos para esta sección.</strong> Ejecuta una vez el script <strong>tarifario-comparar.sql</strong> en Supabase (SQL Editor).
      Mientras tanto la comparación solo junta servicios que se llaman exactamente igual y no se puede guardar la clasificación.</p>
    </div>` : "";
  return `
    <div class="tar-filtros tar-opciones tar-no-imprimir">
      <div class="tcmp-modos" role="group" aria-label="Modo">
        <button type="button" class="btn ${c.modo === "comparar" ? "primario" : ""}" data-tcmp="modo" data-modo="comparar">Comparar proveedores</button>
        <button type="button" class="btn ${c.modo === "seleccion" ? "primario" : ""}" data-tcmp="modo" data-modo="seleccion">
          Selección <span class="tcmp-cuenta verde" id="tcmpCuentaSel" ${tarSeleccionadas().length ? "" : "hidden"}>${tarSeleccionadas().length}</span></button>
        <button type="button" class="btn ${c.modo === "clasificar" ? "primario" : ""}" data-tcmp="modo" data-modo="clasificar">
          Clasificar servicios${faltan ? ` <span class="tcmp-cuenta">${faltan}</span>` : ""}</button>
      </div>
    </div>
    ${aviso}
    ${c.modo === "clasificar" ? tarHtmlClasificar() : c.modo === "seleccion" ? tarHtmlSeleccion() : tarHtmlCompararVista() + tarHtmlBarraSel()}`;
}

// ---------- Comparación ----------
function tarConvertir(monto, moneda, base) {
  if (monto == null) return null;
  if (moneda === base) return monto;
  const tc = Number(tar.ajustes.tipo_cambio) || 0;
  if (!tc) return null;
  return base === "USD" ? monto / tc : monto * tc;
}

function tarGruposComparar() {
  const c = tar.comparar, txt = tarNorm(c.texto);
  const vigentes = tar.tarifas.filter((t) => t.aprobada
    && (!c.fecha || ((!t.fecha_inicio || t.fecha_inicio <= c.fecha) && (!t.fecha_fin || t.fecha_fin >= c.fecha))));

  const grupos = new Map();
  vigentes.forEach((t) => {
    const ficha = tarFicha(t.operador_id, t.servicio);
    const k = tarNorm(ficha?.comparar || t.servicio);
    const g = grupos.get(k) || { clave: k, nombre: ficha?.comparar || t.servicio, miembros: new Map(), tarifas: [] };
    const mk = `${t.operador_id}|${tarNorm(t.servicio)}`;
    if (!g.miembros.has(mk)) g.miembros.set(mk, { operador_id: t.operador_id, servicio: t.servicio, ficha, temporadas: new Set() });
    g.miembros.get(mk).temporadas.add(tarClaveGrupo(t));
    g.tarifas.push(t);
    grupos.set(k, g);
  });

  return [...grupos.values()].map((g) => {
    const miembros = [...g.miembros.values()];
    const tipos = [...new Set(miembros.map((m) => m.ficha?.tipo_id).filter(Boolean))];
    const operadores = new Set(miembros.map((m) => m.operador_id));
    const filas = g.tarifas.filter((t) => tarNorm(t.categoria) === tarNorm(c.categoria));
    const conCategoria = new Set(filas.map((t) => `${t.operador_id}|${tarNorm(t.servicio)}`));
    return {
      ...g, miembros, tipos, operadores, filas,
      sinCategoria: miembros.filter((m) => !conCategoria.has(`${m.operador_id}|${tarNorm(m.servicio)}`)),
      variasTemporadas: miembros.some((m) => m.temporadas.size > 1)
    };
  }).filter((g) =>
    (!c.solo2 || g.miembros.length >= 2)
    && (!c.tipo || (c.tipo === "sin" ? !g.tipos.length : g.tipos.includes(Number(c.tipo))))
    && (!txt || tarNorm([g.nombre, ...g.miembros.flatMap((m) => [m.servicio, tarNombreOp(m.operador_id), m.ficha?.incluye, tarNombreTipo(m.ficha?.tipo_id)])].join(" ")).includes(txt))
  ).sort((a, b) => tarTipoOrden(a.tipos[0]) - tarTipoOrden(b.tipos[0]) || a.nombre.localeCompare(b.nombre, "es"));
}

function tarHtmlCompararVista() {
  const c = tar.comparar;
  const categorias = [...new Set([...TAR_CATEGORIAS, ...tar.tarifas.filter((t) => t.aprobada).map((t) => t.categoria)])]
    .filter((x, i, arr) => arr.findIndex((y) => tarNorm(y) === tarNorm(x)) === i).sort(tarOrdenCat);
  const grupos = tarGruposComparar();
  const aprobadas = tar.tarifas.filter((t) => t.aprobada).length;

  const filtroTexto = [
    c.tipo ? (c.tipo === "sin" ? "Sin tipo" : tarNombreTipo(c.tipo)) : "", `Categoría: ${c.categoria}`,
    c.fecha ? `Vigentes el ${tarFechaCorta(c.fecha)}` : "", c.texto ? `Búsqueda: ${c.texto}` : ""
  ].filter(Boolean).join(" · ");

  let contenido;
  if (!aprobadas) contenido = `<div class="tar-vacio"><p><strong>Todavía no hay tarifas aprobadas en ${tar.anio}.</strong></p>
      <p>La comparación usa el Tarifario final: aprueba las tarifas en Procesar y aparecerán aquí.</p></div>`;
  else if (!grupos.length) contenido = `<div class="tar-vacio"><p><strong>No hay actividades para comparar con estos filtros.</strong></p>
      <p>${c.solo2 ? "Solo se muestran actividades con 2 o más servicios para comparar. " : ""}Para juntar servicios con nombres distintos (por ejemplo "Canopy Tour" y "Zipline 12 cables"), ponles el mismo nombre en "Comparar como" dentro de <button type="button" class="enlace" data-tcmp="modo" data-modo="clasificar">Clasificar servicios</button>.</p></div>`;
  else contenido = grupos.map(tarHtmlGrupoComparar).join("");

  return `
    <div class="tar-filtros">
      ${tarHtmlAnio()}
      <label>Tipo de actividad <select data-tcmp-filtro="tipo">${tarOpcionesTipos(c.tipo)}</select></label>
      <label class="tar-filtro-corto">Categoría
        <select data-tcmp-filtro="categoria">${categorias.map((x) => `<option ${tarNorm(x) === tarNorm(c.categoria) ? "selected" : ""}>${escapar(x)}</option>`).join("")}</select>
      </label>
      <label class="tar-filtro-corto">Vigentes el <input type="date" value="${c.fecha}" data-tcmp-filtro="fecha"></label>
      <label class="tar-buscar">Buscar <input id="tarBuscarCmp" type="search" value="${escapar(c.texto)}" placeholder="Actividad, operador o lo que incluye" data-tcmp-filtro="texto"></label>
    </div>
    <div class="tar-filtros tar-opciones tar-no-imprimir">
      <label class="check-linea chico"><input type="checkbox" data-tcmp-filtro="solo2" ${c.solo2 ? "checked" : ""}> Solo actividades con 2 o más servicios para comparar</label>
      <span class="tar-espacio"></span>
      ${grupos.length ? `<button type="button" class="btn primario" data-tar="imprimir">Imprimir</button>` : ""}
    </div>
    <div class="tar-ayuda tar-no-imprimir">
      <p>Se comparan las tarifas <strong>aprobadas</strong> (Tarifario final) de la categoría elegida, ordenadas de la más barata a la más cara según el neto.
        El <strong>Neto</strong> ya incluye el IVA cuando la tarifa tiene la casilla IVA marcada. Debajo de cada precio se ve cuánto más cuesta que el más bajo.
        Marca con la casilla las opciones que te interesen y ábrelas en <strong>Selección</strong> para verlas juntas, de la más barata a la más cara, y ajustar sus precios.</p>
      <p>En <strong>Incluye</strong>, lo marcado con ✚ solo lo ofrecen algunos operadores, y "No incluye" muestra lo que otros sí dan.
        ${tar.ajustes.tipo_cambio ? `Las tarifas en colones se comparan con las de dólares usando el tipo de cambio de Ajustes (₡${tar.ajustes.tipo_cambio}).` : "Para comparar tarifas en colones con tarifas en dólares, escribe el tipo de cambio en Ajustes."}</p>
    </div>
    <div class="solo-impresion tar-imp-cabeza">
      <p class="imp-marca">The House of Tours</p>
      <p class="imp-titulo">Comparación de operadores ${tar.anio}</p>
      <p class="nota">${escapar(filtroTexto)}</p>
    </div>
    ${grupos.length ? `<p class="tar-resumen tar-no-imprimir"><span><strong>${grupos.length}</strong> actividades</span></p>` : ""}
    ${contenido}`;
}

function tarOpcionesTipos(sel, vacio = "Todos los tipos") {
  return `<option value="">${vacio}</option>`
    + tarTipos().map((tp) => `<option value="${tp.id}" ${String(tp.id) === String(sel) ? "selected" : ""}>${escapar(nombreTipo(tp))}</option>`).join("")
    + `<option value="sin" ${sel === "sin" ? "selected" : ""}>Sin tipo asignado</option>`;
}

function tarHtmlGrupoComparar(g) {
  // Moneda en que se compara: la de todas si es la misma; si se mezclan, dólares (con tipo de cambio)
  const monedas = new Set(g.filas.map((t) => t.moneda));
  const base = monedas.size === 1 ? [...monedas][0] : "USD";
  const filas = g.filas.map((t) => ({
    t,
    neto: tarConvertir(tarCosto(t), t.moneda, base),
    cash: tarSinCash(t) ? null : tarConvertir(t.cash, t.moneda, base),
    tc: tarConvertir(t.tc, t.moneda, base)
  })).sort((a, b) => (a.neto ?? Infinity) - (b.neto ?? Infinity) || tarNombreOp(a.t.operador_id).localeCompare(tarNombreOp(b.t.operador_id), "es"));

  const minimo = (campo) => {
    const v = filas.map((f) => f[campo]).filter((x) => x != null);
    return v.length >= 2 ? { min: Math.min(...v), max: Math.max(...v) } : null;
  };
  const rangos = { neto: minimo("neto"), cash: minimo("cash"), tc: minimo("tc") };
  const resumen = [["neto", "Neto"], ["cash", "Cash"], ["tc", "TC"]].filter(([k]) => rangos[k]).map(([k, n]) => {
    const r = rangos[k];
    return r.max > r.min
      ? `<span>${n}: <strong>${tarDinero(r.min, base)} – ${tarDinero(r.max, base)}</strong> <span class="tcmp-dif">(diferencia ${tarDinero(r.max - r.min, base)})</span></span>`
      : `<span>${n}: <strong>${tarDinero(r.min, base)}</strong> <span class="tcmp-dif">(igual en todos)</span></span>`;
  }).join("");

  // Lo que incluye cada servicio: qué es común y qué no
  const conInfo = g.miembros.filter((m) => tarItems(m.ficha?.incluye).length);
  const itemsDe = (m) => tarItems(m.ficha?.incluye);
  const todos = new Map();
  conInfo.forEach((m) => itemsDe(m).forEach((x) => { if (!todos.has(tarNorm(x))) todos.set(tarNorm(x), x); }));
  const enTodos = (k) => conInfo.every((m) => itemsDe(m).some((x) => tarNorm(x) === k));
  const htmlIncluye = (t) => {
    const m = g.miembros.find((x) => x.operador_id === t.operador_id && tarNorm(x.servicio) === tarNorm(t.servicio));
    const items = itemsDe(m);
    if (!items.length) return `<span class="nota">Sin información</span>`;
    const propios = new Set(items.map(tarNorm));
    const faltan = conInfo.length > 1 ? [...todos.keys()].filter((k) => !propios.has(k)).map((k) => todos.get(k)) : [];
    return `<ul class="tcmp-items">${items.map((x) => {
      const extra = conInfo.length > 1 && !enTodos(tarNorm(x));
      return `<li class="${extra ? "extra" : ""}">${extra ? `<span aria-hidden="true">✚ </span>` : ""}${escapar(x)}</li>`;
    }).join("")}</ul>${faltan.length ? `<p class="tcmp-falta">No incluye: ${faltan.map(escapar).join(", ")}</p>` : ""}`;
  };

  const celda = (f, campo) => {
    const t = f.t;
    if (campo === "cash" && tarSinCash(t)) return `<span class="nota">Sin Cash</span>`;
    const original = campo === "neto" ? tarCosto(t) : t[campo];
    const r = rangos[campo];
    let extra = "";
    if (f[campo] == null) extra = `<span class="tcmp-dif">no se compara (falta tipo de cambio)</span>`;
    else if (r && r.max > r.min) {
      extra = f[campo] === r.min
        ? `<span class="tcmp-bajo">más bajo</span>`
        : `<span class="tcmp-dif">+${tarDinero(f[campo] - r.min, base)} (+${((f[campo] / r.min - 1) * 100).toFixed(0)} %)</span>`;
    }
    const conv = t.moneda !== base && f[campo] != null ? `<span class="tcmp-dif">≈ ${tarDinero(f[campo], base)}</span>` : "";
    const sinIva = campo === "neto" && tarConIva(t) ? `<span class="tcmp-dif">IVA incluido</span>` : "";
    return `<span class="tcmp-monto ${f[campo] != null && r && f[campo] === r.min && r.max > r.min ? "minimo" : ""}">${tarDinero(original, t.moneda)}</span>${conv}${sinIva}${extra}`;
  };

  const tipos = g.tipos.map((id) => `<span class="tcmp-tipo">${escapar(tarNombreTipo(id))}</span>`).join("");
  const notas = [
    g.variasTemporadas && !tar.comparar.fecha ? "Hay servicios con varias temporadas: elige una fecha en \"Vigentes el\" para comparar los precios de un mismo día." : "",
    g.sinCategoria.length ? `Sin tarifa ${escapar(tar.comparar.categoria)}: ${g.sinCategoria.map((m) => `${escapar(m.servicio)} (${escapar(tarNombreOp(m.operador_id))})`).join(", ")}.` : ""
  ].filter(Boolean);

  return `
    <section class="det-seccion sin-margen tcmp-grupo">
      <div class="tcmp-cabeza">
        <h3>${escapar(g.nombre)}</h3>${tipos}
        <span class="chip-gris">${g.miembros.length} servicios · ${g.operadores.size} ${g.operadores.size === 1 ? "operador" : "operadores"}</span>
        ${filas.length ? `<button type="button" class="enlace tcmp-sel-grupo tar-no-imprimir" data-tcmp="sel-grupo" data-ids="${filas.map((f) => f.t.id).join(",")}">${filas.every((f) => tar.seleccion.has(f.t.id)) ? "Quitar de la selección" : "Seleccionar todas"}</button>` : ""}
      </div>
      ${resumen ? `<p class="tcmp-resumen">${resumen}</p>` : ""}
      ${filas.length ? `
        <div class="tabla-scroll">
          <table class="tabla tcmp-tabla">
            <thead><tr><th class="tar-no-imprimir"><span class="solo-lector">Seleccionar</span></th><th>Operador</th><th>Servicio</th><th>Incluye</th><th class="num">Neto</th><th class="num">Cash</th><th class="num">TC</th></tr></thead>
            <tbody>${filas.map((f) => `
              <tr class="${tar.seleccion.has(f.t.id) ? "tcmp-elegida" : ""}">
                <td class="centro tar-no-imprimir"><input type="checkbox" class="tar-check" data-tcmp-sel data-id="${f.t.id}" ${tar.seleccion.has(f.t.id) ? "checked" : ""}
                  aria-label="Seleccionar ${escapar(`${f.t.servicio} ${tarNombreOp(f.t.operador_id)}`)}"></td>
                <td><strong>${escapar(tarNombreOp(f.t.operador_id))}</strong></td>
                <td>${escapar(f.t.servicio)}<br><span class="nota">${escapar(f.t.temporada)}${tarRango(f.t) ? ` · ${tarRango(f.t)}` : ""}</span>${f.t.notas ? `<br><span class="nota">${escapar(f.t.notas)}</span>` : ""}</td>
                <td>${htmlIncluye(f.t)}</td>
                <td class="num">${celda(f, "neto")}</td>
                <td class="num">${celda(f, "cash")}</td>
                <td class="num">${celda(f, "tc")}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : ""}
      ${notas.map((n) => `<p class="nota tcmp-nota">${n}</p>`).join("")}
    </section>`;
}

// =====================================================
// SELECCIÓN: las tarifas que el agente marcó, de la más barata a la más cara,
// con la diferencia respecto a la de neto más bajo. Los precios se editan aquí mismo
// y el cambio se guarda en la tarifa: se ve igual en Procesar, Tarifario final y Comparar.
// =====================================================
const TAR_SEL_CLAVE = "tarSeleccion";
tar.seleccion = new Set((() => { try { return JSON.parse(localStorage.getItem(TAR_SEL_CLAVE) || "[]"); } catch { return []; } })().map(Number));
tar.selDeshacer = null;   // precios anteriores al último ajuste en bloque
tar.selAjuste = { campo: "ambos", accion: "subir", valor: "", redondear: false };

function tarRecordarSel() {
  try { localStorage.setItem(TAR_SEL_CLAVE, JSON.stringify([...tar.seleccion])); } catch { /* sin almacenamiento: solo en esta sesión */ }
}
const tarSeleccionadas = () => tar.tarifas.filter((t) => tar.seleccion.has(t.id));

function tarHtmlBarraSel() {
  const n = tarSeleccionadas().length;
  return `<div class="tcmp-barra tar-no-imprimir" id="tcmpBarra" ${n ? "" : "hidden"}>
    <span><strong id="tcmpBarraN">${n}</strong> tarifa(s) seleccionada(s)</span>
    <button type="button" class="btn primario" data-tcmp="modo" data-modo="seleccion">Ver selección</button>
    <button type="button" class="enlace" data-tcmp="limpiar-sel">Quitar todas</button>
  </div>`;
}
function tarActualizarCuentaSel() {
  const n = tarSeleccionadas().length;
  if ($("tcmpBarra")) { $("tcmpBarra").hidden = !n; $("tcmpBarraN").textContent = n; }
  if ($("tcmpCuentaSel")) { $("tcmpCuentaSel").hidden = !n; $("tcmpCuentaSel").textContent = n; }
}

// Lo que incluye un servicio comparado con los demás de una lista de fichas
function tarHtmlIncluyeEntre(fichas, ficha) {
  const items = tarItems(ficha?.incluye);
  if (!items.length) return `<span class="nota">Sin información</span>`;
  const conInfo = fichas.filter((f) => tarItems(f?.incluye).length);
  const todos = new Map();
  conInfo.forEach((f) => tarItems(f.incluye).forEach((x) => { if (!todos.has(tarNorm(x))) todos.set(tarNorm(x), x); }));
  const enTodos = (k) => conInfo.every((f) => tarItems(f.incluye).some((x) => tarNorm(x) === k));
  const propios = new Set(items.map(tarNorm));
  const faltan = conInfo.length > 1 ? [...todos.keys()].filter((k) => !propios.has(k)).map((k) => todos.get(k)) : [];
  return `<ul class="tcmp-items">${items.map((x) => {
    const extra = conInfo.length > 1 && !enTodos(tarNorm(x));
    return `<li class="${extra ? "extra" : ""}">${extra ? `<span aria-hidden="true">✚ </span>` : ""}${escapar(x)}</li>`;
  }).join("")}</ul>${faltan.length ? `<p class="tcmp-falta">No incluye: ${faltan.map(escapar).join(", ")}</p>` : ""}`;
}

function tarFilasSeleccion() {
  const lista = tarSeleccionadas();
  const monedas = new Set(lista.map((t) => t.moneda));
  const base = monedas.size === 1 ? [...monedas][0] : "USD";
  const filas = lista.map((t) => ({
    t,
    neto: tarConvertir(tarCosto(t), t.moneda, base),
    cash: tarSinCash(t) || t.cash == null ? null : tarConvertir(t.cash, t.moneda, base),
    tc: t.tc == null ? null : tarConvertir(t.tc, t.moneda, base)
  })).sort((a, b) => (a.neto ?? Infinity) - (b.neto ?? Infinity)
    || tarNombreOp(a.t.operador_id).localeCompare(tarNombreOp(b.t.operador_id), "es") || a.t.servicio.localeCompare(b.t.servicio, "es"));
  return { filas, base, ref: filas.find((f) => f.neto != null) };
}

function tarHtmlSeleccion() {
  const { filas, base, ref } = tarFilasSeleccion();
  if (!filas.length) return `<div class="tar-vacio"><p><strong>No hay tarifas seleccionadas en ${tar.anio}.</strong></p>
    <p>En <button type="button" class="enlace" data-tcmp="modo" data-modo="comparar">Comparar proveedores</button>, filtra y marca con la casilla las opciones que quieras ver aquí.</p></div>`;

  const dif = (f, campo) => {
    if (f === ref) return `<span class="tcmp-bajo">Referencia</span>`;
    if (campo === "cash" && tarSinCash(f.t)) return "";
    if (f[campo] == null || !ref || ref[campo] == null) return f[campo] == null && f.t.moneda !== base ? `<span class="tcmp-dif">falta tipo de cambio</span>` : "";
    const d = tarR2(f[campo] - ref[campo]);
    if (!d) return `<span class="tcmp-dif">igual</span>`;
    const pct = ref[campo] ? ` (${d > 0 ? "+" : "−"}${Math.abs((f[campo] / ref[campo] - 1) * 100).toFixed(0)} %)` : "";
    return `<span class="tcmp-dif ${d > 0 ? "" : "menos"}">${d > 0 ? "+" : "−"}${tarDinero(Math.abs(d), base)}${pct}</span>`;
  };
  const monto = (t, campo, valor) => `<input class="tar-monto tar-no-imprimir" type="number" min="0" step="0.01" inputmode="decimal" value="${valor ?? ""}"
      data-tsel-campo="${campo}" data-id="${t.id}" aria-label="${campo === "neto" ? "Neto" : campo === "cash" ? "Precio Cash" : "Precio TC"} ${escapar(`${t.servicio} ${t.categoria}`)}">
      <span class="solo-impresion tcmp-monto">${campo === "cash" && tarSinCash(t) ? "Sin Cash" : valor == null || valor === "" ? "—" : tarDinero(valor, t.moneda)}</span>`;
  const fichas = filas.map((f) => tarFicha(f.t.operador_id, f.t.servicio));
  const a = tar.selAjuste;
  const resumenRef = ref ? `Referencia: <strong>${escapar(ref.t.servicio)}</strong> de ${escapar(tarNombreOp(ref.t.operador_id))} (${escapar(ref.t.categoria)}), neto ${tarDinero(tarCosto(ref.t), ref.t.moneda)}` : "";

  return `
    <div class="tar-filtros tar-opciones tar-no-imprimir">
      <span>${resumenRef}</span>
      <span class="tar-espacio"></span>
      <button type="button" class="btn" data-tcmp="limpiar-sel">Quitar todas</button>
      <button type="button" class="btn primario" data-tar="imprimir">Imprimir</button>
    </div>
    <div class="tar-ayuda tar-no-imprimir">
      <p>Las tarifas que seleccionaste, de la más barata a la más cara según el <strong>neto</strong> (con IVA cuando aplica). La primera es la <strong>referencia</strong>: debajo de cada precio se ve la diferencia con ella.</p>
      <p>Puedes corregir el neto, el IVA y los precios Cash y TC aquí mismo: se guardan solos al salir de cada casilla y <strong>el cambio queda en la tarifa</strong>, así que se ve igual en Procesar, Tarifario final y Comparar. Las tarifas aprobadas siguen aprobadas.</p>
    </div>
    <div class="solo-impresion tar-imp-cabeza">
      <p class="imp-marca">The House of Tours</p>
      <p class="imp-titulo">Selección de tarifas ${tar.anio}</p>
      ${resumenRef ? `<p class="nota">${resumenRef}</p>` : ""}
    </div>
    <div class="det-seccion sin-margen">
      <div class="tabla-scroll">
        <table class="tabla tar-tabla tcmp-tabla tcmp-seleccion">
          <thead><tr><th class="num">#</th><th>Operador</th><th>Servicio</th><th>Incluye</th><th class="num">Neto</th><th class="centro tar-no-imprimir">IVA</th>
            <th class="num">Cash</th><th class="num">TC</th><th class="tar-no-imprimir"></th></tr></thead>
          <tbody>${filas.map((f, i) => {
            const t = f.t, mc = tarMargenCash(t), mt = tarMargenTc(t);
            return `
            <tr class="${f === ref ? "tcmp-ref" : ""}">
              <td class="num">${i + 1}</td>
              <td><strong>${escapar(tarNombreOp(t.operador_id))}</strong>${t.aprobada ? "" : `<br><label class="check-linea chico tar-no-imprimir"><input type="checkbox" class="tar-check" data-tsel-campo="aprobada" data-id="${t.id}"> Aprobar</label><span class="tcmp-pend">Pendiente de aprobar</span>`}</td>
              <td>${escapar(t.servicio)}${tarNombreTipo(tarTipoDe(t)) ? ` <span class="tcmp-tipo">${escapar(tarNombreTipo(tarTipoDe(t)))}</span>` : ""}
                <br><span class="nota">${escapar(t.categoria)} · ${escapar(t.temporada)}${tarRango(t) ? ` · ${tarRango(t)}` : ""}</span>
                ${t.notas ? `<br><span class="nota">${escapar(t.notas)}</span>` : ""}</td>
              <td>${tarHtmlIncluyeEntre(fichas, fichas[i])}</td>
              <td class="num">${monto(t, "neto", tarValorNeto(t))}
                <span class="tcmp-dif">${tarConIva(t) ? `Con IVA · sin IVA ${tarDinero(t.neto, t.moneda)}` : "Sin IVA"}</span>${dif(f, "neto")}</td>
              <td class="centro tar-no-imprimir"><input type="checkbox" class="tar-check" data-tsel-campo="iva" data-id="${t.id}" ${tarConIva(t) ? "checked" : ""} aria-label="Sumar IVA"></td>
              <td class="num">${monto(t, "cash", t.cash)}
                <span class="tcmp-dif tar-margen-chico ${tarBajo(mc, tar.ajustes.cash_min) ? "bajo" : ""}">Margen ${tarTextoMargenCash(t)}</span>${dif(f, "cash")}</td>
              <td class="num">${monto(t, "tc", t.tc)}
                <span class="tcmp-dif tar-margen-chico ${tarBajo(mt, tar.ajustes.tc_min) ? "bajo" : ""}">Margen ${tarPct(mt)}</span>${dif(f, "tc")}</td>
              <td class="tar-no-imprimir"><button type="button" class="enlace peligro" data-tcmp="quitar-sel" data-id="${t.id}">Quitar</button></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    </div>
    <div class="det-seccion sin-margen tar-no-imprimir tcmp-ajuste">
      <h3>Ajustar precios de las ${filas.length} seleccionadas</h3>
      <div class="fila-form">
        <label>Precio
          <select id="tselCampo">
            <option value="ambos" ${a.campo === "ambos" ? "selected" : ""}>Cash y TC</option>
            <option value="cash" ${a.campo === "cash" ? "selected" : ""}>Solo Cash</option>
            <option value="tc" ${a.campo === "tc" ? "selected" : ""}>Solo TC</option>
          </select></label>
        <label>Ajuste
          <select id="tselAccion">
            <option value="subir" ${a.accion === "subir" ? "selected" : ""}>Subir el precio actual un %</option>
            <option value="bajar" ${a.accion === "bajar" ? "selected" : ""}>Bajar el precio actual un %</option>
            <option value="margen" ${a.accion === "margen" ? "selected" : ""}>Dejar un margen de % sobre el neto</option>
            <option value="sugerido" ${a.accion === "sugerido" ? "selected" : ""}>Usar el precio sugerido de Ajustes</option>
          </select></label>
        <label class="tar-filtro-corto">Porcentaje <input id="tselValor" type="number" min="0" step="0.1" value="${escapar(a.valor)}" placeholder="%"></label>
        <label class="check-linea tar-check-form"><input id="tselRedondear" type="checkbox" ${a.redondear ? "checked" : ""}> Redondear (a $1 o ₡100)</label>
      </div>
      <div class="sec-botones">
        <button type="button" class="btn primario" data-tcmp="aplicar-ajuste">Aplicar a las seleccionadas</button>
        ${tar.selDeshacer ? `<button type="button" class="btn" data-tcmp="deshacer-ajuste">Deshacer el último ajuste</button>` : ""}
      </div>
      <p class="nota">Las tarifas sin opción Cash (precio 0) no se tocan en Cash. El cambio se guarda en cada tarifa y se aplica en todo el tarifario.</p>
    </div>`;
}

// Guarda una casilla de la Selección (misma validación que en Procesar, pero sin quitar la aprobación)
async function tarGuardarCampoSel(input) {
  const t = tar.tarifas.find((x) => x.id === Number(input.dataset.id));
  if (!t) return;
  const campo = input.dataset.tselCampo;
  const cambios = {};
  if (campo === "aprobada") {
    if (input.checked && tarSinPrecio(t)) { input.checked = false; return avisar("Escribe el precio Cash y el TC antes de aprobar esta tarifa.", "error"); }
    cambios.aprobada = input.checked;
  } else if (campo === "iva") {
    cambios.iva = input.checked ? null : 0;
  } else {
    const texto = input.value.trim();
    let valor = texto === "" ? null : tarR2(texto);
    const restaurar = () => { input.value = campo === "neto" ? tarValorNeto(t) : t[campo] ?? ""; };
    if (valor != null && (isNaN(valor) || valor < 0)) { restaurar(); return avisar("Escribe un monto válido.", "error"); }
    if (campo === "tc" && valor === 0) { restaurar(); return avisar("El precio TC debe ser mayor que cero.", "error"); }
    if (campo === "neto" && valor == null) { restaurar(); return avisar("El neto no puede quedar vacío.", "error"); }
    if (campo === "neto" && tarConIva(t)) valor = tarR2(valor / (1 + tar.ajustes.iva / 100));
    if (valor === t[campo]) { restaurar(); return; }
    cambios[campo] = valor;
    // Sin precio Cash o TC una tarifa no puede quedar aprobada
    if (t.aprobada && valor == null) cambios.aprobada = false;
  }
  cambios.actualizado = new Date().toISOString();
  const { error } = await db.from("tar_tarifas").update(cambios).eq("id", t.id);
  if (error) { tarPintar(); return fallo(error); }
  Object.assign(t, cambios);
  avisar(cambios.aprobada === false ? "Guardado. La tarifa quedó sin precio completo y pasó a pendiente de aprobar." : "Guardado: el cambio se aplica en todo el tarifario.");

  // Se vuelve a ordenar la tabla, conservando la casilla a la que se pasó el cursor
  await new Promise((r) => setTimeout(r, 0));   // espera a que el cursor llegue a la siguiente casilla
  const foco = document.activeElement?.dataset;
  const destino = foco?.tselCampo ? [foco.id, foco.tselCampo] : null;
  tarPintar();
  if (destino) $("tarContenido").querySelector(`[data-id="${destino[0]}"][data-tsel-campo="${destino[1]}"]`)?.focus();
}

async function tarAplicarAjusteSel(btn) {
  const a = tar.selAjuste = {
    campo: $("tselCampo").value, accion: $("tselAccion").value, valor: $("tselValor").value, redondear: $("tselRedondear").checked
  };
  const p = Number(a.valor);
  if (a.accion !== "sugerido" && (a.valor === "" || isNaN(p) || p < 0)) return avisar("Escribe el porcentaje.", "error");
  if (a.accion === "bajar" && p >= 100) return avisar("El porcentaje para bajar debe ser menor que 100.", "error");
  const redondeo = (n, moneda) => (a.redondear ? (moneda === "CRC" ? Math.round(n / 100) * 100 : Math.round(n)) : tarR2(n));
  const nuevo = (t, campo) => {
    if (campo === "cash" && tarSinCash(t)) return undefined;
    const actual = t[campo];
    let v;
    if (a.accion === "subir") v = actual == null ? undefined : actual * (1 + p / 100);
    else if (a.accion === "bajar") v = actual == null ? undefined : actual * (1 - p / 100);
    else if (a.accion === "margen") v = tarCosto(t) * (1 + p / 100);
    else v = campo === "cash" ? tarSugCash(t) : tarSugTc(t);
    if (v === undefined) return undefined;
    v = redondeo(v, t.moneda);
    return v > 0 && v !== actual ? v : undefined;
  };
  const campos = a.campo === "ambos" ? ["cash", "tc"] : [a.campo];
  const cambios = tarSeleccionadas().map((t) => {
    const c = {};
    campos.forEach((k) => { const v = nuevo(t, k); if (v !== undefined) c[k] = v; });
    return { t, c };
  }).filter((x) => Object.keys(x.c).length);
  if (!cambios.length) return avisar("Con ese ajuste ningún precio cambia.");
  if (!confirm(`Se van a cambiar los precios de ${cambios.length} tarifa(s). El cambio se guarda en cada tarifa y se ve en todo el tarifario. ¿Continuar?`)) return;

  await conBoton(btn, async () => {
    const antes = cambios.map(({ t }) => ({ id: t.id, cash: t.cash, tc: t.tc }));
    const ahora = new Date().toISOString();
    try {
      await tarEnPartes(cambios, 20, ({ t, c }) => db.from("tar_tarifas").update({ ...c, actualizado: ahora }).eq("id", t.id));
    } catch (e) {
      fallo(e, "El ajuste no terminó. Revisa los precios.");
    }
    tar.tarifas = await tarLeerTarifas(tar.anio);
    tar.selDeshacer = antes;
    tarPintar();
    avisar(`Precios ajustados en ${cambios.length} tarifa(s).`);
  });
}

async function tarDeshacerAjusteSel(btn) {
  const antes = tar.selDeshacer;
  if (!antes || !confirm(`¿Volver a dejar los precios Cash y TC como estaban antes del último ajuste (${antes.length} tarifa(s))?`)) return;
  await conBoton(btn, async () => {
    const ahora = new Date().toISOString();
    try {
      await tarEnPartes(antes, 20, (x) => db.from("tar_tarifas").update({ cash: x.cash, tc: x.tc, actualizado: ahora }).eq("id", x.id));
    } catch (e) { fallo(e); }
    tar.tarifas = await tarLeerTarifas(tar.anio);
    tar.selDeshacer = null;
    tarPintar();
    avisar("Se deshizo el último ajuste.");
  });
}

// ---------- Clasificar servicios ----------
function tarHtmlClasificar() {
  const c = tar.comparar, txt = tarNorm(c.buscar);
  const lista = tar.cmpTodos.filter((s) =>
    (!c.operador || s.operador_id === Number(c.operador))
    && (!c.sinClasificar || !tarClasificado(s))
    && (!txt || tarNorm(`${s.servicio} ${tarNombreOp(s.operador_id)} ${s.ficha?.comparar ?? ""} ${s.ficha?.incluye ?? ""}`).includes(txt)));
  tar.cmpServicios = lista;

  const grupos = [...new Set(tar.fichas.map((f) => f.comparar).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  const usados = new Map();
  tar.fichas.forEach((f) => tarItems(f.incluye).forEach((x) => { if (!usados.has(tarNorm(x))) usados.set(tarNorm(x), x); }));
  const sugeribles = lista.filter((s) => { const g = tarSugerencia(s); return (!s.ficha?.comparar && g.comparar) || (!s.ficha?.tipo_id && g.tipo_id); }).length;

  const filas = lista.map((s, i) => {
    const f = s.ficha || {};
    const sug = tarSugerencia(s);
    const sugComparar = !f.comparar && sug.comparar
      ? `<button type="button" class="enlace tcmp-sug" data-tcmp="usar-sug" data-i="${i}" data-campo="comparar">Usar "${escapar(sug.comparar)}"</button>
         <span class="nota">parecido a ${escapar(sug.de.servicio)} (${escapar(tarNombreOp(sug.de.operador_id))})</span>` : "";
    const sugTipo = !f.tipo_id && sug.tipo_id
      ? `<button type="button" class="enlace tcmp-sug" data-tcmp="usar-sug" data-i="${i}" data-campo="tipo_id">Usar ${escapar(tarNombreTipo(sug.tipo_id))}</button>` : "";
    return `
      <tr data-cmp-fila="${i}" class="${tarClasificado(s) ? "" : "tcmp-pendiente"}">
        <td><strong>${escapar(tarNombreOp(s.operador_id))}</strong></td>
        <td>${escapar(s.servicio)}<br><span class="nota">${s.tarifas} tarifa(s)${s.aprobadas < s.tarifas ? ` · ${s.tarifas - s.aprobadas} pendiente(s)` : ""}</span></td>
        <td><select data-tcmp-campo="tipo_id" data-i="${i}" aria-label="Tipo de actividad de ${escapar(s.servicio)}">${tarOpcionesTipos(f.tipo_id ?? "", "Sin tipo").replace(/<option value="sin"[^>]*>.*?<\/option>/, "")}</select>
          <div class="tar-sug">${sugTipo}</div></td>
        <td><input data-tcmp-campo="comparar" data-i="${i}" list="tcmpListaGrupos" value="${escapar(f.comparar ?? "")}" placeholder="Ej.: Canopy" aria-label="Comparar como, ${escapar(s.servicio)}">
          <div class="tar-sug">${sugComparar}</div></td>
        <td><textarea data-tcmp-campo="incluye" data-i="${i}" rows="2" placeholder="Transporte, almuerzo, guía bilingüe" aria-label="Qué incluye ${escapar(s.servicio)}">${escapar(f.incluye ?? "")}</textarea></td>
      </tr>`;
  }).join("");

  return `
    <div class="tar-filtros">
      ${tarHtmlAnio()}
      <label>Operador <select data-tcmp-filtro="operador">${tarOpcionesOperadores(c.operador)}</select></label>
      <label class="tar-buscar">Buscar <input id="tarBuscarClas" type="search" value="${escapar(c.buscar)}" placeholder="Servicio, operador o grupo" data-tcmp-filtro="buscar"></label>
    </div>
    <div class="tar-filtros tar-opciones">
      <label class="check-linea chico"><input type="checkbox" data-tcmp-filtro="sinClasificar" ${c.sinClasificar ? "checked" : ""}> Solo los que falta clasificar</label>
      <span class="tar-espacio"></span>
      ${sugeribles ? `<button type="button" class="btn" data-tcmp="aplicar-sugerencias">Aplicar las ${sugeribles} sugerencia(s)</button>` : ""}
    </div>
    <div class="tar-ayuda">
      <p><strong>Tipo de actividad:</strong> los de la pestaña Tipos de actividad (Aventura, Naturaleza…). Sirve para filtrar el Tarifario final y la comparación.</p>
      <p><strong>Comparar como:</strong> escribe el mismo nombre en los servicios que son iguales o parecidos aunque cada operador los llame distinto
        (por ejemplo "Canopy" para "Canopy Tour" y "Zipline 12 cables"). Los que se llaman exactamente igual se comparan solos.</p>
      <p><strong>Incluye:</strong> sepáralo con comas y escríbelo igual en todos los operadores para que la comparación encuentre las diferencias. Toca un elemento de la lista de abajo para agregarlo a la última casilla Incluye que usaste.</p>
      <p>Todo se guarda solo al salir de cada casilla, y se conserva para los próximos años mientras el servicio se llame igual.</p>
      ${usados.size ? `<div class="tcmp-usados">${[...usados.values()].sort((a, b) => a.localeCompare(b, "es"))
        .map((x) => `<button type="button" class="tcmp-chip" data-tcmp="agregar-item" data-item="${escapar(x)}">+ ${escapar(x)}</button>`).join("")}</div>` : ""}
    </div>
    <datalist id="tcmpListaGrupos">${grupos.map((x) => `<option value="${escapar(x)}">`).join("")}</datalist>
    ${lista.length ? `
      <div class="tabla-scroll">
        <table class="tabla tcmp-clasificar">
          <thead><tr><th>Operador</th><th>Servicio</th><th>Tipo de actividad</th><th>Comparar como</th><th>Incluye</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>` : `<div class="tar-vacio"><p><strong>${tar.cmpTodos.length ? "No hay servicios que coincidan con los filtros." : `Todavía no hay tarifas en ${tar.anio}.`}</strong></p></div>`}`;
}

async function tarGuardarCampoFicha(el) {
  const s = tar.cmpServicios[Number(el.dataset.i)];
  if (!s) return;
  const campo = el.dataset.tcmpCampo;
  const valor = campo === "tipo_id" ? (el.value ? Number(el.value) : null) : (el.value.trim() || null);
  if ((s.ficha?.[campo] ?? null) === valor) return;
  if (await tarGuardarFicha(s.operador_id, s.servicio, { [campo]: valor })) {
    s.ficha = tarFicha(s.operador_id, s.servicio);
    el.closest("tr")?.classList.toggle("tcmp-pendiente", !tarClasificado(s));
    if (campo !== "incluye") el.closest("td").querySelector(".tar-sug").innerHTML = "";
    avisar("Guardado.");
  } else {
    el.value = campo === "tipo_id" ? (s.ficha?.tipo_id ?? "") : (s.ficha?.[campo] ?? "");
  }
}

async function tarAplicarSugerencias(btn) {
  const cambios = tar.cmpServicios.map((s) => {
    const g = tarSugerencia(s), c = {};
    if (!s.ficha?.comparar && g.comparar) c.comparar = g.comparar;
    if (!s.ficha?.tipo_id && g.tipo_id) c.tipo_id = g.tipo_id;
    return { s, c };
  }).filter((x) => Object.keys(x.c).length);
  if (!cambios.length) return;
  if (!confirm(`Se van a completar ${cambios.length} servicio(s) con la sugerencia (solo las casillas vacías). Después puedes corregir cualquiera. ¿Continuar?`)) return;
  await conBoton(btn, async () => {
    for (const { s, c } of cambios) if (!(await tarGuardarFicha(s.operador_id, s.servicio, c))) break;
    tarPintar();
    avisar("Sugerencias aplicadas. Revísalas antes de comparar.");
  });
}

// ---------- Eventos ----------
$("tarContenido").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tcmp]");
  if (!b || tarSoloConsulta()) return;
  const accion = b.dataset.tcmp;
  if (accion === "modo") { tar.comparar.modo = b.dataset.modo; tarPintar(); return window.scrollTo({ top: $("vistaTarifario").offsetTop }); }
  if (accion === "quitar-sel") { tar.seleccion.delete(Number(b.dataset.id)); tarRecordarSel(); return tarPintar(); }
  if (accion === "limpiar-sel") {
    if (!confirm("¿Quitar todas las tarifas de la selección? (Las tarifas no se borran.)")) return;
    tarSeleccionadas().forEach((t) => tar.seleccion.delete(t.id)); tarRecordarSel(); return tarPintar();
  }
  if (accion === "sel-grupo") {
    const ids = b.dataset.ids.split(",").map(Number);
    const todas = ids.every((id) => tar.seleccion.has(id));
    ids.forEach((id) => (todas ? tar.seleccion.delete(id) : tar.seleccion.add(id)));
    tarRecordarSel(); return tarPintar();
  }
  if (accion === "aplicar-ajuste") return tarAplicarAjusteSel(b);
  if (accion === "deshacer-ajuste") return tarDeshacerAjusteSel(b);
  if (accion === "aplicar-sugerencias") return tarAplicarSugerencias(b);
  if (accion === "usar-sug") {
    const s = tar.cmpServicios[Number(b.dataset.i)];
    const el = b.closest("td").querySelector("[data-tcmp-campo]");
    const valor = tarSugerencia(s)[b.dataset.campo];
    if (!s || !el || valor == null) return;
    el.value = valor;
    return tarGuardarCampoFicha(el);
  }
  if (accion === "agregar-item") {
    const el = tar.cmpUltimoIncluye && document.body.contains(tar.cmpUltimoIncluye) ? tar.cmpUltimoIncluye : null;
    if (!el) return avisar("Primero toca la casilla Incluye del servicio al que quieres agregarlo.", "error");
    const items = tarItems(el.value);
    if (!items.some((x) => tarNorm(x) === tarNorm(b.dataset.item))) items.push(b.dataset.item);
    el.value = items.join(", ");
    return tarGuardarCampoFicha(el);
  }
});

$("tarContenido").addEventListener("focusin", (e) => {
  if (e.target.dataset?.tcmpCampo === "incluye") tar.cmpUltimoIncluye = e.target;
});

$("tarContenido").addEventListener("change", (e) => {
  const el = e.target;
  if (tarSoloConsulta()) return;
  if (el.dataset.tcmpCampo) return tarGuardarCampoFicha(el);
  if (el.dataset.tselCampo) return tarGuardarCampoSel(el);
  if (el.hasAttribute("data-tcmp-sel")) {
    const id = Number(el.dataset.id);
    if (el.checked) tar.seleccion.add(id); else tar.seleccion.delete(id);
    el.closest("tr")?.classList.toggle("tcmp-elegida", el.checked);
    tarRecordarSel();
    return tarActualizarCuentaSel();
  }
  const f = el.dataset.tcmpFiltro;
  if (f && f !== "texto" && f !== "buscar") {
    tar.comparar[f] = el.type === "checkbox" ? el.checked : el.value;
    tarPintar();
  }
});

// Búsqueda mientras se escribe (sin perder el cursor)
$("tarContenido").addEventListener("input", (e) => {
  const el = e.target, f = el.dataset.tcmpFiltro;
  if (f !== "texto" && f !== "buscar") return;
  tar.comparar[f] = el.value;
  clearTimeout(tarHtmlComparar.espera);
  tarHtmlComparar.espera = setTimeout(() => {
    const id = el.id;
    tarPintar();
    const nuevo = $(id);
    if (nuevo) { nuevo.focus(); nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length); }
  }, 300);
});
