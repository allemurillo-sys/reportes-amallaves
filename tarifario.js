// =====================================================
// SECCIÓN TARIFARIO (solo administradores)
// Tarifas de los tour operadores: importar desde Excel, escribir los precios
// Cash y TC (el sistema calcula el margen), aprobar y consultar el tarifario final.
// Es la fuente única del sistema: desde aquí salen los operadores, servicios, tipos de actividad,
// fotos y precios que usan el formulario del cliente y el panel (ver tarifario-catalogo.js).
// Usa las utilidades de panel.js ($, db, app, escapar, dinero, fecha, avisar, fallo, conBoton, pad, aTexto).
// =====================================================

const TAR_CATEGORIAS = ["Adulto", "Adulto mayor", "Estudiante", "Niño"];
const TAR_ANIO_DEFECTO = new Date().getMonth() >= 5 ? new Date().getFullYear() + 1 : new Date().getFullYear();

// Cada tarifa (o temporada completa) puede estar en dólares o en colones.
// dinero() de panel.js siempre usa dólares; aquí usamos tarDinero() para respetar la moneda de cada tarifa.
function tarDinero(n, moneda = "USD") {
  return new Intl.NumberFormat(moneda === "CRC" ? "es-CR" : "en-US", {
    style: "currency", currency: moneda === "CRC" ? "CRC" : "USD", maximumFractionDigits: moneda === "CRC" ? 0 : 2
  }).format(Number(n) || 0);
}
const tarMonedaEtiqueta = (moneda) => (moneda === "CRC" ? "₡ Colones" : "$ Dólares");

const tar = {
  pestana: "procesar",
  anio: TAR_ANIO_DEFECTO,
  tarifas: [],
  operadores: [],
  ajustes: { iva: 13, cash_ref: 20, tc_ref: 40, cash_min: 15, tc_min: 30, tipo_cambio: 0 },
  filtro: { operador: "", estado: "pendientes", texto: "" },
  final: { operador: "", tipo: "", fecha: "", texto: "", verNeto: true, politicas: false },
  editando: null,      // { tipo: "fila" | "grupo" | "nuevo" | "operador", ... }
  importacion: null,   // { archivo, filas }
  grupos: []           // grupos pintados en Procesar (para los botones de cada temporada)
};

// ---------- Acceso ----------
// Administrador: todo el tarifario. Otros usuarios con el permiso "ver_tarifario"
// (Mantenimiento › Autorizaciones): solo consultan el Tarifario final, sin editar ni revertir.
VISTAS.tarifario = "vistaTarifario";
const tarEsAdmin = () => app.yo?.rol === "administrador";
const tarSoloConsulta = () => !tarEsAdmin() && !!app.yo && puede("ver_tarifario");
const tarTieneAcceso = () => tarEsAdmin() || tarSoloConsulta();
// Todos los que entran al tarifario ven el neto (con IVA y sin IVA)
const tarPuedeVerNeto = () => tarTieneAcceso();

function tarRevisarAcceso() {
  $("btnMenuTarifario").hidden = !tarTieneAcceso();
  // En modo consulta solo queda la pestaña Tarifario final
  document.querySelectorAll(".pestana[data-tar-pestana]").forEach((b) => (b.hidden = tarSoloConsulta() && b.dataset.tarPestana !== "final"));
  if (tarSoloConsulta()) { tar.pestana = "final"; tar.editando = null; }
  if (!tarTieneAcceso() && !$("vistaTarifario").hidden) mostrarVista("reservas");
}
// panel.js escribe el nombre del usuario cada vez que carga su perfil
new MutationObserver(tarRevisarAcceso).observe($("usuarioNombre"), { childList: true, characterData: true, subtree: true });
tarRevisarAcceso(); // por si el perfil ya se cargó antes que este archivo

document.addEventListener("vista-abierta", (e) => {
  if (e.detail !== "tarifario") return;
  if (!tarTieneAcceso()) return mostrarVista("reservas");
  tarAbrir();
});
document.addEventListener("datos-actualizados", () => {
  if (!$("vistaTarifario").hidden && !tar.editando && tarTieneAcceso()) tarAbrir();
});

document.querySelectorAll(".pestana[data-tar-pestana]").forEach((b) => b.addEventListener("click", () => {
  if (tarSoloConsulta() && b.dataset.tarPestana !== "final") return;
  tar.pestana = b.dataset.tarPestana;
  tar.editando = null;
  tarPintar();
}));

// ---------- Utilidades ----------
const tarR2 = (n) => Math.round(Number(n) * 100) / 100;
const tarNorm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
const tarOperador = (id) => tar.operadores.find((o) => o.id === Number(id));
const tarNombreOp = (id) => tarOperador(id)?.nombre ?? "";
// IVA: cada tarifa tiene una casilla "IVA". Marcada (iva vacío o mayor que 0) = se suma el IVA
// general de Ajustes al neto. Desmarcada (iva = 0) = el neto se usa tal cual.
// El neto guardado es siempre el del operador, sin IVA.
const tarConIva = (t) => Number(t.iva ?? 1) !== 0;
const tarIva = (t) => (tarConIva(t) ? tar.ajustes.iva : 0);
const tarCosto = (t) => tarR2(t.neto * (1 + tarIva(t) / 100));     // neto + IVA si aplica
const tarSugCash = (t) => tarR2(tarCosto(t) * (1 + tar.ajustes.cash_ref / 100));
const tarSugTc = (t) => tarR2(tarCosto(t) * (1 + tar.ajustes.tc_ref / 100));
// Precio Cash en 0 = el operador no ofrece tarifa Cash para esa actividad
const tarSinCash = (t) => t.cash === 0;
const tarMargenCash = (t) => (t.cash != null && !tarSinCash(t) && tarCosto(t) > 0 ? t.cash / tarCosto(t) - 1 : null);
const tarTextoMargenCash = (t) => (tarSinCash(t) ? "No aplica" : tarPct(tarMargenCash(t)));
const tarMargenTc = (t) => (t.tc != null && tarCosto(t) > 0 ? t.tc / tarCosto(t) - 1 : null);
const tarPct = (m) => (m == null ? "—" : `${(m * 100).toFixed(1)} %`);
const tarBajo = (m, min) => m != null && m * 100 < min;
const tarMargenBajo = (t) => tarBajo(tarMargenCash(t), tar.ajustes.cash_min) || tarBajo(tarMargenTc(t), tar.ajustes.tc_min);
const tarSinPrecio = (t) => t.cash == null || t.tc == null;
const tarNormalizar = (t) => ({
  ...t, neto: Number(t.neto) || 0,
  cash: t.cash == null ? null : Number(t.cash),
  tc: t.tc == null ? null : Number(t.tc),
  iva: t.iva == null ? null : Number(t.iva),
  moneda: t.moneda === "CRC" ? "CRC" : "USD"
});
const tarFechaCorta = (t) => fecha(t, { day: "numeric", month: "short", year: "numeric" });

function tarRango(t) {
  if (!t.fecha_inicio && !t.fecha_fin) return "";
  return `${t.fecha_inicio ? tarFechaCorta(t.fecha_inicio) : "…"} al ${t.fecha_fin ? tarFechaCorta(t.fecha_fin) : "…"}`;
}
function tarOrdenCat(a, b) {
  const i = (x) => { const k = TAR_CATEGORIAS.findIndex((c) => tarNorm(c) === tarNorm(x)); return k < 0 ? 99 : k; };
  return i(a) - i(b) || a.localeCompare(b, "es");
}
function tarOrden(a, b) {
  return tarNombreOp(a.operador_id).localeCompare(tarNombreOp(b.operador_id), "es")
    || a.servicio.localeCompare(b.servicio, "es")
    || (a.fecha_inicio || "").localeCompare(b.fecha_inicio || "")
    || a.temporada.localeCompare(b.temporada, "es")
    || tarOrdenCat(a.categoria, b.categoria);
}
const tarClaveGrupo = (t) => [t.operador_id, t.servicio, t.temporada, t.fecha_inicio || "", t.fecha_fin || ""].join("|");

// Agrupa: operador → servicio + temporada → categorías
function tarAgrupar(lista) {
  const ops = [];
  [...lista].sort(tarOrden).forEach((t) => {
    let op = ops.at(-1);
    if (!op || op.id !== t.operador_id) ops.push((op = { id: t.operador_id, grupos: [] }));
    let g = op.grupos.at(-1);
    const clave = tarClaveGrupo(t);
    if (!g || g.clave !== clave) {
      op.grupos.push((g = { clave, operador_id: t.operador_id, servicio: t.servicio, temporada: t.temporada,
        fecha_inicio: t.fecha_inicio, fecha_fin: t.fecha_fin, filas: [] }));
    }
    g.filas.push(t);
  });
  return ops;
}

// En partes, para no saturar la base de datos
async function tarEnPartes(lista, tam, fn) {
  for (let i = 0; i < lista.length; i += tam) {
    const resultados = await Promise.all(lista.slice(i, i + tam).map(fn));
    const error = resultados.find((r) => r?.error)?.error;
    if (error) throw error;
  }
}

// Lector de Excel: se carga solo cuando se necesita
let tarPromesaXLSX = null;
function tarCargarXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (tarPromesaXLSX ||= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => ok(window.XLSX);
    s.onerror = () => { tarPromesaXLSX = null; mal(new Error("No se pudo cargar el lector de Excel. Revisa tu conexión a internet.")); };
    document.head.appendChild(s);
  }));
}

// ---------- Carga de datos ----------
async function tarAbrir() {
  $("tarContenido").innerHTML = `<p class="nota">Cargando tarifas…</p>`;
  await tarCargar();
  tarPintar();
}

async function tarCargar() {
  const [op, aj] = await Promise.all([
    db.from("tar_operadores").select("*").order("nombre"),
    db.from("tar_ajustes").select("*")
  ]);
  const error = op.error || aj.error;
  if (error) {
    fallo(error, "No se pudo cargar el tarifario. ¿Ya se ejecutó el script tarifario.sql en Supabase?");
    return;
  }
  tar.operadores = op.data;
  aj.data.forEach((a) => (tar.ajustes[a.clave] = Number(a.valor)));
  [tar.tarifas] = await Promise.all([tarLeerTarifas(tar.anio), tarLeerFichas(),
    typeof tarLeerCatalogoExtra === "function" ? tarLeerCatalogoExtra() : null]);
}

