/**
 * Projects.gs — CRUD de proyectos y métricas derivadas.
 *
 * `porcentajeAvance` es el valor declarado por el responsable. Además se
 * devuelve `avanceCalculado`, derivado del promedio de avance de las tareas
 * activas. Se eligió no propagar el avance de cada tarea a la hoja PROJECTS
 * para evitar una escritura extra (y su invalidación de caché) en cada edición
 * de tarea: el cálculo en lectura es gratis porque TASKS ya está en memoria.
 */

const PROJECT_EDITABLE = [
  'nombre', 'descripcion', 'responsable', 'fechaInicio', 'fechaFin',
  'estado', 'porcentajeAvance', 'prioridad'
];

/* ──────────────────────────────── Lectura ──────────────────────────────── */

function Projects_list_(user, opts) {
  const o = opts || {};
  const includeInactive = isAdmin_(user) && toBool_(o.includeInactive);

  let projects = includeInactive ? tProjects_().all() : tProjects_().active();
  projects = filterVisibleProjects_(user, projects);

  const stats = projectStats_();
  const texto = String(o.texto || '').trim().toLowerCase();

  let out = projects.map(p => decorateProject_(p, stats[p.projectId]));

  if (texto) {
    out = out.filter(p =>
      (p.nombre + ' ' + p.descripcion + ' ' + p.responsable).toLowerCase().indexOf(texto) !== -1);
  }
  if (o.estado) out = out.filter(p => p.estado === o.estado);
  if (o.prioridad) out = out.filter(p => p.prioridad === o.prioridad);

  out.sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(b.prioridad) - PRIORITY_ORDER.indexOf(a.prioridad);
    if (pa !== 0) return pa;
    return String(a.nombre).localeCompare(String(b.nombre));
  });
  return out;
}

function Projects_get_(user, projectId) {
  const p = tProjects_().findOrFail(projectId, 'proyecto');
  requireProjectAccess_(user, p);
  return decorateProject_(p, projectStats_()[projectId]);
}

/** Métricas por proyecto calculadas en una sola pasada sobre TASKS. */
function projectStats_() {
  const dueSoon = cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS);
  const today = todayIso_();
  const acc = {};

  tTasks_().all().forEach(t => {
    if (!t.activo) return;
    const s = acc[t.projectId] || (acc[t.projectId] = {
      total: 0, completadas: 0, pendientes: 0, vencidas: 0, porVencer: 0,
      sumaAvance: 0, porEstado: {}
    });
    s.total++;
    s.sumaAvance += Number(t.porcentajeAvance) || 0;
    s.porEstado[t.estado] = (s.porEstado[t.estado] || 0) + 1;
    if (t.estado === STATUS.DONE) {
      s.completadas++;
    } else {
      s.pendientes++;
      if (t.fechaVencimiento) {
        if (t.fechaVencimiento < today) s.vencidas++;
        else {
          const d = daysUntil_(t.fechaVencimiento);
          if (d !== null && d <= dueSoon) s.porVencer++;
        }
      }
    }
  });
  return acc;
}

function decorateProject_(p, s) {
  const st = s || { total: 0, completadas: 0, pendientes: 0, vencidas: 0, porVencer: 0, sumaAvance: 0, porEstado: {} };
  const riskPct = cfgNumber_('PROJECT_RISK_PCT', 40);
  const avanceCalculado = st.total ? Math.round(st.sumaAvance / st.total) : 0;

  return {
    projectId: p.projectId,
    nombre: p.nombre,
    descripcion: p.descripcion,
    responsable: p.responsable,
    fechaInicio: p.fechaInicio,
    fechaFin: p.fechaFin,
    estado: p.estado,
    prioridad: p.prioridad,
    porcentajeAvance: p.porcentajeAvance,
    avanceCalculado: avanceCalculado,
    activo: p.activo,
    fechaCreacion: p.fechaCreacion,
    creadoPor: p.creadoPor,
    fechaActualizacion: p.fechaActualizacion,
    actualizadoPor: p.actualizadoPor,
    totalTareas: st.total,
    tareasCompletadas: st.completadas,
    tareasPendientes: st.pendientes,
    tareasVencidas: st.vencidas,
    tareasPorVencer: st.porVencer,
    porEstado: st.porEstado,
    enRiesgo: projectAtRisk_(p, st, avanceCalculado, riskPct)
  };
}

/**
 * Un proyecto está en riesgo si:
 *   · tiene tareas vencidas, o
 *   · su plazo venció y no está en DONE, o
 *   · ya transcurrió el 70 % del plazo y el avance está bajo el umbral.
 */
function projectAtRisk_(p, st, avance, riskPct) {
  if (p.estado === STATUS.DONE || !p.activo) return false;
  if (st.vencidas > 0) return true;

  const today = todayIso_();
  if (p.fechaFin && p.fechaFin < today) return true;

  if (p.fechaInicio && p.fechaFin && p.fechaFin > p.fechaInicio) {
    const ini = new Date(p.fechaInicio + 'T00:00:00Z').getTime();
    const fin = new Date(p.fechaFin + 'T00:00:00Z').getTime();
    const hoy = new Date(today + 'T00:00:00Z').getTime();
    const transcurrido = (hoy - ini) / (fin - ini);
    if (transcurrido >= 0.7 && Math.max(avance, p.porcentajeAvance) < riskPct) return true;
  }
  return false;
}

