-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: el estado de limpieza (Lista / Sucia / Pendiente / Bloqueada) solo se puede
--   marcar en la fecha del reporte, desde las 8:00 a. m. hasta el cierre (8:15 p. m.).
--   Sin excepciones (antes Administrador podía marcar cualquier día).
--   Resto de ocupacion_limpieza igual a 2026-11-10-ocupacion-alertas-cierre.sql.
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================
create or replace function public.ocupacion_limpieza(p_fecha date, p_propiedad bigint, p_estado text, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_new public.ocupacion; v_prop text; v_actor text; v_n int;
begin
  if not public.tengo('ocupacion_limpieza') then raise exception 'No tiene permiso para marcar el estado de limpieza'; end if;
  if public.ocupacion_cerrada(p_fecha) then raise exception 'Este reporte ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  if p_fecha <> public.ocupacion_hoy() or (now() at time zone 'America/Costa_Rica')::time < time '08:00' then
    raise exception 'El estado de limpieza solo se puede marcar el día del reporte, de 8:00 a. m. a 8:15 p. m.';
  end if;
  select nombre into v_prop from public.propiedades where id = p_propiedad;
  if v_prop is null then raise exception 'La propiedad no existe'; end if;
  p_nota := nullif(trim(coalesce(p_nota, '')), '');
  select * into v_old from public.ocupacion where fecha = p_fecha and propiedad_id = p_propiedad;
  if v_old.limpieza is not distinct from p_estado and v_old.limpieza_nota is not distinct from p_nota then return; end if;

  insert into public.ocupacion as o (fecha, propiedad_id, limpieza, limpieza_nota, limpieza_por, limpieza_en)
  values (p_fecha, p_propiedad, p_estado, p_nota, auth.uid(), now())
  on conflict (fecha, propiedad_id) do update set limpieza = excluded.limpieza, limpieza_nota = excluded.limpieza_nota,
    limpieza_por = excluded.limpieza_por, limpieza_en = excluded.limpieza_en
  returning * into v_new;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'limpieza',
          'Limpieza: ' || coalesce(initcap(v_old.limpieza), 'Sin marcar') || ' → ' || coalesce(initcap(p_estado), 'Sin marcar')
          || coalesce(' · ' || p_nota, ''));

  if p_estado = 'lista' and v_old.limpieza is distinct from 'lista' and v_new.entrada = 'ENTRA'
     and p_fecha = public.ocupacion_hoy() then
    select nombre into v_actor from public.perfiles where id = auth.uid();
    insert into public.notificaciones (usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo, fecha_ref)
    select p.id, null, '✅ Lista para el ingreso', v_prop,
           v_prop || ' ya está lista para el ingreso de hoy (3:00 p. m.) — marcada por ' || coalesce(v_actor, '—')
           || ' a las ' || to_char(now() at time zone 'America/Costa_Rica', 'FMHH12:MI')
           || case when extract(hour from now() at time zone 'America/Costa_Rica') < 12 then ' a. m.' else ' p. m.' end,
           'ocupacion', p_fecha
      from public.perfiles p
     where p.activo and p.id is distinct from auth.uid() and public.permiso_de(p.id, 'aviso_ingreso_lista');
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, tipo, detalle)
      values (p_fecha, p_propiedad, v_prop, 'aviso', 'Aviso a recepción: lista para el ingreso (' || v_n || ' persona(s))');
    end if;
  end if;
end $f$;
