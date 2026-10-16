/**
 * Code.gs — Punto de entrada de la Web App y única superficie pública de la API.
 *
 * Todo endpoint pasa por handle_(), que:
 *   1. resuelve la identidad desde el contexto de ejecución (nunca del frontend),
 *   2. valida el permiso declarado contra la matriz de Config.gs,
 *   3. ejecuta la lógica de negocio,
 *   4. devuelve el contrato { success, data } / { success, errorCode, message }.
 *
 * Consecuencia: llamar estas funciones desde la consola del navegador no evade
 * nada. Un usuario no autorizado recibe UNAUTHORIZED en todas ellas.
 */

/* ──────────────────────────── Web App ───────────────────────────────── */

function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.appName = APP.NAME;
  t.appVersion = APP.VERSION;
  return t.evaluate()
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inclusión de parciales HTML desde las plantillas. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ─────────────────────────── Envoltorio común ───────────────────────── */

/**
 * @param {?string} permission Permiso requerido, o null para solo autenticar.
 * @param {function(Object):*} fn Lógica de negocio; recibe el usuario.
 */
function handle_(permission, fn) {
  try {
    const user = requireUser_();
    if (permission) requirePermission_(user, permission);
    return ok_(fn(user));
  } catch (e) {
    return errResponse_(e);
  }
}

/* ──────────────────────────── Sesión ────────────────────────────────── */

/**
 * Identidad y rol del usuario. El frontend usa esto para decidir qué mostrar;
 * el backend no confía en esa decisión.
 */
function getCurrentUser() {
  return handle_('app.access', user => ({
    userId: user.userId,
    email: user.email,
    name: user.nombre,
    nombre: user.nombre,
    role: user.rol,
    rol: user.rol,
    active: user.activo,
    activo: user.activo,
    ultimoAcceso: user.ultimoAcceso,
    permissions: effectivePermissions_(user),
    isAdmin: isAdmin_(user)
  }));
}

/**
 * Carga inicial en una sola llamada: sesión + proyectos + usuarios asignables
 * + metadatos. Evita 4 round-trips al abrir la app.
 */
function getBootstrap() {
  return handle_('app.access', user => ({
    user: {
      userId: user.userId,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      activo: user.activo,
      ultimoAcceso: user.ultimoAcceso,
      permissions: effectivePermissions_(user),
      isAdmin: isAdmin_(user)
    },
    projects: Projects_list_(user, {}),
    assignables: Users_listBasic_(),
    meta: {
      appName: APP.NAME,
      version: APP.VERSION,
      timezone: APP.TIMEZONE,
      statuses: STATUS_ORDER.map(s => ({ value: s, label: STATUS_LABEL[s] })),
      priorities: PRIORITY_ORDER.slice(),
      roles: Object.keys(PERMISSIONS),
      dueSoonDays: cfgNumber_('DUE_SOON_DAYS', APP.DUE_SOON_DAYS),
      canCreateProject: canCreateProject_(user)
    }
  }));
}

function updateMyProfile(data) {
  return handle_('app.access', user => Users_updateOwnProfile_(user, data));
}

/* ─────────────────────────── Dashboard ──────────────────────────────── */

function getDashboard() {
  return handle_('dashboard.read', user => Dashboard_summary_(user));
}

function getMyTasks(filters) {
  return handle_('task.read', user => Dashboard_myTasks_(user, filters));
}

/* ─────────────────────────── Proyectos ──────────────────────────────── */

function getProjects(opts) {
  return handle_('project.read', user => Projects_list_(user, opts));
}

function getProject(projectId) {
  return handle_('project.read', user => Projects_get_(user, projectId));
}

/**
 * El permiso declarado es solo de acceso: quién puede crear proyectos lo decide
 * canCreateProject_() (ADMIN siempre, USER según el parámetro
 * ALLOW_USER_CREATE_PROJECT de la hoja CONFIG), y se valida dentro.
 */
function createProject(data) {
  return handle_('app.access', user => Projects_create_(user, data));
}

function updateProject(projectId, data) {
  return handle_('project.update', user => Projects_update_(user, projectId, data));
}

