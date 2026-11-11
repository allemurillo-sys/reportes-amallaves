-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: la sección "Ocupación" pasa a llamarse "Limpieza" (Reporte de Limpieza).
-- Solo se renombran los textos de los permisos que se ven en Mantenimiento › Autorizaciones.
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
update public.permisos_catalogo set nombre = replace(nombre, 'Ocupación:', 'Limpieza:') where clave in ('ocupacion_ver','ocupacion_editar','ocupacion_limpieza','aviso_ingreso_lista','alerta_ingresos');
update public.permisos_catalogo set nombre = 'Limpieza: ver el Reporte de Limpieza del día' where clave = 'ocupacion_ver';
update public.permisos_catalogo set nombre = 'Limpieza: crear y llenar el reporte (estado, entrada, noches y pax)' where clave = 'ocupacion_editar';
