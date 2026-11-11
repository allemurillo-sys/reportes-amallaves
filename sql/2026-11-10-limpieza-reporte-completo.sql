-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: el estado de limpieza solo se puede marcar cuando TODAS las propiedades del
--   Reporte de Limpieza (activas y visibles en el reporte) tienen "Amanece" y "Queda" llenos.
--   "Reporte terminado" también exige el reporte completo.
--   (Se suma al horario: día del reporte, de 8:00 a. m. al cierre de las 8:15 p. m.)
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================
create or replace function public.ocupacion_incompletas(p_fecha date)
returns integer language sql stable security definer set search_path to 'public' as $f$
  select count(*)::int from public.propiedades p
    left join public.ocupacion o on o.propiedad_id = p.id and o.fecha = p_fecha
   where p.activa and p.en_ocupacion and (o.estado is null or o.entrada is null)
$f$;

-- En ocupacion_limpieza (después de revisar el horario) y en ocupacion_terminar (después de revisar que no esté vacío):
--   if public.ocupacion_incompletas(p_fecha) > 0 then raise exception ...; end if;

-- Aplicado con un parche sobre las funciones existentes (mismo texto agregado):
--   ocupacion_limpieza, después del control de horario:
--     if public.ocupacion_incompletas(p_fecha) > 0 then
--       raise exception 'Todavía no se puede marcar la limpieza: Operaciones debe completar "Amanece" y "Queda" en todas las propiedades (faltan %)', public.ocupacion_incompletas(p_fecha);
--     end if;
--   ocupacion_terminar, después del control de reporte vacío:
--     if public.ocupacion_incompletas(p_fecha) > 0 then
--       raise exception 'Falta completar "Amanece" y "Queda" en % propiedad(es) antes de terminar el reporte', public.ocupacion_incompletas(p_fecha);
--     end if;
