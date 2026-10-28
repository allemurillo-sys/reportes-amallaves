// =====================================================
// SECCIÓN MANTENIMIENTO: cuenta, usuarios, autorizaciones y reportes
// (usa las utilidades y datos de panel.js)
// =====================================================

const mant = { pestana: "cuenta", usuarios: [], permisos: [], editando: null, reporte: null, mensaje: "" };

const ROLES = ["colaborador", "jefatura", "gerente", "administrador"];
const NOMBRE_ROL = { colaborador: "Colaborador", jefatura: "Jefatura", gerente: "Gerente", administrador: "Administrador" };
const PERMISOS = [
  { id: "ver_utilidad", nombre: "Ver costos netos y utilidad", detalle: "Muestra el neto y la utilidad en cotizaciones, servicios y reportes." },
  { id: "editar_catalogo", nombre: "Modificar el catálogo", detalle: "Crear y editar las propiedades (los servicios, precios y operadores se administran en el Tarifario)." },
  { id: "registrar_pagos", nombre: "Registrar pagos", detalle: "Definir el prepago, registrar y eliminar pagos de las reservas." },
  { id: "reabrir_finalizadas", nombre: "Reabrir reservas finalizadas", detalle: "Devolver una reserva finalizada a la columna Reserva para revisarla." },
  { id: "ver_reportes", nombre: "Ver reportes", detalle: "Reportes de ventas por colaborador y cuentas por pagar a operadores." },
  { id: "ver_tarifario", nombre: "Consultar el tarifario final", detalle: "Ver, buscar, imprimir y descargar en Excel las tarifas aprobadas del Tarifario, sin poder editarlas ni revertirlas. Incluye el neto con IVA y sin IVA." },
  { id: "cancelar_reservas", nombre: "Cancelar reservas confirmadas", detalle: "Cancelar o reactivar reservas que el cliente ya confirmó. Cualquier usuario puede cancelar cotizaciones sin confirmar." }
];

const esAdmin = () => app.yo?.rol === "administrador";
const pestanaPermitida = (p) =>
  p === "cuenta" || ((p === "usuarios" || p === "autorizaciones") && esAdmin()) || (p === "reportes" && puede("ver_reportes"));

document.addEventListener("vista-abierta", (e) => { if (e.detail === "mantenimiento") abrirMantenimiento(); });
document.addEventListener("datos-actualizados", () => { if (!$("vistaMantenimiento").hidden) abrirMantenimiento(); });

document.querySelectorAll(".pestana[data-mant]").forEach((b) => b.addEventListener("click", () => {
  mant.pestana = b.dataset.mant;
  mant.editando = null;
  abrirMantenimiento();
}));

async function abrirMantenimiento() {
  document.querySelectorAll(".pestana[data-mant]").forEach((b) => {
    b.hidden = !pestanaPermitida(b.dataset.mant);
    const activa = b.dataset.mant === mant.pestana;
    b.classList.toggle("activa", activa);
    b.setAttribute("aria-selected", activa);
  });
  if (!pestanaPermitida(mant.pestana)) mant.pestana = "cuenta";

  if (mant.pestana === "usuarios") await cargarUsuarios();
  if (mant.pestana === "autorizaciones") await cargarPermisos();
  pintarMantenimiento();
}

function pintarMantenimiento() {
  document.querySelectorAll(".pestana[data-mant]").forEach((b) => b.classList.toggle("activa", b.dataset.mant === mant.pestana));
  const html = {
    cuenta: htmlCuenta,
    usuarios: () => (mant.editando ? htmlFormUsuario(mant.editando) : htmlUsuarios()),
    autorizaciones: htmlAutorizaciones,
    reportes: htmlReportes
  }[mant.pestana]();
  $("mantContenido").innerHTML = html;
  $("mantContenido").querySelector("[autofocus]")?.focus();
}