async function tarLeerTarifas(anio) {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db.from("tar_tarifas").select("*").eq("anio", anio).order("id").range(desde, desde + 999);
    if (error) { fallo(error, "No se pudieron cargar las tarifas."); break; }
    todas.push(...data);
    if (data.length < 1000) break;
  }
  return todas.map(tarNormalizar);
}

// Devuelve el id del operador; si no existe, lo crea
async function tarOperadorId(nombre) {
  const n = String(nombre ?? "").trim();
  if (!n) return null;
  const existe = tar.operadores.find((o) => tarNorm(o.nombre) === tarNorm(n));
  if (existe) return existe.id;
  const { data, error } = await db.from("tar_operadores").insert({ nombre: n }).select().single();
  if (error) { fallo(error, `No se pudo crear el operador ${n}.`); return null; }
  tar.operadores.push(data);
  tar.operadores.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return data.id;
}

// ---------- Pintar ----------
function tarPintar() {
  if (tarSoloConsulta()) { tar.pestana = "final"; tar.editando = null; tar.final.verNeto &&= tarPuedeVerNeto(); }
  document.querySelectorAll(".pestana[data-tar-pestana]").forEach((b) => {
    const activa = b.dataset.tarPestana === tar.pestana;
    b.classList.toggle("activa", activa);
    b.setAttribute("aria-selected", activa);
  });
  let h;
  if (tar.editando?.tipo === "operador") h = tarHtmlFormOperador();
  else if (tar.editando?.tipo === "moneda-masiva") h = tarHtmlFormMoneda();
  else if (tar.editando?.tipo === "ficha") h = tarHtmlFichaCliente();
  else if (tar.editando?.tipo === "tipo") h = tarHtmlFormTipo();
  else if (tar.editando) h = tarHtmlEditor();
  else if (tar.pestana === "procesar") h = tarHtmlProcesar();
  else if (tar.pestana === "importar") h = tarHtmlImportar();
  else if (tar.pestana === "operadores") h = tarHtmlOperadores();
  else if (tar.pestana === "final") h = tarHtmlFinal();
  else if (tar.pestana === "comparar") h = tarHtmlComparar();
  else if (tar.pestana === "catalogo") h = tarHtmlCatalogo();
  else if (tar.pestana === "tipos") h = tarHtmlTipos();
  else if (tar.pestana === "conexion") h = tarHtmlConexion();
  else h = tarHtmlAjustes();
  $("tarContenido").innerHTML = h;
  $("tarContenido").querySelector("[autofocus]")?.focus();
}

function tarHtmlAnio() {
  const anios = new Set([new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2, tar.anio]);
  return `<label class="tar-filtro-corto">Año
    <select id="tarAnio">${[...anios].sort().map((a) => `<option ${a === tar.anio ? "selected" : ""}>${a}</option>`).join("")}</select>
  </label>`;
}
function tarOpcionesOperadores(sel, vacio = "Todos los operadores") {
  return `<option value="">${vacio}</option>` + tar.operadores
    .map((o) => `<option value="${o.id}" ${String(o.id) === String(sel) ? "selected" : ""}>${escapar(o.nombre)}</option>`).join("");
}

// =====================================================
// PESTAÑA PROCESAR
// =====================================================
function tarFiltradas() {
  const f = tar.filtro, txt = tarNorm(f.texto);
  return tar.tarifas.filter((t) =>
    (!f.operador || t.operador_id === Number(f.operador))
    && (f.estado === "todas"
      || (f.estado === "aprobadas" && t.aprobada)
      || (f.estado === "pendientes" && !t.aprobada)
      || (f.estado === "revisar" && !t.aprobada && (tarSinPrecio(t) || tarMargenBajo(t))))
    && (!txt || tarNorm(`${t.servicio} ${t.temporada} ${t.categoria} ${tarNombreOp(t.operador_id)}`).includes(txt)));
}

// Igual que tarFiltradas() pero sin filtrar por estado (incluye pendientes y ya aprobadas):
// se usa para corregir la moneda de tarifas que ya existían, estén aprobadas o no.
function tarFiltradasOperadorTexto() {
  const f = tar.filtro, txt = tarNorm(f.texto);
  return tar.tarifas.filter((t) =>
    (!f.operador || t.operador_id === Number(f.operador))
    && (!txt || tarNorm(`${t.servicio} ${t.temporada} ${t.categoria} ${tarNombreOp(t.operador_id)}`).includes(txt)));
}

function tarHtmlResumen() {
  const lista = tar.tarifas.filter((t) => !tar.filtro.operador || t.operador_id === Number(tar.filtro.operador));
  const pend = lista.filter((t) => !t.aprobada).length;
  const sinPrecio = lista.filter(tarSinPrecio).length;
  const bajo = lista.filter(tarMargenBajo).length;
  return `<span><strong>${lista.length}</strong> tarifas en ${tar.anio}</span>
    <span><strong>${lista.length - pend}</strong> aprobadas</span>
    <span class="${pend ? "tar-ojo" : ""}"><strong>${pend}</strong> pendientes</span>
    <span class="${sinPrecio ? "tar-ojo" : ""}"><strong>${sinPrecio}</strong> sin precio completo</span>
    <span class="${bajo ? "tar-alerta" : ""}"><strong>${bajo}</strong> con margen bajo</span>`;
}

function tarHtmlProcesar() {
  const f = tar.filtro;
  const lista = tarFiltradas();
  const ops = tarAgrupar(lista);
  tar.grupos = [];

  const cuerpo = ops.map((op) => `
    <tr class="fila-grupo"><th colspan="9">${escapar(tarNombreOp(op.id))}</th></tr>
    ${op.grupos.map((g) => {
      const gi = tar.grupos.push(g) - 1;
      return `
      <tr class="tar-grupo"><th colspan="9">
        <span class="tar-servicio">${escapar(g.servicio)}</span>
        <span class="tar-temporada">${escapar(g.temporada)}${tarRango(g) ? ` · ${tarRango(g)}` : ""}</span>
        <span class="tar-moneda">${tarMonedaEtiqueta(g.filas[0]?.moneda)}</span>
        <span class="tar-grupo-acciones">
          <button type="button" class="enlace" data-tar="editar-grupo" data-g="${gi}">Editar temporada</button>
          <button type="button" class="enlace" data-tar="nueva-temporada" data-g="${gi}">Agregar otra temporada</button>
        </span>
      </th></tr>
      <tr class="tar-cabecera">
        <th scope="col">Categoría</th><th scope="col" class="num">Neto</th><th scope="col" class="centro">IVA ${tar.ajustes.iva} %</th>
        <th scope="col" class="num">Precio Cash</th><th scope="col" class="num">Margen Cash</th>
        <th scope="col" class="num">Precio TC</th><th scope="col" class="num">Margen TC</th>
        <th scope="col" class="centro">Aprobada</th><th></th>
      </tr>
      ${g.filas.map(tarHtmlFila).join("")}`;
    }).join("")}`).join("");

  const vacio = tar.tarifas.length
    ? `<p class="nota">No hay tarifas que coincidan con los filtros.</p>`
    : `<div class="tar-vacio"><p><strong>Todavía no hay tarifas para ${tar.anio}.</strong></p>
        <p>Puedes importarlas desde un Excel o agregarlas una por una.</p>
        <div class="sec-botones">
          <button type="button" class="btn primario" data-tar="ir-importar">Importar desde Excel</button>
          <button type="button" class="btn" data-tar="nueva">Agregar tarifa</button>
        </div></div>`;

  return `
    <div class="tar-filtros">
      ${tarHtmlAnio()}
      <label>Operador <select data-tar-filtro="operador">${tarOpcionesOperadores(f.operador)}</select></label>
      <label>Mostrar
        <select data-tar-filtro="estado">
          <option value="pendientes" ${f.estado === "pendientes" ? "selected" : ""}>Pendientes de aprobar</option>
          <option value="revisar" ${f.estado === "revisar" ? "selected" : ""}>Sin precio o con margen bajo</option>
        </select>
      </label>
      <label class="tar-buscar">Buscar <input id="tarBuscar" type="search" value="${escapar(f.texto)}" placeholder="Servicio, temporada o categoría" data-tar-filtro="texto"></label>
    </div>
    <p id="tarResumen" class="tar-resumen">${tarHtmlResumen()}</p>
    <div class="det-seccion sin-margen">
      <div class="sec-cabeza">
        <h3>Precios de venta</h3>
        <div class="sec-botones">
          <button type="button" class="btn" data-tar="nueva">Agregar tarifa</button>
          <button type="button" class="btn" data-tar="cambiar-moneda">Cambiar moneda</button>
          ${lista.length ? `
            <button type="button" class="btn" data-tar="sugeridos">Llenar vacíos con el sugerido</button>
            <button type="button" class="btn primario" data-tar="aprobar-visibles">Aprobar las que se ven</button>` : ""}
        </div>
      </div>
      <div class="tar-ayuda">
        <p><strong>Neto:</strong> lo que nos cobra el operador. Si la casilla <strong>IVA</strong> está marcada, el neto se muestra con el ${tar.ajustes.iva} % ya incluido (debajo queda el monto sin IVA como referencia); al desmarcarla vuelve al monto original. Los precios y márgenes se calculan sobre el neto que ves.</p>
        <p><strong>Precio Cash</strong> y <strong>Precio TC:</strong> lo que le vas a cobrar al cliente. Escribe el monto final que quieras,
          o pulsa "Usar sugerido" (Cash = neto con IVA + ${tar.ajustes.cash_ref} %; TC = neto con IVA + ${tar.ajustes.tc_ref} %).
          Si el operador no ofrece tarifa Cash para esa actividad, escribe <strong>0</strong> en Precio Cash: no se mostrará en el Tarifario final.</p>
        <p><strong>Margen:</strong> se calcula solo con el precio que escribas. En rojo si queda por debajo del mínimo (Cash ${tar.ajustes.cash_min} %, TC ${tar.ajustes.tc_min} %).</p>
        <p><strong>Aprobada:</strong> márcala cuando la tarifa esté lista; desaparece de esta lista y pasa al Tarifario final. Si necesitas corregirla, en el Tarifario final pulsa "Revertir" y vuelve aquí. Todo se guarda solo al salir de cada casilla.</p>
        <p><strong>Cambiar moneda:</strong> corrige de una sola vez la moneda (dólares o colones) de varias tarifas ya creadas, usando los filtros de Operador y Buscar de arriba (incluye también las que ya estén aprobadas).</p>
      </div>
      ${lista.length ? `
        <div class="tabla-scroll">
          <table class="tabla tar-tabla">
            <tbody>${cuerpo}</tbody>
          </table>
        </div>` : vacio}
    </div>`;
}

