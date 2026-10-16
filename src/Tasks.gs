/**
 * Tasks.gs — CRUD de tareas, tablero Kanban y reordenamiento.
 *
 * `ordenKanban` usa huecos (múltiplos de APP.ORDER_GAP) e inserción por punto
 * medio. Un arrastre normal cuesta una sola escritura de una fila; la columna
 * completa se renormaliza únicamente cuando el hueco entre vecinos se agota.
 */

const TASK_EDITABLE = [
  'titulo', 'descripcion', 'estado', 'prioridad', 'porcentajeAvance',
  'avanceManual', 'responsable', 'fechaInicio', 'fechaVencimiento'
];

/* ──────────────────────────────── Lectura ──────────────────────────────── */

/**
 * Tareas con campos derivados. `filters` admite:
 * projectId, estado, prioridad, responsable, texto, soloVencidas,
 * misTareas, desde, hasta, includeInactive.
 */
function Tasks_list_(user, filters) {
  const f = filters || {};
  const dueSoon = cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS);
  const today = todayIso_();

  // Proyectos visibles: también actúa como filtro de autorización.
  // Cuando se pide un proyecto concreto se incluyen los archivados, para poder
  // consultarlos; en el listado general solo aparecen los activos.
  const pool = f.projectId ? tProjects_().all() : tProjects_().active();
  const visible = {};
  filterVisibleProjects_(user, pool).forEach(p => { visible[p.projectId] = p; });

  if (f.projectId && !visible[f.projectId]) {
    if (!tProjects_().find(f.projectId)) fail_(ERR.NOT_FOUND, 'El proyecto indicado no existe.');
    fail_(ERR.FORBIDDEN, 'No tienes acceso a este proyecto.');
  }

  const subCounts = subtaskCounts_();
  const cmtCounts = commentCounts_();
  const names = userNamesByEmail_();
  const texto = String(f.texto || '').trim().toLowerCase();
  const desde = toDateIso_(f.desde);
  const hasta = toDateIso_(f.hasta);

  let rows = tTasks_().all().filter(t => {
    if (!t.activo && !(isAdmin_(user) && toBool_(f.includeInactive))) return false;
    if (!visible[t.projectId]) return false;
    if (f.projectId && t.projectId !== f.projectId) return false;
    if (f.estado && t.estado !== f.estado) return false;
    if (f.prioridad && t.prioridad !== f.prioridad) return false;
    if (f.responsable && t.responsable !== String(f.responsable).toLowerCase()) return false;
    if (toBool_(f.misTareas) && t.responsable !== user.email) return false;
    if (toBool_(f.soloVencidas)) {
      if (t.estado === STATUS.DONE) return false;
      if (!t.fechaVencimiento || t.fechaVencimiento >= today) return false;
    }
    if (desde && t.fechaVencimiento && t.fechaVencimiento < desde) return false;
    if (hasta && t.fechaVencimiento && t.fechaVencimiento > hasta) return false;
    if (texto) {
      const hay = (t.titulo + ' ' + t.descripcion + ' ' + t.responsable + ' ' + t.taskId).toLowerCase();
      if (hay.indexOf(texto) === -1) return false;
    }
    return true;
  });

  rows = rows.map(t => decorateTask_(t, {
    dueSoon: dueSoon, today: today, subCounts: subCounts, cmtCounts: cmtCounts,
    names: names, project: visible[t.projectId]
  }));

  rows.sort((a, b) => (a.ordenKanban || 0) - (b.ordenKanban || 0));
  return rows;
}

/** Tablero completo de un proyecto, ya agrupado por columna. */
function Tasks_board_(user, projectId, filters) {
  const project = tProjects_().findOrFail(projectId, 'proyecto');
  requireProjectAccess_(user, project);

  const tasks = Tasks_list_(user, Object.assign({}, filters || {}, { projectId: projectId }));
  const columns = STATUS_ORDER.map(st => ({
    estado: st,
    label: STATUS_LABEL[st],
    tasks: tasks.filter(t => t.estado === st)
  }));
  return {
    project: decorateProject_(project, projectStats_()[projectId]),
    columns: columns,
    total: tasks.length
  };
}

