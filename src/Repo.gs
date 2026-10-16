/**
 * Repo.gs — Capa de acceso a datos.
 *
 * Toda la aplicación habla con el datastore a través de la clase Table.
 * Ningún otro archivo invoca SpreadsheetApp. Esa es la razón por la que
 * cambiar Sheets por Firestore más adelante solo obliga a reescribir este
 * archivo (ver docs/ARCHITECTURE.md §6).
 *
 * Reglas duras:
 *   · Una lectura por hoja y por ejecución (memoizada), servida desde
 *     CacheService cuando hay versión vigente.
 *   · Escrituras en bloque. Prohibido getRange() dentro de un bucle.
 *   · La caché se invalida por versión de datos, no por TTL.
 */

/* ───────────────────────── Script Properties ────────────────────────── */

let _propsStore = null;
let _propsMemo = null;

function propsStore_() {
  if (!_propsStore) _propsStore = PropertiesService.getScriptProperties();
  return _propsStore;
}

/** Lee todas las Script Properties una sola vez por ejecución. */
function propsAll_() {
  if (!_propsMemo) _propsMemo = propsStore_().getProperties() || {};
  return _propsMemo;
}

/**
 * Relee las Script Properties desde el servicio. Necesario dentro de un lock de
 * escritura: otra ejecución pudo haber incrementado la versión de datos después
 * de que esta ejecución memoizara las propiedades.
 */
function propsRefresh_() {
  _propsMemo = propsStore_().getProperties() || {};
  return _propsMemo;
}

function propGet_(key) {
  const v = propsAll_()[key];
  return v === undefined ? null : v;
}

function propSet_(key, value) {
  propsStore_().setProperty(key, String(value));
  propsAll_()[key] = String(value);
}

/* ───────────────────────────── Spreadsheet ──────────────────────────── */

let _ss = null;

function getSpreadsheet_() {
  if (_ss) return _ss;
  const id = propGet_(PROP.SPREADSHEET_ID);
  if (!id) {
    fail_(ERR.NOT_CONFIGURED,
      'La aplicación aún no está inicializada. El administrador debe ejecutar setupApplication().');
  }
  try {
    _ss = SpreadsheetApp.openById(id);
  } catch (e) {
    fail_(ERR.NOT_CONFIGURED,
      'No se pudo abrir la planilla de datos. Verifica el SPREADSHEET_ID y los permisos de acceso.');
  }
  return _ss;
}

/* ───────────────────────── Caché fragmentada ────────────────────────── */

function cacheKey_(sheetName) {
  const version = propGet_(PROP.VERSION_PREFIX + sheetName) || '0';
  return 't:' + sheetName + ':' + version;
}

function cacheGet_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(key + ':n');
    if (!meta) return null;
    const n = Number(meta);
    if (!isFinite(n) || n < 1) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + ':' + i);
    const parts = cache.getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) {
      const p = parts[key + ':' + i];
      if (p === undefined || p === null) return null; // fragmento expirado
      s += p;
    }
    return JSON.parse(s);
  } catch (e) {
    Logger.log('[cache] lectura fallida: %s', e && e.message);
    return null;
  }
}

function cachePut_(key, payload) {
  try {
    const s = JSON.stringify(payload);
    const size = APP.CACHE_CHUNK_CHARS;
    const n = Math.max(1, Math.ceil(s.length / size));
    if (n > APP.CACHE_MAX_CHUNKS) return; // demasiado grande: se lee del Sheet
    const map = {};
    for (let i = 0; i < n; i++) map[key + ':' + i] = s.substr(i * size, size);
    map[key + ':n'] = String(n);
    CacheService.getScriptCache().putAll(map, APP.CACHE_TTL);
  } catch (e) {
    Logger.log('[cache] escritura fallida: %s', e && e.message);
  }
}

/* ───────────────────────── Conversión de tipos ──────────────────────── */

