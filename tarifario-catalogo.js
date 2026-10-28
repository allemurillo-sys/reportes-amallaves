// =====================================================
// TARIFARIO › CATÁLOGO, TIPOS DE ACTIVIDAD Y CATEGORÍAS (solo administradores)
// El Tarifario es la fuente única del sistema. Aquí se completa lo que ve el cliente
// de cada servicio: nombre, tipo de actividad, descripción, horarios, fotos,
// traducciones y si se muestra en el formulario. También:
//   · alertas de duplicados (mismo proveedor) y de actividades con varios proveedores,
//   · tipos de actividad (antes en Servicios),
//   · equivalencia entre las categorías del tarifario y los tipos de cliente.
// Los datos del cliente se guardan en la tabla servicios (la que leen el formulario y el panel),
// enlazada a su ficha del tarifario (tar_fichas.servicio_id).
// Usa utilidades de panel.js, servicios.js, tarifario.js y tarifario-comparar.js.
// =====================================================

const TAR_FOTOS_MIN = 3;
const TAR_FOTOS_MAX = 8;
const TAR_FOTO_ANCHO = 1200;   // todas las fotos quedan de 1200 × 900 (horizontal 4:3)
const TAR_FOTO_ALTO = 900;
const TAR_BUCKET = "servicios-fotos";
const TAR_DIAS_AVISO = 60;     // avisar cuando la última tarifa termina en menos de estos días
const TAR_IDIOMAS = { en: "Inglés", fr: "Francés", de: "Alemán", it: "Italiano" };

tar.cobertura = [];                 // tarifas de todos los años (solo los campos necesarios)
tar.mapaCategorias = new Map();     // clave de la categoría del tarifario → { clave, nombre, categoria_id }
tar.mapaError = null;
tar.catalogo = { tipo: "", ver: "todos", texto: "" };
tar.catItems = [];                  // filas pintadas en Catálogo
tar.previa = { fecha: "", resultado: null, cargando: false };

// ---------- Datos ----------
async function tarLeerCatalogoExtra() {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db.from("tar_tarifas")
      .select("id, anio, operador_id, servicio, categoria, fecha_inicio, fecha_fin, aprobada, tc, moneda")
      .order("id").range(desde, desde + 999);
    if (error) { fallo(error, "No se pudieron cargar las temporadas."); break; }
    todas.push(...data);
    if (data.length < 1000) break;
  }
  tar.cobertura = todas.map((t) => ({ ...t, operador_id: Number(t.operador_id) }));
  const m = await db.from("tar_categorias").select("*");
  tar.mapaError = m.error || null;
  tar.mapaCategorias = new Map((m.data || []).map((x) => [x.clave, x]));
}

// Al entrar a Catálogo, Tipos o Ajustes se vuelve a leer lo necesario
document.querySelectorAll(".pestana[data-tar-pestana]").forEach((b) => b.addEventListener("click", async () => {
  if (!tarEsAdmin() || !["catalogo", "tipos", "ajustes"].includes(b.dataset.tarPestana)) return;
  await Promise.all([tarLeerCatalogoExtra(), tarLeerFichas(), cargarCatalogos()]);
  if (tar.pestana === b.dataset.tarPestana && !tar.editando) tarPintar();
}));

const tarClaveItem = (it) => (it.sinTarifario ? `s|${it.srv.id}` : `${it.operador_id}|${tarNorm(it.servicio)}`);
const tarFotos = (srv) => (Array.isArray(srv?.fotos) ? srv.fotos : []);
const tarNombreCliente = (it) => it.srv?.nombre || it.servicio;
const tarTraducidos = (srv) => Object.keys(TAR_IDIOMAS).filter((k) => srv?.traducciones?.[k]?.nombre).length;

// Una fila por cada servicio del tarifario (operador + servicio), más los servicios
// del catálogo que todavía no vienen del tarifario.
function tarItemsCatalogo() {
  const mapa = new Map();
  const clave = (op, s) => `${Number(op)}|${tarNorm(s)}`;
  tar.cobertura.forEach((t) => {
    const k = clave(t.operador_id, t.servicio);
    if (!mapa.has(k)) mapa.set(k, { operador_id: Number(t.operador_id), servicio: t.servicio, tarifas: [] });
    mapa.get(k).tarifas.push(t);
  });
  tar.fichas.forEach((f) => {
    const k = clave(f.operador_id, f.servicio);
    if (!mapa.has(k) && f.servicio_id) mapa.set(k, { operador_id: Number(f.operador_id), servicio: f.servicio, tarifas: [] });
  });
  const items = [...mapa.values()]
    .filter((it) => tarOperador(it.operador_id)?.nombre !== "Operador de ejemplo")
    .map((it) => {
      const ficha = tarFicha(it.operador_id, it.servicio);
      return { ...it, ficha, srv: ficha?.servicio_id ? servicioPorId(ficha.servicio_id) : null };
    });
  const enlazados = new Set(items.map((i) => i.srv?.id).filter(Boolean));
  app.servicios.filter((s) => !enlazados.has(s.id)).forEach((s) =>
    items.push({ operador_id: null, servicio: s.nombre, tarifas: [], ficha: null, srv: s, sinTarifario: true }));

  const hoy = aTexto(new Date());
  const enDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return aTexto(d); };
  const limite = enDias(TAR_DIAS_AVISO);
  items.forEach((it) => {
    it.clave = tarClaveItem(it);
    it.tipo_id = it.ficha?.tipo_id ?? it.srv?.tipo_id ?? null;
    it.visible = !!it.srv?.activo;
    const aprobadas = it.tarifas.filter((t) => t.aprobada);
    it.aprobadas = aprobadas.length;
    it.hasta = aprobadas.reduce((m, t) => (t.fecha_fin > m ? t.fecha_fin : m), "");
    it.vigenteHoy = aprobadas.some((t) => t.fecha_inicio <= hoy && hoy <= t.fecha_fin);
    it.porVencer = it.hasta && it.hasta >= hoy && it.hasta <= limite;
    it.vencida = it.hasta && it.hasta < hoy;
    it.grupo = tarNorm(it.ficha?.comparar || it.servicio);
  });

  // Grupos: misma actividad ("Comparar como" o mismo nombre)
  const grupos = new Map();
  items.filter((i) => !i.sinTarifario).forEach((i) => grupos.set(i.grupo, [...(grupos.get(i.grupo) || []), i]));
  items.forEach((i) => {
    const g = i.sinTarifario ? [i] : grupos.get(i.grupo);
    i.otrosProveedores = g.filter((x) => x !== i && x.operador_id !== i.operador_id);
    i.mismoProveedor = g.filter((x) => x !== i && x.operador_id === i.operador_id);
    i.dupPendiente = i.mismoProveedor.length > 0 && !(i.ficha?.duplicado_ok && i.mismoProveedor.every((x) => x.ficha?.duplicado_ok));
    // Con quién compite por mostrarse al cliente (solo una versión por actividad)
    i.rivales = [...i.otrosProveedores, ...(i.dupPendiente ? i.mismoProveedor : [])];
  });
  items.forEach((i) => (i.alertas = tarAlertasItem(i)));
  return items;
}