/** Detalle completo: tarea + subtareas + comentarios + historial. */
function Tasks_get_(user, taskId) {
  const t = tTasks_().findOrFail(taskId, 'tarea');
  const project = tProjects_().findOrFail(t.projectId, 'proyecto');
  requireProjectAccess_(user, project);

  const names = userNamesByEmail_();
  const task = decorateTask_(t, {
    dueSoon: cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS),
    today: todayIso_(),
    subCounts: subtaskCounts_(),
    cmtCounts: commentCounts_(),
    names: names,
    project: project
  });

  return {
    task: task,
    subtasks: Subtasks_list_(taskId, names),
    comments: Comments_list_(taskId, names),
    history: hasPermission_(user, 'audit.read.entity') || hasPermission_(user, 'audit.read.global')
      ? auditForEntity_(ENTITY.TASK, taskId, 60)
      : []
  };
}

function decorateTask_(t, ctx) {
  const sc = ctx.subCounts[t.taskId] || { total: 0, completadas: 0 };
  return {
    taskId: t.taskId,
    projectId: t.projectId,
    proyecto: ctx.project ? ctx.project.nombre : '',
    titulo: t.titulo,
    descripcion: t.descripcion,
    estado: t.estado,
    prioridad: t.prioridad,
    porcentajeAvance: t.porcentajeAvance,
    avanceManual: t.avanceManual,
    responsable: t.responsable,
    responsableNombre: t.responsable ? (ctx.names[t.responsable] || t.responsable) : '',
    fechaInicio: t.fechaInicio,
    fechaVencimiento: t.fechaVencimiento,
    fechaCompletado: t.fechaCompletado,
    creadoPor: t.creadoPor,
    fechaCreacion: t.fechaCreacion,
    actualizadoPor: t.actualizadoPor,
    fechaActualizacion: t.fechaActualizacion,
    ordenKanban: t.ordenKanban,
    activo: t.activo,
    subtareasTotal: sc.total,
    subtareasCompletadas: sc.completadas,
    comentarios: ctx.cmtCounts[t.taskId] || 0,
    dueState: dueState_(t, ctx.dueSoon, ctx.today),
    diasRestantes: t.fechaVencimiento ? daysUntil_(t.fechaVencimiento) : null
  };
}

/** NONE | NORMAL | DUE_SOON | OVERDUE | DONE */
function dueState_(t, dueSoonDays, today) {
  if (t.estado === STATUS.DONE) return 'DONE';
  if (!t.fechaVencimiento) return 'NONE';
  if (t.fechaVencimiento < today) return 'OVERDUE';
  const d = daysUntil_(t.fechaVencimiento);
  return (d !== null && d <= dueSoonDays) ? 'DUE_SOON' : 'NORMAL';
}

function subtaskCounts_() {
  const out = {};
  tSubtasks_().all().forEach(s => {
    if (!s.activo) return;
    const c = out[s.taskId] || (out[s.taskId] = { total: 0, completadas: 0 });
    c.total++;
    if (s.completada) c.completadas++;
  });
  return out;
}

function commentCounts_() {
  const out = {};
  tComments_().all().forEach(c => {
    if (!c.activo) return;
    out[c.taskId] = (out[c.taskId] || 0) + 1;
  });
  return out;
}

/* ─────────────────────────────── Escritura ─────────────────────────────── */

function Tasks_create_(user, data) {
  const d = data || {};
  const projectId = String(d.projectId || '').trim();
  if (!projectId) fail_(ERR.VALIDATION, 'Debes indicar el proyecto de la tarea.');

  const titulo = requireText_(d.titulo, 'Título', 300);
  const estado = optionalOneOf_(d.estado, STATUS_ORDER, STATUS.BACKLOG);
  const prioridad = optionalOneOf_(d.prioridad, PRIORITY_ORDER, PRIORITY.MEDIA);
  const fechaInicio = toDateIso_(d.fechaInicio);
  const fechaVencimiento = toDateIso_(d.fechaVencimiento);
  checkDateRange_(fechaInicio, fechaVencimiento, 'Fecha de inicio', 'Fecha de vencimiento');

  return withLock_(() => {
    const tt = tTasks_().reload();
    const project = tProjects_().findOrFail(projectId, 'proyecto');
    if (!project.activo) fail_(ERR.VALIDATION, 'No se pueden crear tareas en un proyecto archivado.');
    requireProjectAccess_(user, project);

    const column = tt.all().filter(t =>
      t.activo && t.projectId === projectId && t.estado === estado);
    const maxOrder = column.reduce((m, t) => Math.max(m, Number(t.ordenKanban) || 0), 0);

    const now = nowIso_();
    const isDone = estado === STATUS.DONE;
    const created = tt.insert({
      projectId: projectId,
      titulo: titulo,
      descripcion: cleanText_(d.descripcion, 10000),
      estado: estado,
      prioridad: prioridad,
      porcentajeAvance: isDone ? 100 : toPct_(d.porcentajeAvance, 0),
      avanceManual: toBool_(d.avanceManual),
      responsable: assignableEmail_(d.responsable, user),
      fechaInicio: fechaInicio,
      fechaVencimiento: fechaVencimiento,
      fechaCompletado: isDone ? now : '',
      creadoPor: user.email,
      fechaCreacion: now,
      actualizadoPor: user.email,
      fechaActualizacion: now,
      ordenKanban: maxOrder + APP.ORDER_GAP,
      activo: true
    });

    audit_(user, ACTION.CREATE, ENTITY.TASK, created.taskId, null, {
      titulo: titulo, estado: estado, prioridad: prioridad,
      responsable: created.responsable, projectId: projectId
    });

    return decorateTask_(created, taskCtx_(project));
  });
}

