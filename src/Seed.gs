/**
 * Seed.gs — Cargas puntuales de datos para el Gantt.
 *
 * Se ejecutan DESDE EL EDITOR de Apps Script por el dueño del proyecto (igual
 * que Setup.gs). No forman parte de la API de la Web App.
 */

/** [grupo, fila, actividad, inicio, término] — plan de trabajo Nobarzo 2026-27. */
const SEED_NOBARZO_HITOS = [
  ['Gestión', 'Contrato', 'S0 · Firma de contrato y primera cuota', '2026-10-26', '2026-10-30'],
  ['Gestión', 'Kick-off', 'S1 · Kick-off (mar 3 nov)', '2026-11-02', '2026-11-06'],
  ['Gestión', 'Reuniones', 'S4 · Reunión de avance (jue 26 nov): demo de Finanzas y estado de Procesos y RRHH', '2026-11-23', '2026-11-27'],
  ['Gestión', 'Cierre', 'S13 · Reunión final de cierre (mar 26 ene), acta de aceptación, traspaso de documentación y decisión de continuidad', '2027-01-25', '2027-01-29'],

  ['Levantamiento y base', 'Levantamiento', 'S1-S2 · Levantamiento y alcance validado de los 3 módulos', '2026-11-02', '2026-11-13'],
  ['Levantamiento y base', 'Arquitectura', 'S2 · Base de datos y arquitectura lista (Supabase)', '2026-11-09', '2026-11-13'],
  ['Levantamiento y base', 'Accesos del cliente', 'S2 · Cliente entrega accesos (SII, bancos, API Key Buk)', '2026-11-09', '2026-11-13'],
  ['Levantamiento y base', 'Datos maestros', 'S3 · Carga de datos históricos y maestros (CeCo, proveedores, plan de cuentas)', '2026-11-16', '2026-11-20'],

  ['Finanzas', 'Desarrollo', 'S3-S4 · Primera versión funcional de Finanzas', '2026-11-16', '2026-11-27'],
  ['Finanzas', 'Integraciones', 'S4-S5 · Integraciones SII y bancos conectadas', '2026-11-23', '2026-12-04'],
  ['Finanzas', 'Entrega', 'S5 · Entrega Hito 1: módulo Finanzas (vie 4 dic)', '2026-11-30', '2026-12-04'],

  ['Procesos', 'Desarrollo', 'S6 · Desarrollo de Procesos (semana corta, feriado mar 8)', '2026-12-07', '2026-12-11'],
  ['Procesos', 'Entrega', 'S7 · Entrega Hito 2: módulo Procesos (vie 18 dic)', '2026-12-14', '2026-12-18'],

  ['Pausa', 'Fiestas', 'S8-S9 · Baja actividad por fiestas (feriados vie 25 dic y vie 1 ene)', '2026-12-21', '2027-01-01'],

  ['RRHH y BI', 'Business Intelligence', 'S10 · Ventana de Business Intelligence (valor agregado)', '2027-01-04', '2027-01-08'],
  ['RRHH y BI', 'Entrega', 'S11 · Entrega Hito 3: módulo RRHH (vie 15 ene)', '2027-01-11', '2027-01-15'],

  ['Puesta en marcha', 'UAT', 'S11-S12 · Pruebas con usuarios (UAT) y correcciones', '2027-01-11', '2027-01-22'],
  ['Puesta en marcha', 'Capacitación', 'S12 · Capacitación a usuarios', '2027-01-18', '2027-01-22'],
  ['Puesta en marcha', 'Producción', 'S12 · Puesta en producción (vie 22 ene)', '2027-01-22', '2027-01-22']
];

/**
 * Carga los hitos del proyecto Nobarzo en su carta Gantt. Es idempotente: una
 * actividad con el mismo título y fecha de inicio no se vuelve a crear.
 *
 * @param {string=} projectId Solo si hay varios proyectos que coinciden con el nombre.
 */
function seedNobarzoGantt(projectId) {
  const projects = tProjects_().active();
  let project = null;
  if (projectId) {
    project = projects.filter(p => p.projectId === projectId)[0] || null;
  } else {
    const matches = projects.filter(p => /no[bv]arzo/i.test(p.nombre));
    if (matches.length > 1) {
      throw new Error('Hay varios proyectos que coinciden: ' +
        matches.map(p => p.nombre + ' (' + p.projectId + ')').join(', ') +
        '. Ejecuta seedNobarzoGantt("<projectId>").');
    }
    project = matches[0] || null;
  }
  if (!project) {
    throw new Error('No se encontró el proyecto Nobarzo. Proyectos activos: ' +
      projects.map(p => p.nombre).join(', '));
  }

  return withLock_(() => {
    const t = tGantt_().reload();
    const existing = t.all().filter(g => g.activo && g.projectId === project.projectId);

    const rowOrder = {};
    let maxOrder = 0;
    existing.forEach(g => {
      rowOrder[g.grupo + '\u0001' + g.fila] = g.orden;
      if (g.orden > maxOrder) maxOrder = g.orden;
    });
    const have = {};
    existing.forEach(g => { have[g.titulo + '|' + g.fechaInicio] = true; });

    const now = nowIso_();
    const toAdd = [];
    SEED_NOBARZO_HITOS.forEach(h => {
      if (have[h[2] + '|' + h[3]]) return;
      const key = h[0] + '\u0001' + h[1];
      if (rowOrder[key] === undefined) rowOrder[key] = ++maxOrder;
      toAdd.push({
        projectId: project.projectId, grupo: h[0], fila: h[1], titulo: h[2],
        fechaInicio: h[3], fechaFin: h[4], orden: rowOrder[key],
        fechaCreacion: now, fechaActualizacion: now, activo: true
      });
    });

    if (toAdd.length) {
      t.insertMany(toAdd);
      audit_({ userId: '', email: Session.getActiveUser().getEmail() || 'seed' },
        ACTION.CREATE, ENTITY.GANTT, project.projectId, null,
        { seed: 'nobarzo', actividades: toAdd.length });
    }
    const msg = 'Proyecto "' + project.nombre + '": ' + toAdd.length + ' actividades agregadas, ' +
      (SEED_NOBARZO_HITOS.length - toAdd.length) + ' ya existían.';
    Logger.log(msg);
    return msg;
  });
}
