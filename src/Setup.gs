/**
 * Setup.gs — Inicialización y mantenimiento de la aplicación.
 *
 * Estas funciones se ejecutan DESDE EL EDITOR de Apps Script, por el dueño del
 * proyecto. No se exponen a la Web App: quien puede ejecutarlas es quien ya
 * tiene permiso de edición sobre el script, de modo que no requieren una
 * verificación de rol adicional (y no deben llamarse desde el frontend).
 */

/**
 * Punto de entrada de la instalación. Es idempotente: se puede ejecutar varias
 * veces sin duplicar nada ni perder datos.
 *
 * Requisito previo: definir la Script Property ADMIN_EMAIL con el correo del
 * primer administrador. Ver docs/README.md.
 */
function setupApplication() {
  const log = [];

  const adminEmail = cleanEmail_(propGet_(PROP.ADMIN_EMAIL));
  if (!adminEmail) {
    throw new Error(
      'Falta la Script Property "ADMIN_EMAIL".\n' +
      'Configuración del proyecto → Propiedades del script → Agregar propiedad:\n' +
      '  ADMIN_EMAIL = tucorreo@dominio.com\n' +
      'Luego vuelve a ejecutar setupApplication().');
  }

  // 1. Spreadsheet de datos
  let ssId = propGet_(PROP.SPREADSHEET_ID);
  if (!ssId) {
    const ss = SpreadsheetApp.create(APP.NAME + ' — Datos');
    ss.setSpreadsheetTimeZone(APP.TIMEZONE);
    ssId = ss.getId();
    propSet_(PROP.SPREADSHEET_ID, ssId);
    log.push('Spreadsheet creado: ' + ss.getUrl());
  } else {
    log.push('Spreadsheet existente: ' + ssId);
  }

  const ss = getSpreadsheet_();

  // 2. Hojas y encabezados
  Object.keys(SCHEMA).forEach(key => {
    const t = table_(key);
    const existed = !!ss.getSheetByName(t.name);
    t.sheet();
    const r = t.ensureHeaders();
    log.push('Hoja ' + t.name + (existed ? ' verificada' : ' creada') +
      (r.added.length ? ' (columnas añadidas: ' + r.added.join(', ') + ')' : ''));
  });

  // 3. Eliminar SOLO la hoja vacía por defecto que crea Google.
  //    Nunca se borra una hoja desconocida con contenido: podría ser del usuario.
  const known = Object.keys(SCHEMA).map(k => SCHEMA[k].name);
  const defaultName = /^(sheet\s*1|hoja\s*1|hoja de cálculo\s*1)$/i;
  ss.getSheets().forEach(sh => {
    const name = sh.getName();
    if (known.indexOf(name) !== -1) return;
    if (!defaultName.test(name)) return;
    if (sh.getLastRow() > 0 || sh.getLastColumn() > 0) return;
    try { ss.deleteSheet(sh); log.push('Hoja vacía por defecto eliminada: ' + name); } catch (e) { /* noop */ }
  });

  // 4. Parámetros por defecto (solo las claves faltantes)
  const cfgTable = tConfig_();
  const existing = {};
  cfgTable.all().forEach(r => { existing[r.clave] = true; });
  const toAdd = CONFIG_DEFAULTS
    .filter(d => !existing[d[0]])
    .map(d => ({ clave: d[0], valor: d[1], descripcion: d[2] }));
  if (toAdd.length) {
    cfgTable.insertMany(toAdd);
    log.push('Parámetros añadidos a CONFIG: ' + toAdd.map(c => c.clave).join(', '));
  }

  // 5. Administrador inicial
  const users = tUsers_();
  const existingAdmin = users.findBy(u => u.email === adminEmail);
  if (!existingAdmin) {
    const now = nowIso_();
    users.insert({
      email: adminEmail,
      nombre: adminEmail.split('@')[0],
      rol: ROLE.ADMIN,
      activo: true,
      fechaCreacion: now,
      fechaActualizacion: now,
      ultimoAcceso: ''
    });
    log.push('Administrador inicial creado: ' + adminEmail);
  } else if (existingAdmin.rol !== ROLE.ADMIN || !existingAdmin.activo) {
    users.update(existingAdmin.userId, {
      rol: ROLE.ADMIN, activo: true, fechaActualizacion: nowIso_()
    });
    log.push('Administrador inicial reactivado: ' + adminEmail);
  } else {
    log.push('Administrador inicial ya existe: ' + adminEmail);
  }

  // 6. Protección de hojas (relevante si el Sheet se comparte con usuarios)
  log.push(protectSheets_());

  // 7. Marcar instalación
  propSet_(PROP.SETUP_DONE, 'true');

  const summary =
    '=== ' + APP.NAME + ' v' + APP.VERSION + ' — instalación completada ===\n' +
    log.map(l => ' • ' + l).join('\n') +
    '\n\nURL del spreadsheet: ' + ss.getUrl() +
    '\nModo de despliegue declarado: ' + APP.DEPLOY_MODE +
    '\n\nSiguiente paso: Implementar → Nueva implementación → Aplicación web.' +
    '\nRevisa docs/README.md §4 para la configuración correcta de "Ejecutar como" y "Acceso".';

  Logger.log(summary);
  return summary;
}

