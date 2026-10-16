/**
 * Utils.gs — Utilidades transversales: errores, respuestas, IDs, fechas,
 * saneamiento, validación y locking.
 */

/* ──────────────────────────────── Errores ───────────────────────────── */

/**
 * Error de aplicación: su mensaje SÍ puede mostrarse al usuario final.
 * Cualquier otra excepción se considera técnica y se enmascara.
 */
class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details || null;
  }
}

function fail_(code, message, details) {
  throw new AppError(code, message, details);
}

/** Respuesta exitosa del contrato de la API. */
function ok_(data) {
  return { success: true, data: data === undefined ? null : data };
}

/**
 * Respuesta de error. Los AppError viajan con su mensaje; el resto se
 * enmascara y el detalle técnico queda en Cloud Logging.
 */
function errResponse_(e) {
  if (e instanceof AppError) {
    Logger.log('[AppError] %s — %s %s', e.code, e.message, JSON.stringify(e.details || {}));
    return { success: false, errorCode: e.code, message: e.message };
  }
  Logger.log('[ERROR] %s\n%s', e && e.message, (e && e.stack) || '(sin stack)');
  return {
    success: false,
    errorCode: ERR.INTERNAL,
    message: 'Ocurrió un error inesperado. Inténtalo de nuevo; si persiste, avisa al administrador.'
  };
}

/* ────────────────────────────────── IDs ─────────────────────────────── */

/**
 * ID legible y ordenable por antigüedad: PRJ-LXYZ12-AB34
 * Base36 del timestamp + sufijo aleatorio (colisión despreciable y, además,
 * toda inserción ocurre dentro del lock de escritura).
 */
function newId_(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.floor(Math.random() * 1679616).toString(36).toUpperCase().padStart(4, '0');
  return prefix + '-' + ts + '-' + rnd;
}

/* ───────────────────────────────── Fechas ───────────────────────────── */

/** Instante actual en ISO-8601 UTC. */
function nowIso_() {
  return new Date().toISOString();
}

/** Fecha de hoy (YYYY-MM-DD) en la zona horaria de la aplicación. */
function todayIso_() {
  return Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Normaliza cualquier entrada a 'YYYY-MM-DD' o '' si no es una fecha válida.
 * Acepta Date, 'YYYY-MM-DD' y 'YYYY-MM-DDTHH:mm:ss...'.
 */
function toDateIso_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, APP.TIMEZONE, 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}

/** Normaliza cualquier entrada a ISO-8601 UTC completo o ''. */
function toDateTimeIso_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : value.toISOString();
  }
  const s = String(value).trim();
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    // Puede venir como 'YYYY-MM-DD': se interpreta como medianoche UTC.
    const only = toDateIso_(s);
    return only ? new Date(only + 'T00:00:00Z').toISOString() : '';
  }
  return d.toISOString();
}

/** Diferencia en días entre 'YYYY-MM-DD' y hoy. Negativo = ya pasó. */
function daysUntil_(dateIso) {
  const target = toDateIso_(dateIso);
  if (!target) return null;
  const a = new Date(target + 'T00:00:00Z').getTime();
  const b = new Date(todayIso_() + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86400000);
}

/* ─────────────────────────── Saneamiento de datos ───────────────────── */

/**
 * Texto de usuario: recorta, limita el largo y elimina caracteres de control.
 *
 * NO escapa HTML: el escape ocurre en el frontend al pintar (el dato se guarda
 * limpio y no doblemente codificado).
 *
 * Tampoco antepone una comilla a los prefijos de fórmula (= + - @): la
 * inyección de fórmulas se evita en origen, forzando formato de texto en todas
 * las columnas no numéricas al crear las hojas (ver Repo.gs). Anteponer la
 * comilla dejaría además un artefacto visible en el valor leído.
 */
function cleanText_(value, maxLen) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  const limit = maxLen || 5000;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

function cleanEmail_(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(s)) return '';
  return s;
}

function toBool_(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'si' || s === 'sí' || s === '1' || s === 'verdadero' || s === 'yes';
}

/** Entero acotado a [min, max]; devuelve `fallback` si no es numérico. */
function toPct_(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback === undefined ? 0 : fallback;
  }
  const n = Number(value);
  if (!isFinite(n)) return fallback === undefined ? 0 : fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ─────────────────────────────── Validación ─────────────────────────── */

function requireText_(value, label, maxLen) {
  const s = cleanText_(value, maxLen);
  if (!s) fail_(ERR.VALIDATION, 'El campo "' + label + '" es obligatorio.');
  return s;
}

function requireOneOf_(value, allowed, label) {
  const s = String(value || '').trim().toUpperCase();
  if (allowed.indexOf(s) === -1) {
    fail_(ERR.VALIDATION, 'Valor inválido para "' + label + '": ' + s);
  }
  return s;
}

function optionalOneOf_(value, allowed, fallback) {
  const s = String(value || '').trim().toUpperCase();
  return allowed.indexOf(s) === -1 ? fallback : s;
}

/** Valida que fechaFin no sea anterior a fechaInicio (si ambas existen). */
function checkDateRange_(startIso, endIso, labelStart, labelEnd) {
  if (startIso && endIso && endIso < startIso) {
    fail_(ERR.VALIDATION, '"' + labelEnd + '" no puede ser anterior a "' + labelStart + '".');
  }
}

/* ──────────────────────────────── Locking ───────────────────────────── */

/**
 * Serializa las escrituras. Solo envuelve operaciones de escritura: aplicar el
 * lock a las lecturas serializaría a todos los usuarios navegando.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.LOCK_TIMEOUT_MS)) {
    fail_(ERR.CONFLICT, 'El sistema está procesando otro cambio. Reintenta en unos segundos.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ──────────────────────────────── Varios ────────────────────────────── */

/** Agrupa un arreglo por el resultado de `keyFn`. */
function groupBy_(arr, keyFn) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const k = keyFn(arr[i]);
    if (!out[k]) out[k] = [];
    out[k].push(arr[i]);
  }
  return out;
}

/** Índice por clave única. */
function indexBy_(arr, keyFn) {
  const out = {};
  for (let i = 0; i < arr.length; i++) out[keyFn(arr[i])] = arr[i];
  return out;
}

/**
 * Delta entre dos objetos, restringido a `fields`.
 * Devuelve { before:{}, after:{}, changed:[...] } con solo lo que cambió.
 */
function diff_(before, after, fields) {
  const b = {}, a = {}, changed = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!Object.prototype.hasOwnProperty.call(after, f)) continue;
    const ov = before ? before[f] : undefined;
    if (String(ov === undefined || ov === null ? '' : ov) !== String(after[f] === undefined || after[f] === null ? '' : after[f])) {
      b[f] = ov === undefined ? '' : ov;
      a[f] = after[f];
      changed.push(f);
    }
  }
  return { before: b, after: a, changed: changed };
}