// Llama a la función de Supabase que crea usuarios y cambia claves
async function llamarFuncion(cuerpo) {
  const { data, error } = await db.functions.invoke("gestionar-usuarios", { body: cuerpo });
  if (error) {
    let mensaje = "No se pudo completar la acción. Revisa que la función gestionar-usuarios esté publicada en Supabase.";
    try {
      const j = await error.context.json();
      if (j?.error) mensaje = j.error;
    } catch { /* sin detalle */ }
    throw new Error(mensaje);
  }
  return data;
}

function claveAleatoria() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return [...bytes].map((n) => letras[n % letras.length]).join("");
}

// ---------------------------------------------------------
// MI CUENTA
// ---------------------------------------------------------
function htmlCuenta() {
  return `
    <div class="det-seccion sin-margen">
      <h3>Mi cuenta</h3>
      <dl class="datos-cliente">
        <div><dt>Nombre</dt><dd>${escapar(app.yo.nombre)}</dd></div>
        <div><dt>Correo</dt><dd>${escapar(app.yo.correo ?? "")}</dd></div>
        <div><dt>Tipo de usuario</dt><dd>${NOMBRE_ROL[app.yo.rol] ?? app.yo.rol}</dd></div>
      </dl>
    </div>
    <div class="det-seccion sin-margen">
      <h3>Cambiar mi clave</h3>
      <div class="fila">
        <label>Clave nueva <input id="miClave" type="password" autocomplete="new-password" minlength="8"></label>
        <label>Repite la clave nueva <input id="miClave2" type="password" autocomplete="new-password" minlength="8"></label>
      </div>
      <p class="nota">Mínimo 8 caracteres. Usa una clave que no uses en otros sitios.</p>
      <div class="sec-botones"><button type="button" class="btn primario" data-mant-accion="mi-clave">Guardar clave</button></div>
    </div>`;
}

// ---------------------------------------------------------
// USUARIOS
// ---------------------------------------------------------
async function cargarUsuarios() {
  const { data, error } = await db.from("perfiles").select("*").order("nombre");
  if (error) return fallo(error, "No se pudieron cargar los usuarios.");
  mant.usuarios = data;
}

function htmlUsuarios() {
  const filas = mant.usuarios.map((u) => `
    <tr class="${u.activo ? "" : "inactivo"}">
      <td><strong>${escapar(u.nombre)}</strong>${u.id === app.yo.id ? ` <span class="nota">(tú)</span>` : ""}</td>
      <td>${escapar(u.correo ?? "")}</td>
      <td>${NOMBRE_ROL[u.rol] ?? u.rol}</td>
      <td>${u.activo ? "Activo" : "Desactivado"}</td>
      <td class="acciones-fila">
        <button type="button" class="enlace" data-mant-accion="editar-usuario" data-id="${u.id}">Editar</button>
        <button type="button" class="enlace" data-mant-accion="clave-usuario" data-id="${u.id}">Cambiar clave</button>
      </td>
    </tr>`).join("");

  const mensaje = mant.mensaje;
  mant.mensaje = "";
  return `
    ${mensaje ? `<div class="exito-caja" role="status">${mensaje}</div>` : ""}
    <div class="det-seccion sin-margen">
      <div class="sec-cabeza">
        <h3>Usuarios del panel</h3>
        <button type="button" class="btn primario" data-mant-accion="nuevo-usuario">Nuevo usuario</button>
      </div>
      <p class="nota">Un usuario desactivado ya no puede entrar al panel, pero su historial se conserva.</p>
      <div class="tabla-scroll">
        <table class="tabla">
          <thead><tr><th>Nombre</th><th>Correo</th><th>Tipo</th><th>Estado</th><th></th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>`;
}

