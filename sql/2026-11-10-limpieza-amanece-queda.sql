-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: Reporte de Limpieza — columnas "Amanece" y "Queda" (antes Estado / Entrada)
--   · Amanece (cómo inicia la propiedad): LIBRE, SALE, OCUPADA, SUCIA, REVISAR
--   · Queda   (cómo estará):              LIBRE, ENTRA, BLOQUEADA, OCUPADA (huésped sigue)
--   · Se elimina "-" (vacío = Operaciones aún no lo indica)
--   · Combinaciones sin sentido bloqueadas: Ocupada solo puede quedar Ocupada, y viceversa
--   · "Copiar del día anterior" ahora arma el día: lo que ayer "Queda" es lo que hoy "Amanece"
--       ENTRA/OCUPADA → amanece OCUPADA y queda OCUPADA (Operaciones cambia a SALE el día de salida)
--       LIBRE → amanece LIBRE · BLOQUEADA → amanece LIBRE y queda BLOQUEADA
-- Columnas en la base de datos: estado = Amanece, entrada = Queda (mismos nombres internos).
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================

alter table public.ocupacion drop constraint if exists ocupacion_estado_check;
alter table public.ocupacion drop constraint if exists ocupacion_entrada_check;
alter table public.ocupacion alter column estado drop not null, alter column estado drop default;
alter table public.ocupacion alter column entrada drop not null, alter column entrada drop default;
update public.ocupacion set estado = null where estado = '-';
update public.ocupacion set entrada = null where entrada = '-';
update public.ocupacion set entrada = 'OCUPADA' where estado = 'OCUPADA' and entrada is null;
alter table public.ocupacion add constraint ocupacion_estado_check
  check (estado is null or estado in ('LIBRE','SALE','OCUPADA','SUCIA','REVISAR'));
alter table public.ocupacion add constraint ocupacion_entrada_check
  check (entrada is null or entrada in ('LIBRE','ENTRA','BLOQUEADA','OCUPADA'));
alter table public.ocupacion drop constraint if exists ocupacion_combinacion_check;
alter table public.ocupacion add constraint ocupacion_combinacion_check
  check ((estado = 'OCUPADA') = (entrada = 'OCUPADA') or estado is null or entrada is null);

create or replace function public.ocupacion_guardar(p_fecha date, p_propiedad bigint, p_estado text, p_entrada text,
                                                    p_noches integer, p_pax integer, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_det text[] := '{}'; v_prop text;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el Reporte de Limpieza'; end if;
  if public.ocupacion_cerrada(p_fecha) then raise exception 'Este reporte ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  perform public.ocupacion_revisar_antelacion(p_fecha);
  p_estado := nullif(nullif(trim(coalesce(p_estado, '')), ''), '-');
  p_entrada := nullif(nullif(trim(coalesce(p_entrada, '')), ''), '-');
  if p_estado = 'OCUPADA' and p_entrada is distinct from 'OCUPADA' and p_entrada is not null then
    raise exception 'Si la propiedad amanece Ocupada, solo puede quedar Ocupada (el huésped sigue)';
  end if;
  if p_entrada = 'OCUPADA' and p_estado is distinct from 'OCUPADA' and p_estado is not null then
    raise exception '"Queda ocupada" solo aplica cuando la propiedad amanece Ocupada';
  end if;
  select nombre into v_prop from public.propiedades where id = p_propiedad;
  if v_prop is null then raise exception 'La propiedad no existe'; end if;
  p_nota := nullif(trim(coalesce(p_nota, '')), '');
  select * into v_old from public.ocupacion where fecha = p_fecha and propiedad_id = p_propiedad;

  if v_old.estado is distinct from p_estado then v_det := v_det || ('Amanece: ' || coalesce(initcap(v_old.estado), '—') || ' → ' || coalesce(initcap(p_estado), '—')); end if;
  if v_old.entrada is distinct from p_entrada then v_det := v_det || ('Queda: ' || coalesce(initcap(v_old.entrada), '—') || ' → ' || coalesce(initcap(p_entrada), '—')); end if;
  if v_old.noches is distinct from p_noches then v_det := v_det || ('Noches: ' || coalesce(v_old.noches::text, '—') || ' → ' || coalesce(p_noches::text, '—')); end if;
  if v_old.pax is distinct from p_pax then v_det := v_det || ('Pax: ' || coalesce(v_old.pax::text, '—') || ' → ' || coalesce(p_pax::text, '—')); end if;
  if v_old.nota is distinct from p_nota then v_det := v_det || ('Nota: ' || coalesce(p_nota, '(borrada)')); end if;
  if array_length(v_det, 1) is null then return; end if;

  perform public.ocupacion_marcar_creador(p_fecha);
  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, nota, actualizado_por, actualizado_en)
  values (p_fecha, p_propiedad, p_estado, p_entrada, p_noches, p_pax, p_nota, auth.uid(), now())
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, nota = excluded.nota, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'tablero', array_to_string(v_det, ' · '));
end $f$;

-- Armar el día desde el anterior: lo que ayer "Queda" es lo que hoy "Amanece"
create or replace function public.ocupacion_copiar(p_desde date, p_hasta date)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare n integer;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el Reporte de Limpieza'; end if;
  if public.ocupacion_cerrada(p_hasta) then raise exception 'Este reporte ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  perform public.ocupacion_revisar_antelacion(p_hasta);
  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, actualizado_por, actualizado_en)
  select p_hasta, a.propiedad_id,
         case a.entrada when 'ENTRA' then 'OCUPADA' when 'OCUPADA' then 'OCUPADA' else 'LIBRE' end,
         case a.entrada when 'ENTRA' then 'OCUPADA' when 'OCUPADA' then 'OCUPADA' when 'BLOQUEADA' then 'BLOQUEADA' else null end,
         case when a.entrada in ('ENTRA','OCUPADA') then a.noches end,
         case when a.entrada in ('ENTRA','OCUPADA') then a.pax end,
         auth.uid(), now()
    from public.ocupacion a
   where a.fecha = p_desde and a.entrada is not null
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;
  get diagnostics n = row_count;
  if n > 0 then perform public.ocupacion_marcar_creador(p_hasta); end if;
  insert into public.ocupacion_historial (fecha, usuario_id, tipo, detalle)
  values (p_hasta, auth.uid(), 'copia', 'Día armado desde el ' || to_char(p_desde, 'DD/MM/YYYY') || ': lo que ese día "Queda" pasó a "Amanece" (' || n || ' propiedades)');
  return n;
end $f$;