function tarAlertasItem(i) {
  const a = [];   // { nivel: "alerta" | "aviso", texto }
  if (i.dupPendiente) {
    a.push({ nivel: "alerta", dup: true, texto: `Posible duplicado del mismo proveedor: ${i.mismoProveedor.map((x) => `"${x.servicio}"`).join(", ")}. ¿Es un error de ingreso?` });
  }
  const visiblesRivales = i.rivales.filter((x) => x.visible);
  if (i.visible && visiblesRivales.length) {
    a.push({ nivel: "alerta", texto: `El cliente vería esta actividad repetida: también se muestra ${visiblesRivales.map((x) => `la de ${tarNombreOp(x.operador_id) || "otro proveedor"}`).join(", ")}. Deja solo una.` });
  }
  if (!i.tipo_id) a.push({ nivel: "aviso", texto: "Sin tipo de actividad." });
  if (i.sinTarifario) {
    a.push({ nivel: i.visible ? "alerta" : "aviso", texto: "No viene del Tarifario: no tiene tarifas, así que el cliente verá \"tarifa pendiente\". Si ya existe en el tarifario con otro nombre, oculta esta versión y usa aquella; si no, crea sus tarifas en Procesar o Importar." });
    return a;
  }
  if (!i.visible) return a;
  const fotos = tarFotos(i.srv).length;
  if (fotos < TAR_FOTOS_MIN) a.push({ nivel: "aviso", texto: `Tiene ${fotos} de ${TAR_FOTOS_MIN} fotos.` });
  if (!i.srv?.descripcion) a.push({ nivel: "aviso", texto: "Sin descripción para el cliente." });
  if (!i.aprobadas) a.push({ nivel: "alerta", texto: "Sin tarifas aprobadas: el cliente verá \"tarifa pendiente\"." });
  else if (i.vencida) a.push({ nivel: "alerta", texto: `Su última tarifa terminó el ${tarFechaCorta(i.hasta)}.` });
  else if (i.porVencer) a.push({ nivel: "aviso", texto: `Su última tarifa termina el ${tarFechaCorta(i.hasta)}: carga la siguiente temporada.` });
  return a;
}

// Categorías del tarifario que todavía no tienen equivalencia
function tarCategoriasSinAsignar() {
  const vistas = new Map();
  tar.cobertura.forEach((t) => { const k = tarNorm(t.categoria); if (!vistas.has(k)) vistas.set(k, t.categoria); });
  return [...vistas.keys()].filter((k) => !tar.mapaCategorias.has(k));
}