function coerceRead_(value, type) {
  switch (type) {
    case 'bool':
      return toBool_(value);
    case 'number': {
      if (value === '' || value === null || value === undefined) return 0;
      const n = Number(value);
      return isFinite(n) ? n : 0;
    }
    case 'date':
      return toDateIso_(value);
    case 'datetime':
      return toDateTimeIso_(value);
    case 'json': {
      if (value === '' || value === null || value === undefined) return null;
      if (typeof value === 'object') return value;
      try { return JSON.parse(String(value)); } catch (e) { return String(value); }
    }
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

function coerceWrite_(value, type) {
  switch (type) {
    case 'bool':
      return toBool_(value);
    case 'number': {
      const n = Number(value);
      return isFinite(n) ? n : 0;
    }
    case 'date':
      return toDateIso_(value);
    case 'datetime':
      return toDateTimeIso_(value);
    case 'json':
      if (value === null || value === undefined || value === '') return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/* ──────────────────────────────── Table ─────────────────────────────── */

class Table {

  constructor(key) {
    const def = SCHEMA[key];
    if (!def) throw new Error('Tabla desconocida: ' + key);
    this.key = key;
    this.def = def;
    this.name = def.name;
    this.headers = def.fields.map(f => f[0]);
    this.types = {};
    def.fields.forEach(f => { this.types[f[0]] = f[1]; });
    this._rows = null;   // memo por ejecución
    this._index = null;  // id → objeto
  }

  /** Hoja física. Se crea si no existe (idempotente). */
  sheet() {
    if (this._sheet) return this._sheet;
    const ss = getSpreadsheet_();
    let sh = ss.getSheetByName(this.name);
    if (!sh) sh = this._createSheet(ss);
    this._sheet = sh;
    return sh;
  }

  _createSheet(ss) {
    const sh = ss.insertSheet(this.name);
    const n = this.headers.length;
    sh.getRange(1, 1, 1, n).setValues([this.headers])
      .setFontWeight('bold')
      .setBackground('#1f2937')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    this._applyColumnFormats(sh, this.headers, 1);
    if (sh.getMaxColumns() > n) sh.deleteColumns(n + 1, sh.getMaxColumns() - n);
    return sh;
  }

  /**
   * Fuerza el formato de cada columna. Doble propósito:
   *  · evita que Sheets reinterprete los ISO-8601 como objetos Date (§5), y
   *  · neutraliza la inyección de fórmulas: un valor que empieza con "=" en una
   *    columna de texto es texto, no una fórmula.
   */
  _applyColumnFormats(sh, headerNames, startCol) {
    const rows = Math.max(1, sh.getMaxRows() - 1);
    for (let c = 0; c < headerNames.length; c++) {
      const type = this.types[headerNames[c]];
      if (type === 'bool') continue;
      const fmt = (type === 'number') ? '0' : '@';
      sh.getRange(2, startCol + c, rows, 1).setNumberFormat(fmt);
    }
  }

  /**
   * Alinea los encabezados existentes con el esquema (añade columnas nuevas al
   * final). Permite evolucionar el modelo sin perder datos.
   */
  ensureHeaders() {
    const sh = this.sheet();
    const lastCol = Math.max(1, sh.getLastColumn());
    const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim());
    const missing = this.headers.filter(h => current.indexOf(h) === -1);
    if (missing.length === 0) return { added: [] };
    const start = current.filter(String).length + 1;
    if (sh.getMaxColumns() < start + missing.length - 1) {
      sh.insertColumnsAfter(sh.getMaxColumns(), start + missing.length - 1 - sh.getMaxColumns());
    }
    sh.getRange(1, start, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    this._applyColumnFormats(sh, missing, start);
    this._rows = null;
    return { added: missing };
  }

  /** Mapa nombreColumna → índice 0-based, según la hoja real. */
  _colMap(sh) {
    const lastCol = Math.max(1, sh.getLastColumn());
    const row = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    const map = {};
    for (let i = 0; i < row.length; i++) {
      const h = String(row[i]).trim();
      if (h) map[h] = i;
    }
    return map;
  }

  /**
   * Descarta la copia en memoria y fuerza una lectura directa de la hoja en el
   * siguiente all(). Se usa al inicio de cada operación de escritura, dentro
   * del lock: entre la lectura inicial de la ejecución y la obtención del lock
   * otra ejecución pudo haber modificado los datos.
   */
  reload() {
    propsRefresh_();
    this._rows = null;
    this._index = null;
    this._forceSheetRead = true;
    return this;
  }

  /** Todos los registros (incluye inactivos). Una sola lectura por ejecución. */
  all() {
    if (this._rows) return this._rows;

    const force = this._forceSheetRead === true;
    this._forceSheetRead = false;

    const ck = cacheKey_(this.name);
    if (!force) {
      const cached = cacheGet_(ck);
      if (cached && Array.isArray(cached)) {
        this._rows = cached;
        this._index = null;
        return this._rows;
      }
    }

    const sh = this.sheet();
    const lastRow = sh.getLastRow();
    const rows = [];
    if (lastRow > 1) {
      const colMap = this._colMap(sh);
      const lastCol = Math.max(1, sh.getLastColumn());
      const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
      const idField = this.def.idField;
      for (let r = 0; r < values.length; r++) {
        const raw = values[r];
        const idIdx = colMap[idField];
        if (idIdx === undefined) break;
        const idVal = String(raw[idIdx] === null || raw[idIdx] === undefined ? '' : raw[idIdx]).trim();
        if (!idVal) continue; // fila vacía o huérfana
        const obj = { _row: r + 2 };
        for (let h = 0; h < this.headers.length; h++) {
          const name = this.headers[h];
          const idx = colMap[name];
          obj[name] = coerceRead_(idx === undefined ? '' : raw[idx], this.types[name]);
        }
        rows.push(obj);
      }
    }
    this._rows = rows;
    this._index = null;
    cachePut_(ck, rows);
    return rows;
  }

  /** Registros activos (activo === true). Tablas sin campo `activo` → todos. */
  active() {
    if (this.types['activo'] === undefined) return this.all();
    return this.all().filter(r => r.activo === true);
  }

  find(id) {
    if (!id) return null;
    if (!this._index) this._index = indexBy_(this.all(), r => r[this.def.idField]);
    return this._index[id] || null;
  }

  findOrFail(id, label) {
    const r = this.find(id);
    if (!r) fail_(ERR.NOT_FOUND, 'No se encontró el registro solicitado (' + (label || this.name) + ').');
    return r;
  }

  findBy(predicate) {
    const rows = this.all();
    for (let i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
    return null;
  }

  filter(predicate) {
    return this.all().filter(predicate);
  }

  /* ─────────────────────────── Escrituras ──────────────────────────── */

  _toRowArray(obj, colMap, width) {
    const arr = new Array(width).fill('');
    for (let h = 0; h < this.headers.length; h++) {
      const name = this.headers[h];
      const idx = colMap[name];
      if (idx === undefined || idx >= width) continue;
      arr[idx] = coerceWrite_(obj[name], this.types[name]);
    }
    return arr;
  }

  /** Inserta un registro. Genera el ID si la tabla tiene prefijo. */
  insert(obj) {
    return this.insertMany([obj])[0];
  }

  /** Inserta N registros en UNA escritura. */
  insertMany(objs) {
    if (!objs || !objs.length) return [];
    const sh = this.sheet();
    const colMap = this._colMap(sh);
    const width = Math.max(1, sh.getLastColumn());
    const idField = this.def.idField;

    const prepared = objs.map(o => {
      const rec = Object.assign({}, o);
      if (!rec[idField] && this.def.prefix) rec[idField] = newId_(this.def.prefix);
      return rec;
    });

    const startRow = Math.max(2, sh.getLastRow() + 1);
    if (sh.getMaxRows() < startRow + prepared.length - 1) {
      sh.insertRowsAfter(sh.getMaxRows(), startRow + prepared.length - 1 - sh.getMaxRows());
    }
    const matrix = prepared.map(r => this._toRowArray(r, colMap, width));
    sh.getRange(startRow, 1, matrix.length, width).setValues(matrix);

    this._invalidate();
    return prepared.map((r, i) => Object.assign({ _row: startRow + i }, r));
  }

  /**
   * Actualiza un registro por ID aplicando un parche parcial.
   * Devuelve { before, after }. Una sola escritura.
   */
  update(id, patch) {
    const current = this.findOrFail(id);
    const before = Object.assign({}, current);
    const merged = Object.assign({}, current, patch);
    const sh = this.sheet();
    const colMap = this._colMap(sh);
    const width = Math.max(1, sh.getLastColumn());
    sh.getRange(current._row, 1, 1, width).setValues([this._toRowArray(merged, colMap, width)]);
    this._invalidate();
    delete merged._row;
    delete before._row;
    return { before: before, after: merged };
  }

  /**
   * Actualiza varios registros. Agrupa filas contiguas en un único setValues
   * por bloque: reordenar una columna completa del Kanban cuesta 1–2 llamadas.
   */
  updateMany(patches) {
    if (!patches || !patches.length) return 0;
    const sh = this.sheet();
    const colMap = this._colMap(sh);
    const width = Math.max(1, sh.getLastColumn());

    const items = patches.map(p => {
      const cur = this.findOrFail(p.id);
      return { row: cur._row, values: this._toRowArray(Object.assign({}, cur, p.patch), colMap, width) };
    }).sort((a, b) => a.row - b.row);

    let i = 0;
    while (i < items.length) {
      let j = i;
      while (j + 1 < items.length && items[j + 1].row === items[j].row + 1) j++;
      const block = items.slice(i, j + 1).map(x => x.values);
      sh.getRange(items[i].row, 1, block.length, width).setValues(block);
      i = j + 1;
    }
    this._invalidate();
    return items.length;
  }

  /** Soft delete. Nunca se borra físicamente (trazabilidad). */
  softDelete(id) {
    if (this.types['activo'] === undefined) {
      throw new Error('La tabla ' + this.name + ' no admite soft delete.');
    }
    return this.update(id, { activo: false });
  }

  _invalidate() {
    this._rows = null;
    this._index = null;
    const key = PROP.VERSION_PREFIX + this.name;
    const next = Number(propGet_(key) || '0') + 1;
    propSet_(key, next);
  }
}

/* ───────────────────────── Acceso memoizado ─────────────────────────── */

const _tables = {};

function table_(key) {
  if (!_tables[key]) _tables[key] = new Table(key);
  return _tables[key];
}

function tUsers_()    { return table_('USERS'); }
function tProjects_() { return table_('PROJECTS'); }
function tTasks_()    { return table_('TASKS'); }
function tSubtasks_() { return table_('SUBTASKS'); }
function tComments_() { return table_('COMMENTS'); }
function tAudit_()    { return table_('AUDIT_LOG'); }
function tConfig_()   { return table_('CONFIG'); }

/* ───────────────────── Parámetros de la hoja CONFIG ─────────────────── */

let _cfgMemo = null;

/** Lee un parámetro de la hoja CONFIG con valor por defecto. */
function cfg_(clave, fallback) {
  if (!_cfgMemo) {
    _cfgMemo = {};
    try {
      tConfig_().all().forEach(r => { _cfgMemo[r.clave] = r.valor; });
    } catch (e) {
      Logger.log('[cfg] no se pudo leer CONFIG: %s', e && e.message);
    }
  }
  const v = _cfgMemo[clave];
  return (v === undefined || v === '') ? fallback : v;
}

function cfgNumber_(clave, fallback) {
  const n = Number(cfg_(clave, fallback));
  return isFinite(n) ? n : fallback;
}

function cfgBool_(clave, fallback) {
  const v = cfg_(clave, null);
  return v === null ? fallback : toBool_(v);
}
