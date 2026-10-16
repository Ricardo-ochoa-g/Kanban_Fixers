/**
 * Dashboard.gs — Resumen ejecutivo y exportación.
 *
 * Todo el resumen se calcula con una sola lectura de PROJECTS y otra de TASKS
 * (ambas memoizadas). No hay consultas por proyecto.
 */

function Dashboard_summary_(user) {
  const today = todayIso_();
  const dueSoon = cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS);

  const visibleProjects = filterVisibleProjects_(user, tProjects_().active());
  const stats = projectStats_();
  const decorated = visibleProjects.map(p => decorateProject_(p, stats[p.projectId]));
  const visibleIds = {};
  decorated.forEach(p => { visibleIds[p.projectId] = p; });

  const tasks = tTasks_().all().filter(t => t.activo && visibleIds[t.projectId]);

  const porEstado = {};
  STATUS_ORDER.forEach(s => { porEstado[s] = 0; });
  const porPrioridad = {};
  PRIORITY_ORDER.forEach(p => { porPrioridad[p] = 0; });

  let pendientes = 0, doing = 0, vencidas = 0, porVencer = 0, completadas = 0;
  let sumaAvance = 0, misTareas = 0, misVencidas = 0;

  tasks.forEach(t => {
    porEstado[t.estado] = (porEstado[t.estado] || 0) + 1;
    porPrioridad[t.prioridad] = (porPrioridad[t.prioridad] || 0) + 1;
    sumaAvance += Number(t.porcentajeAvance) || 0;

    const esDone = t.estado === STATUS.DONE;
    if (esDone) completadas++;
    else pendientes++;
    if (t.estado === STATUS.DOING) doing++;

    const vencida = !esDone && t.fechaVencimiento && t.fechaVencimiento < today;
    if (vencida) vencidas++;
    else if (!esDone && t.fechaVencimiento) {
      const d = daysUntil_(t.fechaVencimiento);
      if (d !== null && d <= dueSoon) porVencer++;
    }
    if (t.responsable === user.email) {
      misTareas++;
      if (vencida) misVencidas++;
    }
  });

  const avanceProyectos = decorated
    .slice()
    .sort((a, b) => b.totalTareas - a.totalTareas)
    .slice(0, 8)
    .map(p => ({
      projectId: p.projectId,
      nombre: p.nombre,
      avance: p.avanceCalculado,
      declarado: p.porcentajeAvance,
      total: p.totalTareas,
      enRiesgo: p.enRiesgo
    }));

  return {
    kpis: {
      proyectosActivos: decorated.length,
      proyectosEnRiesgo: decorated.filter(p => p.enRiesgo).length,
      tareasTotales: tasks.length,
      tareasPendientes: pendientes,
      tareasDoing: doing,
      tareasVencidas: vencidas,
      tareasPorVencer: porVencer,
      tareasCompletadas: completadas,
      avancePromedio: tasks.length ? Math.round(sumaAvance / tasks.length) : 0,
      misTareas: misTareas,
      misTareasVencidas: misVencidas
    },
    porEstado: STATUS_ORDER.map(s => ({ estado: s, label: STATUS_LABEL[s], valor: porEstado[s] || 0 })),
    porPrioridad: PRIORITY_ORDER.map(p => ({ prioridad: p, valor: porPrioridad[p] || 0 })),
    avanceProyectos: avanceProyectos,
    proyectosEnRiesgo: decorated.filter(p => p.enRiesgo).slice(0, 8).map(p => ({
      projectId: p.projectId, nombre: p.nombre, avance: p.avanceCalculado,
      vencidas: p.tareasVencidas, fechaFin: p.fechaFin
    }))
  };
}

/** Tareas del usuario, ordenadas por urgencia. Alimenta la vista "Mis tareas". */
function Dashboard_myTasks_(user, filters) {
  const f = Object.assign({}, filters || {}, { misTareas: true });
  const rows = Tasks_list_(user, f);
  const weight = { OVERDUE: 0, DUE_SOON: 1, NORMAL: 2, NONE: 3, DONE: 4 };
  rows.sort((a, b) => {
    const w = (weight[a.dueState] || 9) - (weight[b.dueState] || 9);
    if (w !== 0) return w;
    const pa = PRIORITY_ORDER.indexOf(b.prioridad) - PRIORITY_ORDER.indexOf(a.prioridad);
    if (pa !== 0) return pa;
    return String(a.fechaVencimiento || '9999').localeCompare(String(b.fechaVencimiento || '9999'));
  });
  return rows;
}