function tarHtmlFila(t) {
  const mc = tarMargenCash(t), mt = tarMargenTc(t);
  const nombre = escapar(`${t.servicio} ${t.temporada} ${t.categoria}`);
  const monto = (campo, valor) => `<input class="tar-monto" type="number" min="0" step="0.01" inputmode="decimal"
      value="${valor ?? ""}" data-tar-campo="${campo}" data-id="${t.id}"
      aria-label="${campo === "neto" ? "Neto" : campo === "cash" ? "Precio Cash" : "Precio TC"} ${nombre}">`;
  return `
    <tr data-fila="${t.id}" class="${t.aprobada ? "tar-aprobada" : ""}">
      <td>${escapar(t.categoria)}${t.notas ? `<br><span class="nota">${escapar(t.notas)}</span>` : ""}</td>
      <td class="num">
        ${monto("neto", tarValorNeto(t))}
        <div class="tar-sin-iva" data-sin-iva>${tarTextoSinIva(t)}</div>
      </td>
      <td class="centro"><input type="checkbox" class="tar-check" data-tar-campo="iva" data-id="${t.id}" ${tarConIva(t) ? "checked" : ""} aria-label="Sumar IVA ${nombre}"></td>
      <td class="num">${monto("cash", t.cash)}<div class="tar-sug" data-sug="cash">${tarHtmlSug(t, "cash")}</div></td>
      <td class="num tar-margen ${tarBajo(mc, tar.ajustes.cash_min) ? "bajo" : ""}" data-margen="cash">${tarTextoMargenCash(t)}</td>
      <td class="num">${monto("tc", t.tc)}<div class="tar-sug" data-sug="tc">${tarHtmlSug(t, "tc")}</div></td>
      <td class="num tar-margen ${tarBajo(mt, tar.ajustes.tc_min) ? "bajo" : ""}" data-margen="tc">${tarPct(mt)}</td>
      <td class="centro"><input type="checkbox" class="tar-check" data-tar-campo="aprobada" data-id="${t.id}" ${t.aprobada ? "checked" : ""} aria-label="Aprobar ${nombre}"></td>
      <td class="acciones-fila">
        <button type="button" class="enlace" data-tar="editar-fila" data-id="${t.id}">Editar</button>
        <button type="button" class="enlace peligro" data-tar="eliminar-fila" data-id="${t.id}">Eliminar</button>
      </td>
    </tr>`;
}

// La casilla Neto muestra el neto con IVA cuando la casilla IVA está marcada,
// y el neto original del operador cuando no. En la base siempre se guarda el neto sin IVA.
const tarValorNeto = (t) => (tarConIva(t) ? tarCosto(t).toFixed(2) : t.neto);
const tarTextoSinIva = (t) => (tarConIva(t) ? `IVA incluido · sin IVA ${tarDinero(t.neto, t.moneda)}` : "");

// Botón "Usar sugerido" debajo de una casilla de precio vacía
function tarHtmlSug(t, campo) {
  if (campo === "cash" && tarSinCash(t)) return `<span class="tar-no-aplica">Sin tarifa Cash</span>`;
  if (t[campo] != null) return "";
  const sug = campo === "cash" ? tarSugCash(t) : tarSugTc(t);
  return `<button type="button" class="enlace" data-tar="usar-sugerido" data-campo="${campo}" data-id="${t.id}">Usar sugerido ${tarDinero(sug, t.moneda)}</button>`;
}

function tarRefrescarFila(t) {
  const tr = $("tarContenido").querySelector(`tr[data-fila="${t.id}"]`);
  if (tr) {
    const mc = tarMargenCash(t), mt = tarMargenTc(t);
    const celdaC = tr.querySelector('[data-margen="cash"]'), celdaT = tr.querySelector('[data-margen="tc"]');
    celdaC.textContent = tarTextoMargenCash(t);
    celdaC.classList.toggle("bajo", tarBajo(mc, tar.ajustes.cash_min));
    celdaT.textContent = tarPct(mt);
    celdaT.classList.toggle("bajo", tarBajo(mt, tar.ajustes.tc_min));
    tr.querySelector('[data-tar-campo="iva"]').checked = tarConIva(t);
    tr.querySelector('[data-tar-campo="neto"]').value = tarValorNeto(t);
    tr.querySelector("[data-sin-iva]").textContent = tarTextoSinIva(t);
    tr.querySelector('[data-sug="cash"]').innerHTML = tarHtmlSug(t, "cash");
    tr.querySelector('[data-sug="tc"]').innerHTML = tarHtmlSug(t, "tc");
    tr.querySelector('[data-tar-campo="aprobada"]').checked = t.aprobada;
    tr.classList.toggle("tar-aprobada", t.aprobada);
  }
  if ($("tarResumen")) $("tarResumen").innerHTML = tarHtmlResumen();
}

// Guarda una casilla de la tabla en cuanto el usuario sale de ella
async function tarGuardarCampo(input) {
  const t = tar.tarifas.find((x) => x.id === Number(input.dataset.id));
  if (!t) return;
  const campo = input.dataset.tarCampo;
  const cambios = {};

  if (campo === "aprobada") {
    if (input.checked && tarSinPrecio(t)) {
      input.checked = false;
      return avisar("Escribe el precio Cash y el TC antes de aprobar esta tarifa.", "error");
    }
    cambios.aprobada = input.checked;
  } else if (campo === "iva") {
    cambios.iva = input.checked ? null : 0;
  } else {
    const texto = input.value.trim();
    let valor = texto === "" ? null : tarR2(texto);
    if (valor != null && (isNaN(valor) || valor < 0)) {
      input.value = campo === "neto" ? tarValorNeto(t) : t[campo] ?? "";
      return avisar("Escribe un monto válido.", "error");
    }
    if (campo === "tc" && valor === 0 && t.neto > 0) {
      input.value = t[campo] ?? "";
      return avisar("El precio TC debe ser mayor que cero. Si quieres dejarlo sin precio, borra la casilla.", "error");
    }
    if (campo === "neto" && valor == null) {
      input.value = tarValorNeto(t);
      return avisar("El neto no puede quedar vacío.", "error");
    }
    if (campo === "neto" && tarConIva(t)) valor = tarR2(valor / (1 + tar.ajustes.iva / 100));
    if (valor === t[campo]) { if (campo === "neto") input.value = tarValorNeto(t); return; }
    cambios[campo] = valor;
    // Si cambia el neto o se borra un precio, la tarifa vuelve a revisión
    if (t.aprobada && (campo === "neto" || valor == null)) cambios.aprobada = false;
  }

  cambios.actualizado = new Date().toISOString();
  const { error } = await db.from("tar_tarifas").update(cambios).eq("id", t.id);
  if (error) {
    if (campo === "aprobada") input.checked = t.aprobada; else input.value = t[campo] ?? "";
    return fallo(error);
  }
  Object.assign(t, cambios);
  if (campo !== "aprobada" && cambios.aprobada === false) avisar("La tarifa cambió y quedó pendiente de aprobar otra vez.");
  else if (campo === "cash" && tarSinCash(t)) avisar("Tarifa sin opción Cash: ese precio no aparecerá en el Tarifario final.");
  if (campo === "aprobada" && t.aprobada) {
    avisar(`${t.servicio} · ${t.categoria} aprobada: pasó al Tarifario final.`);
    if (tar.filtro.estado === "pendientes" || tar.filtro.estado === "revisar") return tarPintar();
  }
  tarRefrescarFila(t);
}

// Devuelve una tarifa aprobada a Procesar para poder editarla
async function tarRevertir(id) {
  const t = tar.tarifas.find((x) => x.id === Number(id));
  if (!t) return;
  if (!confirm(`¿Devolver ${t.servicio} · ${t.temporada} · ${t.categoria} a Procesar para editarla?\nSaldrá del Tarifario final hasta que la vuelvas a aprobar.`)) return;
  const { error } = await db.from("tar_tarifas").update({ aprobada: false, actualizado: new Date().toISOString() }).eq("id", t.id);
  if (error) return fallo(error);
  t.aprobada = false;
  tarPintar();
  avisar("La tarifa volvió a Procesar como pendiente. Edítala allí y apruébala de nuevo.");
}

async function tarLlenarSugeridos(btn) {
  const lista = tarFiltradas().filter(tarSinPrecio);
  if (!lista.length) return avisar("Todas las tarifas que se ven ya tienen precio Cash y TC.");
  if (!confirm(`Se llenarán con el precio sugerido las casillas vacías de ${lista.length} tarifa(s). Los precios que ya escribiste no se tocan. ¿Continuar?`)) return;
  await conBoton(btn, async () => {
    try {
      await tarEnPartes(lista, 20, (t) => db.from("tar_tarifas").update({
        cash: t.cash ?? tarSugCash(t), tc: t.tc ?? tarSugTc(t), actualizado: new Date().toISOString()
      }).eq("id", t.id));
    } catch (e) { fallo(e); }
    tar.tarifas = await tarLeerTarifas(tar.anio);
    tarPintar();
    avisar(`Se llenaron ${lista.length} tarifa(s) con el precio sugerido. Revísalas y ajusta lo que necesites.`);
  });
}

async function tarAprobarVisibles(btn) {
  const lista = tarFiltradas().filter((t) => !t.aprobada);
  const listas = lista.filter((t) => !tarSinPrecio(t));
  if (!lista.length) return avisar("Todas las tarifas que se ven ya están aprobadas.");
  if (!listas.length) return avisar("Ninguna de las tarifas que se ven tiene precio Cash y TC todavía.", "error");
  const bajas = listas.filter(tarMargenBajo).length;
  let texto = `Se aprobarán ${listas.length} tarifa(s).`;
  if (lista.length > listas.length) texto += ` ${lista.length - listas.length} no se aprobarán porque les falta el precio Cash o TC.`;
  if (bajas) texto += ` Atención: ${bajas} tienen margen por debajo del mínimo.`;
  if (!confirm(`${texto} ¿Continuar?`)) return;
  await conBoton(btn, async () => {
    const { error } = await db.from("tar_tarifas").update({ aprobada: true, actualizado: new Date().toISOString() }).in("id", listas.map((t) => t.id));
    if (error) return fallo(error);
    listas.forEach((t) => (t.aprobada = true));
    tarPintar();
    avisar(`${listas.length} tarifa(s) aprobadas.`);
  });
}

