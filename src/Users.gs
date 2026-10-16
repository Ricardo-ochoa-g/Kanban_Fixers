/**
 * Users.gs — Mantenedor de usuarios y control de acceso por cuenta Google.
 *
 * La lista blanca de la aplicación ES la hoja USERS: si el email no está ahí
 * y activo, el backend rechaza cualquier operación.
 */

/** Lista completa (ADMIN). */
function Users_list_() {
  return tUsers_().all()
    .sort((a, b) => String(a.nombre || a.email).localeCompare(String(b.nombre || b.email)))
    .map(u => ({
      userId: u.userId,
      email: u.email,
      nombre: u.nombre,
      rol: u.rol,
      activo: u.activo,
      fechaCreacion: u.fechaCreacion,
      fechaActualizacion: u.fechaActualizacion,
      ultimoAcceso: u.ultimoAcceso
    }));
}

/**
 * Lista reducida para poblar selectores de responsable (rol USER).
 * No expone rol, estado ni último acceso.
 */
function Users_listBasic_() {
  return tUsers_().active()
    .sort((a, b) => String(a.nombre || a.email).localeCompare(String(b.nombre || b.email)))
    .map(u => ({ email: u.email, nombre: u.nombre || u.email }));
}

function Users_create_(actor, data) {
  const d = data || {};
  const email = cleanEmail_(d.email);
  if (!email) fail_(ERR.VALIDATION, 'Debes indicar un correo de Google válido.');

  const nombre = requireText_(d.nombre, 'Nombre', 120);
  const rol = requireOneOf_(d.rol || ROLE.USER, Object.keys(PERMISSIONS), 'Rol');

  return withLock_(() => {
    const users = tUsers_();
    users.reload(); // relectura fresca dentro del lock
    if (users.findBy(u => u.email === email)) {
      fail_(ERR.CONFLICT, 'Ya existe un usuario con el correo ' + email + '.');
    }
    const now = nowIso_();
    const created = users.insert({
      email: email,
      nombre: nombre,
      rol: rol,
      activo: d.activo === undefined ? true : toBool_(d.activo),
      fechaCreacion: now,
      fechaActualizacion: now,
      ultimoAcceso: ''
    });
    audit_(actor, ACTION.CREATE, ENTITY.USER, created.userId, null,
      { email: email, nombre: nombre, rol: rol, activo: created.activo });
    return stripRow_(created);
  });
}

function Users_update_(actor, userId, data) {
  const d = data || {};
  return withLock_(() => {
    const users = tUsers_();
    users.reload();
    const current = users.findOrFail(userId, 'usuario');

    const patch = { fechaActualizacion: nowIso_() };

    if (d.nombre !== undefined) patch.nombre = requireText_(d.nombre, 'Nombre', 120);

    if (d.email !== undefined) {
      const email = cleanEmail_(d.email);
      if (!email) fail_(ERR.VALIDATION, 'Correo de Google inválido.');
      if (email !== current.email && users.findBy(u => u.email === email)) {
        fail_(ERR.CONFLICT, 'Ya existe un usuario con el correo ' + email + '.');
      }
      patch.email = email;
    }

    if (d.rol !== undefined) {
      patch.rol = requireOneOf_(d.rol, Object.keys(PERMISSIONS), 'Rol');
      if (patch.rol !== ROLE.ADMIN && current.rol === ROLE.ADMIN) {
        assertNotLastAdmin_(users, current.userId);
      }
      if (current.userId === actor.userId && patch.rol !== ROLE.ADMIN) {
        fail_(ERR.VALIDATION, 'No puedes quitarte a ti mismo el rol de administrador.');
      }
    }

    if (d.activo !== undefined) {
      patch.activo = toBool_(d.activo);
      if (!patch.activo) {
        if (current.userId === actor.userId) {
          fail_(ERR.VALIDATION, 'No puedes desactivar tu propia cuenta.');
        }
        if (current.rol === ROLE.ADMIN) assertNotLastAdmin_(users, current.userId);
      }
    }

    const res = users.update(userId, patch);
    const delta = diff_(res.before, res.after, ['nombre', 'email', 'rol', 'activo']);
    if (delta.changed.length) {
      const accion = delta.changed.indexOf('rol') !== -1 ? ACTION.ROLE_CHANGE : ACTION.UPDATE;
      audit_(actor, accion, ENTITY.USER, userId, delta.before, delta.after);
    }
    return stripRow_(res.after);
  });
}

function Users_toggle_(actor, userId) {
  return withLock_(() => {
    const users = tUsers_();
    users.reload();
    const current = users.findOrFail(userId, 'usuario');
    const next = !current.activo;

    if (!next) {
      if (current.userId === actor.userId) {
        fail_(ERR.VALIDATION, 'No puedes desactivar tu propia cuenta.');
      }
      if (current.rol === ROLE.ADMIN) assertNotLastAdmin_(users, current.userId);
    }

    const res = users.update(userId, { activo: next, fechaActualizacion: nowIso_() });
    audit_(actor, ACTION.TOGGLE_STATUS, ENTITY.USER, userId,
      { activo: current.activo }, { activo: next });
    return stripRow_(res.after);
  });
}

/** Impide quedarse sin ningún administrador activo. */
function assertNotLastAdmin_(users, excludeUserId) {
  const admins = users.all().filter(u =>
    u.rol === ROLE.ADMIN && u.activo === true && u.userId !== excludeUserId);
  if (admins.length === 0) {
    fail_(ERR.VALIDATION,
      'Debe quedar al menos un administrador activo. Asigna el rol ADMIN a otro usuario primero.');
  }
}

/** Perfil propio: lo único que un usuario puede editar de sí mismo. */
function Users_updateOwnProfile_(actor, data) {
  const nombre = requireText_((data || {}).nombre, 'Nombre', 120);
  return withLock_(() => {
    const users = tUsers_();
    users.reload();
    const res = users.update(actor.userId, { nombre: nombre, fechaActualizacion: nowIso_() });
    const delta = diff_(res.before, res.after, ['nombre']);
    if (delta.changed.length) {
      audit_(actor, ACTION.UPDATE, ENTITY.USER, actor.userId, delta.before, delta.after);
    }
    return stripRow_(res.after);
  });
}
