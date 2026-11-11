// Reloj de alertas: lo ejecuta una tarea programada cada minuto.
// Envía avisos de reportes nuevos, repite hasta "Lo vi", escala, recuerda responder y envía resúmenes.
//
// HORARIO DE AVISOS (2026-11-10)
//   · Departamento de Ama de llaves (Ama de llaves, Supervisora, Mucama): 8:00 a. m. a 4:30 p. m.
//   · Resto del personal (Operaciones, Administración):                  8:00 a. m. a 9:00 p. m.
//   (Se cambian en Mantenimiento › Telegram › Horario de avisos.)
//   · Cada mensaje se envía solo si TODAS las personas que menciona están dentro de su horario.
//   · Fuera de horario no se envía nada: el aviso queda en espera y sale cuando abre el horario.
//     Al reanudar, el conteo de repetición y escalamiento empieza de nuevo (no escala de golpe a las 8:00).
//   · Los resúmenes del grupo y los botones "Lo vi" / "Tomar caso" no cambian.
//   · Las notificaciones de la app (campana y celular) no cambian.
import { db, tg, esc, cargar, json, prioridadTxt, estadoTxt } from "./tg.ts";

const MIN = 60_000;
const AMA = ["ama_llaves", "supervisora", "mucama"];

Deno.serve(async (req) => {
  const sb = db();
  const { config, secretos } = await cargar(sb);
  if (req.headers.get("x-reloj-secreto") !== secretos?.webhook_secreto) return json({ ok: false }, 401);

  // Interruptor apagado, o falta configurar bot o grupo: no se envía nada.
  if (!config?.activo || !secretos?.bot_token || !config?.grupo_chat_id) {
    return json({ ok: true, enviado: 0, motivo: "inactivo" });
  }
  const ctx: Ctx = { sb, token: secretos.bot_token as string, config, enviados: 0, ahoraMin: horaLocal(config.zona_horaria) };
  try {
    await nuevos(ctx);
    await seguimiento(ctx);
    await resumenes(ctx);
  } catch (e) {
    console.error("telegram-reloj", e);
    return json({ ok: false, error: String(e) }, 500);
  }
  return json({ ok: true, enviado: ctx.enviados });
});

type Ctx = { sb: any; token: string; config: any; enviados: number; ahoraMin: number };

// ---------- Horario de avisos ----------
const minutosDe = (t: string | null | undefined, porDefecto: string) => {
  const [h, m] = String(t || porDefecto).split(":").map(Number);
  return h * 60 + m;
};
function ventanaRol(ctx: Ctx, rol: string): [number, number] {
  const c = ctx.config;
  return AMA.includes(rol)
    ? [minutosDe(c.horario_ama_inicio, "08:00"), minutosDe(c.horario_ama_fin, "16:30")]
    : [minutosDe(c.horario_resto_inicio, "08:00"), minutosDe(c.horario_resto_fin, "21:00")];
}
// Horario común de un grupo de roles: el más corto (empieza en el inicio más tardío y termina en el fin más temprano)
function ventana(ctx: Ctx, roles: string[]): [number, number] {
  const rs = roles.filter(Boolean);
  if (!rs.length) return ventanaRol(ctx, "admin");
  const vs = rs.map((r) => ventanaRol(ctx, r));
  return [Math.max(...vs.map((v) => v[0])), Math.min(...vs.map((v) => v[1]))];
}
function enHorario(ctx: Ctx, roles: string[]) {
  const [ini, fin] = ventana(ctx, roles);
  return ctx.ahoraMin >= ini && ctx.ahoraMin < fin;
}
// Momento (fecha real) en que abrió hoy el horario de esos roles
function aperturaHoy(ctx: Ctx, roles: string[]) {
  const [ini] = ventana(ctx, roles);
  return Date.now() - (ctx.ahoraMin - ini) * MIN - 59_000;
}
const rolesDe = (ps: any[]) => [...new Set(ps.map((p: any) => p.rol).filter(Boolean))] as string[];