function htmlFormUsuario(ed) {
  const opcionesRol = (actual) =>
    ROLES.map((r) => `<option value="${r}" ${r === actual ? "selected" : ""}>${NOMBRE_ROL[r]}</option>`).join("");

  if (ed.modo === "nuevo") {
    return `
      <div class="det-seccion sin-margen">
        <h3>Nuevo usuario</h3>
        <div class="fila">
          <label>Nombre completo <input id="nuNombre" autofocus></label>
          <label>Correo <input id="nuCorreo" type="email" autocomplete="off"></label>
        </div>
        <div class="fila">
          <label>Tipo de usuario <select id="nuRol">${opcionesRol("colaborador")}</select></label>
          <label>Clave inicial
            <span class="clave-linea">
              <input id="nuClave" type="text" autocomplete="off" value="${claveAleatoria()}">
              <button type="button" class="btn" data-mant-accion="generar-clave">Generar otra</button>
            </span>
          </label>
        </div>
        <p class="nota">Anota la clave y entrégasela a la persona. Luego podrá cambiarla en Mantenimiento, Mi cuenta.</p>
        <div class="sec-botones">
          <button type="button" class="btn primario" data-mant-accion="crear-usuario">Crear usuario</button>
          <button type="button" class="btn" data-mant-accion="cancelar">Cancelar</button>
        </div>
      </div>`;
  }

  const u = mant.usuarios.find((x) => x.id === ed.id);
  const yoMismo = u.id === app.yo.id;

  if (ed.modo === "clave") {
    return `
      <div class="det-seccion sin-margen">
        <h3>Cambiar la clave de ${escapar(u.nombre)}</h3>
        <label>Clave nueva
          <span class="clave-linea">
            <input id="ucClave" type="text" autocomplete="off" value="${claveAleatoria()}" autofocus>
            <button type="button" class="btn" data-mant-accion="generar-clave-u">Generar otra</button>
          </span>
        </label>
        <p class="nota">Mínimo 8 caracteres. Entrégale la nueva clave a la persona.</p>
        <div class="sec-botones">
          <button type="button" class="btn primario" data-mant-accion="guardar-clave-usuario">Guardar clave</button>
          <button type="button" class="btn" data-mant-accion="cancelar">Cancelar</button>
        </div>
      </div>`;
  }

  return `
    <div class="det-seccion sin-margen">
      <h3>Editar usuario</h3>
      <div class="fila">
        <label>Nombre completo <input id="euNombre" value="${escapar(u.nombre)}" autofocus></label>
        <label>Correo <input value="${escapar(u.correo ?? "")}" disabled></label>
      </div>
      <div class="fila">
        <label>Tipo de usuario <select id="euRol" ${yoMismo ? "disabled" : ""}>${opcionesRol(u.rol)}</select></label>
      </div>
      <label class="check-linea"><input id="euActivo" type="checkbox" ${u.activo ? "checked" : ""} ${yoMismo ? "disabled" : ""}> Activo (puede entrar al panel)</label>
      ${yoMismo ? `<p class="nota">No puedes cambiar tu propio tipo de usuario ni desactivarte. Pídeselo a otro administrador.</p>` : ""}
      <div class="sec-botones">
        <button type="button" class="btn primario" data-mant-accion="guardar-usuario">Guardar cambios</button>
        <button type="button" class="btn" data-mant-accion="cancelar">Cancelar</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------
// AUTORIZACIONES
// ---------------------------------------------------------
async function cargarPermisos() {
  const { data, error } = await db.from("permisos_rol").select("*");
  if (error) return fallo(error, "No se pudieron cargar las autorizaciones.");
  mant.permisos = data;
}

function htmlAutorizaciones() {
  const permitido = (rol, permiso) =>
    rol === "administrador" || mant.permisos.some((p) => p.rol === rol && p.permiso === permiso && p.permitido);

  const filas = PERMISOS.map((p) => `
    <tr>
      <th scope="row"><strong>${p.nombre}</strong><br><span class="nota">${p.detalle}</span></th>
      ${ROLES.map((r) => `
        <td class="centro">
          <input type="checkbox" class="permiso" data-rol="${r}" data-permiso="${p.id}"
            ${permitido(r, p.id) ? "checked" : ""} ${r === "administrador" ? "disabled" : ""}
            aria-label="${p.nombre} para ${NOMBRE_ROL[r]}">
        </td>`).join("")}
    </tr>`).join("");

  return `
    <div class="det-seccion sin-margen">
      <h3>Autorizaciones por tipo de usuario</h3>
      <p class="nota">Marca lo que puede hacer cada tipo de usuario. Los cambios se guardan al instante y llegan al panel de cada persona en menos de un minuto (o de inmediato si presiona Actualizar); se notan al abrir la siguiente pantalla. El administrador siempre tiene todos los permisos, y es el único que puede gestionar usuarios y autorizaciones.</p>
      <div class="tabla-scroll">
        <table class="tabla permisos">
          <thead><tr><th>Permiso</th>${ROLES.map((r) => `<th class="centro">${NOMBRE_ROL[r]}</th>`).join("")}</tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <p class="nota">Todos los usuarios activos pueden ver el tablero de reservas, atender cotizaciones, armar itinerarios y consultar el catálogo.</p>
    </div>`;
}

// ---------------------------------------------------------
// REPORTES
// ---------------------------------------------------------
function htmlReportes() {
  const hoy = new Date();
  const inicioMes = aTexto(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  const r = mant.reporte;
  return `
    <div class="det-seccion sin-margen no-imprimir">
      <h3>Reportes</h3>
      <div class="fila-form">
        <label>Desde <input id="repDesde" type="date" value="${r?.desde ?? inicioMes}"></label>
        <label>Hasta <input id="repHasta" type="date" value="${r?.hasta ?? aTexto(hoy)}"></label>
        <button type="button" class="btn primario" data-mant-accion="generar-reporte">Generar reporte</button>
        ${r ? `<button type="button" class="btn" data-mant-accion="imprimir-reporte">Imprimir</button>` : ""}
      </div>
    </div>
    ${r ? htmlResultadoReporte(r) : `<p class="nota">Elige un período y presiona Generar reporte.</p>`}`;
}

const esConfirmada = (c) => c.estado === "reserva" || c.estado === "finalizado";
const dentro = (t, desde, hasta) => t && t >= desde && t <= hasta;

function montosActividad(a) {
  const personas = a.actividad_participantes.reduce((s, p) => s + p.cantidad, 0);
  const rackP = a.actividad_participantes.reduce((s, p) => s + p.cantidad * Number(p.precio_unitario), 0);
  const netoP = a.actividad_participantes.reduce((s, p) => s + p.cantidad * Number(p.neto_unitario || 0), 0);
  const conTransporte = a.transporte_modo === "opcional" && a.transporte_respuesta === true;
  const rackT = conTransporte ? Number(a.transporte_costo) : 0;
  const netoT = conTransporte || a.transporte_modo === "incluido" ? Number(a.transporte_neto || 0) : 0;
  return { personas, rackP, netoP, rackT, netoT };
}

async function generarReporte(btn) {
  const desde = $("repDesde").value;
  const hasta = $("repHasta").value;
  if (!desde || !hasta || hasta < desde) return avisar("Revisa las fechas del reporte.", "error");

  await conBoton(btn, async () => {
    const { data, error } = await db.from("cotizaciones")
      .select(`id, numero, nombre, apellido, estado, colaborador_id, creado_en, confirmada_en,
        actividades(fecha, operador_id, servicio_id, transporte_modo, transporte_costo, transporte_neto, transporte_respuesta,
          actividad_participantes(cantidad, precio_unitario, neto_unitario))`)
      .or(`creado_en.gte.${desde},confirmada_en.gte.${desde},fecha_fin.gte.${desde}`);
    if (error) return fallo(error, "No se pudo generar el reporte.");

    // ----- Por colaborador -----
    const porColab = new Map();
    const fila = (id) => {
      if (!porColab.has(id)) porColab.set(id, { id, atendidas: 0, confirmadas: 0, ventas: 0, neto: 0 });
      return porColab.get(id);
    };
    for (const c of data) {
      if (!c.colaborador_id) continue;
      if (dentro(aTexto(new Date(c.creado_en)), desde, hasta)) fila(c.colaborador_id).atendidas++;
      if (esConfirmada(c) && c.confirmada_en && dentro(aTexto(new Date(c.confirmada_en)), desde, hasta)) {
        const f = fila(c.colaborador_id);
        f.confirmadas++;
        for (const a of c.actividades) {
          const m = montosActividad(a);
          f.ventas += m.rackP + m.rackT;
          f.neto += m.netoP + m.netoT;
        }
      }
    }

    // ----- Por operador (servicios realizados en el período) -----
    const porOper = new Map();
    for (const c of data) {
      if (!esConfirmada(c)) continue;
      for (const a of c.actividades) {
        if (!dentro(a.fecha, desde, hasta)) continue;
        const m = montosActividad(a);
        const clave = a.operador_id ?? 0;
        if (!porOper.has(clave)) porOper.set(clave, { id: clave, actividades: 0, personas: 0, ventas: 0, neto: 0, detalle: [] });
        const o = porOper.get(clave);
        o.actividades++;
        o.personas += m.personas;
        o.ventas += m.rackP;
        o.neto += m.netoP;
        o.detalle.push({ fecha: a.fecha, numero: c.numero, cliente: `${c.nombre} ${c.apellido}`, servicio: servicioPorId(a.servicio_id)?.nombre ?? "", personas: m.personas, neto: m.netoP });
      }
    }
    porOper.forEach((o) => o.detalle.sort((x, y) => x.fecha.localeCompare(y.fecha)));

    mant.reporte = {
      desde, hasta,
      colaboradores: [...porColab.values()].sort((x, y) => y.ventas - x.ventas),
      operadores: [...porOper.values()].sort((x, y) => y.neto - x.neto)
    };
    pintarMantenimiento();
  });
}

function htmlResultadoReporte(r) {
  const verUtil = puede("ver_utilidad");
  const suma = (lista, campo) => lista.reduce((s, x) => s + x[campo], 0);
  const periodo = `${fecha(r.desde, { day: "numeric", month: "short", year: "numeric" })} al ${fecha(r.hasta, { day: "numeric", month: "short", year: "numeric" })}`;

  const filasC = r.colaboradores.map((f) => `
    <tr>
      <td><strong>${escapar(nombrePerfil(f.id) || "Usuario eliminado")}</strong></td>
      <td class="num">${f.atendidas}</td>
      <td class="num">${f.confirmadas}</td>
      <td class="num">${f.atendidas ? Math.round((f.confirmadas / f.atendidas) * 100) + "%" : ""}</td>
      <td class="num">${dinero(f.ventas)}</td>
      ${verUtil ? `<td class="num">${dinero(f.neto)}</td><td class="num"><strong>${dinero(f.ventas - f.neto)}</strong></td>` : ""}
    </tr>`).join("");

  const filasO = r.operadores.map((o) => `
    <tr>
      <td>
        <details>
          <summary><strong>${escapar(o.id ? nombreOperador(o.id) : "Sin operador asignado")}</strong></summary>
          <table class="tabla detalle-op">
            <thead><tr><th>Fecha</th><th>Cotización</th><th>Cliente</th><th>Servicio</th><th class="num">Personas</th>${verUtil ? `<th class="num">Neto</th>` : ""}</tr></thead>
            <tbody>${o.detalle.map((d) => `
              <tr><td>${fecha(d.fecha)}</td><td>${d.numero}</td><td>${escapar(d.cliente)}</td><td>${escapar(d.servicio)}</td>
              <td class="num">${d.personas}</td>${verUtil ? `<td class="num">${dinero(d.neto)}</td>` : ""}</tr>`).join("")}
            </tbody>
          </table>
        </details>
      </td>
      <td class="num">${o.actividades}</td>
      <td class="num">${o.personas}</td>
      <td class="num">${dinero(o.ventas)}</td>
      ${verUtil ? `<td class="num"><strong>${dinero(o.neto)}</strong></td><td class="num">${dinero(o.ventas - o.neto)}</td>` : ""}
    </tr>`).join("");

  return `
    <div class="det-seccion sin-margen reporte">
      <p class="imp-marca solo-impresion">The House of Tours</p>
      <h3>Ventas por colaborador</h3>
      <p class="nota">Período: ${periodo}. "Atendidas" son las solicitudes recibidas en el período que tienen colaborador asignado; "Confirmadas" y los montos corresponden a las reservas confirmadas en el período.</p>
      ${r.colaboradores.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Colaborador</th><th class="num">Atendidas</th><th class="num">Confirmadas</th><th class="num">Cierre</th><th class="num">Ventas (rack)</th>${verUtil ? `<th class="num">Costo neto</th><th class="num">Utilidad</th>` : ""}</tr></thead>
            <tbody>${filasC}</tbody>
            <tfoot><tr>
              <th>Total</th>
              <th class="num">${suma(r.colaboradores, "atendidas")}</th>
              <th class="num">${suma(r.colaboradores, "confirmadas")}</th>
              <th></th>
              <th class="num">${dinero(suma(r.colaboradores, "ventas"))}</th>
              ${verUtil ? `<th class="num">${dinero(suma(r.colaboradores, "neto"))}</th><th class="num">${dinero(suma(r.colaboradores, "ventas") - suma(r.colaboradores, "neto"))}</th>` : ""}
            </tr></tfoot>
          </table>
        </div>` : `<p class="nota">No hay actividad de colaboradores en este período.</p>`}
    </div>

    <div class="det-seccion sin-margen reporte">
      <h3>Operadores: servicios realizados y monto por pagar</h3>
      <p class="nota">Período: ${periodo}. Incluye las actividades de reservas confirmadas cuya fecha de servicio cae en el período. El transporte no se incluye aquí. Haz clic en un operador para ver el detalle.</p>
      ${r.operadores.length ? `
        <div class="tabla-scroll">
          <table class="tabla">
            <thead><tr><th>Operador</th><th class="num">Actividades</th><th class="num">Personas</th><th class="num">Ventas (rack)</th>${verUtil ? `<th class="num">Por pagar (neto)</th><th class="num">Utilidad</th>` : ""}</tr></thead>
            <tbody>${filasO}</tbody>
            <tfoot><tr>
              <th>Total</th>
              <th class="num">${suma(r.operadores, "actividades")}</th>
              <th class="num">${suma(r.operadores, "personas")}</th>
              <th class="num">${dinero(suma(r.operadores, "ventas"))}</th>
              ${verUtil ? `<th class="num">${dinero(suma(r.operadores, "neto"))}</th><th class="num">${dinero(suma(r.operadores, "ventas") - suma(r.operadores, "neto"))}</th>` : ""}
            </tr></tfoot>
          </table>
        </div>` : `<p class="nota">No hay servicios realizados en este período.</p>`}
    </div>`;
}

// ---------------------------------------------------------
// EVENTOS
// ---------------------------------------------------------
$("mantContenido").addEventListener("change", async (e) => {
  const chk = e.target.closest("input.permiso");
  if (!chk) return;
  chk.disabled = true;
  const { error } = await db.from("permisos_rol")
    .update({ permitido: chk.checked })
    .eq("rol", chk.dataset.rol).eq("permiso", chk.dataset.permiso);
  chk.disabled = false;
  if (error) {
    chk.checked = !chk.checked;
    return fallo(error, "No se pudo guardar la autorización.");
  }
  await cargarPermisos();
  avisar("Autorización guardada.");
});

$("mantContenido").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-mant-accion]");
  if (!btn) return;
  const id = btn.dataset.id;

  switch (btn.dataset.mantAccion) {
    case "mi-clave": {
      const clave = $("miClave").value;
      if (clave.length < 8) return avisar("La clave debe tener al menos 8 caracteres.", "error");
      if (clave !== $("miClave2").value) return avisar("Las dos claves no coinciden.", "error");
      await conBoton(btn, async () => {
        const { error } = await db.auth.updateUser({ password: clave });
        if (error) return fallo(error, "No se pudo cambiar la clave.");
        $("miClave").value = "";
        $("miClave2").value = "";
        avisar("Tu clave se cambió. Úsala la próxima vez que entres.");
      });
      break;
    }

    case "nuevo-usuario":
      mant.editando = { modo: "nuevo" };
      pintarMantenimiento();
      break;
    case "editar-usuario":
      mant.editando = { modo: "editar", id };
      pintarMantenimiento();
      break;
    case "clave-usuario":
      mant.editando = { modo: "clave", id };
      pintarMantenimiento();
      break;
    case "cancelar":
      mant.editando = null;
      pintarMantenimiento();
      break;
    case "generar-clave":
      $("nuClave").value = claveAleatoria();
      break;
    case "generar-clave-u":
      $("ucClave").value = claveAleatoria();
      break;

    case "crear-usuario": {
      const cuerpo = {
        accion: "crear",
        nombre: $("nuNombre").value.trim(),
        correo: $("nuCorreo").value.trim(),
        rol: $("nuRol").value,
        clave: $("nuClave").value
      };
      if (!cuerpo.nombre || !cuerpo.correo) return avisar("Escribe el nombre y el correo.", "error");
      if (cuerpo.clave.length < 8) return avisar("La clave debe tener al menos 8 caracteres.", "error");
      await conBoton(btn, async () => {
        try {
          await llamarFuncion(cuerpo);
        } catch (err) {
          return avisar(err.message, "error");
        }
        mant.mensaje = `<strong>Usuario creado.</strong> Entrégale a ${escapar(cuerpo.nombre)} estos datos para entrar al panel:<br>
          Correo: <code>${escapar(cuerpo.correo.toLowerCase())}</code><br>Clave: <code>${escapar(cuerpo.clave)}</code>`;
        mant.editando = null;
        await cargarUsuarios();
        await cargarCatalogos();
        pintarMantenimiento();
      });
      break;
    }

    case "guardar-clave-usuario": {
      const clave = $("ucClave").value;
      if (clave.length < 8) return avisar("La clave debe tener al menos 8 caracteres.", "error");
      await conBoton(btn, async () => {
        try {
          await llamarFuncion({ accion: "cambiar_clave", id: mant.editando.id, clave });
        } catch (err) {
          return avisar(err.message, "error");
        }
        const u = mant.usuarios.find((x) => x.id === mant.editando.id);
        mant.mensaje = `<strong>Clave cambiada.</strong> La nueva clave de ${escapar(u?.nombre ?? "")} es: <code>${escapar(clave)}</code>`;
        mant.editando = null;
        pintarMantenimiento();
      });
      break;
    }

    case "guardar-usuario": {
      const u = mant.usuarios.find((x) => x.id === mant.editando.id);
      const datos = { nombre: $("euNombre").value.trim() };
      if (!datos.nombre) return avisar("Escribe el nombre.", "error");
      if (u.id !== app.yo.id) {
        datos.rol = $("euRol").value;
        datos.activo = $("euActivo").checked;
      }
      await conBoton(btn, async () => {
        const { error } = await db.from("perfiles").update(datos).eq("id", u.id);
        if (error) return fallo(error);
        if (u.id === app.yo.id) {
          app.yo.nombre = datos.nombre;
          $("usuarioNombre").textContent = `${app.yo.nombre} (${app.yo.rol})`;
        }
        mant.editando = null;
        await cargarUsuarios();
        await cargarCatalogos();
        pintarMantenimiento();
        avisar("Usuario actualizado.");
      });
      break;
    }

    case "generar-reporte":
      await generarReporte(btn);
      break;
    case "imprimir-reporte":
      window.print();
      break;
  }
});
