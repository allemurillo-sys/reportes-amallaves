-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: Operaciones puede crear el tablero de Ocupación con hasta 2 días de antelación
--   (hoy, mañana y pasado mañana). Aplica al guardar y al "Copiar del día anterior".
-- Nueva función ocupacion_revisar_antelacion(fecha); ocupacion_guardar y ocupacion_copiar
-- la llaman justo después de revisar si el tablero está cerrado (resto igual a
-- 2026-11-10-ocupacion-alertas-cierre.sql).
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================
create or replace function public.ocupacion_revisar_antelacion(p_fecha date)
returns void language plpgsql stable set search_path to 'public' as $f$
begin
  if p_fecha > public.ocupacion_hoy() + 2 then
    raise exception 'El tablero solo se puede crear con hasta 2 días de antelación (hasta el %)', to_char(public.ocupacion_hoy() + 2, 'DD/MM/YYYY');
  end if;
end $f$;
-- En ocupacion_guardar y ocupacion_copiar se agregó:
--   perform public.ocupacion_revisar_antelacion(p_fecha);   -- (p_hasta en copiar)
