// Utilidades compartidas por las funciones de Telegram del sistema de Ama de Llaves.
import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

// Cliente con permisos de servidor (nunca se expone a la app).
export const db = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

// Llamada a la API oficial de bots de Telegram.
export async function tg(token: string, metodo: string, cuerpo: Record<string, unknown> = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    return (await r.json()) as { ok: boolean; result?: any; description?: string };
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

// Escapa texto para el formato HTML de Telegram.
export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function cargar(sb: any) {
  const { data: config } = await sb.from("telegram_config").select("*").eq("id", 1).single();
  const { data: secretos } = await sb.from("telegram_secretos").select("*").eq("id", 1).single();
  return { config, secretos } as { config: any; secretos: any };
}

export const prioridadTxt = (p: string) => (p === "alta" ? "🔴 ALTA" : p === "media" ? "🟠 media" : "🟢 baja");

export const estadoTxt = (e: string) =>
  ({
    nuevo: "Nuevo",
    en_proceso: "En proceso",
    revisado_pendiente: "Revisado / Pendiente",
    pendiente_admin: "Pendiente Admin",
    listo: "Listo (finalizado)",
  } as Record<string, string>)[e] ?? e;

export const rolTxt = (r: string) =>
  ({
    admin: "Administración",
    ama_llaves: "Ama de llaves",
    supervisora: "Supervisora",
    operaciones: "Operaciones",
    mucama: "Mucama",
  } as Record<string, string>)[r] ?? r;
