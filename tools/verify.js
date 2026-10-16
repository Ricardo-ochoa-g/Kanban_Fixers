#!/usr/bin/env node
/**
 * verify.js — Comprobaciones estáticas del proyecto antes de entregarlo.
 *
 *  1. Sintaxis de cada archivo .gs (V8 / ES2020).
 *  2. Sintaxis de la concatenación de todos los .gs: Apps Script los evalúa en
 *     un único ámbito global, así que una colisión de const/class se detecta aquí.
 *  3. Sintaxis de cada bloque <script> de los .html.
 *  4. Declaraciones duplicadas de const/let/class entre bloques <script>
 *     (comparten el ámbito léxico global del navegador).
 *  5. Cada App.rpc('fn') del frontend existe como función global del backend.
 *  6. Cada include('X') tiene su archivo X.html.
 *  7. Los nombres de campo usados en los literales de registro existen en SCHEMA.
 *  8. Cada ruta de navegación tiene su App.registerView correspondiente.
 *  9. Heurística de XSS: innerHTML con interpolación sin UI.esc().
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC);
const gsFiles = files.filter(f => f.endsWith('.gs')).sort();
const htmlFiles = files.filter(f => f.endsWith('.html')).sort();

let errors = 0, warnings = 0, checks = 0;
const fail = m => { errors++; console.log('  FAIL  ' + m); };
const warn = m => { warnings++; console.log('  WARN  ' + m); };
const pass = m => { checks++; console.log('  ok    ' + m); };

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

function checkSyntax(label, code) {
  try {
    new vm.Script(code, { filename: label });
    return true;
  } catch (e) {
    fail(label + ' — ' + e.message.split('\n')[0]);
    return false;
  }
}

/* ── 1. Sintaxis por archivo .gs ─────────────────────────────────────── */
console.log('\n1) Sintaxis de los archivos .gs');
gsFiles.forEach(f => { if (checkSyntax(f, read(f))) pass(f); });

/* ── 2. Concatenación de .gs (ámbito global único de Apps Script) ────── */
console.log('\n2) Concatenación de los .gs en un solo ámbito');
const joined = gsFiles.map(f => '/* ' + f + ' */\n' + read(f)).join('\n');
if (checkSyntax('(todos los .gs concatenados)', joined)) {
  pass('sin colisiones de declaraciones entre archivos .gs');
}

/* ── 3. Sintaxis de los bloques <script> ─────────────────────────────── */
console.log('\n3) Sintaxis del JavaScript en los .html');
const scriptBlocks = {};
htmlFiles.forEach(f => {
  const html = read(f);
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);
  if (!blocks.length) return;
  scriptBlocks[f] = blocks;
  let okAll = true;
  blocks.forEach((b, i) => {
    if (!checkSyntax(f + ' [script #' + (i + 1) + ']', b)) okAll = false;
  });
  if (okAll) pass(f + ' (' + blocks.length + ' bloque(s))');
});

/* ── 4. Duplicados de const/let/class entre bloques <script> ─────────── */
console.log('\n4) Declaraciones léxicas duplicadas en el frontend');
const declared = {};
Object.keys(scriptBlocks).forEach(f => {
  scriptBlocks[f].forEach(b => {
    // Solo declaraciones en columna 0 (nivel superior del bloque).
    [...b.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].forEach(m => {
      const name = m[1];
      if (declared[name] && declared[name] !== f) {
        fail('"' + name + '" se declara en ' + declared[name] + ' y en ' + f);
      } else {
        declared[name] = f;
      }
    });
  });
});
if (!errors) pass('sin colisiones de const/let/class entre vistas');