/* ──────────────────────────── Exportación CSV ──────────────────────────── */

const CSV_COLUMNS = [
  ['taskId', 'ID'],
  ['proyecto', 'Proyecto'],
  ['titulo', 'Título'],
  ['estado', 'Estado'],
  ['prioridad', 'Prioridad'],
  ['porcentajeAvance', '% Avance'],
  ['responsableNombre', 'Responsable'],
  ['responsable', 'Email responsable'],
  ['fechaInicio', 'Inicio'],
  ['fechaVencimiento', 'Vencimiento'],
  ['fechaCompletado', 'Completado'],
  ['subtareasCompletadas', 'Subtareas completadas'],
  ['subtareasTotal', 'Subtareas totales'],
  ['comentarios', 'Comentarios'],
  ['descripcion', 'Descripción']
];

/**
 * CSV de las tareas de un proyecto (o de todas las visibles si no se indica).
 * Se devuelve como texto: el frontend lo descarga con un Blob, sin pasar por Drive.
 */
function Export_tasksCsv_(user, projectId) {
  const rows = Tasks_list_(user, projectId ? { projectId: projectId } : {});
  const header = CSV_COLUMNS.map(c => csvCell_(c[1])).join(',');
  const body = rows.map(r => CSV_COLUMNS.map(c => csvCell_(r[c[0]])).join(',')).join('\r\n');
  const name = projectId
    ? 'tareas_' + String(projectId).replace(/[^A-Za-z0-9_-]/g, '') + '_' + todayIso_() + '.csv'
    : 'tareas_' + todayIso_() + '.csv';
  // BOM para que Excel en Windows reconozca UTF-8.
  return { filename: name, content: '﻿' + header + '\r\n' + body, rows: rows.length };
}

function csvCell_(value) {
  if (value === null || value === undefined) return '""';
  const s = String(value).replace(/"/g, '""').replace(/\r?\n/g, ' ');
  return '"' + s + '"';
}

/* ───────────────────── Parámetros de la aplicación ──────────────────── */

function AppConfig_list_() {
  return tConfig_().all().map(r => ({
    clave: r.clave, valor: r.valor, descripcion: r.descripcion
  })).sort((a, b) => a.clave.localeCompare(b.clave));
}

function AppConfig_update_(user, clave, valor) {
  const key = String(clave || '').trim();
  if (!key) fail_(ERR.VALIDATION, 'Debes indicar la clave del parámetro.');

  return withLock_(() => {
    const tc = tConfig_().reload();
    const current = tc.find(key);
    if (!current) fail_(ERR.NOT_FOUND, 'El parámetro ' + key + ' no existe.');

    const nuevo = cleanText_(valor, 500);
    validateConfigValue_(key, nuevo);

    tc.update(key, { valor: nuevo });
    audit_(user, ACTION.CONFIG, ENTITY.CONFIG, key,
      { valor: current.valor }, { valor: nuevo });
    _cfgMemo = null;
    return AppConfig_list_();
  });
}

function validateConfigValue_(key, valor) {
  switch (key) {
    case 'DUE_SOON_DAYS': {
      const n = Number(valor);
      if (!isFinite(n) || n < 0 || n > 60) {
        fail_(ERR.VALIDATION, 'DUE_SOON_DAYS debe ser un número entre 0 y 60.');
      }
      break;
    }
    case 'PROJECT_VISIBILITY':
      if (['ALL', 'INVOLVED'].indexOf(valor) === -1) {
        fail_(ERR.VALIDATION, 'PROJECT_VISIBILITY debe ser ALL o INVOLVED.');
      }
      break;
    case 'PROJECT_RISK_PCT': {
      const n = Number(valor);
      if (!isFinite(n) || n < 0 || n > 100) {
        fail_(ERR.VALIDATION, 'PROJECT_RISK_PCT debe ser un número entre 0 y 100.');
      }
      break;
    }
    case 'ALLOW_USER_CREATE_PROJECT':
      if (['true', 'false'].indexOf(String(valor).toLowerCase()) === -1) {
        fail_(ERR.VALIDATION, 'ALLOW_USER_CREATE_PROJECT debe ser true o false.');
      }
      break;
    default:
      break;
  }
}