function archiveProject(projectId) {
  return handle_('project.delete', user => Projects_setActive_(user, projectId, false));
}

function restoreProject(projectId) {
  return handle_('project.delete', user => Projects_setActive_(user, projectId, true));
}

/* ───────────────────────────── Tareas ───────────────────────────────── */

function getTasks(projectId, filters) {
  return handle_('task.read', user =>
    Tasks_list_(user, Object.assign({}, filters || {}, projectId ? { projectId: projectId } : {})));
}

function getBoard(projectId, filters) {
  return handle_('task.read', user => Tasks_board_(user, projectId, filters));
}

function getTask(taskId) {
  return handle_('task.read', user => Tasks_get_(user, taskId));
}

function createTask(data) {
  return handle_('task.create', user => Tasks_create_(user, data));
}

function updateTask(taskId, data) {
  return handle_('task.update', user => Tasks_update_(user, taskId, data));
}

/** @param {number} order Índice de destino dentro de la columna (0 = arriba). */
function moveTask(taskId, status, order) {
  return handle_('task.move', user => Tasks_move_(user, taskId, status, order));
}

function archiveTask(taskId) {
  return handle_('task.update', user => Tasks_setActive_(user, taskId, false));
}

function restoreTask(taskId) {
  return handle_('task.update', user => Tasks_setActive_(user, taskId, true));
}

function duplicateTask(taskId) {
  return handle_('task.create', user => Tasks_duplicate_(user, taskId));
}

/* ──────────────────────────── Subtareas ─────────────────────────────── */

function getSubtasks(taskId) {
  return handle_('subtask.read', user => {
    requireParentTask_(user, taskId);
    return Subtasks_list_(taskId);
  });
}

function createSubtask(data) {
  return handle_('subtask.create', user => Subtasks_create_(user, data));
}

function updateSubtask(subtaskId, data) {
  return handle_('subtask.update', user => Subtasks_update_(user, subtaskId, data));
}

function deleteSubtask(subtaskId) {
  return handle_('subtask.update', user => Subtasks_delete_(user, subtaskId));
}

/* ──────────────────────────── Comentarios ───────────────────────────── */

function getComments(taskId) {
  return handle_('comment.read', user => {
    requireParentTask_(user, taskId);
    return Comments_list_(taskId);
  });
}

function addComment(taskId, comment) {
  return handle_('comment.create', user => Comments_add_(user, taskId, comment));
}

/** Comments_delete_ restringe además a autor o administrador. */
function deleteComment(commentId) {
  return handle_('comment.delete.own', user => Comments_delete_(user, commentId));
}

/* ───────────────────── Administración: usuarios ─────────────────────── */

function getUsers() {
  return handle_('user.manage', () => Users_list_());
}

/** Lista reducida para selectores de responsable; accesible a cualquier rol. */
function getAssignableUsers() {
  return handle_('user.list.basic', () => Users_listBasic_());
}

function createUser(data) {
  return handle_('user.manage', user => Users_create_(user, data));
}

function updateUser(userId, data) {
  return handle_('user.manage', user => Users_update_(user, userId, data));
}

function toggleUserStatus(userId) {
  return handle_('user.manage', user => Users_toggle_(user, userId));
}

/* ───────────────────── Administración: auditoría ────────────────────── */

function getAuditLog(filters) {
  return handle_('audit.read.global', () => auditQuery_(filters));
}

function getTaskHistory(taskId) {
  return handle_('audit.read.entity', user => {
    requireParentTask_(user, taskId);
    return auditForEntity_(ENTITY.TASK, taskId, 60);
  });
}

/* ──────────────────── Administración: configuración ─────────────────── */

function getAppConfig() {
  return handle_('config.manage', () => AppConfig_list_());
}

function updateAppConfig(clave, valor) {
  return handle_('config.manage', user => AppConfig_update_(user, clave, valor));
}

/* ───────────────────────────── Exportación ──────────────────────────── */

function exportTasksCsv(projectId) {
  return handle_('task.read', user => Export_tasksCsv_(user, projectId));
}
