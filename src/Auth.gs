/**
 * Auth.gs — Identidad, autorización y matriz de permisos.
 *
 * Principio: el frontend NUNCA envía la identidad. El backend la deriva del
 * contexto de ejecución en cada llamada y vuelve a validar permisos en cada
 * endpoint. Ocultar botones en la UI es cosmética, no control de acceso.
 */

/* ──────────────────────── Resolución de identidad ───────────────────── */

/**
 * Email verificado del usuario que ejecuta la llamada, en minúsculas, o ''.
 *
 * getActiveUser() devuelve cadena vacía cuando la Web App está desplegada como
 * "Ejecutar como: yo" y el usuario no pertenece al dominio del dueño. El
 * fallback a getEffectiveUser() SOLO se permite en EXECUTE_AS_USER, donde
 * efectivo y activo son la misma persona. En EXECUTE_AS_OWNER, getEffectiveUser()
 * es el dueño del script: usarlo como fallback convertiría a cualquier visitante
 * en administrador. Ver docs/ARCHITECTURE.md §2.
 */
function resolveIdentity_() {
  let email = '';
  try {
    email = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    email = '';
  }
  if (!email && APP.DEPLOY_MODE === 'EXECUTE_AS_USER') {
    try {
      email = Session.getEffectiveUser().getEmail() || '';
    } catch (e) {
      email = '';
    }
  }
  return String(email).trim().toLowerCase();
}

/* ─────────────────────────── Usuario actual ─────────────────────────── */

let _currentUserMemo = undefined;

/**
 * Usuario autenticado y autorizado. Lanza AppError si no corresponde.
 * Memoizado por ejecución: una sola resolución aunque se llame varias veces.
 */
function requireUser_() {
  if (_currentUserMemo !== undefined) {
    if (_currentUserMemo instanceof AppError) throw _currentUserMemo;
    return _currentUserMemo;
  }
  try {
    _currentUserMemo = loadAuthorizedUser_();
    return _currentUserMemo;
  } catch (e) {
    if (e instanceof AppError) _currentUserMemo = e;
    throw e;
  }
}

function loadAuthorizedUser_() {
  const email = resolveIdentity_();

  if (!email) {
    fail_(ERR.IDENTITY_UNAVAILABLE,
      'No se pudo verificar tu identidad de Google. Vuelve a abrir la aplicación desde su URL ' +
      'e inicia sesión con tu cuenta. Si el problema persiste, contacta al administrador.');
  }

  const users = tUsers_();
  let user = users.findBy(u => u.email === email);

  // Arranque en frío: si la tabla está vacía y quien entra es el ADMIN_EMAIL
  // configurado, se autoinscribe como administrador. Solo ocurre una vez.
  if (!user) {
    const bootstrapEmail = cleanEmail_(propGet_(PROP.ADMIN_EMAIL));
    if (bootstrapEmail && bootstrapEmail === email && users.active().length === 0) {
      const now = nowIso_();
      user = users.insert({
        email: email,
        nombre: email.split('@')[0],
        rol: ROLE.ADMIN,
        activo: true,
        fechaCreacion: now,
        fechaActualizacion: now,
        ultimoAcceso: now
      });
      Logger.log('[auth] administrador inicial autoinscrito: %s', email);
    }
  }

  if (!user) {
    fail_(ERR.UNAUTHORIZED,
      'Tu cuenta no tiene permisos para acceder a esta aplicación. Contacta al administrador.');
  }
  if (!user.activo) {
    fail_(ERR.USER_INACTIVE,
      'Tu cuenta está desactivada. Contacta al administrador.');
  }
  if (!PERMISSIONS[user.rol]) {
    fail_(ERR.FORBIDDEN,
      'Tu cuenta tiene un rol no reconocido (' + user.rol + '). Contacta al administrador.');
  }

  touchLastAccess_(user);
  return user;
}

/**
 * Registra el último acceso, como máximo una vez cada 10 minutos por usuario.
 * Escribir en cada RPC invalidaría la caché de USERS constantemente.
 */
function touchLastAccess_(user) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'touch:' + user.userId;
    if (cache.get(key)) return;
    cache.put(key, '1', 600);
    tUsers_().update(user.userId, { ultimoAcceso: nowIso_() });
  } catch (e) {
    Logger.log('[auth] no se pudo registrar ultimoAcceso: %s', e && e.message);
  }
}

/* ──────────────────────────── Permisos ──────────────────────────────── */

/**
 * Evalúa un permiso contra la matriz declarativa de Config.gs.
 * Soporta '*' (todo) y 'namespace.*'.
 */
function hasPermission_(user, permission) {
  if (!user || !permission) return false;
  const granted = PERMISSIONS[user.rol];
  if (!granted) return false;
  if (granted.indexOf('*') !== -1) return true;
  if (granted.indexOf(permission) !== -1) return true;

  const parts = permission.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    if (granted.indexOf(parts.slice(0, i).join('.') + '.*') !== -1) return true;
  }
  return false;
}

function requirePermission_(user, permission) {
  if (!hasPermission_(user, permission)) {
    fail_(ERR.FORBIDDEN, 'No tienes permisos para realizar esta acción.', { permission: permission });
  }
}

function isAdmin_(user) {
  return !!user && user.rol === ROLE.ADMIN;
}

/** Lista de permisos efectivos, para que la UI decida qué mostrar. */
function effectivePermissions_(user) {
  return (PERMISSIONS[user.rol] || []).slice();
}

/* ──────────────────────── Visibilidad de proyectos ──────────────────── */

/**
 * ¿Puede este usuario ver el proyecto? Punto único de extensión para una
 * futura hoja PROJECT_MEMBERS.
 */
function canSeeProject_(user, project, tasksOfUser) {
  if (isAdmin_(user)) return true;
  const mode = cfg_('PROJECT_VISIBILITY', APP.PROJECT_VISIBILITY);
  if (mode !== 'INVOLVED') return true;
  if (project.responsable === user.email) return true;
  if (tasksOfUser && tasksOfUser[project.projectId]) return true;
  return false;
}

/** Conjunto projectId → true de los proyectos donde el usuario tiene tareas. */
function projectsWithUserTasks_(user) {
  const out = {};
  tTasks_().all().forEach(t => {
    if (t.activo && t.responsable === user.email) out[t.projectId] = true;
  });
  return out;
}

/** Filtra una lista de proyectos según la visibilidad del usuario. */
function filterVisibleProjects_(user, projects) {
  if (isAdmin_(user)) return projects;
  const mode = cfg_('PROJECT_VISIBILITY', APP.PROJECT_VISIBILITY);
  if (mode !== 'INVOLVED') return projects;
  const mine = projectsWithUserTasks_(user);
  return projects.filter(p => canSeeProject_(user, p, mine));
}

/** Verifica acceso a un proyecto concreto o lanza FORBIDDEN. */
function requireProjectAccess_(user, project) {
  if (!canSeeProject_(user, project, projectsWithUserTasks_(user))) {
    fail_(ERR.FORBIDDEN, 'No tienes acceso a este proyecto.');
  }
}

/** ¿Puede el usuario crear proyectos? (ADMIN siempre; USER según CONFIG) */
function canCreateProject_(user) {
  if (isAdmin_(user)) return true;
  return cfgBool_('ALLOW_USER_CREATE_PROJECT', false);
}