/* ─────────────────────────────── Escritura ─────────────────────────────── */

function Projects_create_(user, data) {
  if (!canCreateProject_(user)) {
    fail_(ERR.FORBIDDEN, 'No tienes permisos para crear proyectos.');
  }
  const d = data || {};
  const rec = {
    nombre: requireText_(d.nombre, 'Nombre del proyecto', 200),
    descripcion: cleanText_(d.descripcion, 5000),
    responsable: assignableEmail_(d.responsable, user),
    fechaInicio: toDateIso_(d.fechaInicio),
    fechaFin: toDateIso_(d.fechaFin),
    estado: optionalOneOf_(d.estado, STATUS_ORDER, STATUS.BACKLOG),
    porcentajeAvance: toPct_(d.porcentajeAvance, 0),
    prioridad: optionalOneOf_(d.prioridad, PRIORITY_ORDER, PRIORITY.MEDIA),
    activo: true
  };
  checkDateRange_(rec.fechaInicio, rec.fechaFin, 'Fecha de inicio', 'Fecha objetivo');

  return withLock_(() => {
    const t = tProjects_().reload();
    const now = nowIso_();
    const created = t.insert(Object.assign({}, rec, {
      fechaCreacion: now, creadoPor: user.email,
      fechaActualizacion: now, actualizadoPor: user.email
    }));
    audit_(user, ACTION.CREATE, ENTITY.PROJECT, created.projectId, null, {
      nombre: rec.nombre, estado: rec.estado, prioridad: rec.prioridad, responsable: rec.responsable
    });
    return decorateProject_(created, projectStats_()[created.projectId]);
  });
}

function Projects_update_(user, projectId, data) {
  const d = data || {};
  return withLock_(() => {
    const t = tProjects_().reload();
    const current = t.findOrFail(projectId, 'proyecto');
    if (!isAdmin_(user) && current.responsable !== user.email) {
      fail_(ERR.FORBIDDEN, 'Solo el responsable del proyecto o un administrador pueden editarlo.');
    }

    const patch = {};
    if (d.nombre !== undefined) patch.nombre = requireText_(d.nombre, 'Nombre del proyecto', 200);
    if (d.descripcion !== undefined) patch.descripcion = cleanText_(d.descripcion, 5000);
    if (d.responsable !== undefined) patch.responsable = assignableEmail_(d.responsable, user);
    if (d.fechaInicio !== undefined) patch.fechaInicio = toDateIso_(d.fechaInicio);
    if (d.fechaFin !== undefined) patch.fechaFin = toDateIso_(d.fechaFin);
    if (d.estado !== undefined) patch.estado = requireOneOf_(d.estado, STATUS_ORDER, 'Estado');
    if (d.prioridad !== undefined) patch.prioridad = requireOneOf_(d.prioridad, PRIORITY_ORDER, 'Prioridad');
    if (d.porcentajeAvance !== undefined) patch.porcentajeAvance = toPct_(d.porcentajeAvance, current.porcentajeAvance);

    checkDateRange_(
      patch.fechaInicio !== undefined ? patch.fechaInicio : current.fechaInicio,
      patch.fechaFin !== undefined ? patch.fechaFin : current.fechaFin,
      'Fecha de inicio', 'Fecha objetivo');

    if (patch.estado === STATUS.DONE && patch.porcentajeAvance === undefined) {
      patch.porcentajeAvance = 100;
    }

    patch.fechaActualizacion = nowIso_();
    patch.actualizadoPor = user.email;

    const res = t.update(projectId, patch);
    const delta = diff_(res.before, res.after, PROJECT_EDITABLE);
    if (delta.changed.length) {
      audit_(user, ACTION.UPDATE, ENTITY.PROJECT, projectId, delta.before, delta.after);
    }
    return decorateProject_(res.after, projectStats_()[projectId]);
  });
}

/** Archivar = soft delete. Las tareas quedan intactas y dejan de listarse. */
function Projects_setActive_(user, projectId, activo) {
  return withLock_(() => {
    const t = tProjects_().reload();
    const current = t.findOrFail(projectId, 'proyecto');
    const next = toBool_(activo);
    if (current.activo === next) return decorateProject_(current, projectStats_()[projectId]);

    const res = t.update(projectId, {
      activo: next, fechaActualizacion: nowIso_(), actualizadoPor: user.email
    });
    audit_(user, next ? ACTION.RESTORE : ACTION.DELETE, ENTITY.PROJECT, projectId,
      { activo: current.activo }, { activo: next });
    return decorateProject_(res.after, projectStats_()[projectId]);
  });
}

/**
 * Valida que el responsable sea un usuario activo de la aplicación.
 * Cadena vacía = sin asignar. Evita responsables inventados desde el frontend.
 */
function assignableEmail_(value, actor) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const email = cleanEmail_(value);
  if (!email) fail_(ERR.VALIDATION, 'El responsable debe ser un correo válido.');
  if (actor && email === actor.email) return email;
  const u = tUsers_().findBy(x => x.email === email && x.activo === true);
  if (!u) fail_(ERR.VALIDATION, 'El responsable debe ser un usuario activo de la aplicación.');
  return email;
}