// ---------- Utilidades ----------
async function perfiles(ctx: Ctx, ids: string[]) {
  if (!ids.length) return [];
  const { data: ps } = await ctx.sb.from("perfiles").select("id, nombre, rol").in("id", ids);
  const { data: vs } = await ctx.sb.from("telegram_vinculos").select("usuario_id, telegram_user_id").in("usuario_id", ids);
  const tgId = new Map((vs ?? []).map((v: any) => [v.usuario_id, v.telegram_user_id]));
  return (ps ?? []).map((p: any) => ({ ...p, telegram_user_id: tgId.get(p.id) ?? null }));
}

// Menciona con @ a quien tiene Telegram conectado; marca a quien no lo tiene.
function menciones(ps: any[]) {
  if (!ps.length) return "(sin responsables definidos)";
  return ps.map((p) =>
    p.telegram_user_id
      ? `<a href="tg://user?id=${p.telegram_user_id}">${esc(p.nombre)}</a>`
      : `${esc(p.nombre)} <i>(sin Telegram conectado)</i>`
  ).join(", ");
}

function botonesReporte(ctx: Ctx, reporteId: number, conBotones = true) {
  const filas: any[] = [];
  if (conBotones) filas.push([{ text: "👀 Lo vi", callback_data: `vi:${reporteId}` }, { text: "✋ Tomar caso", callback_data: `tomar:${reporteId}` }]);
  if (ctx.config.app_url) filas.push([{ text: "📋 Responder en el sistema", url: ctx.config.app_url }]);
  return filas.length ? { inline_keyboard: filas } : undefined;
}

async function enviar(ctx: Ctx, tipo: string, texto: string, opts: { reporteId?: number; mencionados?: string[]; teclado?: any; responderA?: number } = {}) {
  const r = await tg(ctx.token, "sendMessage", {
    chat_id: ctx.config.grupo_chat_id,
    text: texto,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: opts.teclado,
    reply_to_message_id: opts.responderA,
    allow_sending_without_reply: true,
  });
  await ctx.sb.from("telegram_alertas").insert({
    reporte_id: opts.reporteId ?? null,
    tipo,
    mencionados: opts.mencionados ?? [],
    chat_id: ctx.config.grupo_chat_id,
    mensaje_id: r.result?.message_id ?? null,
    estado_envio: r.ok ? "enviado" : "fallido",
    error: r.ok ? null : r.description ?? "error",
    modo: ctx.config.modo,
  });
  if (r.ok) ctx.enviados++;
  return r.ok ? (r.result?.message_id as number) : null;
}

// Responsables según el sistema: asignados del reporte o, si no hay, el rol del "Dirigido a".
async function responsablesDe(ctx: Ctx, r: any): Promise<string[]> {
  if (r.asignados?.length) return r.asignados;
  if (r.asignado_a) return [r.asignado_a];
  const { data } = await ctx.sb.from("perfiles").select("id").eq("rol", r.departamento).eq("activo", true);
  return (data ?? []).map((x: any) => x.id);
}

function encabezado(r: any) {
  const fotos = r.fotos?.length ? `\n📷 ${r.fotos.length} foto(s) en el sistema` : "";
  return `<b>${esc(r.numero_caso)}</b> · ${esc(r.propiedad_nombre)}\n${prioridadTxt(r.prioridad)}\n📝 ${esc(r.descripcion)}${fotos}`;
}

function fechaHora(iso: string, zona: string) {
  return new Intl.DateTimeFormat("es-CR", { timeZone: zona, day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso));
}

