// =====================================================
// SECCIÓN SERVICIOS (consulta): servicios, tipos de actividad y operadores
// se administran en el Tarifario, que es la fuente única del sistema.
// Aquí solo se editan las Propiedades (lista de hospedajes del formulario del cliente).
// (usa las utilidades y datos de panel.js)
// =====================================================

const catalogo = { pestana: "servicios", editando: null };
const TRANSPORTE_TEXTO = { incluido: "Incluido", opcional: "Opcional", sin_transporte: "Sin transporte" };
const OTROS_IDIOMAS = { en: "Inglés", fr: "Francés", de: "Alemán", it: "Italiano" };
const tipoPorId = (id) => app.tipos.find((x) => x.id === Number(id));
const nombreTipo = (tp) => `${tp.icono ? tp.icono + " " : ""}${tp.nombre}`;

document.addEventListener("vista-abierta", (e) => { if (e.detail === "servicios") pintarCatalogo(); });
document.addEventListener("datos-actualizados", () => { if (!$("vistaServicios").hidden) pintarCatalogo(); });

document.querySelectorAll(".pestana[data-pestana]").forEach((b) => b.addEventListener("click", () => {
  catalogo.pestana = b.dataset.pestana;
  catalogo.editando = null;
  pintarCatalogo();
}));

function pintarCatalogo() {
  document.querySelectorAll(".pestana[data-pestana]").forEach((b) => {
    const activa = b.dataset.pestana === catalogo.pestana;
    b.classList.toggle("activa", activa);
    b.setAttribute("aria-selected", activa);
  });

  let h;
  if (catalogo.pestana === "propiedades") {
    const editar = puede("editar_catalogo");
    h = (editar ? "" : `<p class="aviso">Puedes consultar las propiedades. Tu usuario no tiene autorización para modificarlas.</p>`) + htmlPropiedades(editar);
  } else {
    h = htmlAvisoTarifario();
    if (catalogo.pestana === "servicios") h += htmlListaServicios();
    if (catalogo.pestana === "tipos") h += htmlListaTipos();
    if (catalogo.pestana === "operadores") h += htmlListaOperadores();
  }
  $("catalogoContenido").innerHTML = h;
  $("catalogoContenido").querySelector("[autofocus]")?.focus();
}

function htmlAvisoTarifario() {
  const admin = app.yo?.rol === "administrador";
  return `<p class="aviso suave">Esta lista es de consulta. Los servicios, sus fotos y precios, los tipos de actividad y los operadores se administran en el <strong>Tarifario</strong>${admin ? `: <button type="button" class="enlace" data-cat="ir-tarifario">ir al Tarifario › Catálogo</button>` : " (lo hace un administrador)"}.</p>`;
}