function Tasks_update_(user, taskId, data) {
  const d = data || {};
  return withLock_(() => {
    const tt = tTasks_().reload();
    const current = tt.findOrFail(taskId, 'tarea');
    const project = tProjects_().findOrFail(current.projectId, 'proyecto');
    requireProjectAccess_(user, project);

    const patch = {};
    if (d.titulo !== undefined) patch.titulo = requireText_(d.titulo, 'Título', 300);
    if (d.descripcion !== undefined) patch.descripcion = cleanText_(d.descripcion, 10000);
    if (d.prioridad !== undefined) patch.prioridad = requireOneOf_(d.prioridad, PRIORITY_ORDER, 'Prioridad');
    if (d.responsable !== undefined) patch.responsable = assignableEmail_(d.responsable, user);
    if (d.fechaInicio !== undefined) patch.fechaInicio = toDateIso_(d.fechaInicio);
    if (d.fechaVencimiento !== undefined) patch.fechaVencimiento = toDateIso_(d.fechaVencimiento);
    if (d.avanceManual !== undefined) patch.avanceManual = toBool_(d.avanceManual);

    checkDateRange_(
      patch.fechaInicio !== undefined ? patch.fechaInicio : current.fechaInicio,
      patch.fechaVencimiento !== undefined ? patch.fechaVencimiento : current.fechaVencimiento,
      'Fecha de inicio', 'Fecha de vencimiento');

    const nuevoEstado = d.estado !== undefined
      ? requireOneOf_(d.estado, STATUS_ORDER, 'Estado')
      : current.estado;
    if (nuevoEstado !== current.estado) patch.estado = nuevoEstado;

    // Avance: manual si lo pide el usuario, derivado de subtareas si no.
    const manual = patch.avanceManual !== undefined ? patch.avanceManual : current.avanceManual;
    if (d.porcentajeAvance !== undefined) {
      patch.porcentajeAvance = toPct_(d.porcentajeAvance, current.porcentajeAvance);
      if (d.avanceManual === undefined) patch.avanceManual = true;
    } else if (!manual) {
      const derived = progressFromSubtasks_(taskId);
      if (derived !== null) patch.porcentajeAvance = derived;
    }

    applyStatusSideEffects_(patch, current, nuevoEstado, taskId, manual);

    patch.fechaActualizacion = nowIso_();
    patch.actualizadoPor = user.email;

    const res = tt.update(taskId, patch);
    const delta = diff_(res.before, res.after, TASK_EDITABLE);
    if (delta.changed.length) {
      let accion = ACTION.UPDATE;
      if (delta.changed.indexOf('estado') !== -1) accion = ACTION.STATUS_CHANGE;
      else if (delta.changed.indexOf('responsable') !== -1) accion = ACTION.ASSIGN;
      else if (delta.changed.length === 1 && delta.changed[0] === 'porcentajeAvance') accion = ACTION.PROGRESS;
      audit_(user, accion, ENTITY.TASK, taskId, delta.before, delta.after);
    }
    return decorateTask_(res.after, taskCtx_(project));
  });
}

/**
 * Mueve una tarjeta entre columnas y/o la reordena dentro de una columna.
 * `targetIndex` es la posición final (0 = arriba). Si se omite, va al final.
 */