// ---------- 1. Reportes nuevos ----------
async function nuevos(ctx: Ctx) {
  const { data: reps } = await ctx.sb.from("reportes")
    .select("*")
    .gte("creado_en", ctx.config.activado_en)
    .neq("estado", "listo")
    .order("creado_en")
    .limit(200);
  if (!reps?.length) return;
  const { data: ya } = await ctx.sb.from("telegram_seguimiento").select("reporte_id").in("reporte_id", reps.map((r: any) => r.id));
  const conocidos = new Set((ya ?? []).map((x: any) => x.reporte_id));

  for (const r of reps) {
    if (conocidos.has(r.id)) continue;
    const resp = await responsablesDe(ctx, r);
    const ps = await perfiles(ctx, resp);
    // Fuera del horario de los responsables: el aviso espera a que abra el horario
    if (!enHorario(ctx, ps.length ? rolesDe(ps) : [r.departamento])) continue;
    const { data: creador } = await ctx.sb.from("perfiles").select("nombre").eq("id", r.creado_por).maybeSingle();
    const ahora = new Date().toISOString();
    const espero = Date.now() - new Date(r.creado_en).getTime() > 15 * MIN
      ? `\n🕗 Se reportó el ${fechaHora(r.creado_en, ctx.config.zona_horaria)} (fuera del horario de avisos)` : "";
    // Se registra primero para no duplicar avisos si el envío tarda.
    await ctx.sb.from("telegram_seguimiento").insert({
      reporte_id: r.id, responsables: resp, primera_alerta_en: ahora, ultima_alerta_en: ahora, modo: ctx.config.modo,
    });
    await enviar(ctx, "nuevo",
      `🆕 <b>Nuevo reporte</b>\n${encabezado(r)}\n👤 Reportó: ${esc(creador?.nombre ?? "—")}${espero}\n\n➡️ Responsable: ${menciones(ps)}\nToca <b>Lo vi</b> para confirmar. La respuesta se hace en el sistema.`,
      { reporteId: r.id, mencionados: resp, teclado: botonesReporte(ctx, r.id) });
  }
}