// ---------------------------------------------------------
// SERVICIOS
// ---------------------------------------------------------
function htmlListaServicios() {
  const fila = (s) => {
    const precios = app.categorias
      .map((c) => ({ c, p: app.precios.find((x) => x.servicio_id === s.id && x.categoria_id === c.id) }))
      .filter((x) => x.p)
      .map(({ c, p }) => `<span class="precio-linea">${escapar(c.nombre)}: ${dinero(p.precio)}${puede("ver_utilidad") ? ` <span class="nota">neto ${dinero(p.neto)}</span>` : ""}</span>`)
      .join("");
    const fotos = Array.isArray(s.fotos) ? s.fotos : [];
    return `
      <tr class="${s.activo ? "" : "inactivo"}">
        <td><strong>${escapar(s.nombre)}</strong>${typeof tarEtiquetaServicio === "function" ? tarEtiquetaServicio(s.id) : ""}${s.duracion_min ? `<br><span class="nota">${s.duracion_min} min</span>` : ""}${s.horarios?.length ? `<br><span class="nota">Salidas: ${s.horarios.map(hora).join(", ")}</span>` : ""}</td>
        <td>${escapar(nombreOperador(s.operador_id)) || `<span class="nota">Sin operador</span>`}</td>
        <td>${TRANSPORTE_TEXTO[s.transporte] ?? ""}</td>
        <td>${precios || `<span class="nota">Sin precios</span>`}</td>
        <td>${s.activo ? "Visible para clientes" : "Oculto"}<br><span class="nota">${fotos.length} foto(s)</span></td>
      </tr>`;
  };

  // Un bloque por tipo de actividad, en el mismo orden que ve el cliente
  const grupos = app.tipos
    .map((tp) => ({ titulo: nombreTipo(tp), oculto: !tp.activo, lista: app.servicios.filter((s) => s.tipo_id === tp.id) }))
    .filter((g) => g.lista.length);
  const sinTipo = app.servicios.filter((s) => !tipoPorId(s.tipo_id));
  if (sinTipo.length) grupos.push({ titulo: "Sin tipo", sinTipo: true, lista: sinTipo });
  const filas = grupos.map((g) => `
    <tr class="fila-grupo"><th colspan="5">${escapar(g.titulo)}
      <span class="nota">${g.lista.length} ${g.lista.length === 1 ? "servicio" : "servicios"}${g.oculto ? " · tipo oculto: no se muestran al cliente" : ""}${g.sinTipo ? " · el cliente los ve en \"Otras actividades\"" : ""}</span>
    </th></tr>
    ${g.lista.map(fila).join("")}`).join("");

  return `
    <div class="det-seccion sin-margen">
      <h3>Servicios que ofrecemos</h3>
      <p class="nota">Rack es el precio que se cobra al cliente (precio TC de la temporada vigente). Neto es lo que nos cobra el operador. El operador y el neto nunca se muestran al cliente.</p>
      ${app.servicios.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Servicio</th><th>Operador</th><th>Transporte</th><th>Precios (rack y neto)</th><th>Estado</th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>` : `<p class="nota">Todavía no hay servicios.</p>`}
    </div>`;
}

// ---------------------------------------------------------
// TIPOS DE ACTIVIDAD
// ---------------------------------------------------------
function htmlListaTipos() {
  const tarjetas = app.tipos.map((tp) => {
    const lista = app.servicios.filter((s) => s.tipo_id === tp.id);
    const traducciones = Object.entries(OTROS_IDIOMAS)
      .map(([k, v]) => (tp.traducciones?.[k] ? `${v}: ${escapar(tp.traducciones[k])}` : null)).filter(Boolean).join(" · ");
    return `
      <li class="tipo-tarjeta${tp.activo ? "" : " inactivo"}">
        <div class="tipo-cabeza">
          <span class="tipo-icono" aria-hidden="true">${escapar(tp.icono || "•")}</span>
          <div class="tipo-textos">
            <p class="tipo-nombre">${escapar(tp.nombre)} ${tp.activo ? "" : `<span class="chip-gris">Oculto para clientes</span>`}</p>
            <p class="nota">${traducciones || "Sin traducciones"}</p>
          </div>
        </div>
        ${lista.length
          ? `<ul class="tipo-servicios">${lista.map((s) => `<li class="${s.activo ? "" : "inactivo"}">${escapar(s.nombre)}${s.activo ? "" : " <span class=\"nota\">(oculto)</span>"}</li>`).join("")}</ul>`
          : `<p class="nota tipo-vacio">Todavía no tiene servicios.</p>`}
      </li>`;
  }).join("");

  return `
    <div class="det-seccion sin-margen">
      <h3>Tipos de actividad</h3>
      <p class="nota">Así se agrupan las actividades en el formulario del cliente, en este mismo orden.</p>
      ${app.tipos.length ? `<ul class="tipos-lista">${tarjetas}</ul>` : `<p class="nota">Todavía no hay tipos de actividad.</p>`}
    </div>`;
}

// ---------------------------------------------------------
// OPERADORES
// ---------------------------------------------------------
function htmlListaOperadores() {
  const filas = app.operadores.map((o) => {
    const servicios = app.servicios.filter((s) => s.operador_id === o.id).map((s) => escapar(s.nombre)).join(", ");
    return `
      <tr class="${o.activo ? "" : "inactivo"}">
        <td><strong>${escapar(o.nombre)}</strong>${typeof tarEtiquetaOperador === "function" ? tarEtiquetaOperador(o.id) : ""}${o.contacto ? `<br><span class="nota">${escapar(o.contacto)}</span>` : ""}</td>
        <td>${escapar(o.telefono ?? "")}</td>
        <td>${o.correo ? `<a href="mailto:${escapar(o.correo)}">${escapar(o.correo)}</a>` : ""}</td>
        <td>${servicios || `<span class="nota">Ninguno</span>`}</td>
        <td>${o.activo ? "Activo" : "Inactivo"}</td>
      </tr>`;
  }).join("");

  return `
    <div class="det-seccion sin-margen">
      <h3>Operadores</h3>
      <p class="nota">Empresas que realizan los servicios. Esta información es solo para uso interno.</p>
      ${app.operadores.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Operador</th><th>Teléfono</th><th>Correo</th><th>Servicios</th><th>Estado</th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>` : `<p class="nota">Todavía no hay operadores.</p>`}
    </div>`;
}

