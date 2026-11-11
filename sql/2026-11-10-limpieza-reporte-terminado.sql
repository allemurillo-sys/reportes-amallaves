-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: botón "Reporte terminado" en el Reporte de Limpieza
--   · Operaciones indica que terminó de armar el reporte de un día (hoy o hasta 2 días antes)
--   · Se avisa (campana y celular) a quien tenga el permiso aviso_reporte_terminado
--     (por defecto: Ama de llaves, Supervisora y Mucamas)
--   · Si después hay cambios, se puede volver a avisar ("Avisar actualización")
--   · Queda en la bitácora; el aviso abre el reporte de ESE día (notificaciones.fecha_ref)
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================
insert into public.permisos_catalogo (clave, grupo, nombre, orden, fijo) values
  ('aviso_reporte_terminado', 'permiso', 'Limpieza: aviso cuando Operaciones termina el Reporte de Limpieza', 295, null)
on conflict (clave) do nothing;
insert into public.permisos_rol (rol, clave, permitido) values
  ('admin','aviso_reporte_terminado',false), ('ama_llaves','aviso_reporte_terminado',true), ('supervisora','aviso_reporte_terminado',true),
  ('operaciones','aviso_reporte_terminado',false), ('mucama','aviso_reporte_terminado',true)
on conflict (rol, clave) do nothing;

alter table public.ocupacion_dia add column if not exists terminado_por uuid references public.perfiles(id);
alter table public.ocupacion_dia add column if not exists terminado_en timestamptz;
alter table public.ocupacion_dia add column if not exists avisos_terminado integer not null default 0;
alter table public.notificaciones add column if not exists fecha_ref date;

alter table public.ocupacion_historial drop constraint if exists ocupacion_historial_tipo_check;
alter table public.ocupacion_historial add constraint ocupacion_historial_tipo_check
  check (tipo in ('tablero','limpieza','copia','creado','archivo','aviso','alerta','terminado'));

create or replace function public.ocupacion_terminar(p_fecha date)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare v_actor text; v_rol text; v_prev timestamptz; v_n int; v_fc text := to_char(p_fecha, 'DD/MM/YY'); v_act boolean;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para terminar el Reporte de Limpieza'; end if;
  if public.ocupacion_cerrada(p_fecha) then raise exception 'Este reporte ya está archivado (se cierra a las 8:15 p. m.)'; end if;
  perform public.ocupacion_revisar_antelacion(p_fecha);
  if not exists (select 1 from public.ocupacion where fecha = p_fecha and (estado is not null or entrada is not null)) then
    raise exception 'El reporte está vacío: llene al menos una propiedad antes de terminarlo';
  end if;
  perform public.ocupacion_marcar_creador(p_fecha);
  select terminado_en into v_prev from public.ocupacion_dia where fecha = p_fecha;
  v_act := v_prev is not null;
  update public.ocupacion_dia set terminado_por = auth.uid(), terminado_en = now(), avisos_terminado = avisos_terminado + 1 where fecha = p_fecha;

  select nombre, rol into v_actor, v_rol from public.perfiles where id = auth.uid();
  insert into public.notificaciones (usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo, fecha_ref)
  select p.id, null,
         case when v_act then '📋 Reporte de Limpieza actualizado' else '📋 Reporte de Limpieza listo' end,
         null,
         'El Reporte de Limpieza ' || v_fc || case when v_act then ' tiene cambios' else ' ya está listo para revisar' end
         || ' — ' || coalesce(v_actor, '—') || case v_rol when 'operaciones' then ' (Operaciones)' when 'admin' then ' (Administrador)' else '' end,
         'ocupacion', p_fecha
    from public.perfiles p
   where p.activo and p.id is distinct from auth.uid() and public.permiso_de(p.id, 'aviso_reporte_terminado');
  get diagnostics v_n = row_count;

  insert into public.ocupacion_historial (fecha, usuario_id, tipo, detalle)
  values (p_fecha, auth.uid(), 'terminado',
          case when v_act then 'Avisó actualización del reporte' else 'Marcó el reporte como terminado' end || ' (aviso a ' || v_n || ' persona(s))');
  return v_n;
end $f$;
revoke execute on function public.ocupacion_terminar(date) from anon;