// ---------- 2. Repeticiones, escalamiento, recordatorios y cierre ----------
async function seguimiento(ctx: Ctx) {
  const { data: segs } = await ctx.sb.from("telegram_seguimiento").select("*").eq("finalizado", false).limit(50);
  if (!segs?.length) return;
  const { data: reps } = await ctx.sb.from("reportes").select("*").in("id", segs.map((s: any) => s.reporte_id));
  const porId = new Map((reps ?? []).map((r: any) => [r.id, r]));
  const ahora = Date.now();
  const repetir = ctx.config.repetir_cada_min * MIN;
  const escalar = ctx.config.escalar_a_min * MIN;

  for (const s of segs) {
    const r: any = porId.get(s.reporte_id);
    if (!r) { await ctx.sb.from("telegram_seguimiento").update({ finalizado: true }).eq("reporte_id", s.reporte_id); continue; }

    // Caso cerrado en el sistema: se avisa (dentro del horario de quien reportó) y termina el seguimiento.
    if (r.estado === "listo") {
      const ps = await perfiles(ctx, [r.creado_por, r.cerrado_por].filter(Boolean));
      const creador = ps.find((p: any) => p.id === r.creado_por);
      const cerro = ps.find((p: any) => p.id === r.cerrado_por);
      if (creador && !enHorario(ctx, [creador.rol])) continue;   // se avisa cuando abra su horario
      await ctx.sb.from("telegram_seguimiento").update({ finalizado: true }).eq("reporte_id", r.id);
      await enviar(ctx, "cambio_estado",
        `✅ <b>Caso cerrado</b> · <b>${esc(r.numero_caso)}</b> · ${esc(r.propiedad_nombre)}\nCerrado en el sistema por ${esc(cerro?.nombre ?? "—")}.\n${creador ? menciones([creador]) : ""}`,
        { reporteId: r.id, mencionados: creador ? [creador.id] : [] });
      continue;
    }

    // Si alguien abrió el caso directamente en el sistema, cuenta como confirmado.
    if (!s.visto_en && r.abierto_en) {
      await ctx.sb.from("telegram_seguimiento").update({ visto_por: r.abierto_por, visto_en: r.abierto_en }).eq("reporte_id", r.id);
      s.visto_en = r.abierto_en; s.visto_por = r.abierto_por;
    }

    if (!s.visto_en) {
      const resps = await perfiles(ctx, s.responsables);
      const yaSup = await perfiles(ctx, s.escalado_a ?? []);
      const roles = rolesDe([...resps, ...yaSup]);
      if (!enHorario(ctx, roles.length ? roles : [r.departamento])) continue;   // fuera de horario: en espera

      // Reanudación: el último aviso fue antes de que abriera el horario de hoy (quedó pendiente de ayer).
      // Se avisa una vez y el conteo de repetición/escalamiento empieza desde ahora.
      if (new Date(s.ultima_alerta_en).getTime() < aperturaHoy(ctx, roles.length ? roles : [r.departamento])) {
        const nowIso = new Date().toISOString();
        await ctx.sb.from("telegram_seguimiento").update({ primera_alerta_en: nowIso, ultima_alerta_en: nowIso }).eq("reporte_id", r.id);
        await enviar(ctx, "repeticion",
          `🔔 <b>Pendiente de confirmar</b> · ${esc(r.numero_caso)} · ${esc(r.propiedad_nombre)} · ${prioridadTxt(r.prioridad)}\nQuedó sin confirmar fuera del horario de avisos.\n${menciones([...resps, ...yaSup])}`,
          { reporteId: r.id, mencionados: [...s.responsables, ...(s.escalado_a ?? [])], teclado: botonesReporte(ctx, r.id) });
        continue;
      }

      const desdeInicio = ahora - new Date(s.primera_alerta_en).getTime();
      const desdeUltima = ahora - new Date(s.ultima_alerta_en).getTime();

      // Escalamiento a los superiores (una sola vez).
      if (!s.escalado_en && desdeInicio >= escalar) {
        const rolesResp = rolesDe(resps);
        const { data: reglas } = await ctx.sb.from("telegram_escalamiento").select("escala_a").in("rol", rolesResp.length ? rolesResp : ["_"]);
        const rolesSup = [...new Set((reglas ?? []).flatMap((x: any) => x.escala_a))];
        let sup: string[] = [];
        if (rolesSup.length) {
          const { data } = await ctx.sb.from("perfiles").select("id").in("rol", rolesSup).eq("activo", true);
          sup = (data ?? []).map((x: any) => x.id).filter((id: string) => !s.responsables.includes(id));
        }
        const psSup = await perfiles(ctx, sup);
        // Los superiores también deben estar en su horario; si no, el escalamiento espera y sigue la repetición
        if (enHorario(ctx, rolesDe([...resps, ...psSup]))) {
          const nowIso = new Date().toISOString();
          await ctx.sb.from("telegram_seguimiento").update({ escalado_en: nowIso, escalado_a: sup, ultima_alerta_en: nowIso }).eq("reporte_id", r.id);
          await enviar(ctx, "escalamiento",
            `🚨 <b>Escalamiento</b> · ${ctx.config.escalar_a_min} min sin confirmar\n${encabezado(r)}\n\nResponsable: ${menciones(resps)}\nSe alerta a: ${menciones(psSup)}`,
            { reporteId: r.id, mencionados: [...s.responsables, ...sup], teclado: botonesReporte(ctx, r.id) });
          continue;
        }
      }

      // Repetición de la alerta.
      if (desdeUltima >= repetir) {
        const ids = [...s.responsables, ...(s.escalado_a ?? [])];
        const ps = [...resps, ...yaSup];
        const n = s.repeticiones + 1;
        await ctx.sb.from("telegram_seguimiento").update({ repeticiones: n, ultima_alerta_en: new Date().toISOString() }).eq("reporte_id", r.id);
        const min = Math.floor(desdeInicio / MIN);
        await enviar(ctx, "repeticion",
          `🔔 <b>Recordatorio ${n}</b> · ${esc(r.numero_caso)} · ${esc(r.propiedad_nombre)} · ${prioridadTxt(r.prioridad)}\nSin confirmar desde hace ${min} min.\n${menciones(ps)}`,
          { reporteId: r.id, mencionados: ids, teclado: botonesReporte(ctx, r.id) });
      }
      continue;
    }

    // Confirmado pero sin respuesta en el sistema (sigue en "Nuevo"): recordar cada plazo de escalamiento.
    if (r.estado === "nuevo") {
      const base = new Date(s.ultimo_recordatorio_respuesta ?? s.visto_en).getTime();
      if (ahora - base >= escalar) {
        const quien = s.tomado_por ?? s.visto_por;
        const ps = await perfiles(ctx, quien ? [quien] : s.responsables);
        if (!enHorario(ctx, ps.length ? rolesDe(ps) : [r.departamento])) continue;   // fuera de horario: en espera
        await ctx.sb.from("telegram_seguimiento").update({ ultimo_recordatorio_respuesta: new Date().toISOString() }).eq("reporte_id", r.id);
        await enviar(ctx, "recordatorio_respuesta",
          `⏳ <b>Falta la respuesta en el sistema</b> · ${esc(r.numero_caso)} · ${esc(r.propiedad_nombre)}\nEl caso fue confirmado pero sigue en estado ${estadoTxt(r.estado)}.\n${menciones(ps)}`,
          { reporteId: r.id, mencionados: ps.map((p: any) => p.id), teclado: botonesReporte(ctx, r.id, false) });
      }
    }
  }
}