async function tarEliminarFila(id) {
  const t = tar.tarifas.find((x) => x.id === Number(id));
  if (!t || !confirm(`¿Eliminar la tarifa ${t.servicio} · ${t.temporada} · ${t.categoria}?`)) return;
  const { error } = await db.from("tar_tarifas").delete().eq("id", t.id);
  if (error) return fallo(error, "No se pudo eliminar.");
  tar.tarifas = tar.tarifas.filter((x) => x.id !== t.id);
  tarPintar();
  avisar("Tarifa eliminada.");
}

// ---------- Cambiar moneda en varias tarifas ya creadas de una sola vez ----------
function tarHtmlFormMoneda() {
  const f = tar.filtro;
  const lista = tarFiltradasOperadorTexto();
  const filtroTexto = [f.operador ? tarNombreOp(f.operador) : "Todos los operadores", f.texto ? `Búsqueda: ${f.texto}` : ""]
    .filter(Boolean).join(" · ");
  return `
    <div class="det-seccion sin-margen">
      <h3>Cambiar moneda de tarifas ya creadas</h3>
      <p class="nota">Se usan los filtros de Operador y Buscar de la pestaña Procesar: <strong>${escapar(filtroTexto)}</strong>.
        Coinciden <strong>${lista.length}</strong> tarifa(s) de ${tar.anio} (incluye las ya aprobadas). Si quieres cambiar solo un operador o un servicio, cierra esto, ajusta esos filtros y vuelve a abrir "Cambiar moneda".</p>
      <label class="tar-filtro-corto">Moneda nueva
        <select id="tarMonedaMasiva" autofocus>
          <option value="USD">Dólares (USD)</option>
          <option value="CRC">Colones (CRC)</option>
        </select>
      </label>
      <p class="nota">Las tarifas que ya estaban aprobadas y cambien de moneda volverán a quedar pendientes de aprobar, para que revises los precios en esa moneda.</p>
      <div class="sec-botones">
        <button type="button" class="btn primario" data-tar="guardar-moneda-masiva">Cambiar moneda</button>
        <button type="button" class="btn" data-tar="cancelar">Cancelar</button>
      </div>
    </div>`;
}

async function tarCambiarMonedaMasiva(btn) {
  const moneda = $("tarMonedaMasiva").value === "CRC" ? "CRC" : "USD";
  const lista = tarFiltradasOperadorTexto();
  if (!lista.length) return avisar("No hay tarifas que coincidan con esos filtros.", "error");
  const cambian = lista.filter((t) => t.moneda !== moneda);
  if (!cambian.length) return avisar(`Esas ${lista.length} tarifa(s) ya estaban en ${moneda === "CRC" ? "colones" : "dólares"}.`);
  const aprobadas = cambian.filter((t) => t.aprobada).length;
  let texto = `Se cambiará la moneda de ${cambian.length} tarifa(s) a ${moneda === "CRC" ? "Colones" : "Dólares"}.`;
  if (aprobadas) texto += ` ${aprobadas} estaban aprobadas y volverán a quedar pendientes.`;
  if (!confirm(`${texto} ¿Continuar?`)) return;
  await conBoton(btn, async () => {
    try {
      await tarEnPartes(cambian, 20, (t) => db.from("tar_tarifas").update({
        moneda, actualizado: new Date().toISOString(), ...(t.aprobada ? { aprobada: false } : {})
      }).eq("id", t.id));
    } catch (e) { return fallo(e); }
    tar.editando = null;
    tar.tarifas = await tarLeerTarifas(tar.anio);
    tarPintar();
    avisar(`Moneda cambiada en ${cambian.length} tarifa(s).${aprobadas ? ` ${aprobadas} volvieron a quedar pendientes de aprobar.` : ""}`);
  });
}

// =====================================================
// EDITOR: una tarifa, una temporada completa o tarifas nuevas
// =====================================================
function tarListas() {
  const unicos = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  const opt = (arr) => arr.map((v) => `<option value="${escapar(v)}">`).join("");
  return `
    <datalist id="tarListaOperadores">${opt(tar.operadores.map((o) => o.nombre))}</datalist>
    <datalist id="tarListaServicios">${opt(unicos(tar.tarifas.map((t) => t.servicio)))}</datalist>
    <datalist id="tarListaTemporadas">${opt(unicos(["Regular", "Alta", "Pico", "Baja", "Todo el año", ...tar.tarifas.map((t) => t.temporada)]))}</datalist>
    <datalist id="tarListaCategorias">${opt(unicos([...TAR_CATEGORIAS, ...tar.tarifas.map((t) => t.categoria)]))}</datalist>`;
}

function tarHtmlCamposGrupo(d, conAnio) {
  return `
    <div class="fila-form">
      ${conAnio ? `<label class="tar-filtro-corto">Año <input id="tarEdAnio" type="number" min="2000" max="2100" value="${d.anio ?? tar.anio}"></label>` : ""}
      <label>Operador <input id="tarEdOperador" list="tarListaOperadores" value="${escapar(d.operador ?? "")}" autofocus required></label>
      <label>Servicio <input id="tarEdServicio" list="tarListaServicios" value="${escapar(d.servicio ?? "")}" required></label>
    </div>
    <div class="fila-form">
      <label>Temporada <input id="tarEdTemporada" list="tarListaTemporadas" value="${escapar(d.temporada ?? "Regular")}"></label>
      <label>Desde <input id="tarEdDesde" type="date" value="${d.fecha_inicio ?? ""}" required></label>
      <label>Hasta <input id="tarEdHasta" type="date" value="${d.fecha_fin ?? ""}" required></label>
      <label class="tar-filtro-corto">Moneda
        <select id="tarEdMoneda">
          <option value="USD" ${d.moneda === "CRC" ? "" : "selected"}>Dólares (USD)</option>
          <option value="CRC" ${d.moneda === "CRC" ? "selected" : ""}>Colones (CRC)</option>
        </select>
      </label>
    </div>
    <p class="nota">Las fechas son obligatorias: el precio que ve el cliente depende de la fecha de la actividad.
      Si la tarifa aplica todo el año, <button type="button" class="enlace" data-tar="todo-anio">usa del 1 de enero al 31 de diciembre</button>. La moneda se aplica a todo este tour/temporada.</p>`;
}

function tarHtmlFilaCategoria(c = {}) {
  return `
    <tr class="tar-nueva-cat">
      <td><input class="tar-ed-cat" list="tarListaCategorias" value="${escapar(c.categoria ?? "")}" aria-label="Categoría"></td>
      <td><input class="tar-ed-neto tar-monto" type="number" min="0" step="0.01" value="${c.neto ?? ""}" aria-label="Neto"></td>
      <td><input class="tar-ed-cash tar-monto" type="number" min="0" step="0.01" value="${c.cash ?? ""}" aria-label="Cash"></td>
      <td><input class="tar-ed-tc tar-monto" type="number" min="0" step="0.01" value="${c.tc ?? ""}" aria-label="TC"></td>
    </tr>`;
}

function tarHtmlEditor() {
  const e = tar.editando;
  let titulo, cuerpo;

  if (e.tipo === "fila") {
    const t = tar.tarifas.find((x) => x.id === e.id);
    titulo = "Editar tarifa";
    cuerpo = tarHtmlCamposGrupo({ ...t, operador: tarNombreOp(t.operador_id) }, false) + `
      <div class="fila-form">
        <label>Categoría <input id="tarEdCategoria" list="tarListaCategorias" value="${escapar(t.categoria)}"></label>
        <label>Neto sin IVA <input id="tarEdNeto" type="number" min="0" step="0.01" value="${t.neto}"></label>
        <label class="check-linea tar-check-form"><input id="tarEdIva" type="checkbox" ${tarConIva(t) ? "checked" : ""}> Sumar IVA (${tar.ajustes.iva} %)</label>
        <label>Cash <input id="tarEdCash" type="number" min="0" step="0.01" value="${t.cash ?? ""}"></label>
        <label>TC <input id="tarEdTc" type="number" min="0" step="0.01" value="${t.tc ?? ""}"></label>
      </div>
      <label>Notas <input id="tarEdNotas" value="${escapar(t.notas ?? "")}" placeholder="Por ejemplo: incluye almuerzo, edad de niño 5 a 11"></label>`;
  } else if (e.tipo === "grupo") {
    const g = e.grupo;
    titulo = "Editar temporada";
    cuerpo = `<p class="nota">Los cambios se aplican a las ${g.filas.length} categorías de esta temporada.</p>`
      + tarHtmlCamposGrupo({ ...g, operador: tarNombreOp(g.operador_id), moneda: g.filas[0]?.moneda }, false) + `
      <div class="fila-form">
        <label>IVA (${tar.ajustes.iva} %)
          <select id="tarEdIva">
            <option value="">No cambiar</option>
            <option value="si">Sumar IVA a todas las categorías</option>
            <option value="no">Sin IVA en todas las categorías</option>
          </select>
        </label>
      </div>`;
  } else {
    const b = e.base || {};
    titulo = "Agregar tarifas";
    const cats = b.categorias?.length ? b.categorias.map((c) => ({ categoria: c })) : TAR_CATEGORIAS.map((c) => ({ categoria: c }));
    cuerpo = tarHtmlCamposGrupo({ ...b, temporada: b.servicio ? "" : "Regular" }, true) + `
      <div class="fila-form">
        <label class="check-linea tar-check-form"><input id="tarEdIva" type="checkbox" checked> Sumar IVA (${tar.ajustes.iva} %)</label>
        <label>Notas (opcional, se aplican a todas las categorías) <input id="tarEdNotas"></label>
      </div>
      <h4>Precios por categoría</h4>
      <p class="nota">Las filas sin neto no se guardan. Cash y TC los puedes dejar vacíos y ponerlos después.</p>
      <div class="tabla-scroll">
        <table class="tabla tar-tabla-nueva">
          <thead><tr><th>Categoría</th><th>Neto</th><th>Cash</th><th>TC</th></tr></thead>
          <tbody id="tarEdCategorias">${cats.map(tarHtmlFilaCategoria).join("")}</tbody>
        </table>
      </div>
      <button type="button" class="enlace" data-tar="agregar-categoria">Agregar otra categoría</button>`;
  }

  return `
    <div class="det-seccion sin-margen">
      <h3>${titulo}</h3>
      ${tarListas()}
      ${cuerpo}
      <div class="sec-botones">
        <button type="button" class="btn primario" data-tar="guardar-editor">Guardar</button>
        <button type="button" class="btn" data-tar="cancelar">Cancelar</button>
      </div>
    </div>`;
}