function Tasks_move_(user, taskId, estado, targetIndex) {
  const nuevoEstado = requireOneOf_(estado, STATUS_ORDER, 'Estado');

  return withLock_(() => {
    const tt = tTasks_().reload();
    const current = tt.findOrFail(taskId, 'tarea');
    const project = tProjects_().findOrFail(current.projectId, 'proyecto');
    requireProjectAccess_(user, project);
    if (!current.activo) fail_(ERR.VALIDATION, 'La tarea está archivada.');

    const column = tt.all()
      .filter(t => t.activo && t.projectId === current.projectId &&
        t.estado === nuevoEstado && t.taskId !== taskId)
      .sort((a, b) => (a.ordenKanban || 0) - (b.ordenKanban || 0));

    const idx = clampIndex_(targetIndex, column.length);
    const plan = planOrder_(column, idx);

    const patch = { estado: nuevoEstado, ordenKanban: plan.order };
    const manual = current.avanceManual;
    applyStatusSideEffects_(patch, current, nuevoEstado, taskId, manual);
    patch.fechaActualizacion = nowIso_();
    patch.actualizadoPor = user.email;

    let renormalized = 0;
    let after;
    if (plan.renormalize) {
      // Secuencia final de la columna con la tarjeta ya insertada.
      const finalOrder = column.slice();
      finalOrder.splice(idx, 0, current);
      const patches = finalOrder.map((t, i) => {
        const base = { ordenKanban: (i + 1) * APP.ORDER_GAP };
        return { id: t.taskId, patch: t.taskId === taskId ? Object.assign({}, patch, base) : base };
      });
      renormalized = tt.updateMany(patches);
      after = Object.assign({}, current, patch, { ordenKanban: (idx + 1) * APP.ORDER_GAP });
      delete after._row;
    } else {
      after = tt.update(taskId, patch).after;
    }

    if (current.estado !== nuevoEstado) {
      audit_(user, ACTION.MOVE, ENTITY.TASK, taskId,
        { estado: current.estado, porcentajeAvance: current.porcentajeAvance },
        { estado: nuevoEstado, porcentajeAvance: after.porcentajeAvance });
    }

    return {
      task: decorateTask_(after, taskCtx_(project)),
      renormalized: renormalized,
      project: decorateProject_(project, projectStats_()[project.projectId])
    };
  });
}

function Tasks_setActive_(user, taskId, activo) {
  return withLock_(() => {
    const tt = tTasks_().reload();
    const current = tt.findOrFail(taskId, 'tarea');
    const project = tProjects_().findOrFail(current.projectId, 'proyecto');
    requireProjectAccess_(user, project);
    if (!isAdmin_(user) && current.creadoPor !== user.email && project.responsable !== user.email) {
      fail_(ERR.FORBIDDEN, 'Solo un administrador, el creador de la tarea o el responsable del proyecto pueden archivarla.');
    }
    const next = toBool_(activo);
    const res = tt.update(taskId, {
      activo: next, fechaActualizacion: nowIso_(), actualizadoPor: user.email
    });
    audit_(user, next ? ACTION.RESTORE : ACTION.DELETE, ENTITY.TASK, taskId,
      { activo: current.activo }, { activo: next });
    return decorateTask_(res.after, taskCtx_(project));
  });
}

/** Duplica una tarea con sus subtareas (sin comentarios ni historial). */
function Tasks_duplicate_(user, taskId) {
  return withLock_(() => {
    const tt = tTasks_().reload();
    const src = tt.findOrFail(taskId, 'tarea');
    const project = tProjects_().findOrFail(src.projectId, 'proyecto');
    requireProjectAccess_(user, project);

    const column = tt.all().filter(t => t.activo && t.projectId === src.projectId && t.estado === src.estado);
    const maxOrder = column.reduce((m, t) => Math.max(m, Number(t.ordenKanban) || 0), 0);
    const now = nowIso_();

    const copy = tt.insert({
      projectId: src.projectId,
      titulo: cleanText_(src.titulo + ' (copia)', 300),
      descripcion: src.descripcion,
      estado: src.estado,
      prioridad: src.prioridad,
      porcentajeAvance: src.estado === STATUS.DONE ? 100 : 0,
      avanceManual: src.avanceManual,
      responsable: src.responsable,
      fechaInicio: src.fechaInicio,
      fechaVencimiento: src.fechaVencimiento,
      fechaCompletado: '',
      creadoPor: user.email,
      fechaCreacion: now,
      actualizadoPor: user.email,
      fechaActualizacion: now,
      ordenKanban: maxOrder + APP.ORDER_GAP,
      activo: true
    });

    const subs = tSubtasks_().all().filter(s => s.activo && s.taskId === taskId);
    if (subs.length) {
      tSubtasks_().insertMany(subs.map(s => ({
        taskId: copy.taskId,
        titulo: s.titulo,
        descripcion: s.descripcion,
        completada: false,
        porcentajeAvance: 0,
        responsable: s.responsable,
        fechaVencimiento: s.fechaVencimiento,
        fechaCreacion: now,
        fechaActualizacion: now,
        activo: true
      })));
    }

    audit_(user, ACTION.CREATE, ENTITY.TASK, copy.taskId, null,
      { duplicadaDe: taskId, titulo: copy.titulo });
    return decorateTask_(copy, taskCtx_(project));
  });
}

