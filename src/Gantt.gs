/**
 * Gantt.gs — Carta Gantt por proyecto.
 *
 * Una actividad ("cajita") pertenece a una fila identificada por (grupo, fila).
 * El frontend la mueve o la extiende con el mouse y persiste solo fechas y
 * fila; la escala de tiempo (semana, mes, trimestre…) es puramente visual y
 * no se guarda.
 *
 * Permisos: leer requiere acceso al proyecto; escribir exige además gantt.write.
 * Las actividades se archivan (soft delete), igual que el resto de entidades.
 */

const GANTT_EDITABLE = ['grupo', 'fila', 'titulo', 'fechaInicio', 'fechaFin', 'orden'];
const GANTT_DEFAULT_GROUP = 'General';

function Gantt_decorate_(g) {
  return {
    ganttId: g.ganttId,
    projectId: g.projectId,
    grupo: g.grupo,
    fila: g.fila,
    titulo: g.titulo,
    fechaInicio: g.fechaInicio,
    fechaFin: g.fechaFin,
    orden: g.orden
  };
}

/** Actividades activas del proyecto, ordenadas por fila y luego por inicio. */
function Gantt_items_(projectId) {
  return tGantt_().all()
    .filter(g => g.activo && g.projectId === projectId)
    .sort((a, b) =>
      (a.orden - b.orden) ||
      String(a.fechaInicio).localeCompare(String(b.fechaInicio)) ||
      (a._row - b._row))
    .map(Gantt_decorate_);
}

function Gantt_list_(user, projectId) {
  const project = tProjects_().findOrFail(projectId, 'proyecto');
  requireProjectAccess_(user, project);
  return {
    project: {
      projectId: project.projectId,
      nombre: project.nombre,
      fechaInicio: project.fechaInicio,
      fechaFin: project.fechaFin
    },
    items: Gantt_items_(projectId)
  };
}

/** Campos de la actividad ya validados. Los parches parciales usan `current`. */
function Gantt_clean_(d, current) {
  const out = {};
  const has = k => d[k] !== undefined;

  if (!current || has('titulo')) out.titulo = requireText_(d.titulo, 'Título de la actividad', 200);
  if (!current || has('grupo')) {
    out.grupo = cleanText_(d.grupo, 80) || GANTT_DEFAULT_GROUP;
  }
  if (!current || has('fila')) {
    out.fila = cleanText_(d.fila, 120) || (out.titulo || (current && current.titulo));
  }
  if (!current || has('fechaInicio')) {
    out.fechaInicio = toDateIso_(d.fechaInicio);
    if (!out.fechaInicio) fail_(ERR.VALIDATION, 'La fecha de inicio es obligatoria.');
  }
  if (!current || has('fechaFin')) {
    out.fechaFin = toDateIso_(d.fechaFin);
    if (!out.fechaFin) fail_(ERR.VALIDATION, 'La fecha de término es obligatoria.');
  }
  checkDateRange_(
    out.fechaInicio !== undefined ? out.fechaInicio : current.fechaInicio,
    out.fechaFin !== undefined ? out.fechaFin : current.fechaFin,
    'Fecha de inicio', 'Fecha de término');
  return out;
}

/** Orden de la fila (grupo, fila) si ya existe; si no, una fila nueva al final. */
function Gantt_rowOrder_(projectId, grupo, fila, excludeId) {
  let max = 0;
  const rows = tGantt_().all().filter(g =>
    g.activo && g.projectId === projectId && g.ganttId !== excludeId);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].grupo === grupo && rows[i].fila === fila) return rows[i].orden;
    if (rows[i].orden > max) max = rows[i].orden;
  }
  return max + 1;
}

function Gantt_create_(user, data) {
  const d = data || {};
  const projectId = String(d.projectId || '').trim();
  if (!projectId) fail_(ERR.VALIDATION, 'Debes indicar el proyecto de la actividad.');
  const rec = Gantt_clean_(d, null);

  return withLock_(() => {
    tProjects_().reload();
    const project = tProjects_().findOrFail(projectId, 'proyecto');
    requireProjectAccess_(user, project);
    tGantt_().reload();

    const now = nowIso_();
    const created = tGantt_().insert(Object.assign({}, rec, {
      projectId: projectId,
      orden: Gantt_rowOrder_(projectId, rec.grupo, rec.fila, null),
      fechaCreacion: now,
      fechaActualizacion: now,
      activo: true
    }));
    audit_(user, ACTION.CREATE, ENTITY.GANTT, created.ganttId, null, {
      projectId: projectId, grupo: rec.grupo, fila: rec.fila, titulo: rec.titulo,
      fechaInicio: rec.fechaInicio, fechaFin: rec.fechaFin
    });
    return Gantt_list_(user, projectId);
  });
}

function Gantt_update_(user, ganttId, data) {
  const d = data || {};
  return withLock_(() => {
    const t = tGantt_().reload();
    const current = t.findOrFail(ganttId, 'actividad');
    if (!current.activo) fail_(ERR.NOT_FOUND, 'La actividad ya no existe.');
    tProjects_().reload();
    requireProjectAccess_(user, tProjects_().findOrFail(current.projectId, 'proyecto'));

    const patch = Gantt_clean_(d, current);
    const grupo = patch.grupo !== undefined ? patch.grupo : current.grupo;
    const fila = patch.fila !== undefined ? patch.fila : current.fila;
    if (grupo !== current.grupo || fila !== current.fila) {
      patch.orden = Gantt_rowOrder_(current.projectId, grupo, fila, ganttId);
    }
    patch.fechaActualizacion = nowIso_();

    const res = t.update(ganttId, patch);
    const delta = diff_(res.before, res.after, GANTT_EDITABLE);
    if (delta.changed.length) {
      audit_(user, ACTION.UPDATE, ENTITY.GANTT, ganttId, delta.before, delta.after);
    }
    return Gantt_list_(user, current.projectId);
  });
}

function Gantt_delete_(user, ganttId) {
  return withLock_(() => {
    const t = tGantt_().reload();
    const current = t.findOrFail(ganttId, 'actividad');
    tProjects_().reload();
    requireProjectAccess_(user, tProjects_().findOrFail(current.projectId, 'proyecto'));

    t.update(ganttId, { activo: false, fechaActualizacion: nowIso_() });
    audit_(user, ACTION.DELETE, ENTITY.GANTT, ganttId,
      { titulo: current.titulo, activo: true }, { activo: false });
    return Gantt_list_(user, current.projectId);
  });
}