function tarLeerCamposGrupo() {
  const d = {
    operador: $("tarEdOperador").value.trim(),
    servicio: $("tarEdServicio").value.trim(),
    temporada: $("tarEdTemporada").value.trim() || "Todo el año",
    fecha_inicio: $("tarEdDesde").value || null,
    fecha_fin: $("tarEdHasta").value || null,
    moneda: $("tarEdMoneda").value === "CRC" ? "CRC" : "USD"
  };
  if (!d.operador) return avisar("Escribe el operador.", "error");
  if (!d.servicio) return avisar("Escribe el servicio.", "error");
  if (!d.fecha_inicio || !d.fecha_fin) return avisar("Escribe las fechas Desde y Hasta de la temporada (son obligatorias).", "error");
  if (d.fecha_inicio > d.fecha_fin) return avisar("La fecha Desde no puede ser posterior a Hasta.", "error");
  return d;
}
const tarNumCampo = (el) => (el.value.trim() === "" ? null : tarR2(el.value));

async function tarGuardarEditor(btn) {
  const e = tar.editando;
  const d = tarLeerCamposGrupo();
  if (!d) return;

  // null = con IVA; 0 = sin IVA; undefined = no cambiar (solo al editar una temporada)
  const elIva = $("tarEdIva");
  const iva = elIva.type === "checkbox" ? (elIva.checked ? null : 0) : elIva.value === "si" ? null : elIva.value === "no" ? 0 : undefined;

  await conBoton(btn, async () => {
    const operador_id = await tarOperadorId(d.operador);
    if (!operador_id) return;
    const ahora = new Date().toISOString();
    let error;

    if (e.tipo === "fila") {
      const t = tar.tarifas.find((x) => x.id === e.id);
      const neto = tarNumCampo($("tarEdNeto"));
      if (neto == null) return avisar("Escribe el neto.", "error");
      const cambios = {
        ...d, operador: undefined, operador_id, neto, iva,
        categoria: $("tarEdCategoria").value.trim() || t.categoria,
        cash: tarNumCampo($("tarEdCash")), tc: tarNumCampo($("tarEdTc")),
        notas: $("tarEdNotas").value.trim() || null, actualizado: ahora
      };
      delete cambios.operador;
      if (t.aprobada && (neto !== t.neto || cambios.cash == null || cambios.tc == null || d.moneda !== t.moneda)) cambios.aprobada = false;
      ({ error } = await db.from("tar_tarifas").update(cambios).eq("id", t.id));
    } else if (e.tipo === "grupo") {
      const cambios = { ...d, operador_id, actualizado: ahora };
      if (iva !== undefined) cambios.iva = iva;
      delete cambios.operador;
      // Si cambia la moneda, esas tarifas vuelven a pendiente de aprobar (los precios ya no corresponden a la moneda anterior)
      if (e.grupo.filas.some((t) => t.moneda !== d.moneda)) cambios.aprobada = false;
      ({ error } = await db.from("tar_tarifas").update(cambios).in("id", e.grupo.filas.map((t) => t.id)));
    } else {
      const anio = Number($("tarEdAnio").value);
      if (!anio || anio < 2000 || anio > 2100) return avisar("Escribe un año válido.", "error");
      const notas = $("tarEdNotas").value.trim() || null;
      const filas = [...document.querySelectorAll("#tarEdCategorias tr")].map((tr) => ({
        categoria: tr.querySelector(".tar-ed-cat").value.trim(),
        neto: tarNumCampo(tr.querySelector(".tar-ed-neto")),
        cash: tarNumCampo(tr.querySelector(".tar-ed-cash")),
        tc: tarNumCampo(tr.querySelector(".tar-ed-tc"))
      })).filter((f) => f.categoria && f.neto != null);
      if (!filas.length) return avisar("Escribe al menos una categoría con su neto.", "error");
      const nuevas = filas.map((f) => ({
        anio, operador_id, servicio: d.servicio, temporada: d.temporada,
        fecha_inicio: d.fecha_inicio, fecha_fin: d.fecha_fin, notas, iva, moneda: d.moneda, ...f
      }));
      ({ error } = await db.from("tar_tarifas").insert(nuevas));
      if (!error && anio !== tar.anio) tar.anio = anio;
    }

    if (error) return fallo(error);
    if (e.tipo === "fila" || e.tipo === "grupo") {
      const antes = e.tipo === "fila" ? tar.tarifas.find((x) => x.id === e.id) : e.grupo;
      if (antes) await tarMoverFicha(antes.operador_id, antes.servicio, operador_id, d.servicio);
    }
    tar.editando = null;
    tar.tarifas = await tarLeerTarifas(tar.anio);
    if (e.tipo === "nuevo" && tar.filtro.estado === "aprobadas") tar.filtro.estado = "pendientes";
    tarPintar();
    avisar("Cambios guardados.");
  });
}

// =====================================================
// PESTAÑA IMPORTAR
// =====================================================
const TAR_COLUMNAS = {
  operador: ["operador", "tour operador", "proveedor"],
  servicio: ["servicio", "tour", "actividad"],
  temporada: ["temporada"],
  fecha_inicio: ["desde", "fecha inicio", "inicio", "fecha desde"],
  fecha_fin: ["hasta", "fecha fin", "fin", "fecha hasta"],
  categoria: ["categoria", "tipo", "tipo de persona"],
  neto: ["neto", "tarifa neta", "precio neto"],
  cash: ["cash", "tarifa cash", "efectivo"],
  tc: ["tc", "tarifa tc", "tarjeta"],
  notas: ["notas", "observaciones"],
  iva: ["iva", "iva %", "impuesto"],
  moneda: ["moneda", "currency", "tipo de moneda"],
  tipo_actividad: ["tipo de actividad", "tipo actividad", "tipo de tour"],
  comparar: ["comparar como", "comparar", "actividad comparable"],
  incluye: ["incluye", "que incluye", "incluido"]
};