/* ───────────────────────────── Auxiliares ──────────────────────────────── */

function taskCtx_(project) {
  return {
    dueSoon: cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS),
    today: todayIso_(),
    subCounts: subtaskCounts_(),
    cmtCounts: commentCounts_(),
    names: userNamesByEmail_(),
    project: project
  };
}

/**
 * Efectos de un cambio de estado:
 *   · entrar a DONE → 100 % y fecha de completado.
 *   · salir de DONE → se limpia la fecha y, si el avance NO es manual, se
 *     recalcula desde las subtareas (el usuario puede ajustarlo después).
 */
function applyStatusSideEffects_(patch, current, nuevoEstado, taskId, manual) {
  const entraDone = nuevoEstado === STATUS.DONE && current.estado !== STATUS.DONE;
  const saleDone = nuevoEstado !== STATUS.DONE && current.estado === STATUS.DONE;

  if (entraDone) {
    patch.porcentajeAvance = 100;
    patch.fechaCompletado = nowIso_();
  } else if (saleDone) {
    patch.fechaCompletado = '';
    if (!manual) {
      const derived = progressFromSubtasks_(taskId);
      patch.porcentajeAvance = derived === null ? 0 : derived;
    }
  } else if (nuevoEstado === STATUS.DONE && patch.porcentajeAvance === undefined) {
    patch.porcentajeAvance = 100;
  }
}

/** Avance derivado de las subtareas activas, o null si no hay subtareas. */
function progressFromSubtasks_(taskId) {
  const subs = tSubtasks_().all().filter(s => s.activo && s.taskId === taskId);
  if (!subs.length) return null;
  let sum = 0;
  subs.forEach(s => { sum += s.completada ? 100 : (Number(s.porcentajeAvance) || 0); });
  return Math.round(sum / subs.length);
}

/**
 * Propaga el avance de las subtareas a la tarea. Se llama tras cualquier
 * cambio en SUBTASKS. No hace nada si la tarea tiene avance manual o está DONE.
 */
function syncTaskProgress_(user, taskId) {
  const tt = tTasks_();
  const task = tt.find(taskId);
  if (!task || task.avanceManual || task.estado === STATUS.DONE) return task;
  const derived = progressFromSubtasks_(taskId);
  if (derived === null || derived === task.porcentajeAvance) return task;
  const res = tt.update(taskId, {
    porcentajeAvance: derived,
    fechaActualizacion: nowIso_(),
    actualizadoPor: user.email
  });
  audit_(user, ACTION.PROGRESS, ENTITY.TASK, taskId,
    { porcentajeAvance: task.porcentajeAvance }, { porcentajeAvance: derived });
  return res.after;
}

function clampIndex_(targetIndex, length) {
  if (targetIndex === undefined || targetIndex === null || targetIndex === '') return length;
  const n = Math.floor(Number(targetIndex));
  if (!isFinite(n)) return length;
  return Math.max(0, Math.min(n, length));
}

/**
 * Calcula el nuevo ordenKanban por punto medio.
 * Devuelve { order, renormalize }. `renormalize` indica que el hueco se agotó y
 * hay que reescribir la columna completa.
 */
function planOrder_(column, idx) {
  const gap = APP.ORDER_GAP;
  const min = APP.ORDER_MIN_GAP;
  const n = column.length;

  if (n === 0) return { order: gap, renormalize: false };

  if (idx <= 0) {
    const next = Number(column[0].ordenKanban) || gap;
    if (next - min * 2 <= 0) return { order: gap, renormalize: true };
    return { order: next > gap ? next - gap : next / 2, renormalize: false };
  }

  if (idx >= n) {
    const prev = Number(column[n - 1].ordenKanban) || 0;
    return { order: prev + gap, renormalize: false };
  }

  const prev = Number(column[idx - 1].ordenKanban) || 0;
  const next = Number(column[idx].ordenKanban) || prev + gap;
  if (next - prev < min * 2) return { order: (idx + 1) * gap, renormalize: true };
  return { order: (prev + next) / 2, renormalize: false };
}