// ---------- 3. Resúmenes diarios ----------
function horaLocal(zona: string) {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = Number(partes.find((p) => p.type === "hour")?.value) % 24;
  const m = Number(partes.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

async function resumenes(ctx: Ctx) {
  const ahoraMin = ctx.ahoraMin;
  for (const [cual, hora] of [["mañana", ctx.config.resumen_manana], ["tarde", ctx.config.resumen_tarde]] as const) {
    const slot = minutosDe(hora, "00:00");
    const pasados = ahoraMin - slot;
    if (pasados < 0 || pasados > 30) continue; // ventana de 30 min por si el reloj se atrasa
    const desde = new Date(Date.now() - (pasados + 1) * MIN).toISOString();
    const { count } = await ctx.sb.from("telegram_alertas").select("id", { count: "exact", head: true })
      .eq("tipo", "resumen").gte("enviado_en", desde).eq("estado_envio", "enviado");
    if ((count ?? 0) > 0) continue;

    const { data: abiertos } = await ctx.sb.from("reportes").select("numero_caso, propiedad_nombre, estado, prioridad, creado_en")
      .neq("estado", "listo").order("creado_en");
    const peso: Record<string, number> = { alta: 0, media: 1, baja: 2 };
    (abiertos ?? []).sort((a: any, b: any) => (peso[a.prioridad] ?? 3) - (peso[b.prioridad] ?? 3));
    const lista = (abiertos ?? []).slice(0, 20).map((r: any) => {
      const dias = Math.floor((Date.now() - new Date(r.creado_en).getTime()) / (24 * 60 * MIN));
      return `• <b>${esc(r.numero_caso)}</b> · ${esc(r.propiedad_nombre)} · ${estadoTxt(r.estado)} · ${prioridadTxt(r.prioridad)}${dias ? ` · ${dias} d` : ""}`;
    }).join("\n");
    let extra = "";
    if (cual === "tarde") {
      const inicioDia = new Date(Date.now() - ahoraMin * MIN).toISOString();
      const { count: cerrados } = await ctx.sb.from("reportes").select("id", { count: "exact", head: true }).eq("estado", "listo").gte("cerrado_en", inicioDia);
      extra = `\n✅ Cerrados hoy: <b>${cerrados ?? 0}</b>`;
    }
    const total = abiertos?.length ?? 0;
    await enviar(ctx, "resumen",
      `📊 <b>Resumen de la ${cual}</b>${extra}\n📂 Casos abiertos: <b>${total}</b>${total ? `\n\n${lista}${total > 20 ? `\n… y ${total - 20} más en el sistema` : ""}` : "\nNo hay casos pendientes. 🎉"}`,
      { teclado: ctx.config.app_url ? { inline_keyboard: [[{ text: "📋 Abrir el sistema", url: ctx.config.app_url }]] } : undefined });
  }
}