function tarHtmlImportar() {
  const imp = tar.importacion;
  let vista = "";
  if (imp) {
    const buenas = imp.filas.filter((f) => !f.error);
    const nuevas = buenas.filter((f) => f.estado === "nueva").length;
    const actualiza = buenas.length - nuevas;
    const errores = imp.filas.length - buenas.length;
    vista = `
      <div class="det-seccion sin-margen">
        <div class="sec-cabeza">
          <h3>Revisión de ${escapar(imp.archivo)}</h3>
          <div class="sec-botones">
            <button type="button" class="btn" data-tar="cancelar-importacion">Descartar</button>
            ${buenas.length ? `<button type="button" class="btn primario" data-tar="importar">Importar ${buenas.length} tarifa(s) a ${tar.anio}</button>` : ""}
          </div>
        </div>
        <p class="tar-resumen">
          <span><strong>${nuevas}</strong> nuevas</span>
          <span><strong>${actualiza}</strong> ya existen y se actualizarán</span>
          <span class="${errores ? "tar-alerta" : ""}"><strong>${errores}</strong> con errores (no se importan)</span>
        </p>
        <p class="nota">Compara esta lista con el documento del operador antes de importar. Las tarifas que ya existen se actualizan con el nuevo neto y fechas; si el neto cambió, vuelven a quedar pendientes de aprobar.</p>
        <div class="tabla-scroll">
          <table class="tabla tar-tabla">
            <thead><tr><th>Fila</th><th>Operador</th><th>Servicio</th><th>Temporada</th><th>Categoría</th><th>Moneda</th>
              <th class="num">Neto</th><th class="num">Cash</th><th class="num">TC</th><th>Estado</th></tr></thead>
            <tbody>${imp.filas.map((f) => `
              <tr class="${f.error ? "tar-fila-error" : ""}">
                <td>${f.fila}</td>
                <td>${escapar(f.operador)}</td>
                <td>${escapar(f.servicio)}${f.tipo_id ? ` <span class="tcmp-tipo">${escapar(tarNombreTipo(f.tipo_id))}</span>` : ""}${f.incluye ? `<br><span class="nota">Incluye: ${escapar(f.incluye)}</span>` : ""}</td>
                <td>${escapar(f.temporada)}${tarRango(f) ? `<br><span class="nota">${tarRango(f)}</span>` : ""}</td>
                <td>${escapar(f.categoria)}</td>
                <td>${f.moneda === "CRC" ? "₡ Colones" : "$ Dólares"}</td>
                <td class="num">${f.neto != null && !isNaN(f.neto) ? tarDinero(f.neto, f.moneda) : ""}</td>
                <td class="num">${f.cash != null && !isNaN(f.cash) ? tarDinero(f.cash, f.moneda) : ""}</td>
                <td class="num">${f.tc != null && !isNaN(f.tc) ? tarDinero(f.tc, f.moneda) : ""}</td>
                <td>${f.error ? `<span class="tar-alerta">${escapar(f.error)}</span>` : f.estado === "nueva" ? "Nueva" : "Actualiza"}${!f.error && f.aviso ? `<br><span class="tar-ojo">${escapar(f.aviso)}</span>` : ""}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>`;
  }

  return `
    <div class="det-seccion sin-margen">
      <h3>Importar tarifas desde Excel</h3>
      <ol class="tar-pasos">
        <li>Descarga la plantilla y copia en ella las tarifas del operador: una fila por cada categoría y temporada.</li>
        <li>Si el operador envió un PDF, pásaselo a Claude en el chat y pídele que llene la plantilla.</li>
        <li>Elige el año y sube el archivo. Antes de guardar vas a ver una lista para revisar.</li>
      </ol>
      <div class="fila-form">
        ${tarHtmlAnio()}
        <label>Archivo de Excel <input id="tarArchivo" type="file" accept=".xlsx,.xls,.csv"></label>
        <button type="button" class="btn" data-tar="plantilla">Descargar plantilla</button>
      </div>
      <p class="nota">Columnas que se reconocen: Operador, Servicio, Temporada, Desde, Hasta, Categoría, Neto, Cash, TC, Moneda, Notas, Tipo de actividad, Comparar como e Incluye. Desde y Hasta son obligatorias (si la temporada se llama "Todo el año" y no tiene fechas, se usa del 1 de enero al 31 de diciembre del año elegido). Cash, TC, Moneda y las tres últimas son opcionales (si no se indica, la moneda es Dólares). El tipo de actividad debe llamarse igual que en Tarifario › Tipos de actividad.</p>
    </div>
    ${vista}`;
}

function tarFechaValida(y, m, d) {
  const f = new Date(y, m - 1, d);
  return f.getFullYear() === y && f.getMonth() === m - 1 && f.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : undefined;
}
// Devuelve "AAAA-MM-DD", null si está vacía o undefined si no es una fecha válida
function tarFechaCelda(v, XLSX) {
  if (v === "" || v == null) return null;
  if (v instanceof Date) return isNaN(v) ? undefined : aTexto(new Date(v.getTime() + 12 * 3600e3));
  if (typeof v === "number") {
    const p = XLSX.SSF.parse_date_code(v);
    return p ? tarFechaValida(p.y, p.m, p.d) : undefined;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return tarFechaValida(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return tarFechaValida(+m[3] < 100 ? +m[3] + 2000 : +m[3], +m[2], +m[1]);
  return undefined;
}
// Columna IVA del Excel: "si" | "no" | null (vacía: con IVA) | undefined (no se entiende)
function tarIvaCelda(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v === 0 ? "no" : "si";
  const s = tarNorm(v);
  if (["si", "x", "s", "yes", "1"].includes(s) || /^\d+(\.\d+)?\s*%?$/.test(s) && Number(s.replace("%", "")) > 0) return "si";
  if (["no", "n", "0", "0%"].includes(s)) return "no";
  return undefined;
}
// Columna Moneda del Excel: "USD" | "CRC" | null (vacía: USD por defecto) | undefined (no se entiende)
function tarMonedaCelda(v) {
  if (v === "" || v == null) return null;
  const s = tarNorm(v);
  if (["usd", "dolar", "dolares", "$", "us$"].includes(s)) return "USD";
  if (["crc", "colon", "colones", "₡"].includes(s)) return "CRC";
  return undefined;
}

// Devuelve el monto, null si está vacío o undefined si no es un número
function tarMonto(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v < 0 ? undefined : tarR2(v);
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (!s) return undefined;
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return isNaN(n) || n < 0 ? undefined : tarR2(n);
}

async function tarLeerArchivo(archivo) {
  let XLSX;
  try { XLSX = await tarCargarXLSX(); } catch (e) { return fallo(e, ""); }
  let filas;
  try {
    const libro = XLSX.read(await archivo.arrayBuffer(), { cellDates: true });
    filas = XLSX.utils.sheet_to_json(libro.Sheets[libro.SheetNames[0]], { defval: "", raw: true });
  } catch (e) {
    return fallo(e, "No se pudo leer el archivo. Revisa que sea un Excel válido.");
  }

  const vistos = new Set();
  const resultado = [];
  filas.forEach((fila, i) => {
    const f = { fila: i + 2 };
    Object.entries(fila).forEach(([col, valor]) => {
      const campo = Object.keys(TAR_COLUMNAS).find((k) => TAR_COLUMNAS[k].includes(tarNorm(col)));
      if (campo && f[campo] === undefined) f[campo] = valor;
    });
    const texto = (x) => String(x ?? "").trim();
    f.operador = texto(f.operador); f.servicio = texto(f.servicio);
    f.temporada = texto(f.temporada) || "Todo el año"; f.categoria = texto(f.categoria); f.notas = texto(f.notas) || null;
    if (!f.operador && !f.servicio && !f.categoria && (f.neto === "" || f.neto == null)) return; // fila vacía

    const netoOriginal = f.neto;
    f.neto = tarMonto(f.neto); f.cash = tarMonto(f.cash); f.tc = tarMonto(f.tc); f.iva = tarIvaCelda(f.iva);
    f.moneda = tarMonedaCelda(f.moneda);
    // Datos del servicio (opcionales): tipo de actividad, comparar como e incluye
    const tipoTexto = texto(f.tipo_actividad);
    f.tipo_id = tarTipoCelda(tipoTexto);
    if (f.tipo_id === undefined) { f.aviso = `El tipo de actividad "${tipoTexto}" no existe en Tarifario › Tipos de actividad: no se asigna`; f.tipo_id = null; }
    f.comparar = texto(f.comparar) || null; f.incluye = texto(f.incluye) || null;
    const desde = tarFechaCelda(f.fecha_inicio, XLSX), hasta = tarFechaCelda(f.fecha_fin, XLSX);

    if (!f.operador) f.error = "Falta el operador";
    else if (!f.servicio) f.error = "Falta el servicio";
    else if (!f.categoria) f.error = "Falta la categoría";
    else if (f.neto === undefined) f.error = `Neto no válido: ${netoOriginal}`;
    else if (f.neto == null) f.error = "Falta el neto";
    else if (f.cash === undefined || f.tc === undefined) f.error = "Cash o TC no es un número";
    else if (f.iva === undefined) f.error = "IVA no válido (usa Sí o No)";
    else if (f.moneda === undefined) f.error = "Moneda no válida (usa Dólares o Colones)";
    else if (desde === undefined || hasta === undefined) f.error = "Fecha no válida (usa día/mes/año)";
    else if (desde && hasta && desde > hasta) f.error = "Desde es posterior a Hasta";
    else if (!desde && !hasta && tarNorm(f.temporada) === "todo el ano") {
      f.aviso = [f.aviso, `Sin fechas: se usará todo ${tar.anio} (1 ene al 31 dic)`].filter(Boolean).join(" · ");
    }
    else if (!desde || !hasta) f.error = "Faltan las fechas Desde y Hasta (son obligatorias)";
    const todoAnio = !f.error && !desde && !hasta;
    f.fecha_inicio = todoAnio ? `${tar.anio}-01-01` : desde || null;
    f.fecha_fin = todoAnio ? `${tar.anio}-12-31` : hasta || null;

    if (!f.error) {
      const clave = [f.operador, f.servicio, f.temporada, f.categoria].map(tarNorm).join("|");
      if (vistos.has(clave)) f.error = "Repetida en el archivo";
      vistos.add(clave);
      f.estado = tarBuscarExistente(f) ? "actualiza" : "nueva";
    }
    resultado.push(f);
  });

  if (!resultado.length) return avisar("El archivo no tiene tarifas. Revisa que la primera fila tenga los nombres de las columnas.", "error");
  tar.importacion = { archivo: archivo.name, filas: resultado };
  tarPintar();
}

function tarBuscarExistente(f, operador_id = null) {
  const opId = operador_id ?? tar.operadores.find((o) => tarNorm(o.nombre) === tarNorm(f.operador))?.id;
  if (!opId) return null;
  return tar.tarifas.find((t) => t.operador_id === opId && tarNorm(t.servicio) === tarNorm(f.servicio)
    && tarNorm(t.temporada) === tarNorm(f.temporada) && tarNorm(t.categoria) === tarNorm(f.categoria));
}

async function tarImportar(btn) {
  const filas = tar.importacion.filas.filter((f) => !f.error);
  await conBoton(btn, async () => {
    const ids = {};
    for (const nombre of new Set(filas.map((f) => f.operador))) {
      ids[tarNorm(nombre)] = await tarOperadorId(nombre);
      if (!ids[tarNorm(nombre)]) return;
    }
    const nuevas = [], cambios = [];
    filas.forEach((f) => {
      const operador_id = ids[tarNorm(f.operador)];
      const existe = tarBuscarExistente(f, operador_id);
      if (existe) {
        const c = { neto: f.neto, fecha_inicio: f.fecha_inicio, fecha_fin: f.fecha_fin, actualizado: new Date().toISOString() };
        if (f.notas) c.notas = f.notas;
        if (f.cash != null) c.cash = f.cash;
        if (f.tc != null) c.tc = f.tc;
        if (f.iva != null) c.iva = f.iva === "si" ? null : 0;
        if (f.moneda != null) c.moneda = f.moneda;
        if (existe.aprobada && (f.neto !== existe.neto || f.cash != null || f.tc != null || (f.moneda != null && f.moneda !== existe.moneda))) c.aprobada = false;
        cambios.push({ id: existe.id, c });
      } else {
        nuevas.push({
          anio: tar.anio, operador_id, servicio: f.servicio, temporada: f.temporada,
          fecha_inicio: f.fecha_inicio, fecha_fin: f.fecha_fin, categoria: f.categoria,
          neto: f.neto, cash: f.cash, tc: f.tc, notas: f.notas, iva: f.iva === "no" ? 0 : null, moneda: f.moneda || "USD"
        });
      }
    });
    try {
      for (let i = 0; i < nuevas.length; i += 500) {
        const { error } = await db.from("tar_tarifas").insert(nuevas.slice(i, i + 500));
        if (error) throw error;
      }
      await tarEnPartes(cambios, 20, (x) => db.from("tar_tarifas").update(x.c).eq("id", x.id));
    } catch (e) {
      tar.tarifas = await tarLeerTarifas(tar.anio);
      return fallo(e, "La importación no terminó. Revisa en Procesar qué se guardó.");
    }
    const fichas = await tarGuardarFichasImportadas(filas, ids);
    tar.importacion = null;
    tar.tarifas = await tarLeerTarifas(tar.anio);
    tar.pestana = "procesar";
    tar.filtro = { operador: "", estado: "pendientes", texto: "" };
    tarPintar();
    avisar(`Importación lista: ${nuevas.length} nuevas y ${cambios.length} actualizadas${fichas ? `; ${fichas} servicio(s) clasificados` : ""}. Ahora ponles precio y apruébalas.`);
  });
}

async function tarDescargarPlantilla() {
  let XLSX;
  try { XLSX = await tarCargarXLSX(); } catch (e) { return fallo(e, ""); }
  const a = tar.anio;
  const filas = [
    ["Operador", "Servicio", "Temporada", "Desde", "Hasta", "Categoría", "Neto", "Cash", "TC", "Moneda", "Notas", "Tipo de actividad", "Comparar como", "Incluye"],
    ["Operador de ejemplo", "Tour de ejemplo", "Regular", new Date(a, 4, 1), new Date(a, 10, 30), "Adulto", 80, "", "", "USD", "", "Aventura", "Canopy", "Transporte, almuerzo, guía bilingüe"],
    ["Operador de ejemplo", "Tour de ejemplo", "Regular", new Date(a, 4, 1), new Date(a, 10, 30), "Niño", 60, "", "", "USD", "Niños de 6 a 11 años", "", "", ""],
    ["Operador de ejemplo", "Tour de ejemplo", "Alta", new Date(a, 11, 1), new Date(a + 1, 3, 30), "Adulto", 90, "", "", "USD", "", "", "", ""],
    ["Operador de ejemplo", "Tour de ejemplo", "Alta", new Date(a, 11, 1), new Date(a + 1, 3, 30), "Niño", 70, "", "", "USD", "", "", "", ""]
  ];
  const hoja = XLSX.utils.aoa_to_sheet(filas, { cellDates: true, dateNF: "dd/mm/yyyy" });
  hoja["!cols"] = [24, 28, 14, 12, 12, 16, 10, 10, 10, 10, 30, 18, 18, 36].map((w) => ({ wch: w }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Tarifas");
  XLSX.writeFile(libro, "Plantilla tarifas.xlsx");
}

// =====================================================
// PESTAÑA OPERADORES (con sus políticas)
// =====================================================
function tarHtmlOperadores() {
  const cuenta = (id) => tar.tarifas.filter((t) => t.operador_id === id).length;
  return `
    <div class="det-seccion sin-margen">
      <div class="sec-cabeza">
        <h3>Operadores del tarifario</h3>
        <button type="button" class="btn primario" data-tar="nuevo-operador">Nuevo operador</button>
      </div>
      <p class="nota">Aquí guardas el contacto y las políticas de cada operador (cancelación, pagos, edades). Los operadores también se crean solos al importar un Excel. Es la lista única de proveedores: el resto del sistema la toma de aquí.</p>
      ${tar.operadores.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Operador</th><th>Contacto</th><th>Políticas</th><th class="num">Tarifas ${tar.anio}</th><th></th></tr></thead>
            <tbody>${tar.operadores.map((o) => `
              <tr>
                <td><strong>${escapar(o.nombre)}</strong></td>
                <td>${escapar(o.contacto ?? "")}</td>
                <td>${o.politicas ? `<span class="tar-recorte">${escapar(o.politicas)}</span>` : `<span class="nota">Sin políticas</span>`}</td>
                <td class="num">${cuenta(o.id)}</td>
                <td class="acciones-fila">
                  <button type="button" class="enlace" data-tar="editar-operador" data-id="${o.id}">Editar</button>
                  <button type="button" class="enlace peligro" data-tar="eliminar-operador" data-id="${o.id}">Eliminar</button>
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : `<p class="nota">Todavía no hay operadores.</p>`}
    </div>`;
}

function tarHtmlFormOperador() {
  const o = tar.editando.id ? tarOperador(tar.editando.id) : {};
  return `
    <div class="det-seccion sin-margen">
      <h3>${o.id ? "Editar operador" : "Nuevo operador"}</h3>
      <div class="fila-form">
        <label>Nombre <input id="tarOpNombre" value="${escapar(o.nombre ?? "")}" autofocus></label>
        <label>Contacto <input id="tarOpContacto" value="${escapar(o.contacto ?? "")}" placeholder="Nombre, correo o teléfono"></label>
      </div>
      <label>Políticas <textarea id="tarOpPoliticas" rows="7" placeholder="Cancelación, forma de pago, edades de niños, qué incluye…">${escapar(o.politicas ?? "")}</textarea></label>
      <label>Notas internas <textarea id="tarOpNotas" rows="3">${escapar(o.notas ?? "")}</textarea></label>
      <div class="sec-botones">
        <button type="button" class="btn primario" data-tar="guardar-operador">Guardar</button>
        <button type="button" class="btn" data-tar="cancelar">Cancelar</button>
      </div>
    </div>`;
}

async function tarGuardarOperador(btn) {
  const datos = {
    nombre: $("tarOpNombre").value.trim(),
    contacto: $("tarOpContacto").value.trim() || null,
    politicas: $("tarOpPoliticas").value.trim() || null,
    notas: $("tarOpNotas").value.trim() || null
  };
  if (!datos.nombre) return avisar("Escribe el nombre del operador.", "error");
  const id = tar.editando.id;
  if (tar.operadores.some((o) => o.id !== id && tarNorm(o.nombre) === tarNorm(datos.nombre))) {
    return avisar("Ya existe un operador con ese nombre.", "error");
  }
  await conBoton(btn, async () => {
    const { error } = id
      ? await db.from("tar_operadores").update(datos).eq("id", id)
      : await db.from("tar_operadores").insert(datos);
    if (error) return fallo(error);
    tar.editando = null;
    await tarCargar();
    tarPintar();
    avisar("Operador guardado.");
  });
}

async function tarEliminarOperador(id) {
  const o = tarOperador(id);
  const { count, error } = await db.from("tar_tarifas").select("id", { count: "exact", head: true }).eq("operador_id", o.id);
  if (error) return fallo(error);
  const texto = count
    ? `${o.nombre} tiene ${count} tarifa(s) guardadas (sumando todos los años). Si lo eliminas, se borran también esas tarifas. ¿Eliminar?`
    : `¿Eliminar el operador ${o.nombre}?`;
  if (!confirm(texto)) return;
  const r = await db.from("tar_operadores").delete().eq("id", o.id);
  if (r.error) return fallo(r.error, "No se pudo eliminar.");
  await tarCargar();
  tarPintar();
  avisar("Operador eliminado.");
}

// =====================================================
// PESTAÑA TARIFARIO FINAL (solo tarifas aprobadas)
// =====================================================
function tarFinalFiltradas() {
  const f = tar.final, txt = tarNorm(f.texto);
  return tar.tarifas.filter((t) => {
    const ficha = tarFicha(t.operador_id, t.servicio);
    return t.aprobada
      && (!f.operador || t.operador_id === Number(f.operador))
      && (!f.tipo || (f.tipo === "sin" ? !ficha?.tipo_id : ficha?.tipo_id === Number(f.tipo)))
      && (!f.fecha || ((!t.fecha_inicio || t.fecha_inicio <= f.fecha) && (!t.fecha_fin || t.fecha_fin >= f.fecha)))
      && (!txt || tarNorm(`${t.servicio} ${t.temporada} ${t.categoria} ${tarNombreOp(t.operador_id)} ${tarNombreTipo(ficha?.tipo_id)} ${ficha?.comparar ?? ""} ${ficha?.incluye ?? ""}`).includes(txt));
  });
}

function tarHtmlFinal() {
  const f = tar.final;
  const lista = tarFinalFiltradas();
  const ops = tarAgrupar(lista);
  const consulta = tarSoloConsulta();
  const cols = (f.verNeto ? 8 : 6) - (consulta ? 1 : 0);

  const bloques = ops.map((op) => {
    const o = tarOperador(op.id);
    const porServicio = [];
    op.grupos.forEach((g) => {
      let s = porServicio.at(-1);
      if (!s || s.servicio !== g.servicio) porServicio.push((s = { servicio: g.servicio, grupos: [] }));
      s.grupos.push(g);
    });
    return `
      <section class="det-seccion sin-margen tar-op-final">
        <h3>${escapar(o?.nombre ?? "")}</h3>
        ${f.politicas && o?.politicas ? `<div class="tar-politicas">${escapar(o.politicas)}</div>` : ""}
        <div class="tabla-scroll">
          <table class="tabla tar-final">
            <thead><tr><th>Temporada</th><th>Categoría</th>${f.verNeto ? `<th class="num">Neto con IVA</th><th class="num">Neto sin IVA</th>` : ""}<th class="num">Cash</th><th class="num">TC</th>${consulta ? "" : `<th class="tar-no-imprimir"></th>`}</tr></thead>
            <tbody>${porServicio.map((s) => `
              <tr class="fila-grupo"><th colspan="${cols}">${tarHtmlServicioFinal(op.id, s.servicio)}</th></tr>
              ${s.grupos.map((g) => g.filas.map((t, i) => `
                <tr class="${i === 0 ? "tar-inicio-temporada" : ""}">
                  <td>${i === 0 ? `${escapar(g.temporada)} <span class="tar-moneda">${tarMonedaEtiqueta(g.filas[0]?.moneda)}</span>${tarRango(g) ? `<br><span class="nota">${tarRango(g)}</span>` : ""}` : ""}</td>
                  <td>${escapar(t.categoria)}${t.notas ? `<br><span class="nota">${escapar(t.notas)}</span>` : ""}</td>
                  ${f.verNeto ? `<td class="num">${tarConIva(t) ? tarDinero(tarCosto(t), t.moneda) : `<span class="nota">No aplica IVA</span>`}</td><td class="num">${tarDinero(t.neto, t.moneda)}</td>` : ""}
                  <td class="num">${tarSinCash(t) ? `<span class="nota">—</span>` : tarDinero(t.cash, t.moneda)}</td>
                  <td class="num">${tarDinero(t.tc, t.moneda)}</td>
                  ${consulta ? "" : `<td class="acciones-fila tar-no-imprimir"><button type="button" class="enlace" data-tar="revertir" data-id="${t.id}">Revertir</button></td>`}
                </tr>`).join("")).join("")}`).join("")}
            </tbody>
          </table>
        </div>
      </section>`;
  }).join("");

  const pendientes = consulta ? 0 : tar.tarifas.filter((t) => !t.aprobada).length;
  const filtroTexto = [
    f.operador ? tarNombreOp(f.operador) : "",
    f.tipo ? (f.tipo === "sin" ? "Sin tipo de actividad" : tarNombreTipo(f.tipo)) : "",
    f.fecha ? `Vigentes el ${tarFechaCorta(f.fecha)}` : "",
    f.texto ? `Búsqueda: ${f.texto}` : ""
  ].filter(Boolean).join(" · ");

  return `
    <div class="tar-filtros">
      ${tarHtmlAnio()}
      <label>Operador <select data-tar-final="operador">${tarOpcionesOperadores(f.operador)}</select></label>
      <label>Tipo de actividad <select data-tar-final="tipo">${tarOpcionesTipos(f.tipo)}</select></label>
      <label class="tar-filtro-corto">Vigentes el <input type="date" value="${f.fecha}" data-tar-final="fecha"></label>
      <label class="tar-buscar">Buscar <input id="tarBuscarFinal" type="search" value="${escapar(f.texto)}" placeholder="Servicio, categoría o lo que incluye" data-tar-final="texto"></label>
    </div>
    <div class="tar-filtros tar-opciones">
      ${tarPuedeVerNeto() ? `<label class="check-linea chico"><input type="checkbox" data-tar-final="verNeto" ${f.verNeto ? "checked" : ""}> Mostrar neto</label>` : ""}
      <label class="check-linea chico"><input type="checkbox" data-tar-final="politicas" ${f.politicas ? "checked" : ""}> Incluir políticas</label>
      <span class="tar-espacio"></span>
      ${lista.length ? `
        <button type="button" class="btn" data-tar="exportar">Descargar Excel</button>
        <button type="button" class="btn primario" data-tar="imprimir">Imprimir</button>` : ""}
    </div>
    ${pendientes ? `<p class="aviso suave tar-no-imprimir">${pendientes} tarifa(s) de ${tar.anio} siguen pendientes de aprobar y no aparecen aquí.</p>` : ""}
    <div class="solo-impresion tar-imp-cabeza">
      <p class="imp-marca">The House of Tours</p>
      <p class="imp-titulo">Tarifario ${tar.anio}</p>
      ${filtroTexto ? `<p class="nota">${escapar(filtroTexto)}</p>` : ""}
    </div>
    ${lista.length ? bloques : `<div class="tar-vacio"><p><strong>No hay tarifas aprobadas que mostrar.</strong></p>
      <p>${consulta ? "Todavía no hay tarifas publicadas para este año." : "Las tarifas aparecen aquí cuando las apruebas en la pestaña Procesar."}</p></div>`}`;
}

// Encabezado de cada servicio en el Tarifario final: nombre, tipo de actividad y lo que incluye
function tarHtmlServicioFinal(operador_id, servicio) {
  const ficha = tarFicha(operador_id, servicio);
  const tipo = tarNombreTipo(ficha?.tipo_id);
  return `${escapar(servicio)}${tipo ? ` <span class="tcmp-tipo">${escapar(tipo)}</span>` : ""}`
    + (ficha?.incluye ? `<span class="tar-incluye">Incluye: ${escapar(tarItems(ficha.incluye).join(", "))}</span>` : "");
}

async function tarExportar() {
  let XLSX;
  try { XLSX = await tarCargarXLSX(); } catch (e) { return fallo(e, ""); }
  const f = tar.final;
  const aFecha = (t) => (t ? new Date(t + "T12:00:00") : "");
  const filas = [...tarFinalFiltradas()].sort(tarOrden).map((t) => {
    const ficha = tarFicha(t.operador_id, t.servicio);
    const fila = {
      Operador: tarNombreOp(t.operador_id), Servicio: t.servicio,
      "Tipo de actividad": tarTipoPorId(ficha?.tipo_id)?.nombre ?? "", Temporada: t.temporada,
      Desde: aFecha(t.fecha_inicio), Hasta: aFecha(t.fecha_fin), "Categoría": t.categoria,
      Moneda: t.moneda === "CRC" ? "Colones" : "Dólares"
    };
    if (f.verNeto) { fila["Neto con IVA"] = tarConIva(t) ? tarCosto(t) : "No aplica"; fila["Neto sin IVA"] = t.neto; fila.IVA = tarConIva(t) ? "Sí" : "No"; }
    fila.Cash = tarSinCash(t) ? "—" : t.cash;
    fila.TC = t.tc;
    fila.Incluye = ficha?.incluye ?? "";
    fila.Notas = t.notas ?? "";
    return fila;
  });
  const hoja = XLSX.utils.json_to_sheet(filas, { cellDates: true, dateNF: "dd/mm/yyyy" });
  hoja["!cols"] = [24, 28, 16, 14, 12, 12, 16, 12, 10, 10, 10, 10, 10, 36, 30].map((w) => ({ wch: w }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, `Tarifario ${tar.anio}`);
  XLSX.writeFile(libro, `Tarifario ${tar.anio}.xlsx`);
}

// =====================================================
// PESTAÑA AJUSTES
// =====================================================
function tarHtmlAjustes() {
  const a = tar.ajustes;
  const campo = (id, texto, ayuda) => `
    <label>${texto} <input id="tarAj_${id}" type="number" min="0" step="0.1" value="${a[id]}">
      <span class="nota">${ayuda}</span></label>`;
  return `
    <div class="det-seccion sin-margen">
      <h3>Porcentajes de referencia</h3>
      <p class="nota">Se usan para el precio sugerido y para marcar en rojo los márgenes bajos. El precio final siempre lo decides tú.</p>
      <div class="fila-form tar-ajustes">
        ${campo("cash_ref", "Margen sugerido Cash (%)", "Se suma al neto con IVA.")}
        ${campo("iva", "IVA (%)", "Se suma al neto en las tarifas que tienen marcada la casilla IVA.")}
        ${campo("tc_ref", "Margen sugerido TC (%)", "Se suma al neto con IVA.")}
      </div>
      <div class="fila-form tar-ajustes">
        ${campo("cash_min", "Margen mínimo Cash (%)", "Por debajo se marca en rojo.")}
        ${campo("tc_min", "Margen mínimo TC (%)", "Por debajo se marca en rojo.")}
        ${campo("tipo_cambio", "Tipo de cambio (₡ por cada $1)", "Convierte a dólares las tarifas en colones: para comparar y para el precio que ve el cliente. 0 = no convertir (esas tarifas no se muestran al cliente).")}
      </div>
      <p class="nota">Ejemplo con neto de $80 y la casilla IVA marcada: neto con IVA ${dinero(tarCosto({ neto: 80 }))}; Cash sugerido ${dinero(tarSugCash({ neto: 80 }))}; TC sugerido ${dinero(tarSugTc({ neto: 80 }))}.</p>
      <div class="sec-botones"><button type="button" class="btn primario" data-tar="guardar-ajustes">Guardar</button></div>
    </div>
    ${typeof tarHtmlCategorias === "function" ? tarHtmlCategorias() : ""}`;
}

async function tarGuardarAjustes(btn) {
  const filas = Object.keys(tar.ajustes).map((clave) => ({ clave, valor: Number($(`tarAj_${clave}`).value) }));
  if (filas.some((f) => isNaN(f.valor) || f.valor < 0)) return avisar("Revisa los porcentajes: deben ser números positivos.", "error");
  await conBoton(btn, async () => {
    const { error } = await db.from("tar_ajustes").upsert(filas);
    if (error) return fallo(error);
    filas.forEach((f) => (tar.ajustes[f.clave] = f.valor));
    tarPintar();
    avisar("Porcentajes guardados.");
  });
}

// =====================================================
// EVENTOS
// =====================================================
$("tarContenido").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tar]");
  if (!b) return;
  const accion = b.dataset.tar;
  if (tarSoloConsulta() && accion !== "exportar" && accion !== "imprimir") return;
  const grupo = () => tar.grupos[Number(b.dataset.g)];

  if (accion === "cancelar") { tar.editando = null; return tarPintar(); }
  if (accion === "nueva") { tar.editando = { tipo: "nuevo" }; return tarPintar(); }
  if (accion === "cambiar-moneda") { tar.editando = { tipo: "moneda-masiva" }; return tarPintar(); }
  if (accion === "guardar-moneda-masiva") return tarCambiarMonedaMasiva(b);
  if (accion === "ir-importar") { tar.pestana = "importar"; return tarPintar(); }
  if (accion === "editar-fila") { tar.editando = { tipo: "fila", id: Number(b.dataset.id) }; return tarPintar(); }
  if (accion === "eliminar-fila") return tarEliminarFila(b.dataset.id);
  if (accion === "usar-sugerido") {
    const t = tar.tarifas.find((x) => x.id === Number(b.dataset.id));
    const input = b.closest("td").querySelector("[data-tar-campo]");
    if (!t || !input) return;
    input.value = (b.dataset.campo === "cash" ? tarSugCash(t) : tarSugTc(t)).toFixed(2);
    return tarGuardarCampo(input);
  }
  if (accion === "editar-grupo") { tar.editando = { tipo: "grupo", grupo: grupo() }; return tarPintar(); }
  if (accion === "nueva-temporada") {
    const g = grupo();
    tar.editando = { tipo: "nuevo", base: { operador: tarNombreOp(g.operador_id), servicio: g.servicio, categorias: g.filas.map((t) => t.categoria), moneda: g.filas[0]?.moneda } };
    return tarPintar();
  }
  if (accion === "todo-anio") {
    const anio = Number($("tarEdAnio")?.value) || Number(($("tarEdDesde").value || "").slice(0, 4)) || tar.anio;
    $("tarEdDesde").value = `${anio}-01-01`;
    $("tarEdHasta").value = `${anio}-12-31`;
    return;
  }
  if (accion === "agregar-categoria") return $("tarEdCategorias").insertAdjacentHTML("beforeend", tarHtmlFilaCategoria());
  if (accion === "guardar-editor") return tarGuardarEditor(b);
  if (accion === "sugeridos") return tarLlenarSugeridos(b);
  if (accion === "aprobar-visibles") return tarAprobarVisibles(b);
  if (accion === "plantilla") return tarDescargarPlantilla();
  if (accion === "importar") return tarImportar(b);
  if (accion === "cancelar-importacion") { tar.importacion = null; return tarPintar(); }
  if (accion === "nuevo-operador") { tar.editando = { tipo: "operador", id: null }; return tarPintar(); }
  if (accion === "editar-operador") { tar.editando = { tipo: "operador", id: Number(b.dataset.id) }; return tarPintar(); }
  if (accion === "guardar-operador") return tarGuardarOperador(b);
  if (accion === "eliminar-operador") return tarEliminarOperador(b.dataset.id);
  if (accion === "exportar") return tarExportar();
  if (accion === "revertir") return tarRevertir(b.dataset.id);
  if (accion === "imprimir") return window.print();
  if (accion === "guardar-ajustes") return tarGuardarAjustes(b);
});

$("tarContenido").addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.tarCampo) return tarSoloConsulta() ? undefined : tarGuardarCampo(el);
  if (el.id === "tarAnio") {
    tar.anio = Number(el.value);
    tar.importacion = null;
    $("tarContenido").innerHTML = `<p class="nota">Cargando tarifas de ${tar.anio}…</p>`;
    tar.tarifas = await tarLeerTarifas(tar.anio);
    return tarPintar();
  }
  if (el.id === "tarArchivo" && el.files[0]) return tarLeerArchivo(el.files[0]);
  if (el.dataset.tarFiltro && el.dataset.tarFiltro !== "texto") { tar.filtro[el.dataset.tarFiltro] = el.value; return tarPintar(); }
  if (el.dataset.tarFinal && el.dataset.tarFinal !== "texto") {
    tar.final[el.dataset.tarFinal] = el.type === "checkbox" ? el.checked : el.value;
    return tarPintar();
  }
});

// Búsqueda mientras se escribe (sin perder el cursor)
$("tarContenido").addEventListener("input", (e) => {
  const el = e.target;
  const donde = el.dataset.tarFiltro === "texto" ? tar.filtro : el.dataset.tarFinal === "texto" ? tar.final : null;
  if (!donde) return;
  donde.texto = el.value;
  clearTimeout(tarPintar.espera);
  tarPintar.espera = setTimeout(() => {
    const id = el.id;
    tarPintar();
    const nuevo = $(id);
    if (nuevo) { nuevo.focus(); nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length); }
  }, 300);
});