// ---------------------------------------------------------
// PROPIEDADES
// ---------------------------------------------------------
function htmlPropiedades(editable) {
  const filas = app.propiedades.map((p) => `
    <tr class="${p.activa ? "" : "inactivo"}">
      <td><strong>${escapar(p.nombre)}</strong></td>
      <td>${p.activa ? "Visible para clientes" : "Oculta"}</td>
      <td class="acciones-fila">${editable ? `
        <button type="button" class="enlace" data-cat="renombrar-propiedad" data-id="${p.id}">Cambiar nombre</button>
        <button type="button" class="enlace" data-cat="alternar-propiedad" data-id="${p.id}">${p.activa ? "Ocultar" : "Mostrar"}</button>
        <button type="button" class="enlace peligro" data-cat="eliminar-propiedad" data-id="${p.id}">Eliminar</button>` : ""}
      </td>
    </tr>`).join("");

  return `
    <div class="det-seccion sin-margen">
      <h3>Propiedades</h3>
      <p class="nota">Estas son las opciones que ve el cliente en "¿Dónde te hospedas?". Cuando un cliente elige "Otro lugar", lo que escribe queda solo en su cotización y no se agrega a esta lista.</p>
      ${editable ? `
        <div class="fila-form">
          <label>Nueva propiedad <input id="nuevaPropiedad" type="text" placeholder="Nombre de la propiedad"></label>
          <button type="button" class="btn primario" data-cat="agregar-propiedad">Agregar</button>
        </div>` : ""}
      ${app.propiedades.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Propiedad</th><th>Estado</th><th></th></tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>` : `<p class="nota">Todavía no hay propiedades.</p>`}
    </div>`;
}

// ---------------------------------------------------------
// EVENTOS
// ---------------------------------------------------------
$("catalogoContenido").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "nuevaPropiedad") {
    e.preventDefault();
    document.querySelector('[data-cat="agregar-propiedad"]')?.click();
  }
});

$("catalogoContenido").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cat]");
  if (!btn) return;
  const id = Number(btn.dataset.id);

  switch (btn.dataset.cat) {
    case "ir-tarifario":
      mostrarVista("tarifario");
      if (typeof tar !== "undefined") { tar.pestana = "catalogo"; tar.editando = null; document.querySelector('.pestana[data-tar-pestana="catalogo"]')?.click(); }
      break;
    case "agregar-propiedad": {
      const nombre = $("nuevaPropiedad").value.trim();
      if (!nombre) return avisar("Escribe el nombre de la propiedad.", "error");
      await conBoton(btn, async () => {
        const { error } = await db.from("propiedades").insert({ nombre });
        if (error) return fallo(error, error.code === "23505" ? "Esa propiedad ya existe." : "No se pudo agregar.");
        await cargarCatalogos();
        pintarCatalogo();
        $("nuevaPropiedad")?.focus();
        avisar("Propiedad agregada.");
      });
      break;
    }
    case "renombrar-propiedad": {
      const actual = app.propiedades.find((p) => p.id === id);
      const nombre = prompt("Nuevo nombre de la propiedad:", actual?.nombre ?? "")?.trim();
      if (!nombre || nombre === actual?.nombre) return;
      const { error } = await db.from("propiedades").update({ nombre }).eq("id", id);
      if (error) return fallo(error);
      await cargarCatalogos();
      pintarCatalogo();
      break;
    }
    case "alternar-propiedad": {
      const actual = app.propiedades.find((p) => p.id === id);
      const { error } = await db.from("propiedades").update({ activa: !actual.activa }).eq("id", id);
      if (error) return fallo(error);
      await cargarCatalogos();
      pintarCatalogo();
      break;
    }
    case "eliminar-propiedad": {
      const actual = app.propiedades.find((p) => p.id === id);
      if (!confirm(`¿Eliminar "${actual?.nombre}"?`)) return;
      const { error } = await db.from("propiedades").delete().eq("id", id);
      if (error) {
        if (error.code === "23503") {
          return avisar("Esta propiedad ya aparece en cotizaciones, así que no se puede eliminar. Usa \"Ocultar\" para que los clientes ya no la vean.", "error");
        }
        return fallo(error, "No se pudo eliminar.");
      }
      await cargarCatalogos();
      pintarCatalogo();
      avisar("Propiedad eliminada.");
      break;
    }
  }
});
