/**
 * gasenv.js — Simulador en memoria de los servicios de Google Apps Script.
 *
 * Carga los archivos .gs del proyecto en un único ámbito (igual que hace Apps
 * Script) sobre mocks de SpreadsheetApp, PropertiesService, CacheService,
 * LockService, Session, Utilities y Logger.
 *
 * Lo usan tools/sim.js (pruebas del backend) y tools/uitest.js (pruebas del
 * frontend sobre jsdom con un google.script.run real contra estos mocks).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

/* ─────────────────────────── Hojas de cálculo ───────────────────────── */

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) row.push(this.sheet._get(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows) {
      throw new Error('setValues: ' + values.length + ' filas para un rango de ' + this.numRows);
    }
    values.forEach((row, r) => {
      if (row.length !== this.numCols) {
        throw new Error('setValues: ' + row.length + ' columnas para un rango de ' + this.numCols);
      }
      row.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v));
    });
    this.sheet.writes++;
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setNumberFormat() { return this; }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();
    this.maxRows = 1000;
    this.maxCols = 26;
    this.protections = [];
    this.reads = 0;
    this.writes = 0;
  }
  _key(r, c) { return r + ':' + c; }
  _get(r, c) { const v = this.cells.get(this._key(r, c)); return v === undefined ? '' : v; }
  _set(r, c, v) {
    if (v === '' || v === null || v === undefined) this.cells.delete(this._key(r, c));
    else this.cells.set(this._key(r, c), v);
  }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(':')[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(':')[1]));
    return last;
  }
  getRange(r, c, nr, nc) {
    this.reads++;
    return new MockRange(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  setFrozenRows() { return this; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(after, n) { this.maxCols += n; return this; }
  deleteColumns(start, n) { this.maxCols -= n; return this; }
  deleteRow(row) {
    const next = new Map();
    for (const [k, v] of this.cells) {
      const [r, c] = k.split(':').map(Number);
      if (r === row) continue;
      next.set((r > row ? r - 1 : r) + ':' + c, v);
    }
    this.cells = next;
    return this;
  }
  protect() {
    const p = { setDescription: () => p, setWarningOnly: () => p };
    this.protections.push(p);
    return p;
  }
  getProtections() { return this.protections; }
}

class MockSpreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = []; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  setSpreadsheetTimeZone() { return this; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.filter(s => s.getName() === n)[0] || null; }
  insertSheet(n) { const s = new MockSheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

/* ───────────────────────────── Entorno ──────────────────────────────── */

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * @param {Object} opts { ownerEmail }
 * @returns entorno con { ctx, store, as, call, setEffectiveIsOwner, ownerEmail }
 */
function createEnv(opts) {
  const ownerEmail = (opts && opts.ownerEmail) || 'ricardo.admin@example.com';
  const store = { props: {}, cache: new Map(), spreadsheets: {} };
  let currentEmail = '';
  let effectiveIsOwner = false;

  const sandbox = {
    console,
    Date, Math, JSON, String, Number, Boolean, Array, Object, Error, RegExp,
    isFinite, isNaN, Promise, Map, Set, parseInt, parseFloat,

    SpreadsheetApp: {
      ProtectionType: { SHEET: 'SHEET' },
      create(name) {
        const id = 'ss-' + Object.keys(store.spreadsheets).length;
        const ss = new MockSpreadsheet(id, name);
        ss.insertSheet('Sheet1');
        store.spreadsheets[id] = ss;
        return ss;
      },
      openById(id) {
        if (!store.spreadsheets[id]) throw new Error('No existe el spreadsheet ' + id);
        return store.spreadsheets[id];
      }
    },

    PropertiesService: {
      getScriptProperties() {
        return {
          getProperties() { return Object.assign({}, store.props); },
          getProperty(k) { return store.props[k] === undefined ? null : store.props[k]; },
          setProperty(k, v) { store.props[k] = String(v); return this; }
        };
      }
    },

    CacheService: {
      getScriptCache() {
        return {
          get(k) { return store.cache.has(k) ? store.cache.get(k) : null; },
          getAll(keys) {
            const out = {};
            keys.forEach(k => { if (store.cache.has(k)) out[k] = store.cache.get(k); });
            return out;
          },
          put(k, v) { store.cache.set(k, String(v)); },
          putAll(map) { Object.keys(map).forEach(k => store.cache.set(k, String(map[k]))); },
          remove(k) { store.cache.delete(k); }
        };
      }
    },

    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },

    // En EXECUTE_AS_USER el usuario efectivo ES el activo. effectiveIsOwner
    // simula EXECUTE_AS_OWNER, donde el efectivo es el dueño del script.
    Session: {
      getActiveUser: () => ({ getEmail: () => currentEmail }),
      getEffectiveUser: () => ({ getEmail: () => (effectiveIsOwner ? ownerEmail : currentEmail) })
    },

    Utilities: {
      formatDate(date, tz, fmt) {
        const d = new Date(date.toLocaleString('en-US', { timeZone: tz }));
        if (fmt === 'yyyy-MM-dd') {
          return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        }
        return d.toISOString();
      }
    },

    Logger: { log() {} },

    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile() {
        return {
          evaluate: () => ({
            setTitle: () => ({ addMetaTag: () => ({ setXFrameOptionsMode: () => ({}) }) })
          })
        };
      },
      createHtmlOutputFromFile() { return { getContent: () => '' }; }
    }
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort().forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  });

  /** Simula una ejecución nueva de la Web App como `email`. */
  function as(email) {
    currentEmail = email;
    vm.runInContext(
      '_propsMemo = null; _ss = null; _cfgMemo = null; _userNamesMemo = null; ' +
      '_usersByIdMemo = null; _currentUserMemo = undefined; ' +
      'Object.keys(_tables).forEach(function(k){ delete _tables[k]; });', ctx);
  }

  function call(fnName, ...args) {
    return vm.runInContext('(' + fnName + ')', ctx).apply(null, args);
  }

  function setEffectiveIsOwner(v) { effectiveIsOwner = !!v; }
  function setDeployMode(mode) { vm.runInContext("APP.DEPLOY_MODE = '" + mode + "';", ctx); }
  function currentUserEmail() { return currentEmail; }

  return { ctx, store, as, call, setEffectiveIsOwner, setDeployMode, ownerEmail, currentUserEmail };
}

module.exports = { createEnv, SRC };
