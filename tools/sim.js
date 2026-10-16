#!/usr/bin/env node
/**
 * sim.js — Pruebas funcionales del backend fuera de Google.
 *
 * Usa gasenv.js (mocks en memoria de SpreadsheetApp, PropertiesService,
 * CacheService, LockService, Session, Utilities y Logger) para ejecutar el
 * recorrido completo: instalación, control de acceso, CRUD, Kanban, subtareas,
 * comentarios, auditoría, permisos por rol y rendimiento de acceso a la hoja.
 */


const { createEnv } = require('./gasenv');

const env = createEnv();
const { ctx, store, ownerEmail } = env;
const as = env.as;
const call = env.call;

/* ───────────────────────────── Utilidades de test ───────────────────── */

let passed = 0, failed = 0;
function check(label, condition, detail) {
  if (condition) { passed++; console.log('  ok    ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? ' → ' + detail : '')); }
}
function ok(res, label) {
  if (!res || res.success !== true) {
    failed++;
    console.log('  FAIL  ' + label + ' → ' + (res ? res.errorCode + ': ' + res.message : 'sin respuesta'));
    return null;
  }
  passed++;
  console.log('  ok    ' + label);
  return res.data;
}
function denied(res, label, expectedCode) {
  if (res && res.success === false && (!expectedCode || res.errorCode === expectedCode)) {
    passed++;
    console.log('  ok    ' + label + ' (' + res.errorCode + ')');
    return true;
  }
  failed++;
  console.log('  FAIL  ' + label + ' → se esperaba un rechazo' +
    (expectedCode ? ' ' + expectedCode : '') + ', se obtuvo ' + JSON.stringify(res && res.errorCode));
  return false;
}

/* ═══════════════════════════════ ESCENARIO ══════════════════════════════ */

console.log('\n── 1. Instalación ──────────────────────────────────────────');
store.props.ADMIN_EMAIL = ownerEmail;
as(ownerEmail);

try {
  call('setupApplication');
  check('setupApplication() se ejecuta sin errores', true);
} catch (e) {
  check('setupApplication() se ejecuta sin errores', false, e.message);
  process.exit(1);
}
const ssId = store.props.SPREADSHEET_ID;
const ss = store.spreadsheets[ssId];
check('se creó el spreadsheet de datos', !!ss);
check('se crearon las 8 hojas del esquema',
  ss.getSheets().length === 8, 'hojas: ' + ss.getSheets().map(s => s.getName()).join(', '));
check('se eliminó la hoja por defecto vacía', !ss.getSheetByName('Sheet1'));

as(ownerEmail);
check('setupApplication() es idempotente', (() => {
  try { call('setupApplication'); return ss.getSheets().length === 8; }
  catch (e) { return false; }
})());

console.log('\n── 2. Control de acceso ────────────────────────────────────');
as(ownerEmail);
const me = ok(call('getCurrentUser'), 'el administrador inicial puede entrar');
check('su rol es ADMIN', me && me.rol === 'ADMIN');
check('recibe el permiso comodín', me && me.permissions.indexOf('*') !== -1);

as('desconocido@gmail.com');
denied(call('getCurrentUser'), 'una cuenta no registrada es rechazada', 'UNAUTHORIZED');
denied(call('getProjects', {}), 'y tampoco puede llamar a getProjects', 'UNAUTHORIZED');
denied(call('createProject', { nombre: 'Intento' }), 'ni crear proyectos saltándose la UI', 'UNAUTHORIZED');

console.log('\n── 3. Alta de usuarios ─────────────────────────────────────');
as(ownerEmail);
const u1 = ok(call('createUser', { nombre: 'Ana Pérez', email: 'ana@example.com', rol: 'USER' }),
  'el ADMIN crea un usuario');
ok(call('createUser', { nombre: 'Beto Soto', email: 'beto@example.com', rol: 'USER' }),
  'el ADMIN crea un segundo usuario');
as(ownerEmail);
denied(call('createUser', { nombre: 'Duplicada', email: 'ana@example.com', rol: 'USER' }),
  'no se permite un correo duplicado', 'CONFLICT');
as(ownerEmail);
denied(call('createUser', { nombre: 'Sin correo', email: 'no-es-un-correo', rol: 'USER' }),
  'se valida el formato del correo', 'VALIDATION');

as('ana@example.com');
const ana = ok(call('getCurrentUser'), 'el usuario recién creado ya puede entrar');
check('su rol es USER', ana && ana.rol === 'USER');
denied(call('getUsers'), 'un USER no puede listar usuarios', 'FORBIDDEN');
denied(call('getAuditLog', {}), 'un USER no puede consultar la auditoría global', 'FORBIDDEN');
denied(call('getAppConfig'), 'un USER no puede ver la configuración', 'FORBIDDEN');
denied(call('createUser', { nombre: 'X', email: 'x@example.com' }),
  'un USER no puede crear usuarios', 'FORBIDDEN');

console.log('\n── 4. Proyectos ────────────────────────────────────────────');
as(ownerEmail);
const proj = ok(call('createProject', {
  nombre: 'Implementación CRM', descripcion: 'Despliegue por fases',
  responsable: 'ana@example.com', fechaInicio: '2026-09-01', fechaFin: '2026-12-15',
  estado: 'DOING', prioridad: 'ALTA'
}), 'el ADMIN crea un proyecto');
check('el proyecto nace con 0 tareas', proj && proj.totalTareas === 0);

as(ownerEmail);
denied(call('createProject', { nombre: '' }), 'el nombre es obligatorio', 'VALIDATION');
as(ownerEmail);
denied(call('createProject', {
  nombre: 'Fechas al revés', fechaInicio: '2026-12-01', fechaFin: '2026-01-01'
}), 'la fecha objetivo no puede ser anterior al inicio', 'VALIDATION');
as(ownerEmail);
denied(call('createProject', { nombre: 'Responsable inventado', responsable: 'nadie@example.com' }),
  'el responsable debe ser un usuario activo', 'VALIDATION');

as('ana@example.com');
denied(call('updateProject', proj.projectId, { nombre: 'Hackeado' }),
  'un USER no puede editar proyectos', 'FORBIDDEN');

console.log('\n── 5. Tareas y Kanban ──────────────────────────────────────');
as('ana@example.com');
const t1 = ok(call('createTask', {
  projectId: proj.projectId, titulo: 'Levantamiento de requisitos',
  descripcion: 'Entrevistas con las áreas', estado: 'TO_DO', prioridad: 'ALTA',
  responsable: 'ana@example.com', fechaVencimiento: '2026-10-01'
}), 'un USER crea una tarea');

as('ana@example.com');
const t2 = ok(call('createTask', {
  projectId: proj.projectId, titulo: 'Migración de datos',
  estado: 'TO_DO', prioridad: 'CRITICA', responsable: 'beto@example.com'
}), 'crea una segunda tarea en la misma columna');

as('ana@example.com');
const t3 = ok(call('createTask', {
  projectId: proj.projectId, titulo: 'Capacitación', estado: 'BACKLOG'
}), 'crea una tercera tarea en otra columna');

check('las tareas de una columna reciben órdenes crecientes',
  t1.ordenKanban < t2.ordenKanban, t1.ordenKanban + ' vs ' + t2.ordenKanban);

as('ana@example.com');
const board1 = ok(call('getBoard', proj.projectId, {}), 'el tablero se arma con 5 columnas');
check('el tablero tiene exactamente 5 columnas', board1 && board1.columns.length === 5);
check('las columnas están en el orden ON_HOLD → DONE',
  board1 && board1.columns.map(c => c.estado).join(',') === 'ON_HOLD,BACKLOG,TO_DO,DOING,DONE');
check('TO_DO contiene las dos primeras tareas',
  board1.columns.filter(c => c.estado === 'TO_DO')[0].tasks.length === 2);

as('ana@example.com');
const moved = ok(call('moveTask', t2.taskId, 'DOING', 0), 'mover una tarjeta a DOING');
check('el estado quedó persistido', moved && moved.task.estado === 'DOING');

as('ana@example.com');
const reordered = ok(call('moveTask', t1.taskId, 'DOING', 0),
  'mover otra tarjeta al tope de la misma columna');
check('la tarjeta movida al tope queda antes que la otra',
  reordered.task.ordenKanban < moved.task.ordenKanban,
  reordered.task.ordenKanban + ' vs ' + moved.task.ordenKanban);

as('ana@example.com');
const doneTask = ok(call('moveTask', t1.taskId, 'DONE', 0), 'mover una tarjeta a DONE');
check('al entrar en DONE el avance pasa a 100%', doneTask.task.porcentajeAvance === 100);
check('al entrar en DONE se registra la fecha de completado', !!doneTask.task.fechaCompletado);
check('el indicador de vencimiento pasa a DONE', doneTask.task.dueState === 'DONE');

as('ana@example.com');
const backFromDone = ok(call('moveTask', t1.taskId, 'DOING', 0), 'sacar la tarjeta de DONE');
check('al salir de DONE se limpia la fecha de completado', !backFromDone.task.fechaCompletado);
check('al salir de DONE el avance se recalcula', backFromDone.task.porcentajeAvance === 0,
  'quedó en ' + backFromDone.task.porcentajeAvance);

as('ana@example.com');
denied(call('moveTask', t1.taskId, 'ESTADO_INVENTADO', 0),
  'un estado inválido es rechazado', 'VALIDATION');

console.log('\n── 6. Subtareas y avance ───────────────────────────────────');
as('ana@example.com');
ok(call('createSubtask', { taskId: t2.taskId, titulo: 'Mapear tablas' }), 'crear subtarea 1');
as('ana@example.com');
const subRes = ok(call('createSubtask', { taskId: t2.taskId, titulo: 'Script de carga' }), 'crear subtarea 2');
as('ana@example.com');
ok(call('createSubtask', { taskId: t2.taskId, titulo: 'Validación' }), 'crear subtarea 3');

as('ana@example.com');
const detail1 = ok(call('getTask', t2.taskId), 'el detalle devuelve las subtareas');
check('la tarea muestra 3 subtareas', detail1.subtasks.length === 3);
check('el contador de subtareas de la tarjeta es 0/3',
  detail1.task.subtareasCompletadas === 0 && detail1.task.subtareasTotal === 3);

as('ana@example.com');
const afterToggle = ok(call('updateSubtask', detail1.subtasks[0].subtaskId, { completada: true }),
  'marcar una subtarea como completada');
check('el avance de la tarea se recalcula a 33%', afterToggle.task.porcentajeAvance === 33,
  'quedó en ' + afterToggle.task.porcentajeAvance);

as('ana@example.com');
const manual = ok(call('updateTask', t2.taskId, { porcentajeAvance: 80 }),
  'fijar el avance manualmente');
check('el avance manual se respeta', manual.porcentajeAvance === 80);
check('la tarea queda marcada como avance manual', manual.avanceManual === true);

as('ana@example.com');
const afterToggle2 = ok(call('updateSubtask', detail1.subtasks[1].subtaskId, { completada: true }),
  'completar otra subtarea con avance manual activo');
check('el avance manual NO es sobrescrito por las subtareas',
  afterToggle2.task.porcentajeAvance === 80, 'quedó en ' + afterToggle2.task.porcentajeAvance);

as('ana@example.com');
const backToAuto = ok(call('updateTask', t2.taskId, { avanceManual: false }),
  'volver al cálculo automático');
check('el avance vuelve a derivarse de las subtareas (2/3 = 67%)',
  backToAuto.porcentajeAvance === 67, 'quedó en ' + backToAuto.porcentajeAvance);

as('ana@example.com');
const afterDelete = ok(call('deleteSubtask', detail1.subtasks[2].subtaskId), 'eliminar una subtarea');
check('la subtarea eliminada desaparece del listado', afterDelete.subtasks.length === 2);
check('el avance se recalcula tras eliminar (2/2 = 100%)',
  afterDelete.task.porcentajeAvance === 100, 'quedó en ' + afterDelete.task.porcentajeAvance);

console.log('\n── 7. Comentarios ──────────────────────────────────────────');
as('ana@example.com');
const comments = ok(call('addComment', t2.taskId, 'Pendiente confirmar el acceso a producción.'),
  'agregar un comentario');
check('el comentario queda atribuido al autor correcto',
  comments[0] && comments[0].email === 'ana@example.com');

as('beto@example.com');
const comments2 = ok(call('addComment', t2.taskId, 'Reviso mañana.'), 'otro usuario comenta');
check('los comentarios se ordenan del más reciente al más antiguo',
  comments2[0].comentario === 'Reviso mañana.');

as('beto@example.com');
denied(call('deleteComment', comments[0].commentId),
  'un usuario no puede borrar el comentario de otro', 'FORBIDDEN');

as(ownerEmail);
ok(call('deleteComment', comments[0].commentId), 'un ADMIN sí puede borrar cualquier comentario');

console.log('\n── 8. Historial y auditoría ────────────────────────────────');
as('ana@example.com');
const detail2 = ok(call('getTask', t2.taskId), 'el detalle incluye el historial de la tarea');
check('el historial registra el movimiento de columna',
  detail2.history.some(h => h.accion === 'MOVE'),
  'acciones: ' + detail2.history.map(h => h.accion).join(','));
check('el historial registra la creación',
  detail2.history.some(h => h.accion === 'CREATE'));

as(ownerEmail);
const audit = ok(call('getAuditLog', { limit: 500 }), 'el ADMIN consulta la auditoría global');
check('la auditoría tiene registros', audit && audit.total > 10, 'total: ' + audit.total);
check('la auditoría registra la creación de usuarios',
  audit.rows.some(r => r.entidad === 'USER' && r.accion === 'CREATE'));
check('la auditoría registra el cambio de estado de tareas',
  audit.rows.some(r => r.entidad === 'TASK' && (r.accion === 'MOVE' || r.accion === 'STATUS_CHANGE')));
as(ownerEmail);
const auditFiltered = ok(call('getAuditLog', { entidad: 'USER' }), 'la auditoría se puede filtrar');
check('el filtro por entidad funciona',
  auditFiltered.rows.every(r => r.entidad === 'USER'));

console.log('\n── 9. Dashboard, filtros y exportación ─────────────────────');
as(ownerEmail);
const dash = ok(call('getDashboard'), 'el dashboard se calcula');
check('cuenta 1 proyecto activo', dash.kpis.proyectosActivos === 1);
check('cuenta las 3 tareas', dash.kpis.tareasTotales === 3, 'total: ' + dash.kpis.tareasTotales);
check('la distribución por estado cubre las 5 columnas', dash.porEstado.length === 5);
check('la distribución por prioridad cubre los 4 niveles', dash.porPrioridad.length === 4);
check('el avance promedio está entre 0 y 100',
  dash.kpis.avancePromedio >= 0 && dash.kpis.avancePromedio <= 100);

as('ana@example.com');
const mine = ok(call('getMyTasks', {}), 'la vista "Mis tareas" filtra por responsable');
check('solo devuelve tareas de quien consulta',
  mine.every(t => t.responsable === 'ana@example.com'), 'devolvió ' + mine.length);

as('ana@example.com');
const search = ok(call('getTasks', proj.projectId, { texto: 'migración' }), 'la búsqueda por texto funciona');
check('la búsqueda encuentra la tarea esperada',
  search.length === 1 && search[0].taskId === t2.taskId, 'resultados: ' + search.length);

as('ana@example.com');
const byPrio = ok(call('getTasks', proj.projectId, { prioridad: 'CRITICA' }), 'el filtro por prioridad funciona');
check('solo devuelve tareas CRÍTICAS', byPrio.every(t => t.prioridad === 'CRITICA'));

as('ana@example.com');
const csv = ok(call('exportTasksCsv', proj.projectId), 'exportación CSV');
check('el CSV trae una fila por tarea más la cabecera',
  csv.content.split('\r\n').length === 4, 'líneas: ' + csv.content.split('\r\n').length);

console.log('\n── 10. Archivado y reglas de integridad ────────────────────');
as(ownerEmail);
ok(call('archiveTask', t3.taskId), 'archivar una tarea');
as('ana@example.com');
const boardAfter = ok(call('getBoard', proj.projectId, {}), 'el tablero excluye las tareas archivadas');
check('quedan 2 tareas visibles', boardAfter.total === 2, 'total: ' + boardAfter.total);

as(ownerEmail);
denied(call('updateUser', me.userId, { activo: false }),
  'un ADMIN no puede desactivarse a sí mismo', 'VALIDATION');
as(ownerEmail);
denied(call('updateUser', me.userId, { rol: 'USER' }),
  'un ADMIN no puede quitarse su propio rol', 'VALIDATION');

as(ownerEmail);
ok(call('toggleUserStatus', u1.userId), 'el ADMIN desactiva a un usuario');
as('ana@example.com');
denied(call('getCurrentUser'), 'el usuario desactivado pierde el acceso de inmediato', 'USER_INACTIVE');
denied(call('getTasks', proj.projectId, {}),
  'y tampoco puede ejecutar funciones del backend', 'USER_INACTIVE');
as(ownerEmail);
ok(call('toggleUserStatus', u1.userId), 'el ADMIN lo reactiva');
as('ana@example.com');
ok(call('getCurrentUser'), 'el usuario recupera el acceso');

console.log('\n── 11. Configuración ───────────────────────────────────────');
as(ownerEmail);
ok(call('updateAppConfig', 'DUE_SOON_DAYS', '7'), 'el ADMIN cambia un parámetro');
as(ownerEmail);
denied(call('updateAppConfig', 'DUE_SOON_DAYS', 'abc'), 'se valida el tipo del parámetro', 'VALIDATION');
as(ownerEmail);
denied(call('updateAppConfig', 'PARAMETRO_FALSO', '1'), 'no se aceptan claves inexistentes', 'NOT_FOUND');

as(ownerEmail);
ok(call('updateAppConfig', 'ALLOW_USER_CREATE_PROJECT', 'true'),
  'se habilita la creación de proyectos para USER');
as('ana@example.com');
ok(call('createProject', { nombre: 'Proyecto creado por un USER' }),
  'con el parámetro activo, un USER sí puede crear proyectos');
as(ownerEmail);
ok(call('updateAppConfig', 'ALLOW_USER_CREATE_PROJECT', 'false'), 'se vuelve a deshabilitar');
as('ana@example.com');
denied(call('createProject', { nombre: 'No debería poder' }),
  'y el USER vuelve a ser rechazado', 'FORBIDDEN');

console.log('\n── 11b. Carta Gantt ────────────────────────────────────────');
as('ana@example.com');
let gRes = ok(call('createGanttItem', {
  projectId: proj.projectId, grupo: 'Diseño', fila: 'Luis', titulo: 'Plataforma',
  fechaInicio: '2026-09-10', fechaFin: '2026-09-30'
}), 'un USER crea una actividad del Gantt');
check('la actividad queda listada con su fila', gRes && gRes.items.length === 1 && gRes.items[0].fila === 'Luis');
const gItem = gRes && gRes.items[0];

as('ana@example.com');
gRes = ok(call('createGanttItem', {
  projectId: proj.projectId, grupo: 'Diseño', fila: 'Luis', titulo: 'Video',
  fechaInicio: '2026-10-01', fechaFin: '2026-10-20'
}), 'una segunda actividad puede compartir fila');
check('comparten el mismo orden de fila',
  gRes && gRes.items.length === 2 && gRes.items[0].orden === gRes.items[1].orden);

as('ana@example.com');
gRes = ok(call('createGanttItem', {
  projectId: proj.projectId, grupo: 'Marketing', titulo: 'Investigar',
  fechaInicio: '2026-09-01', fechaFin: '2026-09-15'
}), 'sin fila indicada se usa el título');
const gInv = gRes && gRes.items.filter(i => i.titulo === 'Investigar')[0];
check('la fila nueva queda al final y toma el título', gInv && gInv.fila === 'Investigar' && gInv.orden > gItem.orden);

as('ana@example.com');
gRes = ok(call('updateGanttItem', gItem.ganttId, { fechaInicio: '2026-09-12', fechaFin: '2026-10-02' }),
  'mover/extender una actividad actualiza sus fechas');
check('las fechas se persisten', gRes && gRes.items.filter(i => i.ganttId === gItem.ganttId)[0].fechaInicio === '2026-09-12');
as('ana@example.com');
gRes = ok(call('updateGanttItem', gItem.ganttId, { grupo: 'Marketing', fila: 'Investigar' }),
  'arrastrar a otra fila cambia grupo y fila');
const gMoved = gRes && gRes.items.filter(i => i.ganttId === gItem.ganttId)[0];
const gTarget = gRes && gRes.items.filter(i => i.titulo === 'Investigar')[0];
check('adopta el orden de la fila destino', gMoved && gTarget && gMoved.orden === gTarget.orden);

as('ana@example.com');
denied(call('updateGanttItem', gItem.ganttId, { fechaInicio: '2026-12-01', fechaFin: '2026-11-01' }),
  'el término no puede ser anterior al inicio', 'VALIDATION');
as('ana@example.com');
denied(call('createGanttItem', { projectId: proj.projectId, titulo: '', fechaInicio: '2026-09-01', fechaFin: '2026-09-02' }),
  'el título es obligatorio', 'VALIDATION');
as('ana@example.com');
denied(call('createGanttItem', { projectId: proj.projectId, titulo: 'x', fechaInicio: '', fechaFin: '2026-09-02' }),
  'la fecha de inicio es obligatoria', 'VALIDATION');
as('desconocido@gmail.com');
denied(call('getGantt', proj.projectId), 'una cuenta no registrada no ve el Gantt', 'UNAUTHORIZED');
as('ana@example.com');
denied(call('getGantt', 'PRJ-NO-EXISTE'), 'un proyecto inexistente se rechaza', 'NOT_FOUND');

as('ana@example.com');
gRes = ok(call('deleteGanttItem', gItem.ganttId), 'eliminar archiva la actividad');
check('deja de listarse', gRes && gRes.items.every(i => i.ganttId !== gItem.ganttId));
as(ownerEmail);
const ganttAudit = ok(call('getAuditLog', { entidad: 'GANTT' }), 'el ADMIN consulta la auditoría del Gantt');
check('las operaciones del Gantt quedan auditadas',
  ganttAudit && (ganttAudit.rows || ganttAudit).length >= 5, JSON.stringify(ganttAudit).slice(0, 120));

console.log('\n── 12. Rendimiento de acceso a la hoja ─────────────────────');
Object.values(store.spreadsheets).forEach(s => s.getSheets().forEach(sh => { sh.reads = 0; sh.writes = 0; }));
as('ana@example.com');
call('getBoard', proj.projectId, {});
const tasksSheet = ss.getSheetByName('TASKS');
check('cargar el tablero lee TASKS a lo sumo 2 veces',
  tasksSheet.reads <= 2, 'lecturas: ' + tasksSheet.reads);

Object.values(store.spreadsheets).forEach(s => s.getSheets().forEach(sh => { sh.reads = 0; sh.writes = 0; }));
as('ana@example.com');
call('moveTask', t2.taskId, 'TO_DO', 0);
check('mover una tarjeta escribe una sola fila de TASKS',
  tasksSheet.writes === 1, 'escrituras: ' + tasksSheet.writes);

console.log('\n── 13. Identidad según el modo de despliegue ───────────────');
// EXECUTE_AS_OWNER: getActiveUser() viene vacío para cuentas externas al
// dominio y getEffectiveUser() es el DUEÑO del script. Si el fallback se
// aplicara aquí, cualquier visitante anónimo entraría como administrador.
env.setEffectiveIsOwner(true);
env.setDeployMode('EXECUTE_AS_OWNER');
as('');
denied(call('getCurrentUser'),
  'EXECUTE_AS_OWNER: sin identidad NO se cae al dueño del script', 'IDENTITY_UNAVAILABLE');
as('');
denied(call('getUsers'),
  'EXECUTE_AS_OWNER: tampoco se puede administrar usuarios de forma anónima', 'IDENTITY_UNAVAILABLE');

env.setDeployMode('EXECUTE_AS_USER');
env.setEffectiveIsOwner(false);
as('');
denied(call('getCurrentUser'),
  'EXECUTE_AS_USER: sin identidad verificable también se deniega', 'IDENTITY_UNAVAILABLE');

/* ───────────────────────────────── Resumen ─────────────────────────── */

console.log('\n' + '─'.repeat(64));
console.log('Pruebas superadas: ' + passed + ' · Fallidas: ' + failed);
console.log('─'.repeat(64) + '\n');
process.exit(failed ? 1 : 0);
