/**
 * Subtasks.gs — Subtareas (checklist) de una tarea.
 *
 * Toda escritura recalcula el avance de la tarea padre, salvo que la tarea
 * tenga avance manual o esté en DONE.
 */

/** Subtareas activas de una tarea. La autorización la valida quien llama. */
function Subtasks_list_(taskId, names) {
  const map = names || userNamesByEmail_();
  return tSubtasks_().all()
    .filter(s => s.activo && s.taskId === taskId)
    .sort((a, b) => String(a.fechaCreacion).localeCompare(String(b.fechaCreacion)) || (a._row - b._row))
    .map(s => ({
      subtaskId: s.subtaskId,
      taskId: s.taskId,
      titulo: s.titulo,
      descripcion: s.descripcion,
      completada: s.completada,
      porcentajeAvance: s.completada ? 100 : s.porcentajeAvance,
      responsable: s.responsable,
      responsableNombre: s.responsable ? (map[s.responsable] || s.responsable) : '',
      fechaVencimiento: s.fechaVencimiento,
      fechaCreacion: s.fechaCreacion,
      fechaActualizacion: s.fechaActualizacion
    }));
}

/** Carga la tarea padre verificando acceso al proyecto. */
function requireParentTask_(user, taskId) {
  const task = tTasks_().findOrFail(taskId, 'tarea');
  const project = tProjects_().findOrFail(task.projectId, 'proyecto');
  requireProjectAccess_(user, project);
  return { task: task, project: project };
}

function Subtasks_create_(user, data) {
  const d = data || {};
  const taskId = String(d.taskId || '').trim();
  if (!taskId) fail_(ERR.VALIDATION, 'Debes indicar la tarea de la subtarea.');
  const titulo = requireText_(d.titulo, 'Título de la subtarea', 300);

  return withLock_(() => {
    tSubtasks_().reload();
    requireParentTask_(user, taskId);

    const now = nowIso_();
    const completada = toBool_(d.completada);
    const created = tSubtasks_().insert({
      taskId: taskId,
      titulo: titulo,
      descripcion: cleanText_(d.descripcion, 2000),
      completada: completada,
      porcentajeAvance: completada ? 100 : toPct_(d.porcentajeAvance, 0),
      responsable: assignableEmail_(d.responsable, user),
      fechaVencimiento: toDateIso_(d.fechaVencimiento),
      fechaCreacion: now,
      fechaActualizacion: now,
      activo: true
    });

    audit_(user, ACTION.CREATE, ENTITY.SUBTASK, created.subtaskId, null,
      { taskId: taskId, titulo: titulo });
    syncTaskProgress_(user, taskId);

    return {
      subtasks: Subtasks_list_(taskId),
      task: taskAfterSubtaskChange_(user, taskId)
    };
  });
}

function Subtasks_update_(user, subtaskId, data) {
  const d = data || {};
  return withLock_(() => {
    const ts = tSubtasks_().reload();
    const current = ts.findOrFail(subtaskId, 'subtarea');
    requireParentTask_(user, current.taskId);

    const patch = { fechaActualizacion: nowIso_() };
    if (d.titulo !== undefined) patch.titulo = requireText_(d.titulo, 'Título de la subtarea', 300);
    if (d.descripcion !== undefined) patch.descripcion = cleanText_(d.descripcion, 2000);
    if (d.responsable !== undefined) patch.responsable = assignableEmail_(d.responsable, user);
    if (d.fechaVencimiento !== undefined) patch.fechaVencimiento = toDateIso_(d.fechaVencimiento);

    if (d.completada !== undefined) {
      patch.completada = toBool_(d.completada);
      // Completar fija el avance en 100; descompletar lo baja si estaba en 100.
      if (patch.completada) patch.porcentajeAvance = 100;
      else if (d.porcentajeAvance === undefined && current.porcentajeAvance === 100) patch.porcentajeAvance = 0;
    }
    if (d.porcentajeAvance !== undefined) {
      patch.porcentajeAvance = toPct_(d.porcentajeAvance, current.porcentajeAvance);
      if (patch.porcentajeAvance === 100 && d.completada === undefined) patch.completada = true;
    }

    const res = ts.update(subtaskId, patch);
    const delta = diff_(res.before, res.after,
      ['titulo', 'descripcion', 'completada', 'porcentajeAvance', 'responsable', 'fechaVencimiento']);
    if (delta.changed.length) {
      audit_(user, ACTION.UPDATE, ENTITY.SUBTASK, subtaskId, delta.before, delta.after);
    }
    syncTaskProgress_(user, current.taskId);

    return {
      subtasks: Subtasks_list_(current.taskId),
      task: taskAfterSubtaskChange_(user, current.taskId)
    };
  });
}

function Subtasks_delete_(user, subtaskId) {
  return withLock_(() => {
    const ts = tSubtasks_().reload();
    const current = ts.findOrFail(subtaskId, 'subtarea');
    requireParentTask_(user, current.taskId);

    ts.update(subtaskId, { activo: false, fechaActualizacion: nowIso_() });
    audit_(user, ACTION.DELETE, ENTITY.SUBTASK, subtaskId,
      { titulo: current.titulo, activo: true }, { activo: false });
    syncTaskProgress_(user, current.taskId);

    return {
      subtasks: Subtasks_list_(current.taskId),
      task: taskAfterSubtaskChange_(user, current.taskId)
    };
  });
}

/** Tarea padre ya decorada, para que el frontend refresque la tarjeta. */
function taskAfterSubtaskChange_(user, taskId) {
  const task = tTasks_().findOrFail(taskId, 'tarea');
  const project = tProjects_().find(task.projectId);
  return decorateTask_(task, taskCtx_(project));
}
