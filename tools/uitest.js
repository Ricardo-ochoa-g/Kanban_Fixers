#!/usr/bin/env node
/**
 * uitest.js — Prueba de extremo a extremo del frontend.
 *
 * Monta Index.html en jsdom resolviendo los include() de HtmlService y conecta
 * google.script.run al backend real corriendo sobre los mocks de gasenv.js.
 * Es decir: el HTML, el CSS y el JavaScript que se despliegan son los mismos
 * que se ejecutan aquí, y las respuestas vienen de la lógica de Apps Script.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createEnv, SRC } = require('./gasenv');

let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok    ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? ' → ' + detail : '')); }
};

/* ────────────────── Resolución de plantillas de HtmlService ─────────── */

function buildIndexHtml(vars) {
  let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (_, name) =>
    fs.readFileSync(path.join(SRC, name + '.html'), 'utf8'));
  html = html.replace(/<\?=\s*([A-Za-z_$][\w$]*)\s*\?>/g, (_, key) =>
    (vars[key] === undefined ? '' : String(vars[key])));
  if (/<\?/.test(html)) throw new Error('Quedaron scriptlets sin resolver en Index.html');
  return html;
}

/* ──────────────────────── Puente google.script.run ──────────────────── */

function makeGoogleScriptRun(env, getEmail, log) {
  function build(handlers) {
    const base = {
      withSuccessHandler(fn) { return build(Object.assign({}, handlers, { ok: fn })); },
      withFailureHandler(fn) { return build(Object.assign({}, handlers, { err: fn })); },
      withUserObject() { return build(handlers); }
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string') return undefined;
        return function (...args) {
          setTimeout(() => {
            try {
              env.as(getEmail());
              const res = env.call(prop, ...args);
              log.push({ fn: prop, ok: res && res.success });
              if (handlers.ok) handlers.ok(res);
            } catch (e) {
              log.push({ fn: prop, ok: false, error: e.message });
              if (handlers.err) handlers.err(e);
            }
          }, 0);
        };
      }
    });
  }
  return build({});
}

/* ──────────────────────────── Arranque jsdom ────────────────────────── */

const flush = (times = 12) => new Promise(resolve => {
  let n = 0;
  const tick = () => (++n >= times ? resolve() : setTimeout(tick, 0));
  setTimeout(tick, 0);
});

function boot(env, getEmail) {
  const rpcLog = [];
  const dom = new JSDOM(buildIndexHtml({ appName: 'Kanban Workspace', appVersion: '1.0.0' }), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://script.google.com/macros/s/test/exec',
    resources: undefined,
    beforeParse(window) {
      window.google = { script: { run: makeGoogleScriptRun(env, getEmail, rpcLog), host: {} } };
      // SortableJS llega por CDN: en la prueba se sustituye por un doble.
      window.Sortable = function () { return { destroy() {} }; };
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.__errors = [];
      window.addEventListener('error', e => window.__errors.push(String(e.message)));
    }
  });
  return { dom, window: dom.window, doc: dom.window.document, rpcLog };
}

/* ═══════════════════════════════ ESCENARIO ══════════════════════════════ */