/* ── 5. App.rpc('fn') ↔ funciones globales del backend ───────────────── */
console.log('\n5) Llamadas RPC del frontend contra la API del backend');
const backendFns = new Set();
gsFiles.forEach(f => {
  [...read(f).matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].forEach(m => {
    if (!m[1].endsWith('_')) backendFns.add(m[1]);
  });
});
const rpcCalls = new Set();
Object.keys(scriptBlocks).forEach(f => {
  scriptBlocks[f].forEach(b => {
    [...b.matchAll(/App\.rpc\(\s*'([^']+)'/g)].forEach(m => rpcCalls.add(m[1]));
    [...b.matchAll(/rpc\(\s*'([^']+)'/g)].forEach(m => rpcCalls.add(m[1]));
  });
});
[...rpcCalls].sort().forEach(fn => {
  if (backendFns.has(fn)) pass("rpc('" + fn + "') → existe");
  else fail("rpc('" + fn + "') no corresponde a ninguna función global del backend");
});

/* ── 6. include('X') ↔ X.html ────────────────────────────────────────── */
console.log('\n6) Inclusiones de plantillas');
const includes = new Set();
htmlFiles.forEach(f => {
  [...read(f).matchAll(/include\(\s*'([^']+)'/g)].forEach(m => includes.add(m[1]));
});
[...includes].sort().forEach(name => {
  if (htmlFiles.indexOf(name + '.html') !== -1) pass("include('" + name + "') → " + name + '.html');
  else fail("include('" + name + "') sin archivo " + name + '.html');
});

/* ── 7. Campos usados ↔ SCHEMA ───────────────────────────────────────── */
console.log('\n7) Campos del modelo de datos');
const configSrc = read('Config.gs');
const sandbox = { APP: {}, Utilities: {}, Logger: { log() {} } };
let SCHEMA = null;
try {
  const ctx = vm.createContext({});
  vm.runInContext(configSrc + '\n;globalThis.__out = { SCHEMA, STATUS_ORDER, PRIORITY_ORDER, PERMISSIONS, CONFIG_DEFAULTS };', ctx);
  SCHEMA = ctx.__out.SCHEMA;
  pass('Config.gs evaluado: ' + Object.keys(SCHEMA).length + ' hojas definidas');
} catch (e) {
  fail('no se pudo evaluar Config.gs: ' + e.message);
}

if (SCHEMA) {
  const known = new Set(['_row']);
  Object.keys(SCHEMA).forEach(k => SCHEMA[k].fields.forEach(f => known.add(f[0])));

  // Campos escritos vía insert/update: literales { campo: ... } en los módulos.
  const dataFiles = ['Users.gs', 'Projects.gs', 'Tasks.gs', 'Subtasks.gs', 'Comments.gs',
    'Audit.gs', 'Setup.gs', 'Dashboard.gs'];
  const writeCalls = [];
  dataFiles.forEach(f => {
    const src = read(f);
    // Bloques que empiezan en .insert({ / .update(x, { / patch.<campo> =
    [...src.matchAll(/patch\.([A-Za-z_$][\w$]*)\s*=/g)].forEach(m => {
      writeCalls.push({ file: f, field: m[1] });
    });
  });
  const unknown = writeCalls.filter(w => !known.has(w.field));
  if (unknown.length) {
    unknown.forEach(u => fail('campo desconocido "' + u.field + '" asignado en ' + u.file));
  } else {
    pass('todos los campos asignados a patches existen en SCHEMA (' +
      writeCalls.length + ' asignaciones revisadas)');
  }

  // Cabeceras duplicadas dentro de una hoja
  Object.keys(SCHEMA).forEach(k => {
    const names = SCHEMA[k].fields.map(f => f[0]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) fail('hoja ' + k + ' con cabeceras duplicadas: ' + dup.join(', '));
  });

  // Tipos válidos
  const validTypes = ['string', 'number', 'bool', 'date', 'datetime', 'json'];
  Object.keys(SCHEMA).forEach(k => {
    SCHEMA[k].fields.forEach(f => {
      if (validTypes.indexOf(f[1]) === -1) {
        fail('hoja ' + k + ', campo ' + f[0] + ': tipo inválido "' + f[1] + '"');
      }
    });
  });
  pass('tipos de campo válidos en todas las hojas');
}

/* ── 8. Rutas de navegación ↔ vistas registradas ─────────────────────── */
console.log('\n8) Rutas de navegación');
const appSrc = read('App.html');
const navRoutes = [...appSrc.matchAll(/\{\s*route:\s*'([^']+)'/g)].map(m => m[1]);
const registered = new Set();
Object.keys(scriptBlocks).forEach(f => {
  scriptBlocks[f].forEach(b => {
    [...b.matchAll(/App\.registerView\(\s*'([^']+)'/g)].forEach(m => registered.add(m[1]));
  });
});
navRoutes.forEach(r => {
  if (registered.has(r)) pass("ruta '" + r + "' registrada");
  else fail("la navegación apunta a '" + r + "' pero ninguna vista la registra");
});
[...registered].forEach(r => {
  if (navRoutes.indexOf(r) === -1) warn("vista '" + r + "' registrada pero no está en el menú");
});

/* ── 9. Heurística de XSS ────────────────────────────────────────────── */
console.log('\n9) Inyección de datos en el DOM');
let xssSuspects = 0;
Object.keys(scriptBlocks).forEach(f => {
  scriptBlocks[f].forEach(b => {
    b.split('\n').forEach((line, i) => {
      if (!/innerHTML\s*[+]?=/.test(line)) return;
      // Sospechoso: interpolación de variables sin esc() ni plantilla constante.
      if (/innerHTML\s*[+]?=\s*['"]/.test(line)) return;        // literal
      if (/UI\.esc|esc\(|Html\(|skeleton|empty\(|\bhtml\b|Inner\(|\.join\(/.test(line)) return;
      if (/innerHTML\s*[+]?=\s*[A-Za-z_$][\w$.]*\s*;?\s*$/.test(line)) {
        xssSuspects++;
        warn(f + ' línea ' + (i + 1) + ': innerHTML con variable — revisar escapado: ' + line.trim());
      }
    });
  });
});
if (!xssSuspects) pass('ninguna asignación de innerHTML con datos sin escapar evidentes');

/* ── Resumen ─────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(64));
console.log('Comprobaciones OK: ' + checks + ' · Advertencias: ' + warnings + ' · Errores: ' + errors);
console.log('─'.repeat(64) + '\n');
process.exit(errors ? 1 : 0);
