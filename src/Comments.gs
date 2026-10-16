/**
 * Comments.gs — Comentarios de una tarea, del más reciente al más antiguo.
 *
 * Se guarda el userId (no el email) para que renombrar la cuenta no rompa la
 * atribución. El email se resuelve en lectura.
 */

let _usersByIdMemo = null;
function usersById_() {
  if (_usersByIdMemo) return _usersByIdMemo;
  _usersByIdMemo = indexBy_(tUsers_().all(), u => u.userId);
  return _usersByIdMemo;
}

/** Comentarios activos de una tarea. La autorización la valida quien llama. */
function Comments_list_(taskId, names) {
  const byId = usersById_();
  const map = names || userNamesByEmail_();
  return tComments_().all()
    .filter(c => c.activo && c.taskId === taskId)
    // Desempate por nº de fila: dos comentarios creados en el mismo
    // milisegundo deben conservar su orden real de inserción.
    .sort((a, b) => String(b.fechaCreacion).localeCompare(String(a.fechaCreacion)) || (b._row - a._row))
    .map(c => {
      const u = byId[c.userId];
      const email = u ? u.email : '';
      return {
        commentId: c.commentId,
        taskId: c.taskId,
        userId: c.userId,
        email: email,
        autor: u ? (u.nombre || u.email) : (map[email] || 'Usuario eliminado'),
        comentario: c.comentario,
        fechaCreacion: c.fechaCreacion
      };
    });
}

function Comments_add_(user, taskId, comentario) {
  const id = String(taskId || '').trim();
  if (!id) fail_(ERR.VALIDATION, 'Debes indicar la tarea del comentario.');
  const texto = requireText_(comentario, 'Comentario', 4000);

  return withLock_(() => {
    tComments_().reload();
    requireParentTask_(user, id);

    const created = tComments_().insert({
      taskId: id,
      userId: user.userId,
      comentario: texto,
      fechaCreacion: nowIso_(),
      activo: true
    });

    audit_(user, ACTION.COMMENT, ENTITY.TASK, id, null,
      { commentId: created.commentId, extracto: texto.slice(0, 120) });

    _usersByIdMemo = null;
    return Comments_list_(id);
  });
}

/** Solo el autor o un administrador pueden eliminar un comentario. */
function Comments_delete_(user, commentId) {
  return withLock_(() => {
    const tc = tComments_().reload();
    const current = tc.findOrFail(commentId, 'comentario');
    requireParentTask_(user, current.taskId);

    if (current.userId !== user.userId && !isAdmin_(user)) {
      fail_(ERR.FORBIDDEN, 'Solo el autor del comentario o un administrador pueden eliminarlo.');
    }

    tc.update(commentId, { activo: false });
    audit_(user, ACTION.DELETE, ENTITY.COMMENT, commentId,
      { extracto: String(current.comentario).slice(0, 120) }, { activo: false });

    return Comments_list_(current.taskId);
  });
}