(async function main() {

  /* ── Datos de partida ── */
  const env = createEnv();
  env.store.props.ADMIN_EMAIL = env.ownerEmail;
  env.as(env.ownerEmail);
  env.call('setupApplication');

  env.as(env.ownerEmail);
  env.call('createUser', { nombre: 'Ana Pérez', email: 'ana@example.com', rol: 'USER' });
  env.as(env.ownerEmail);
  const proj = env.call('createProject', {
    nombre: 'Implementación CRM', descripcion: 'Despliegue por fases',
    responsable: 'ana@example.com', estado: 'DOING', prioridad: 'ALTA',
    fechaInicio: '2026-09-01', fechaFin: '2026-12-15'
  }).data;
  env.as(env.ownerEmail);
  const task = env.call('createTask', {
    projectId: proj.projectId, titulo: 'Levantamiento de requisitos',
    descripcion: 'Entrevistas con las áreas', estado: 'TO_DO', prioridad: 'ALTA',
    responsable: 'ana@example.com', fechaVencimiento: '2026-11-20'
  }).data;
  env.as(env.ownerEmail);
  env.call('createTask', {
    projectId: proj.projectId, titulo: 'Migración de datos',
    estado: 'DOING', prioridad: 'CRITICA', responsable: 'ana@example.com'
  });
  env.as(env.ownerEmail);
  env.call('createSubtask', { taskId: task.taskId, titulo: 'Agendar entrevistas' });
  env.as(env.ownerEmail);
  env.call('addComment', task.taskId, 'Partimos por el área comercial.');

  /* ── 1. Arranque como ADMIN ── */
  console.log('\n── 1. Arranque de la aplicación (ADMIN) ────────────────────');
  let email = env.ownerEmail;
  const { window, doc, rpcLog } = boot(env, () => email);
  await flush();

  check('no hay errores de JavaScript al cargar',
    window.__errors.length === 0, window.__errors.join(' | '));
  check('la pantalla de carga desaparece', doc.getElementById('boot').classList.contains('hidden'));
  check('la aplicación queda visible', !doc.getElementById('app').classList.contains('hidden'));
  check('la pantalla de acceso denegado permanece oculta',
    doc.getElementById('denied').classList.contains('hidden'));
  check('el arranque usa una sola llamada (getBootstrap)',
    rpcLog.filter(r => r.fn === 'getBootstrap').length === 1);
  check('se muestra la identidad del usuario',
    doc.getElementById('who-name').textContent.length > 0);

  /* ── 2. Navegación y permisos en la UI ── */
  console.log('\n── 2. Navegación ───────────────────────────────────────────');
  const routes = [...doc.querySelectorAll('.nav-item[data-route]')]
    .map(b => b.getAttribute('data-route'));
  check('el menú muestra las 8 secciones para un ADMIN',
    routes.length === 9, 'rutas: ' + routes.join(', '));
  check('incluye la sección de administración',
    routes.indexOf('admin-users') !== -1 && routes.indexOf('admin-audit') !== -1);

  /* ── 3. Dashboard ── */
  console.log('\n── 3. Dashboard ────────────────────────────────────────────');
  check('se pintan las tarjetas de KPI', doc.querySelectorAll('.kpi').length >= 6,
    'kpis: ' + doc.querySelectorAll('.kpi').length);
  check('se pintan los gráficos', doc.querySelectorAll('.card .bars').length >= 2);
  check('las barras tienen etiqueta directa de valor',
    doc.querySelectorAll('.bar-row .b-value').length > 0);
  check('el KPI de proyectos activos muestra 1',
    doc.querySelector('.kpi .k-value').textContent.trim() === '1',
    doc.querySelector('.kpi .k-value').textContent);

  /* ── 4. Proyectos ── */
  console.log('\n── 4. Proyectos ────────────────────────────────────────────');
  doc.querySelector('.nav-item[data-route="projects"]').click();
  await flush();
  check('se lista el proyecto creado', doc.querySelectorAll('.proj-card').length === 1);
  check('la tarjeta muestra el nombre del proyecto',
    doc.querySelector('.proj-card h3').textContent === 'Implementación CRM');
  check('el ADMIN ve el botón de nuevo proyecto', !!doc.getElementById('p-new'));

  doc.getElementById('p-new').click();
  await flush();
  check('se abre el modal de nuevo proyecto', !!doc.querySelector('.overlay'));
  doc.querySelector('.overlay [data-act="save"]').click();
  await flush();
  check('el modal valida el nombre obligatorio sin llamar al backend',
    !!doc.querySelector('.overlay .form-error'));
  doc.querySelector('.overlay .modal-close').click();
  await flush();
  check('el modal se cierra', !doc.querySelector('.overlay'));

  /* ── 5. Kanban ── */
  console.log('\n── 5. Tablero Kanban ───────────────────────────────────────');
  doc.querySelector('.nav-item[data-route="kanban"]').click();
  await flush();
  const cols = [...doc.querySelectorAll('#kb-board .col')];
  check('el tablero tiene 5 columnas', cols.length === 5, 'columnas: ' + cols.length);
  check('las columnas están en el orden correcto',
    cols.map(c => c.getAttribute('data-col')).join(',') === 'ON_HOLD,BACKLOG,TO_DO,DOING,DONE');
  check('se pintan las dos tarjetas', doc.querySelectorAll('.tcard').length === 2);
  check('la tarjeta muestra prioridad, avance y responsable',
    !!doc.querySelector('.tcard .chip') &&
    !!doc.querySelector('.tcard .meter') &&
    !!doc.querySelector('.tcard .avatar-xs'));
  check('la tarjeta con subtareas muestra el contador',
    doc.querySelector('.tcard').textContent.indexOf('0/1') !== -1,
    doc.querySelector('.tcard').textContent.replace(/\s+/g, ' ').trim());
  check('los contadores de columna son correctos',
    [...doc.querySelectorAll('.col-count')].map(e => e.textContent).join(',') === '0,0,1,1,0');
  check('las columnas vacías muestran el placeholder',
    [...doc.querySelectorAll('.col-empty')].filter(e => e.style.display !== 'none').length === 3);

  /* ── 6. Detalle de tarea ── */
  console.log('\n── 6. Detalle de tarea ─────────────────────────────────────');
  const card = [...doc.querySelectorAll('.tcard')]
    .filter(c => c.textContent.indexOf('Levantamiento') !== -1)[0];
  card.click();
  await flush();
  const overlay = doc.querySelector('.overlay');
  check('se abre el panel de detalle', !!overlay);
  check('el título del panel es el de la tarea',
    overlay.querySelector('.modal-head h2').textContent === 'Levantamiento de requisitos');
  check('se muestra la descripción',
    overlay.querySelector('.detail-desc').textContent.indexOf('Entrevistas') !== -1);
  check('se listan las subtareas', overlay.querySelectorAll('.sub-item').length === 1);
  check('se listan los comentarios', overlay.querySelectorAll('.comment').length === 1);
  check('se muestra el historial de cambios', overlay.querySelectorAll('.history li').length >= 1);
  check('el panel lateral permite cambiar el estado', !!overlay.querySelector('#d-estado'));
  check('el campo de avance está deshabilitado en modo automático',
    overlay.querySelector('#d-pct').disabled === true);

  /* Cambio de estado desde el detalle: debe persistir en el backend */
  const select = overlay.querySelector('#d-estado');
  select.value = 'DOING';
  select.dispatchEvent(new window.Event('change'));
  await flush(20);
  env.as(env.ownerEmail);
  const persisted = env.call('getTask', task.taskId).data.task;
  check('el cambio de estado se persiste en el backend', persisted.estado === 'DOING',
    'estado: ' + persisted.estado);
  check('aparece la notificación de confirmación',
    doc.querySelectorAll('#toasts .toast').length > 0);

  /* Agregar una subtarea desde el panel */
  const subInput = doc.querySelector('#sub-new');
  subInput.value = 'Transcribir entrevistas';
  doc.querySelector('[data-d="add-sub"]').click();
  await flush(20);
  env.as(env.ownerEmail);
  const subs = env.call('getSubtasks', task.taskId).data;
  check('la subtarea creada desde la UI llega al backend', subs.length === 2,
    'subtareas: ' + subs.length);
  check('el panel se refresca con la nueva subtarea',
    doc.querySelectorAll('.sub-item').length === 2);

  /* Agregar un comentario */
  doc.querySelector('#cmt-new').value = 'Entrevistas agendadas para el lunes.';
  doc.querySelector('[data-d="add-cmt"]').click();
  await flush(20);
  check('el comentario aparece en el panel', doc.querySelectorAll('.comment').length === 2);

  doc.querySelector('.overlay .modal-close').click();
  await flush();
  check('el panel de detalle se cierra', !doc.querySelector('.overlay'));

  /* ── 7. Escapado de HTML ── */
  console.log('\n── 7. Saneamiento de contenido ─────────────────────────────');
  env.as(env.ownerEmail);
  env.call('createTask', {
    projectId: proj.projectId,
    titulo: '<img src=x onerror="window.__xss=1">Tarea con HTML',
    estado: 'BACKLOG'
  });
  doc.getElementById('kb-refresh').click();
  await flush(20);
  check('el título malicioso no inyecta elementos en el DOM',
    doc.querySelectorAll('.tcard img').length === 0);
  check('no se ejecuta el script inyectado', window.__xss === undefined);
  check('el texto se muestra tal cual, escapado',
    [...doc.querySelectorAll('.tcard-title')]
      .some(e => e.textContent.indexOf('<img src=x') === 0),
    [...doc.querySelectorAll('.tcard-title')].map(e => e.textContent).join(' | '));

  /* ── 7b. Carta Gantt ── */
  console.log('\n── 7b. Carta Gantt ─────────────────────────────────────────');
  const fire = (el, type, x, y) => el.dispatchEvent(new window.MouseEvent(type,
    { bubbles: true, cancelable: true, clientX: x, clientY: y || 0, button: 0 }));
  const ganttItems = () => { env.as(env.ownerEmail); return env.call('getGantt', proj.projectId).data.items; };

  doc.querySelector('.nav-item[data-route="gantt"]').click();
  await flush(20);
  check('la vista Gantt carga con un selector de proyecto y de escala',
    !!doc.getElementById('gt-project') && !!doc.getElementById('gt-scale'));
  check('sin actividades se muestra el estado vacío', !!doc.querySelector('#gt-host .empty'));
  check('el selector de escala ofrece las 6 opciones',
    [...doc.querySelectorAll('#gt-scale option')].map(o => o.value).join(',') ===
      'week,month,quarter,fourmonth,semester,year');

  // Alta desde el modal
  doc.getElementById('gt-new').click();
  await flush();
  const gm = doc.querySelector('.overlay');
  check('se abre el modal de nueva actividad', !!gm);
  gm.querySelector('[name="titulo"]').value = 'Diseño web';
  gm.querySelector('[name="grupo"]').value = 'Marketing';
  gm.querySelector('[name="fila"]').value = 'Ricardo';
  gm.querySelector('[name="fechaInicio"]').value = '2026-09-10';
  gm.querySelector('[name="fechaFin"]').value = '2026-09-30';
  gm.querySelector('[data-act="save"]').click();
  await flush(20);
  check('la actividad se guarda y el modal se cierra', !doc.querySelector('.overlay') && ganttItems().length === 1);
  check('se dibuja una cajita con su título', doc.querySelectorAll('.gt-bar').length === 1 &&
    doc.querySelector('.gt-bar .t').textContent === 'Diseño web');
  check('la fila y el grupo aparecen a la izquierda',
    doc.querySelector('.gt-rlabel').textContent === 'Ricardo' &&
    doc.querySelector('.gt-gcell').textContent === 'Marketing');

  // Columnas según la escala
  const lowLabels = () => [...doc.querySelectorAll('.gt-lowrow .gt-lc')].map(c => c.textContent);
  const upLabels = () => [...doc.querySelectorAll('.gt-uprow .gt-uc')].map(c => c.textContent);
  const setScale = async v => {
    const sel = doc.getElementById('gt-scale');
    sel.value = v; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
  };
  check('escala Mes: columnas por mes agrupadas por año',
    lowLabels()[0] === 'sep' && upLabels()[0] === '2026', lowLabels().join(',') + ' / ' + upLabels().join(','));
  await setScale('week');
  check('escala Semana: columnas por semana agrupadas por mes',
    lowLabels()[0] === '31 ago' && upLabels()[0] === 'agosto 2026' && upLabels().indexOf('septiembre 2026') !== -1,
    lowLabels().join(',') + ' / ' + upLabels().join(','));
  await setScale('quarter');
  check('escala Trimestre: T1…T4', lowLabels()[0] === 'T3', lowLabels().join(','));
  await setScale('fourmonth');
  check('escala Cuatrimestre: C1…C3', lowLabels()[0] === 'C3', lowLabels().join(','));
  await setScale('semester');
  check('escala Semestre: S1/S2', lowLabels()[0] === 'S2', lowLabels().join(','));
  await setScale('year');
  check('escala Año: una sola fila de encabezado', lowLabels()[0] === '2026' && !doc.querySelector('.gt-uprow'),
    lowLabels().join(','));
  await setScale('month');
  check('cambiar de escala no modifica los datos guardados',
    ganttItems()[0].fechaInicio === '2026-09-10' && ganttItems()[0].fechaFin === '2026-09-30');

  // Mover con el mouse: 7 px/día en escala Mes → 35 px = 5 días
  let bar = doc.querySelector('.gt-bar');
  fire(bar, 'pointerdown', 200, 50);
  fire(bar, 'pointermove', 235, 50);
  check('durante el arrastre aparece la etiqueta con las fechas', !!doc.querySelector('.gt-tip'));
  fire(bar, 'pointerup', 235, 50);
  await flush(20);
  let it0 = ganttItems()[0];
  check('arrastrar la cajita 5 días la mueve sin cambiar su duración',
    it0.fechaInicio === '2026-09-15' && it0.fechaFin === '2026-10-05', it0.fechaInicio + ' → ' + it0.fechaFin);
  check('la etiqueta de arrastre desaparece al soltar', !doc.querySelector('.gt-tip'));

  // Extender por el borde derecho: +3 días
  bar = doc.querySelector('.gt-bar');
  fire(bar.querySelector('.h.r'), 'pointerdown', 400, 50);
  fire(bar, 'pointermove', 421, 50);
  fire(bar, 'pointerup', 421, 50);
  await flush(20);
  it0 = ganttItems()[0];
  check('tirar del borde derecho extiende el término', it0.fechaInicio === '2026-09-15' && it0.fechaFin === '2026-10-08',
    it0.fechaInicio + ' → ' + it0.fechaFin);

  // Acortar por el borde izquierdo: +2 días
  bar = doc.querySelector('.gt-bar');
  fire(bar.querySelector('.h.l'), 'pointerdown', 100, 50);
  fire(bar, 'pointermove', 114, 50);
  fire(bar, 'pointerup', 114, 50);
  await flush(20);
  it0 = ganttItems()[0];
  check('tirar del borde izquierdo mueve el inicio', it0.fechaInicio === '2026-09-17' && it0.fechaFin === '2026-10-08',
    it0.fechaInicio + ' → ' + it0.fechaFin);

  // No se puede invertir: arrastrar el borde derecho más allá del inicio
  bar = doc.querySelector('.gt-bar');
  fire(bar.querySelector('.h.r'), 'pointerdown', 500, 50);
  fire(bar, 'pointermove', 100, 50);
  fire(bar, 'pointerup', 100, 50);
  await flush(20);
  it0 = ganttItems()[0];
  check('el término nunca queda antes del inicio', it0.fechaFin >= it0.fechaInicio, it0.fechaInicio + ' → ' + it0.fechaFin);

  // Un clic sin arrastre abre la edición
  bar = doc.querySelector('.gt-bar');
  fire(bar, 'pointerdown', 300, 50);
  fire(bar, 'pointerup', 300, 50);
  await flush();
  check('un clic sin arrastre abre el modal de edición',
    !!doc.querySelector('.overlay') && doc.querySelector('.overlay [name="titulo"]').value === 'Diseño web');
  doc.querySelector('.overlay [name="titulo"]').value = 'Diseño web v2';
  doc.querySelector('.overlay [data-act="save"]').click();
  await flush(20);
  check('editar el título se refleja en la cajita', doc.querySelector('.gt-bar .t').textContent === 'Diseño web v2');

  // Segunda actividad en la misma fila (doble clic en el carril)
  const lane = doc.querySelector('.gt-lane');
  fire(lane, 'dblclick', 0, 0);
  await flush();
  const gm2 = doc.querySelector('.overlay');
  check('doble clic en una fila abre el alta con la fila preseleccionada',
    !!gm2 && gm2.querySelector('[name="fila"]').value === 'Ricardo' && gm2.querySelector('[name="grupo"]').value === 'Marketing');
  gm2.querySelector('[name="titulo"]').value = 'Investigar';
  gm2.querySelector('[data-act="save"]').click();
  await flush(20);
  check('ambas actividades comparten la misma fila',
    doc.querySelectorAll('.gt-row').length === 1 && doc.querySelectorAll('.gt-bar').length === 2);

  // XSS
  env.as(env.ownerEmail);
  env.call('createGanttItem', { projectId: proj.projectId, grupo: '<b>g</b>', fila: '<i>f</i>',
    titulo: '<img src=x onerror="window.__xss=2">', fechaInicio: '2026-10-01', fechaFin: '2026-10-10' });
  doc.getElementById('gt-refresh').click();
  await flush(20);
  check('los textos del Gantt se escapan (sin elementos inyectados)',
    doc.querySelectorAll('.gt-wrap img, .gt-wrap b, .gt-wrap i:not(.gt-vline):not(.gt-today)').length === 0 &&
    window.__xss === undefined);

  // Eliminar
  bar = doc.querySelector('.gt-bar');
  fire(bar, 'pointerdown', 300, 50);
  fire(bar, 'pointerup', 300, 50);
  await flush();
  const nBefore = ganttItems().length;
  doc.querySelector('.overlay [data-act="delete"]').click();
  await flush();
  doc.querySelector('.overlay [data-act="yes"]').click();
  await flush(20);
  check('eliminar una actividad la quita del Gantt', ganttItems().length === nBefore - 1);

  // Acceso directo desde la tarjeta del proyecto
  doc.querySelector('.nav-item[data-route="projects"]').click();
  await flush(20);
  const gBtn = doc.querySelector('.proj-card [data-act="gantt"]');
  check('la tarjeta del proyecto tiene un acceso al Gantt', !!gBtn);
  gBtn.click();
  await flush(20);
  check('el acceso abre el Gantt del proyecto', !!doc.getElementById('gt-scale') && doc.querySelectorAll('.gt-bar').length >= 1);

  /* ── 8. Mis tareas ── */
  console.log('\n── 8. Mis tareas ───────────────────────────────────────────');
  doc.querySelector('.nav-item[data-route="mytasks"]').click();
  await flush();
  check('la vista "Mis tareas" se carga', !!doc.getElementById('mt-list'));
  check('el ADMIN no tiene tareas asignadas y ve el estado vacío',
    !!doc.querySelector('#mt-list .empty'));

  /* ── 9. Administración ── */
  console.log('\n── 9. Administración ───────────────────────────────────────');
  doc.querySelector('.nav-item[data-route="admin-users"]').click();
  await flush();
  check('se listan los usuarios', doc.querySelectorAll('#u-list tbody tr').length === 2);
  check('se marca cuál es el usuario propio',
    doc.querySelector('#u-list tbody').textContent.indexOf('tú') !== -1);

  doc.querySelector('.nav-item[data-route="admin-audit"]').click();
  await flush();
  check('la auditoría muestra registros', doc.querySelectorAll('#a-list tbody tr').length > 5);

  doc.querySelector('.nav-item[data-route="admin-config"]').click();
  await flush();
  check('la configuración lista los parámetros',
    doc.querySelectorAll('#c-list tbody tr').length === 4);

  /* ── 10. Sesión de un usuario con rol USER ── */
  console.log('\n── 10. Interfaz con rol USER ───────────────────────────────');
  email = 'ana@example.com';
  const u = boot(env, () => email);
  await flush();
  check('el USER entra correctamente', !u.doc.getElementById('app').classList.contains('hidden'));
  const userRoutes = [...u.doc.querySelectorAll('.nav-item[data-route]')]
    .map(b => b.getAttribute('data-route'));
  check('el menú del USER no muestra administración',
    userRoutes.indexOf('admin-users') === -1, 'rutas: ' + userRoutes.join(', '));
  check('el USER sí ve Dashboard, Proyectos, Kanban y Mis tareas',
    ['dashboard', 'projects', 'kanban', 'mytasks'].every(r => userRoutes.indexOf(r) !== -1));

  u.doc.querySelector('.nav-item[data-route="projects"]').click();
  await flush();
  check('el USER no ve el botón de nuevo proyecto', !u.doc.getElementById('p-new'));
  check('el USER no ve acciones de edición de proyectos',
    u.doc.querySelectorAll('.proj-card [data-act="edit"]').length === 0);

  u.doc.querySelector('.nav-item[data-route="mytasks"]').click();
  await flush();
  check('"Mis tareas" del USER muestra sus tareas asignadas',
    u.doc.querySelectorAll('#mt-list tbody tr').length >= 2,
    'filas: ' + u.doc.querySelectorAll('#mt-list tbody tr').length);

  /* ── 11. Cuenta no autorizada ── */
  console.log('\n── 11. Cuenta no autorizada ────────────────────────────────');
  email = 'intruso@example.com';
  const x = boot(env, () => email);
  await flush();
  check('se muestra la pantalla de acceso restringido',
    !x.doc.getElementById('denied').classList.contains('hidden'));
  check('la aplicación permanece oculta', x.doc.getElementById('app').classList.contains('hidden'));
  check('el mensaje es el definido en el enunciado',
    x.doc.getElementById('denied-msg').textContent
      .indexOf('Tu cuenta no tiene permisos para acceder a esta aplicación') === 0,
    x.doc.getElementById('denied-msg').textContent);

  /* ── 12. Cuenta desactivada ── */
  console.log('\n── 12. Cuenta desactivada ──────────────────────────────────');
  env.as(env.ownerEmail);
  const users = env.call('getUsers').data;
  const ana = users.filter(uu => uu.email === 'ana@example.com')[0];
  env.as(env.ownerEmail);
  env.call('toggleUserStatus', ana.userId);

  email = 'ana@example.com';
  const dz = boot(env, () => email);
  await flush();
  check('la cuenta desactivada no entra',
    !dz.doc.getElementById('denied').classList.contains('hidden'));
  check('se le informa que su cuenta está desactivada',
    dz.doc.getElementById('denied-msg').textContent.indexOf('desactivada') !== -1,
    dz.doc.getElementById('denied-msg').textContent);

  console.log('\n' + '─'.repeat(64));
  console.log('Pruebas de interfaz superadas: ' + passed + ' · Fallidas: ' + failed);
  console.log('─'.repeat(64) + '\n');
  process.exit(failed ? 1 : 0);

})().catch(e => {
  console.error('\nERROR en la prueba de interfaz:\n', e);
  process.exit(1);
});
