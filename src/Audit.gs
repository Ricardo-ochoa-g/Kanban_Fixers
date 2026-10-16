/**
 * Audit.gs — Registro de auditoría.
 *
 * Se guarda únicamente el delta de campos modificados (en JSON). Registrar el
 * objeto completo multiplicaría el tamaño de la hoja sin aportar información.
 *
 * La auditoría nunca debe hacer fallar la operación de negocio: si la escritura
 * del log falla, se registra en Cloud Logging y la operación continúa.
 */

const ACTION = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  RESTORE: 'RESTORE',
  MOVE: 'MOVE',
  COMMENT: 'COMMENT',
  STATUS_CHANGE: 'STATUS_CHANGE',
  ASSIGN: 'ASSIGN',
  PROGRESS: 'PROGRESS',
  ROLE_CHANGE: 'ROLE_CHANGE',
  TOGGLE_STATUS: 'TOGGLE_STATUS',
  CONFIG: 'CONFIG'
};

const ENTITY = {
  PROJECT: 'PROJECT',
  TASK: 'TASK',
  SUBTASK: 'SUBTASK',
  COMMENT: 'COMMENT',
  USER: 'USER',
  CONFIG: 'CONFIG'
};

/**
 * Escribe una entrada de auditoría.
 * @param {Object} user     Usuario autenticado.
 * @param {string} accion   ACTION.*
 * @param {string} entidad  ENTITY.*
 * @param {string} entityId Id de la entidad afectada.
 * @param {Object} before   Valores anteriores (solo campos cambiados) o null.
 * @param {Object} after    Valores nuevos (solo campos cambiados) o null.
 */
function audit_(user, accion, entidad, entityId, before, after) {
  try {
    tAudit_().insert({
      userId: user ? user.userId : '',
      email: user ? user.email : '',
      accion: accion,
      entidad: entidad,
      entityId: entityId || '',
      valorAnterior: before && Object.keys(before).length ? before : '',
      valorNuevo: after && Object.keys(after).length ? after : '',
      fecha: nowIso_()
    });
  } catch (e) {
    Logger.log('[audit] no se pudo registrar %s/%s %s: %s', accion, entidad, entityId, e && e.message);
  }
}

/** Varias entradas en una sola escritura. */
function auditMany_(user, entries) {
  if (!entries || !entries.length) return;
  try {
    const now = nowIso_();
    tAudit_().insertMany(entries.map(e => ({
      userId: user ? user.userId : '',
      email: user ? user.email : '',
      accion: e.accion,
      entidad: e.entidad,
      entityId: e.entityId || '',
      valorAnterior: e.before && Object.keys(e.before).length ? e.before : '',
      valorNuevo: e.after && Object.keys(e.after).length ? e.after : '',
      fecha: now
    })));
  } catch (err) {
    Logger.log('[audit] lote fallido: %s', err && err.message);
  }
}

/**
 * Consulta de auditoría global (solo ADMIN).
 * filters: { entidad, accion, email, desde, hasta, entityId, texto, limit }
 */
function auditQuery_(filters) {
  const f = filters || {};
  const limit = Math.min(Number(f.limit) || 200, APP.AUDIT_MAX_ROWS);
  const desde = toDateIso_(f.desde);
  const hasta = toDateIso_(f.hasta);
  const texto = String(f.texto || '').trim().toLowerCase();

  let rows = tAudit_().all();

  rows = rows.filter(r => {
    if (f.entidad && r.entidad !== f.entidad) return false;
    if (f.accion && r.accion !== f.accion) return false;
    if (f.email && r.email !== String(f.email).toLowerCase()) return false;
    if (f.entityId && r.entityId !== f.entityId) return false;
    if (desde && (r.fecha || '').slice(0, 10) < desde) return false;
    if (hasta && (r.fecha || '').slice(0, 10) > hasta) return false;
    if (texto) {
      const hay = (r.accion + ' ' + r.entidad + ' ' + r.entityId + ' ' + r.email + ' ' +
        JSON.stringify(r.valorAnterior || '') + ' ' + JSON.stringify(r.valorNuevo || '')).toLowerCase();
      if (hay.indexOf(texto) === -1) return false;
    }
    return true;
  });

  // Desempate por nº de fila: auditMany_ escribe varias entradas con la misma
  // marca de tiempo y deben listarse en su orden real.
  rows.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b._row - a._row));
  const total = rows.length;

  return {
    total: total,
    rows: rows.slice(0, limit).map(stripRow_),
    truncated: total > limit
  };
}

/**
 * Historial de UNA entidad, formateado para mostrarse en el detalle de tarea.
 * Accesible para el rol USER (permiso audit.read.entity).
 */
function auditForEntity_(entidad, entityId, limit) {
  const max = Math.min(Number(limit) || 50, 200);
  const names = userNamesByEmail_();
  return tAudit_().all()
    .filter(r => r.entidad === entidad && r.entityId === entityId)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b._row - a._row))
    .slice(0, max)
    .map(r => ({
      logId: r.logId,
      accion: r.accion,
      email: r.email,
      autor: names[r.email] || r.email,
      fecha: r.fecha,
      before: r.valorAnterior || null,
      after: r.valorNuevo || null
    }));
}

/** Quita los campos internos antes de enviar al frontend. */
function stripRow_(row) {
  const out = {};
  Object.keys(row).forEach(k => { if (k !== '_row') out[k] = row[k]; });
  return out;
}

/** Mapa email → nombre, para mostrar autores sin consultas extra. */
let _userNamesMemo = null;
function userNamesByEmail_() {
  if (_userNamesMemo) return _userNamesMemo;
  _userNamesMemo = {};
  tUsers_().all().forEach(u => { _userNamesMemo[u.email] = u.nombre || u.email; });
  return _userNamesMemo;
}
