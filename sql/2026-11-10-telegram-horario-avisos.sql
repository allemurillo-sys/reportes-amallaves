-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: horario de avisos de Telegram
--   · Ama de llaves, Supervisoras y Mucamas: 8:00 a. m. a 4:30 p. m.
--   · Operaciones y Administración:          8:00 a. m. a 9:00 p. m.
--   · Fuera de horario Telegram no envía nada; los avisos quedan en espera y salen al abrir
--     el horario (con el conteo de repetición/escalamiento reiniciado).
--   · Si un mensaje menciona a personas de los dos grupos, se usa el horario más corto.
--   · Editable en Mantenimiento › Telegram › Horario de avisos.
--   · La lógica está en la función supabase/functions/telegram-reloj (versión 2).
--   · No cambia: resúmenes del grupo, botones "Lo vi"/"Tomar caso", notificaciones de la app.
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================
alter table public.telegram_config add column if not exists horario_ama_inicio time not null default '08:00';
alter table public.telegram_config add column if not exists horario_ama_fin time not null default '16:30';
alter table public.telegram_config add column if not exists horario_resto_inicio time not null default '08:00';
alter table public.telegram_config add column if not exists horario_resto_fin time not null default '21:00';
alter table public.telegram_config drop constraint if exists telegram_horario_chk;
alter table public.telegram_config add constraint telegram_horario_chk
  check (horario_ama_inicio < horario_ama_fin and horario_resto_inicio < horario_resto_fin);