/**
 * Aplica protección de solo-advertencia a todas las hojas de datos.
 * No impide la edición manual del dueño, pero sí evita cambios accidentales y
 * deja claro que la planilla es infraestructura, no interfaz.
 */
function protectSheets_() {
  const ss = getSpreadsheet_();
  let applied = 0;
  Object.keys(SCHEMA).forEach(key => {
    const sh = ss.getSheetByName(SCHEMA[key].name);
    if (!sh) return;
    const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    if (existing && existing.length) return; // ya protegida
    try {
      sh.protect()
        .setDescription(APP.NAME + ' — datos gestionados por la aplicación')
        .setWarningOnly(true);
      applied++;
    } catch (e) {
      Logger.log('[setup] no se pudo proteger %s: %s', SCHEMA[key].name, e && e.message);
    }
  });
  return 'Protección de hojas aplicada a ' + applied + ' hoja(s).';
}

/**
 * Diagnóstico de despliegue. Ejecutar desde el editor si el acceso falla:
 * muestra si Apps Script está entregando la identidad del usuario.
 */
function diagnoseDeployment() {
  let active = '(excepción)';
  let effective = '(excepción)';
  try { active = Session.getActiveUser().getEmail() || '(vacío)'; } catch (e) { active = 'ERROR: ' + e.message; }
  try { effective = Session.getEffectiveUser().getEmail() || '(vacío)'; } catch (e) { effective = 'ERROR: ' + e.message; }

  const out = [
    'DEPLOY_MODE declarado : ' + APP.DEPLOY_MODE,
    'SPREADSHEET_ID        : ' + (propGet_(PROP.SPREADSHEET_ID) || '(no configurado)'),
    'ADMIN_EMAIL           : ' + (propGet_(PROP.ADMIN_EMAIL) || '(no configurado)'),
    'SETUP_DONE            : ' + (propGet_(PROP.SETUP_DONE) || 'false'),
    'getActiveUser()       : ' + active,
    'getEffectiveUser()    : ' + effective,
    'Usuarios registrados  : ' + tUsers_().all().length,
    '',
    'Si getActiveUser() aparece vacío al usar la Web App, el despliegue está',
    'en "Ejecutar como: yo" con acceso externo al dominio. Cambia a',
    '"Ejecutar como: el usuario que accede" y pon DEPLOY_MODE = EXECUTE_AS_USER.'
  ].join('\n');

  Logger.log(out);
  return out;
}

/** Limpia la caché de datos. Útil tras editar la planilla a mano. */
function clearDataCache() {
  Object.keys(SCHEMA).forEach(key => {
    const name = SCHEMA[key].name;
    propSet_(PROP.VERSION_PREFIX + name, Number(propGet_(PROP.VERSION_PREFIX + name) || '0') + 1);
  });
  const msg = 'Caché invalidada para todas las hojas.';
  Logger.log(msg);
  return msg;
}

/**
 * Archiva en AUDIT_LOG_ARCHIVE los registros de auditoría con más de `days`
 * días. Pensado para un activador mensual cuando la hoja crece.
 */
function archiveAuditLog(days) {
  const limitDays = days || 180;
  return withLock_(() => {
    const t = tAudit_();
    const cutoff = new Date(Date.now() - limitDays * 86400000).toISOString();
    const old = t.all().filter(r => r.fecha && r.fecha < cutoff);
    if (!old.length) return 'No hay registros de auditoría que archivar.';

    const ss = getSpreadsheet_();
    const archName = 'AUDIT_LOG_ARCHIVE';
    let arch = ss.getSheetByName(archName);
    if (!arch) {
      arch = ss.insertSheet(archName);
      arch.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setFontWeight('bold');
      arch.setFrozenRows(1);
    }
    const matrix = old.map(r => t.headers.map(h => coerceWrite_(r[h], t.types[h])));
    arch.getRange(arch.getLastRow() + 1, 1, matrix.length, t.headers.length).setValues(matrix);

    // Borrado físico solo en auditoría ya archivada, de abajo hacia arriba.
    const sh = t.sheet();
    old.map(r => r._row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
    t._invalidate();

    return 'Archivados ' + old.length + ' registros de auditoría (> ' + limitDays + ' días).';
  });
}