// =====================================================
// PESTAÑA CATÁLOGO
// =====================================================
function tarHtmlCatalogo() {
  const todos = tarItemsCatalogo();
  const c = tar.catalogo, txt = tarNorm(c.texto);
  const lista = todos.filter((i) =>
    (!c.tipo || (c.tipo === "sin" ? !i.tipo_id : i.tipo_id === Number(c.tipo)))
    && (c.ver === "todos" || (c.ver === "alertas" && i.alertas.length) || (c.ver === "visibles" && i.visible)
      || (c.ver === "ocultos" && !i.visible) || (c.ver === "varios" && i.otrosProveedores.length))
    && (!txt || tarNorm(`${i.servicio} ${i.srv?.nombre ?? ""} ${tarNombreOp(i.operador_id)} ${i.ficha?.comparar ?? ""}`).includes(txt)));
  tar.catItems = lista;

  const visibles = todos.filter((i) => i.visible).length;
  const conAlertas = todos.filter((i) => i.alertas.some((a) => a.nivel === "alerta")).length;
  const dups = todos.filter((i) => i.dupPendiente).length;
  const sinAsignar = tarCategoriasSinAsignar().length;

  // Un bloque por tipo de actividad, en el orden que ve el cliente
  const bloques = [...tarTipos().map((tp) => ({ titulo: nombreTipo(tp), oculto: !tp.activo, id: tp.id })), { titulo: "Sin tipo de actividad", id: null }]
    .map((b) => ({ ...b, filas: lista.filter((i) => (b.id ? i.tipo_id === b.id : !tarTipoPorId(i.tipo_id))) }))
    .filter((b) => b.filas.length);

  const cuerpo = bloques.map((b) => `
    <tr class="fila-grupo"><th colspan="7">${escapar(b.titulo)}
      <span class="nota">${b.filas.length} ${b.filas.length === 1 ? "servicio" : "servicios"}${b.oculto ? " · tipo oculto: el cliente no ve estas actividades" : ""}</span></th></tr>
    ${b.filas.sort((x, y) => tarNombreCliente(x).localeCompare(tarNombreCliente(y), "es") || tarNombreOp(x.operador_id).localeCompare(tarNombreOp(y.operador_id), "es"))
      .map(tarHtmlFilaCatalogo).join("")}`).join("");

  return `
    <div class="tar-filtros">
      <label>Tipo de actividad <select data-tcat-filtro="tipo">${tarOpcionesTipos(c.tipo)}</select></label>
      <label>Mostrar
        <select data-tcat-filtro="ver">
          ${[["todos", "Todos los servicios"], ["alertas", "Con alertas o avisos"], ["visibles", "Visibles para clientes"], ["ocultos", "Ocultos"], ["varios", "Con varios proveedores"]]
            .map(([v, t]) => `<option value="${v}" ${c.ver === v ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </label>
      <label class="tar-buscar">Buscar <input id="tcatBuscar" type="search" value="${escapar(c.texto)}" placeholder="Servicio, proveedor o grupo" data-tcat-filtro="texto"></label>
    </div>
    <p class="tar-resumen">
      <span><strong>${todos.length}</strong> servicios</span>
      <span><strong>${visibles}</strong> visibles para clientes</span>
      <span class="${conAlertas ? "tar-alerta" : ""}"><strong>${conAlertas}</strong> con alertas</span>
      <span class="${dups ? "tar-alerta" : ""}"><strong>${dups}</strong> posibles duplicados</span>
      ${sinAsignar ? `<span class="tar-alerta"><strong>${sinAsignar}</strong> categorías sin equivalencia · <button type="button" class="enlace" data-tcat="ir-categorias">Asignarlas en Ajustes</button></span>` : ""}
    </p>
    <div class="tar-ayuda">
      <p>Aquí se prepara <strong>lo que ve el cliente</strong> de cada servicio: nombre, tipo de actividad, descripción, horarios, fotos (mínimo ${TAR_FOTOS_MIN}) e idiomas. Marca <strong>Visible</strong> para que aparezca en el formulario. El cliente nunca ve el proveedor.</p>
      <p>Cuando la misma actividad la ofrecen <strong>varios proveedores</strong> (mismo nombre o mismo "Comparar como"), solo una puede ser visible: al marcar una, el sistema oculta las demás.
        Si el <strong>mismo proveedor</strong> tiene dos servicios en el mismo grupo, aparece como posible duplicado para que revises si fue un error de ingreso.</p>
    </div>
    ${lista.length ? `
      <div class="tabla-scroll">
        <table class="tabla tcat-tabla">
          <thead><tr><th>Servicio</th><th>Proveedor</th><th class="centro">Visible</th><th>Fotos e información</th><th>Tarifas</th><th>Alertas</th><th></th></tr></thead>
          <tbody>${cuerpo}</tbody>
        </table>
      </div>` : `<div class="tar-vacio"><p><strong>No hay servicios que coincidan con los filtros.</strong></p></div>`}`;
}

function tarHtmlFilaCatalogo(it) {
  const i = tar.catItems.indexOf(it);
  const fotos = tarFotos(it.srv);
  const srv = it.srv;
  const nombreTar = !it.sinTarifario && srv && tarNorm(srv.nombre) !== tarNorm(it.servicio) ? `<br><span class="nota">En el tarifario: ${escapar(it.servicio)}</span>` : "";
  const varios = it.otrosProveedores.length ? ` <span class="tcat-varios" title="${escapar(it.otrosProveedores.map((x) => tarNombreOp(x.operador_id)).join(", "))}">Varios proveedores (${it.otrosProveedores.length + 1})</span>` : "";
  const info = srv ? [
    srv.descripcion ? "✓ Descripción" : "✗ Descripción",
    srv.horarios?.length ? "✓ Horarios" : "✗ Horarios",
    `${tarTraducidos(srv)}/4 idiomas`
  ].map((x) => `<span class="${x.startsWith("✗") ? "tcat-falta" : ""}">${x}</span>`).join("<br>") : "";
  const tarifas = it.sinTarifario ? `<span class="nota">—</span>`
    : !it.tarifas.length ? `<span class="nota">Sin tarifas</span>`
    : !it.aprobadas ? `<span class="tar-ojo">${it.tarifas.length} sin aprobar</span>`
    : `Hasta ${tarFechaCorta(it.hasta)}${it.aprobadas < it.tarifas.length ? `<br><span class="nota">${it.tarifas.length - it.aprobadas} sin aprobar</span>` : ""}`;
  const alertas = it.alertas.map((a) => `<li class="tcat-${a.nivel}">${escapar(a.texto)}${a.dup ? ` <button type="button" class="enlace" data-tcat="dup-ok" data-i="${i}">Están bien</button>` : ""}</li>`).join("");

  return `
    <tr class="${it.visible ? "" : "inactivo"} ${it.alertas.some((a) => a.nivel === "alerta") ? "tcat-con-alerta" : ""}">
      <td><strong>${escapar(tarNombreCliente(it))}</strong>${varios}${nombreTar}${it.ficha?.comparar ? `<br><span class="nota">Grupo: ${escapar(it.ficha.comparar)}</span>` : ""}</td>
      <td>${it.sinTarifario ? `<span class="nota">Sin tarifario</span>` : escapar(tarNombreOp(it.operador_id))}</td>
      <td class="centro">${srv
        ? `<input type="checkbox" class="tar-check" data-tcat="visible" data-i="${i}" ${it.visible ? "checked" : ""} aria-label="Visible para clientes: ${escapar(tarNombreCliente(it))}">`
        : `<span class="nota">—</span>`}</td>
      <td>${srv ? `
        <div class="tcat-mini">
          ${fotos[0] ? `<img src="${escapar(fotos[0].url)}" alt="" loading="lazy">` : `<span class="tcat-sin-foto" aria-hidden="true">📷</span>`}
          <span><strong class="${fotos.length < TAR_FOTOS_MIN ? "tcat-falta" : ""}">${fotos.length}/${TAR_FOTOS_MIN} fotos</strong><br><span class="nota">${info}</span></span>
        </div>` : `<span class="nota">Todavía sin ficha para clientes</span>`}</td>
      <td>${tarifas}</td>
      <td>${alertas ? `<ul class="tcat-alertas">${alertas}</ul>` : `<span class="tcmp-bajo">Todo en orden</span>`}</td>
      <td class="acciones-fila">${srv
        ? `<button type="button" class="enlace" data-tcat="editar" data-i="${i}">Editar ficha</button>`
        : `<button type="button" class="enlace" data-tcat="crear" data-i="${i}">Crear ficha</button>`}</td>
    </tr>`;
}

// ---------- Visible / oculto (solo una versión por actividad) ----------
async function tarCambiarVisible(it, visible, el) {
  if (!it?.srv) return;
  let ocultar = [];
  if (visible) {
    ocultar = it.rivales.filter((x) => x.visible && x.srv);
    if (ocultar.length && !confirm(`"${tarNombreCliente(it)}" también la ofrece ${ocultar.map((x) => tarNombreOp(x.operador_id)).join(", ")}, y el cliente solo debe ver una versión.\n\n¿Mostrar la de ${tarNombreOp(it.operador_id) || "este servicio"} y ocultar las demás?`)) {
      if (el) el.checked = false;
      return false;
    }
    if (!tarTipoPorId(it.tipo_id)) avisar("Ojo: no tiene tipo de actividad, el cliente la verá al final en \"Otras actividades\".");
  }
  const { error } = await db.from("servicios").update({ activo: visible }).eq("id", it.srv.id);
  if (error) { if (el) el.checked = !visible; fallo(error); return false; }
  for (const x of ocultar) {
    const r = await db.from("servicios").update({ activo: false }).eq("id", x.srv.id);
    if (r.error) { fallo(r.error, "No se pudieron ocultar las otras versiones."); break; }
  }
  await cargarCatalogos();
  avisar(visible
    ? `"${tarNombreCliente(it)}" ya es visible para los clientes.${ocultar.length ? ` Se ocultaron ${ocultar.length} versión(es) de otros proveedores.` : ""}`
    : `"${tarNombreCliente(it)}" quedó oculto para los clientes.`);
  return true;
}

// Crea la ficha para clientes (fila en servicios) de un servicio del tarifario que aún no la tiene
async function tarCrearServicioCliente(it, btn) {
  await conBoton(btn, async () => {
    const op = tarOperador(it.operador_id);
    const incluye = tarItems(it.ficha?.incluye);
    const { data, error } = await db.from("servicios").insert({
      nombre: it.servicio, operador_id: op?.operador_id ?? null, tipo_id: it.ficha?.tipo_id ?? null,
      traducciones: {}, horarios: [], duracion_min: null, transporte: "opcional", activo: false, fotos: [],
      descripcion: incluye.length ? `Incluye: ${incluye.join(", ")}.` : null
    }).select().single();
    if (error) return fallo(error, "No se pudo crear la ficha.");
    if (!(await tarGuardarFicha(it.operador_id, it.servicio, { servicio_id: data.id }))) return;
    await cargarCatalogos();
    tar.editando = { tipo: "ficha", clave: `${it.operador_id}|${tarNorm(it.servicio)}` };
    tar.previa = { fecha: "", resultado: null, cargando: false };
    tarPintar();
    avisar("Ficha creada (oculta). Complétala y márcala como visible cuando esté lista.");
  });
}

// =====================================================
// FICHA PARA CLIENTES (editor)
// =====================================================
function tarItemEditando() {
  return tarItemsCatalogo().find((i) => i.clave === tar.editando?.clave);
}

function tarHtmlFichaCliente() {
  const it = tarItemEditando();
  if (!it?.srv) { tar.editando = null; return `<p class="nota">Ese servicio ya no existe.</p>`; }
  const s = it.srv;
  const tr = s.traducciones || {};
  const tiposOpc = tarTipos().map((tp) =>
    `<option value="${tp.id}" ${tp.id === it.tipo_id ? "selected" : ""}>${escapar(nombreTipo(tp))}${tp.activo ? "" : " (oculto)"}</option>`).join("");
  const transporte = Object.entries(TRANSPORTE_TEXTO)
    .map(([k, v]) => `<option value="${k}" ${k === (s.transporte || "opcional") ? "selected" : ""}>${v}</option>`).join("");
  const filasIdioma = Object.entries(TAR_IDIOMAS).map(([k, v]) => `
    <tr data-idioma="${k}">
      <th scope="row">${v}</th>
      <td><input data-tr="nombre" value="${escapar(tr[k]?.nombre ?? "")}" aria-label="Nombre en ${v.toLowerCase()}"></td>
      <td><textarea data-tr="descripcion" rows="2" aria-label="Descripción en ${v.toLowerCase()}">${escapar(tr[k]?.descripcion ?? "")}</textarea></td>
    </tr>`).join("");
  const rivales = it.rivales.filter((x) => x.srv);
  const op = it.sinTarifario ? null : tarOperador(it.operador_id);

  return `
    <div class="det-seccion sin-margen">
      <div class="sec-cabeza">
        <h3>Ficha para clientes</h3>
        <div class="sec-botones"><button type="button" class="btn" data-tcat="cerrar">Volver al catálogo</button></div>
      </div>
      <p class="nota">${it.sinTarifario
        ? "Este servicio no viene del Tarifario: no tiene tarifas, así que el cliente verá \"tarifa pendiente\"."
        : `Del tarifario: <strong>${escapar(it.servicio)}</strong> · proveedor <strong>${escapar(op?.nombre ?? "")}</strong> (el cliente no ve el proveedor).`}
        ${it.otrosProveedores.length ? `<br><span class="tcat-varios">Varios proveedores</span> También la ofrecen: ${it.otrosProveedores.map((x) => `${escapar(tarNombreOp(x.operador_id))}${x.visible ? " (visible)" : ""}`).join(", ")}.` : ""}</p>

      <div class="fila">
        <label>Nombre que ve el cliente <input id="tcfNombre" value="${escapar(s.nombre ?? "")}" autofocus></label>
        <label>Tipo de actividad <select id="tcfTipo"><option value="">Sin tipo</option>${tiposOpc}</select></label>
      </div>
      <div class="fila">
        <label>Duración en minutos <input id="tcfDuracion" type="number" min="0" value="${s.duracion_min ?? ""}"></label>
        <label>Horarios de salida <input id="tcfHorarios" placeholder="Ej.: 07:30, 13:00" value="${(s.horarios || []).map(hora).join(", ")}"></label>
        <label>Transporte <select id="tcfTransporte">${transporte}</select></label>
      </div>
      <label>Descripción para el cliente
        <textarea id="tcfDescripcion" rows="3" placeholder="Ej.: Recorrido por puentes colgantes entre el bosque nuboso.">${escapar(s.descripcion ?? "")}</textarea>
      </label>
      ${it.sinTarifario ? "" : `
        <label>Qué incluye (separado por comas)
          <textarea id="tcfIncluye" rows="2" placeholder="Transporte, almuerzo, guía bilingüe">${escapar(it.ficha?.incluye ?? "")}</textarea>
        </label>`}
      <details class="traducciones" ${tarTraducidos(s) ? "" : "open"}>
        <summary>Nombre y descripción en otros idiomas <span class="nota">(${tarTraducidos(s)} de 4 idiomas con nombre)</span></summary>
        <p class="nota">El cliente ve la actividad en el idioma que eligió. Si un idioma queda vacío, verá el nombre en español y ninguna descripción.</p>
        <div class="tabla-scroll">
          <table class="tabla traduccion">
            <thead><tr><th>Idioma</th><th>Nombre</th><th>Descripción</th></tr></thead>
            <tbody id="tcfTraducciones">${filasIdioma}</tbody>
          </table>
        </div>
      </details>
      <label class="check-linea"><input id="tcfVisible" type="checkbox" ${s.activo ? "checked" : ""}> Visible para clientes (aparece en el formulario)</label>
      ${rivales.length ? `<p class="nota">Si la marcas visible, se ocultan las otras versiones de esta actividad (${rivales.map((x) => escapar(tarNombreOp(x.operador_id) || x.servicio)).join(", ")}).</p>` : ""}
      <div class="sec-botones">
        <button type="button" class="btn primario" data-tcat="guardar-ficha">Guardar ficha</button>
        <button type="button" class="btn" data-tcat="cerrar">Cancelar</button>
      </div>
    </div>

    <div class="det-seccion sin-margen" id="tcfFotos">${tarHtmlFotos(s)}</div>
    <div class="det-seccion sin-margen" id="tcfPrecios">${tarHtmlPrevia(s)}</div>`;
}

function tarLeerTraduccionesFicha() {
  const tr = {};
  document.querySelectorAll("#tcfTraducciones tr").forEach((fila) => {
    const nombre = fila.querySelector('[data-tr="nombre"]').value.trim();
    const descripcion = fila.querySelector('[data-tr="descripcion"]').value.trim();
    if (nombre || descripcion) tr[fila.dataset.idioma] = { ...(nombre && { nombre }), ...(descripcion && { descripcion }) };
  });
  return tr;
}

async function tarGuardarFichaCliente(btn) {
  const it = tarItemEditando();
  if (!it?.srv) return;
  const nombre = $("tcfNombre").value.trim();
  if (!nombre) return avisar("Escribe el nombre que ve el cliente.", "error");
  const horarios = [];
  for (const parte of $("tcfHorarios").value.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = parte.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return avisar(`El horario "${parte}" no es válido. Usa el formato 07:30, separado por comas.`, "error");
    horarios.push(`${m[1].padStart(2, "0")}:${m[2]}`);
  }
  const tipo_id = $("tcfTipo").value ? Number($("tcfTipo").value) : null;
  const visible = $("tcfVisible").checked;
  const fila = {
    nombre, tipo_id, horarios,
    duracion_min: parseInt($("tcfDuracion").value, 10) || null,
    transporte: $("tcfTransporte").value,
    descripcion: $("tcfDescripcion").value.trim() || null,
    traducciones: tarLeerTraduccionesFicha()
  };

  await conBoton(btn, async () => {
    const { error } = await db.from("servicios").update(fila).eq("id", it.srv.id);
    if (error) return fallo(error);
    if (!it.sinTarifario) {
      const cambios = { tipo_id, incluye: $("tcfIncluye").value.trim() || null };
      if ((it.ficha?.tipo_id ?? null) !== cambios.tipo_id || (it.ficha?.incluye ?? null) !== cambios.incluye) {
        if (!(await tarGuardarFicha(it.operador_id, it.servicio, cambios))) return;
      }
    }
    await cargarCatalogos();
    if (visible !== it.visible) {
      const item = tarItemEditando();
      if (!(await tarCambiarVisible(item, visible, $("tcfVisible")))) return;
    } else avisar("Ficha guardada.");
    if (visible && tarFotos(it.srv).length < TAR_FOTOS_MIN) avisar(`Guardada. Recuerda subir al menos ${TAR_FOTOS_MIN} fotos.`);
    tar.editando = null;
    tarPintar();
  });
}

// ---------- Fotos ----------
function tarHtmlFotos(s) {
  const fotos = tarFotos(s);
  return `
    <div class="sec-cabeza">
      <h3>Fotos <span class="nota">(${fotos.length} de mínimo ${TAR_FOTOS_MIN})</span></h3>
      ${fotos.length < TAR_FOTOS_MAX ? `<label class="btn tcat-subir">Subir fotos
        <input id="tcfArchivoFotos" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden></label>` : ""}
    </div>
    <p class="nota">Al subirlas, todas quedan del mismo tamaño: horizontales (4:3) de ${TAR_FOTO_ANCHO} × ${TAR_FOTO_ALTO}. Si la foto no es horizontal, se recorta desde el centro.
      La primera es la principal. Usa fotos en JPG o PNG (las fotos HEIC del iPhone se pueden exportar como JPG).</p>
    <p id="tcfFotosEstado" class="nota" hidden></p>
    ${fotos.length ? `<ul class="tcat-fotos">${fotos.map((f, i) => `
      <li class="tcat-foto">
        <img src="${escapar(f.url)}" alt="Foto ${i + 1} de ${escapar(s.nombre)}" loading="lazy">
        ${i === 0 ? `<span class="tcat-principal">Principal</span>` : ""}
        <div class="tcat-foto-acciones">
          <button type="button" class="btn-icono" data-tcat="foto-mover" data-n="${i}" data-paso="-1" ${i === 0 ? "disabled" : ""} aria-label="Mover a la izquierda" title="Mover a la izquierda">◀</button>
          <button type="button" class="btn-icono" data-tcat="foto-mover" data-n="${i}" data-paso="1" ${i === fotos.length - 1 ? "disabled" : ""} aria-label="Mover a la derecha" title="Mover a la derecha">▶</button>
          <button type="button" class="enlace peligro" data-tcat="foto-borrar" data-n="${i}">Quitar</button>
        </div>
      </li>`).join("")}</ul>` : `<div class="tar-vacio"><p>Todavía no tiene fotos.</p></div>`}`;
}

// Recorta al centro en 4:3 y deja la foto en 1200 × 900 (JPG)
async function tarPrepararFoto(archivo) {
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise((ok, mal) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => mal(new Error(`"${archivo.name}" no se pudo abrir. Usa una foto JPG o PNG.`));
      i.src = url;
    });
    const r = TAR_FOTO_ANCHO / TAR_FOTO_ALTO;
    let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (sw / sh > r) { const w = sh * r; sx = (sw - w) / 2; sw = w; } else { const h = sw / r; sy = (sh - h) / 2; sh = h; }
    const lienzo = document.createElement("canvas");
    lienzo.width = TAR_FOTO_ANCHO; lienzo.height = TAR_FOTO_ALTO;
    const ctx = lienzo.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, TAR_FOTO_ANCHO, TAR_FOTO_ALTO);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TAR_FOTO_ANCHO, TAR_FOTO_ALTO);
    return await new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo preparar la foto."))), "image/jpeg", 0.82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function tarGuardarFotos(srv, fotos) {
  const { error } = await db.from("servicios").update({ fotos }).eq("id", srv.id);
  if (error) { fallo(error, "No se pudieron guardar las fotos."); return false; }
  srv.fotos = fotos;
  return true;
}

function tarRepintarFotos(srv) {
  if ($("tcfFotos")) $("tcfFotos").innerHTML = tarHtmlFotos(srv);
}

async function tarSubirFotos(archivos) {
  const it = tarItemEditando();
  if (!it?.srv) return;
  const srv = it.srv;
  const libres = TAR_FOTOS_MAX - tarFotos(srv).length;
  const lista = [...archivos].slice(0, libres);
  if (archivos.length > libres) avisar(`Solo se pueden tener ${TAR_FOTOS_MAX} fotos por servicio: se subirán ${lista.length}.`);
  const estado = $("tcfFotosEstado");
  let subidas = 0;
  for (const [n, archivo] of lista.entries()) {
    if (estado) { estado.hidden = false; estado.textContent = `Preparando y subiendo foto ${n + 1} de ${lista.length}…`; }
    try {
      const blob = await tarPrepararFoto(archivo);
      const path = `servicio-${srv.id}/${Date.now()}-${n}.jpg`;
      const subida = await db.storage.from(TAR_BUCKET).upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
      if (subida.error) throw subida.error;
      const url = db.storage.from(TAR_BUCKET).getPublicUrl(path).data.publicUrl;
      if (!(await tarGuardarFotos(srv, [...tarFotos(srv), { path, url }]))) break;
      subidas++;
      tarRepintarFotos(srv);
    } catch (e) {
      fallo(e, "No se pudo subir la foto.");
      break;
    }
  }
  if (subidas) avisar(`${subidas} foto(s) subida(s).`);
  tarRepintarFotos(srv);
}

async function tarMoverFoto(n, paso) {
  const srv = tarItemEditando()?.srv;
  const fotos = [...tarFotos(srv)];
  const j = n + paso;
  if (!srv || j < 0 || j >= fotos.length) return;
  [fotos[n], fotos[j]] = [fotos[j], fotos[n]];
  if (await tarGuardarFotos(srv, fotos)) tarRepintarFotos(srv);
}

async function tarBorrarFoto(n) {
  const srv = tarItemEditando()?.srv;
  const foto = tarFotos(srv)[n];
  if (!foto || !confirm("¿Quitar esta foto?")) return;
  if (!(await tarGuardarFotos(srv, tarFotos(srv).filter((_, i) => i !== n)))) return;
  if (foto.path) await db.storage.from(TAR_BUCKET).remove([foto.path]);   // si falla, solo queda el archivo sin usar
  tarRepintarFotos(srv);
  avisar("Foto quitada.");
}

// ---------- Vista previa del precio que ve el cliente ----------
function tarHtmlPrevia(s) {
  const p = tar.previa;
  const r = p.resultado;
  let res = "";
  if (p.cargando) res = `<p class="nota">Consultando…</p>`;
  else if (r?.error) res = `<p class="aviso">${escapar(r.error)}</p>`;
  else if (r?.lista && !r.lista.length) res = `<p class="aviso suave">El cliente verá: <strong>Tarifa pendiente de ingreso, un agente la verificará.</strong> No hay una tarifa aprobada cuya temporada cubra esa fecha (o sus categorías no tienen equivalencia en Ajustes).</p>`;
  else if (r?.lista) res = `<ul class="tcat-precios">${r.lista.map((x) => `
      <li><span>${escapar(x.categoria)}${x.por_grupo ? ` <span class="nota">(por grupo)</span>` : ""}</span>
        <strong>${dinero(x.precio)}${x.colones ? ` <span title="Tarifa en colones (${tarDinero(x.precio_colones, "CRC")}), se muestra en dólares" aria-label="Tarifa en colones">ⓘ</span>` : ""}</strong></li>`).join("")}</ul>
      ${r.lista.some((x) => x.colones) ? `<p class="nota">ⓘ = tarifa en colones convertida a dólares con el tipo de cambio de Ajustes.</p>` : ""}`;
  return `
    <h3>Precio que ve el cliente</h3>
    <p class="nota">Precio TC de las tarifas aprobadas, según la fecha de la actividad. El cliente nunca ve el neto ni el Cash.</p>
    <div class="fila-form">
      <label class="tar-filtro-corto">Fecha <input id="tcfFechaPrevia" type="date" value="${p.fecha}"></label>
      <button type="button" class="btn" data-tcat="previa">Ver precio</button>
    </div>
    ${res}`;
}

async function tarConsultarPrevia() {
  const it = tarItemEditando();
  if (!it?.srv) return;
  const fecha = $("tcfFechaPrevia").value;
  if (!fecha) return avisar("Elige una fecha.", "error");
  tar.previa = { fecha, resultado: null, cargando: true };
  $("tcfPrecios").innerHTML = tarHtmlPrevia(it.srv);
  const { data, error } = await db.rpc("precios_cliente", { p_servicio: it.srv.id, p_fecha: fecha });
  tar.previa = { fecha, cargando: false, resultado: error ? { error: `No se pudo consultar: ${error.message}` } : { lista: data || [] } };
  if ($("tcfPrecios")) $("tcfPrecios").innerHTML = tarHtmlPrevia(it.srv);
}

// =====================================================
// PESTAÑA TIPOS DE ACTIVIDAD (antes en Servicios)
// =====================================================
function tarHtmlTipos() {
  const tarjetas = tarTipos().map((tp, i) => {
    const lista = app.servicios.filter((s) => s.tipo_id === tp.id);
    const visibles = lista.filter((s) => s.activo).length;
    const traducciones = Object.entries(TAR_IDIOMAS)
      .map(([k, v]) => (tp.traducciones?.[k] ? `${v}: ${escapar(tp.traducciones[k])}` : null)).filter(Boolean).join(" · ");
    return `
      <li class="tipo-tarjeta${tp.activo ? "" : " inactivo"}">
        <div class="tipo-cabeza">
          <span class="tipo-icono" aria-hidden="true">${escapar(tp.icono || "•")}</span>
          <div class="tipo-textos">
            <p class="tipo-nombre">${escapar(tp.nombre)} ${tp.activo ? "" : `<span class="chip-gris">Oculto para clientes</span>`}</p>
            <p class="nota">${traducciones || "Sin traducciones"} · ${lista.length} servicios, ${visibles} visibles</p>
          </div>
          <div class="tipo-acciones">
            <button type="button" class="btn-icono" data-ttipo="subir" data-id="${tp.id}" ${i === 0 ? "disabled" : ""} aria-label="Subir ${escapar(tp.nombre)}" title="Subir">▲</button>
            <button type="button" class="btn-icono" data-ttipo="bajar" data-id="${tp.id}" ${i === tarTipos().length - 1 ? "disabled" : ""} aria-label="Bajar ${escapar(tp.nombre)}" title="Bajar">▼</button>
            <button type="button" class="enlace" data-ttipo="editar" data-id="${tp.id}">Editar</button>
          </div>
        </div>
      </li>`;
  }).join("");

  return `
    <div class="det-seccion sin-margen">
      <div class="sec-cabeza">
        <h3>Tipos de actividad</h3>
        <button type="button" class="btn primario" data-ttipo="nuevo">Nuevo tipo</button>
      </div>
      <p class="nota">Así se agrupan las actividades en el formulario del cliente, en este mismo orden. Usa ▲ ▼ para cambiar el orden.
        Para poner un servicio dentro de un tipo, edita su ficha en Catálogo (o usa Comparar › Clasificar servicios).</p>
      ${tarTipos().length ? `<ul class="tipos-lista">${tarjetas}</ul>` : `<p class="nota">Todavía no hay tipos de actividad.</p>`}
    </div>`;
}

function tarHtmlFormTipo() {
  const tp = tar.editando.datos;
  const idiomas = Object.entries(TAR_IDIOMAS).map(([k, v]) =>
    `<label>${v} <input data-tr-tipo="${k}" value="${escapar(tp.traducciones?.[k] ?? "")}"></label>`).join("");
  const cuantos = tp.id ? app.servicios.filter((s) => s.tipo_id === tp.id).length : 0;
  return `
    <div class="det-seccion sin-margen">
      <h3>${tp.id ? "Editar tipo de actividad" : "Nuevo tipo de actividad"}</h3>
      <div class="fila">
        <label>Nombre (en español) <input id="ftNombre" value="${escapar(tp.nombre ?? "")}" autofocus></label>
        <label>Ícono (un emoji, opcional) <input id="ftIcono" value="${escapar(tp.icono ?? "")}" maxlength="8" placeholder="Ej.: 🌋"></label>
      </div>
      <h4>Nombre en otros idiomas</h4>
      <div class="fila">${idiomas}</div>
      <label class="check-linea"><input id="ftActivo" type="checkbox" ${tp.activo !== false ? "checked" : ""}> Visible para clientes (si lo ocultas, sus actividades tampoco aparecen en el formulario)</label>
      <div class="sec-botones">
        <button type="button" class="btn primario" data-ttipo="guardar">Guardar tipo</button>
        <button type="button" class="btn" data-ttipo="cancelar">Cancelar</button>
        ${tp.id ? `<button type="button" class="enlace peligro" data-ttipo="eliminar" data-id="${tp.id}" data-cuantos="${cuantos}">Eliminar tipo</button>` : ""}
      </div>
    </div>`;
}

async function tarGuardarTipo(btn) {
  const tp = tar.editando.datos;
  const traducciones = {};
  document.querySelectorAll("[data-tr-tipo]").forEach((el) => { if (el.value.trim()) traducciones[el.dataset.trTipo] = el.value.trim(); });
  const fila = { nombre: $("ftNombre").value.trim(), icono: $("ftIcono").value.trim() || null, traducciones, activo: $("ftActivo").checked };
  if (!fila.nombre) return avisar("Escribe el nombre del tipo de actividad.", "error");
  if (!tp.id) fila.orden = Math.max(0, ...tarTipos().map((x) => x.orden)) + 1;
  await conBoton(btn, async () => {
    const r = tp.id ? await db.from("tipos_servicio").update(fila).eq("id", tp.id) : await db.from("tipos_servicio").insert(fila);
    if (r.error) return fallo(r.error, r.error.code === "23505" ? "Ya existe un tipo con ese nombre." : "No se pudo guardar.");
    await cargarCatalogos();
    tar.editando = null;
    tarPintar();
    avisar("Tipo de actividad guardado.");
  });
}

async function tarMoverTipo(id, paso) {
  const lista = [...tarTipos()];
  const i = lista.findIndex((x) => x.id === id), j = i + paso;
  if (i < 0 || j < 0 || j >= lista.length) return;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  const cambios = lista.map((x, k) => ({ id: x.id, orden: k + 1 })).filter((x) => tarTipoPorId(x.id).orden !== x.orden);
  for (const c of cambios) {
    const { error } = await db.from("tipos_servicio").update({ orden: c.orden }).eq("id", c.id);
    if (error) { await cargarCatalogos(); tarPintar(); return fallo(error, "No se pudo cambiar el orden."); }
  }
  await cargarCatalogos();
  tarPintar();
  document.querySelector(`[data-ttipo="${paso < 0 ? "subir" : "bajar"}"][data-id="${id}"]:not(:disabled)`)?.focus();
}

async function tarEliminarTipo(id, cuantos) {
  const tp = tarTipoPorId(id);
  const texto = cuantos
    ? `¿Eliminar el tipo "${tp?.nombre}"? Sus ${cuantos} servicios no se borran: quedan "sin tipo" y el cliente los verá en "Otras actividades".`
    : `¿Eliminar el tipo "${tp?.nombre}"?`;
  if (!confirm(texto)) return;
  const { error } = await db.from("tipos_servicio").delete().eq("id", id);
  if (error) return fallo(error, "No se pudo eliminar.");
  await Promise.all([cargarCatalogos(), tarLeerFichas()]);
  tar.editando = null;
  tarPintar();
  avisar("Tipo de actividad eliminado.");
}

// =====================================================
// AJUSTES › CATEGORÍAS DEL TARIFARIO Y TIPOS DE CLIENTE
// =====================================================
const TAR_SUGERENCIAS_CAT = {
  adulto: "adulto", adult: "adulto", adults: "adulto", "adulto extranjero": "adulto",
  nino: "nino", child: "nino", children: "nino", "nino extranjero": "nino",
  "adulto mayor": "senior", senior: "senior", seniors: "senior", "ciudadano de oro": "senior",
  estudiante: "estudiante", student: "estudiante", infante: "menor de 6 anos"
};
const tarSugerenciaCat = (clave) => {
  const destino = TAR_SUGERENCIAS_CAT[clave];
  return destino ? app.categorias.find((k) => tarNorm(k.nombre) === destino) : null;
};

function tarHtmlCategorias() {
  if (tar.mapaError) return `<div class="det-seccion sin-margen"><h3>Categorías del tarifario</h3><p class="aviso">Falta preparar la base de datos para esta sección (etapa 1).</p></div>`;
  const porClave = new Map();
  tar.cobertura.forEach((t) => {
    const k = tarNorm(t.categoria);
    const x = porClave.get(k) || { clave: k, nombre: t.categoria, tarifas: 0, aprobadas: 0 };
    x.tarifas++; if (t.aprobada) x.aprobadas++;
    porClave.set(k, x);
  });
  const lista = [...porClave.values()].sort((a, b) =>
    (tar.mapaCategorias.has(a.clave) - tar.mapaCategorias.has(b.clave)) || a.nombre.localeCompare(b.nombre, "es"));
  const sinAsignar = lista.filter((x) => !tar.mapaCategorias.has(x.clave));
  const conSugerencia = sinAsignar.filter((x) => tarSugerenciaCat(x.clave)).length;
  const opciones = (x) => {
    const m = tar.mapaCategorias.get(x.clave);
    const valor = !m ? "" : m.categoria_id ? String(m.categoria_id) : "oculta";
    return `<option value="" ${valor === "" ? "selected" : ""}>— Sin asignar —</option>`
      + app.categorias.map((k) => `<option value="${k.id}" ${valor === String(k.id) ? "selected" : ""}>${escapar(k.nombre)}${k.por_grupo ? " (por grupo)" : ""}</option>`).join("")
      + `<option value="oculta" ${valor === "oculta" ? "selected" : ""}>No se muestra al cliente</option>`;
  };

  const filasTipos = app.categorias.map((k) => `
    <tr data-cat-cliente="${k.id}">
      <td><input data-kc="nombre" value="${escapar(k.nombre)}" aria-label="Nombre"></td>
      ${Object.keys(TAR_IDIOMAS).map((l) => `<td><input data-kc="${l}" value="${escapar(k.traducciones?.[l] ?? "")}" aria-label="${TAR_IDIOMAS[l]}"></td>`).join("")}
      <td class="centro"><input type="checkbox" class="tar-check" data-kc="por_grupo" ${k.por_grupo ? "checked" : ""} aria-label="Precio por grupo"></td>
    </tr>`).join("");

  return `
    <div class="det-seccion sin-margen" id="tarCategorias">
      <div class="sec-cabeza">
        <h3>Categorías del tarifario → tipos de cliente</h3>
        ${conSugerencia ? `<button type="button" class="btn" data-tcat="aplicar-sug-cat">Asignar ${conSugerencia} sugerida(s)</button>` : ""}
      </div>
      <p class="nota">Cada operador llama distinto a sus categorías ("Adulto", "adult", "Adulto extranjero"…). Indica a qué tipo de cliente corresponde cada una:
        así el cliente ve el precio correcto y el agente lo usa al cotizar. Las que no se muestran al cliente (por ejemplo, tarifas para nacionales) siguen en el tarifario.
        ${sinAsignar.length ? `<strong class="tar-alerta">${sinAsignar.length} sin asignar:</strong> mientras tanto esos precios no se muestran al cliente.` : ""}</p>
      <div class="tabla-scroll">
        <table class="tabla">
          <thead><tr><th>Categoría en el tarifario</th><th class="num">Tarifas</th><th>Tipo de cliente</th></tr></thead>
          <tbody>${lista.map((x) => `
            <tr class="${tar.mapaCategorias.has(x.clave) ? "" : "tcat-con-alerta"}">
              <td>${escapar(x.nombre)}${!tar.mapaCategorias.has(x.clave) && tarSugerenciaCat(x.clave) ? `<br><span class="nota">Sugerido: ${escapar(tarSugerenciaCat(x.clave).nombre)}</span>` : ""}</td>
              <td class="num">${x.tarifas}${x.aprobadas < x.tarifas ? ` <span class="nota">(${x.aprobadas} aprobadas)</span>` : ""}</td>
              <td><select data-tcat-cat="${escapar(x.clave)}" data-nombre="${escapar(x.nombre)}" aria-label="Tipo de cliente para ${escapar(x.nombre)}">${opciones(x)}</select></td>
            </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="det-seccion sin-margen">
      <h3>Tipos de cliente</h3>
      <p class="nota">Son las categorías que ve el cliente y que usa el agente al cotizar. Escribe su nombre en otros idiomas (se guarda solo al salir de cada casilla).
        Marca <strong>Por grupo</strong> cuando el precio es por vehículo, habitación o grupo (no por persona); por ejemplo "Vehículo 1-6 pax".</p>
      <div class="tabla-scroll">
        <table class="tabla traduccion">
          <thead><tr><th>Nombre</th>${Object.values(TAR_IDIOMAS).map((v) => `<th>${v}</th>`).join("")}<th class="centro">Por grupo</th></tr></thead>
          <tbody>${filasTipos}</tbody>
        </table>
      </div>
      <div class="fila-form">
        <label>Nuevo tipo de cliente <input id="tcatNuevoTipo" placeholder="Ej.: Vehículo 1-6 pax"></label>
        <label class="check-linea tar-check-form"><input id="tcatNuevoGrupo" type="checkbox"> Precio por grupo</label>
        <button type="button" class="btn" data-tcat="nuevo-tipo-cliente">Agregar</button>
      </div>
    </div>`;
}

async function tarGuardarEquivalencia(sel) {
  const clave = sel.dataset.tcatCat, nombre = sel.dataset.nombre, v = sel.value;
  const r = v === ""
    ? await db.from("tar_categorias").delete().eq("clave", clave)
    : await db.from("tar_categorias").upsert({ clave, nombre, categoria_id: v === "oculta" ? null : Number(v), actualizado: new Date().toISOString() });
  if (r.error) { fallo(r.error); return tarPintar(); }
  if (v === "") tar.mapaCategorias.delete(clave);
  else tar.mapaCategorias.set(clave, { clave, nombre, categoria_id: v === "oculta" ? null : Number(v) });
  sel.closest("tr")?.classList.toggle("tcat-con-alerta", v === "");
  avisar("Guardado.");
}

async function tarAplicarSugerenciasCat(btn) {
  const filas = [];
  const vistas = new Map();
  tar.cobertura.forEach((t) => { const k = tarNorm(t.categoria); if (!vistas.has(k)) vistas.set(k, t.categoria); });
  vistas.forEach((nombre, clave) => {
    const k = !tar.mapaCategorias.has(clave) && tarSugerenciaCat(clave);
    if (k) filas.push({ clave, nombre, categoria_id: k.id });
  });
  if (!filas.length) return;
  await conBoton(btn, async () => {
    const { error } = await db.from("tar_categorias").upsert(filas);
    if (error) return fallo(error);
    filas.forEach((f) => tar.mapaCategorias.set(f.clave, f));
    tarPintar();
    avisar(`${filas.length} categoría(s) asignadas.`);
  });
}

// Se guarda la fila completa al salir de cualquiera de sus casillas
async function tarGuardarTipoCliente(el) {
  const tr = el.closest("tr");
  const id = Number(tr.dataset.catCliente);
  const k = app.categorias.find((x) => x.id === id);
  const nombre = tr.querySelector('[data-kc="nombre"]').value.trim();
  if (!nombre) { tr.querySelector('[data-kc="nombre"]').value = k?.nombre ?? ""; return avisar("El nombre del tipo de cliente no puede quedar vacío.", "error"); }
  const traducciones = {};
  Object.keys(TAR_IDIOMAS).forEach((l) => { const v = tr.querySelector(`[data-kc="${l}"]`).value.trim(); if (v) traducciones[l] = v; });
  const fila = { nombre, traducciones, por_grupo: tr.querySelector('[data-kc="por_grupo"]').checked };
  const { error } = await db.from("categorias_cliente").update(fila).eq("id", id);
  if (error) { fallo(error, error.code === "23505" ? "Ya existe un tipo de cliente con ese nombre." : "No se pudo guardar."); return tarPintar(); }
  if (k) Object.assign(k, fila);
  avisar("Tipo de cliente guardado.");
}

async function tarNuevoTipoCliente(btn) {
  const nombre = $("tcatNuevoTipo").value.trim();
  if (!nombre) return avisar("Escribe el nombre del tipo de cliente.", "error");
  await conBoton(btn, async () => {
    const orden = Math.max(0, ...app.categorias.map((k) => k.orden)) + 1;
    const { error } = await db.from("categorias_cliente").insert({ nombre, orden, por_grupo: $("tcatNuevoGrupo").checked });
    if (error) return fallo(error, error.code === "23505" ? "Ya existe un tipo de cliente con ese nombre." : "No se pudo agregar.");
    await cargarCatalogos();
    tarPintar();
    avisar("Tipo de cliente agregado.");
  });
}

// =====================================================
// EVENTOS
// =====================================================
$("tarContenido").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tcat], [data-ttipo]");
  if (!b || !tarEsAdmin()) return;
  const it = () => tar.catItems[Number(b.dataset.i)];

  if (b.dataset.ttipo) {
    const id = Number(b.dataset.id);
    switch (b.dataset.ttipo) {
      case "nuevo": tar.editando = { tipo: "tipo", datos: { activo: true, traducciones: {} } }; return tarPintar();
      case "editar": tar.editando = { tipo: "tipo", datos: { ...tarTipoPorId(id) } }; return tarPintar();
      case "cancelar": tar.editando = null; return tarPintar();
      case "guardar": return tarGuardarTipo(b);
      case "subir": case "bajar": return conBoton(b, () => tarMoverTipo(id, b.dataset.ttipo === "subir" ? -1 : 1));
      case "eliminar": return tarEliminarTipo(id, Number(b.dataset.cuantos));
    }
    return;
  }

  switch (b.dataset.tcat) {
    case "editar":
      tar.editando = { tipo: "ficha", clave: it().clave };
      tar.previa = { fecha: "", resultado: null, cargando: false };
      tarPintar();
      return window.scrollTo({ top: $("vistaTarifario").offsetTop });
    case "crear": return tarCrearServicioCliente(it(), b);
    case "cerrar": tar.editando = null; return tarPintar();
    case "guardar-ficha": return tarGuardarFichaCliente(b);
    case "foto-mover": return conBoton(b, () => tarMoverFoto(Number(b.dataset.n), Number(b.dataset.paso)));
    case "foto-borrar": return tarBorrarFoto(Number(b.dataset.n));
    case "previa": return conBoton(b, tarConsultarPrevia);
    case "dup-ok": {
      const x = it();
      const fichas = [x, ...x.mismoProveedor];
      if (!confirm(`¿Confirmas que estos servicios de ${tarNombreOp(x.operador_id)} son distintos y están bien?\n\n${fichas.map((f) => `· ${f.servicio}`).join("\n")}\n\nDejarán de marcarse como posible duplicado y cada uno puede ser visible.`)) return;
      for (const f of fichas) if (!(await tarGuardarFicha(f.operador_id, f.servicio, { duplicado_ok: true }))) return;
      tarPintar();
      return avisar("Marcados como revisados.");
    }
    case "ir-categorias":
      tar.pestana = "ajustes"; tar.editando = null; tarPintar();
      return $("tarCategorias")?.scrollIntoView({ behavior: "smooth" });
    case "aplicar-sug-cat": return tarAplicarSugerenciasCat(b);
    case "nuevo-tipo-cliente": return tarNuevoTipoCliente(b);
  }
});

$("tarContenido").addEventListener("change", async (e) => {
  const el = e.target;
  if (!tarEsAdmin()) return;
  if (el.dataset.tcat === "visible") {
    const x = tar.catItems[Number(el.dataset.i)];
    el.disabled = true;
    const ok = await tarCambiarVisible(x, el.checked, el);
    if (el.isConnected) el.disabled = false;
    if (ok) tarPintar();
    return;
  }
  if (el.id === "tcfArchivoFotos" && el.files.length) return tarSubirFotos(el.files);
  if (el.dataset.tcatCat !== undefined) return tarGuardarEquivalencia(el);
  if (el.dataset.kc) return tarGuardarTipoCliente(el);
  const f = el.dataset.tcatFiltro;
  if (f && f !== "texto") { tar.catalogo[f] = el.value; tarPintar(); }
});

// Búsqueda mientras se escribe (sin perder el cursor)
$("tarContenido").addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.tcatFiltro !== "texto") return;
  tar.catalogo.texto = el.value;
  clearTimeout(tarHtmlCatalogo.espera);
  tarHtmlCatalogo.espera = setTimeout(() => {
    tarPintar();
    const nuevo = $("tcatBuscar");
    if (nuevo) { nuevo.focus(); nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length); }
  }, 300);
});
