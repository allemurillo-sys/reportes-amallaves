// =====================================================================
// enviar-push · Reportes Ama de Llaves (Home Vacations CR)
// Envía cada notificación de la campana al celular / computadora de la persona,
// aunque el sistema esté cerrado o el celular en reposo.
//   · La llama la base de datos cuando se crea una notificación (con x-secreto).
//   · Desde "Mi cuenta", el usuario puede pedir una notificación de prueba.
//   · Avisos de reportes (abren el caso) y de "Claves de caja" (abren esa sección).
//     El aviso de claves NUNCA lleva la clave: así no queda a la vista en la pantalla bloqueada.
// =====================================================================
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let cfg: Record<string, string> | null = null;
async function config() {
  if (cfg) return cfg;
  const { data, error } = await admin.from("push_config").select("clave, valor");
  if (error) throw error;
  cfg = Object.fromEntries((data || []).map((r) => [r.clave, r.valor]));
  webpush.setVapidDetails(cfg.vapid_contacto, cfg.vapid_publica, cfg.vapid_privada);
  return cfg;
}

type Aviso = {
  title: string; body: string; tag: string; url: string;
  reporte_id?: number; badge?: number; vista?: string; caja_id?: number;
};

async function enviarA(usuarioId: string, aviso: Aviso) {
  const { data: subs } = await admin.from("push_suscripciones").select("*").eq("usuario_id", usuarioId);
  let ok = 0, fallos = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(aviso),
        { TTL: 60 * 60 * 24, urgency: "high" },
      );
      ok++;
      await admin.from("push_suscripciones").update({ ultimo_envio: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      fallos++;
      const code = (e as { statusCode?: number }).statusCode;
      // El dispositivo ya no acepta avisos (desinstaló o quitó el permiso): se borra
      if (code === 404 || code === 410) await admin.from("push_suscripciones").delete().eq("id", s.id);
      else console.error("push error", code, String((e as Error).message || e));
    }
  }
  return { dispositivos: (subs || []).length, enviados: ok, fallos };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const c = await config();
    const body = await req.json().catch(() => ({}));

    // 1) Llamada de la base de datos: notificación nueva
    if (req.headers.get("x-secreto")) {
      if (req.headers.get("x-secreto") !== c.secreto) return json({ error: "No autorizado" }, 401);
      const { data: n } = await admin.from("notificaciones").select("*").eq("id", body.notificacion_id).maybeSingle();
      if (!n) return json({ error: "No existe" }, 404);
      const { count } = await admin.from("notificaciones").select("id", { count: "exact", head: true })
        .eq("usuario_id", n.usuario_id).eq("leida", false);
      const lugar = n.propiedad_nombre ? " · " + n.propiedad_nombre : "";
      const aviso: Aviso = n.tipo === "clave"
        ? {
          title: `${n.numero_caso || "Clave de caja"}${lugar}`,
          body: n.mensaje,
          tag: "clave-" + (n.caja_id ?? n.id),
          url: "./?claves=" + (n.caja_id ?? ""),
          vista: "claves",
          caja_id: n.caja_id ?? undefined,
          badge: count || 1,
        }
        : {
          title: `${n.numero_caso || "Reporte"}${lugar}`,
          body: n.mensaje,
          tag: "caso-" + n.reporte_id,
          url: "./?caso=" + n.reporte_id,
          reporte_id: n.reporte_id,
          badge: count || 1,
        };
      return json(await enviarA(n.usuario_id, aviso));
    }

    // 2) Prueba pedida por el usuario conectado
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Inicie sesión" }, 401);
    if (body.accion === "prueba") {
      const r = await enviarA(u.user.id, {
        title: "✅ Notificaciones activas",
        body: "Así le llegarán los avisos de los reportes, aunque el celular esté en reposo.",
        tag: "prueba",
        url: "./",
      });
      return json(r);
    }
    return json({ error: "Acción no válida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
