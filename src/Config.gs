/**
 * Config.gs — Constantes, esquema de datos y matriz de permisos.
 *
 * Único archivo que se edita para parametrizar la aplicación.
 * No contiene lógica: solo declaraciones.
 */

/* ───────────────────────────── Aplicación ───────────────────────────── */

const APP = {
  NAME: 'Kanban Workspace',
  VERSION: '1.0.0',

  /**
   * Modo de despliegue de la Web App. Ver docs/ARCHITECTURE.md §2.
   *
   *  'EXECUTE_AS_OWNER' → Implementar como: "yo" + Acceso: "usuarios de mi dominio".
   *                       Requiere Google Workspace. El Sheet NO se comparte.
   *                       Es la opción más segura.
   *
   *  'EXECUTE_AS_USER'  → Implementar como: "el usuario que accede" + Acceso:
   *                       "cualquiera con cuenta de Google". Necesario si hay
   *                       invitados @gmail.com. Obliga a compartir el Sheet con
   *                       los usuarios autorizados (ver mitigaciones en los docs).
   *
   * ATENCIÓN: este valor debe coincidir con la configuración real del despliegue.
   * Declararlo mal no abre un agujero (el fallback de identidad solo se activa en
   * EXECUTE_AS_USER), pero sí puede dejar la app inutilizable.
   */
  DEPLOY_MODE: 'EXECUTE_AS_USER',

  TIMEZONE: 'America/Santiago',

  /** Visibilidad de proyectos para el rol USER: 'ALL' | 'INVOLVED' */
  PROJECT_VISIBILITY: 'ALL',

  /** Una tarea se marca "próxima a vencer" dentro de esta cantidad de días. */
  DUE_SOON_DAYS: 3,

  /** Separación inicial entre tarjetas al calcular ordenKanban. */
  ORDER_GAP: 1000,

  /** Umbral bajo el cual se renormaliza el orden de una columna. */
  ORDER_MIN_GAP: 1,

  /** TTL de caché en segundos (la invalidación real es por versión de datos). */
  CACHE_TTL: 1500,

  /**
   * Caracteres por fragmento de caché. CacheService admite 100 KB por entrada;
   * con acentos (2 bytes en UTF-8) 40 000 caracteres nunca superan ese límite.
   */
  CACHE_CHUNK_CHARS: 40000,

  /** Máximo de fragmentos por hoja; si se excede, se omite la caché. */
  CACHE_MAX_CHUNKS: 12,

  /** Espera máxima por el lock de escritura. */
  LOCK_TIMEOUT_MS: 20000,

  /** Límite duro de filas devueltas por consulta de auditoría. */
  AUDIT_MAX_ROWS: 500
};

/* ───────────────────────── Script Properties ───────────────────────── */

const PROP = {
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  ADMIN_EMAIL: 'ADMIN_EMAIL',
  SETUP_DONE: 'SETUP_DONE',
  DRIVE_FOLDER_ID: 'DRIVE_FOLDER_ID',
  VERSION_PREFIX: 'DV_'
};

/* ──────────────────────────── Enumeraciones ─────────────────────────── */

const STATUS = {
  ON_HOLD: 'ON_HOLD',
  BACKLOG: 'BACKLOG',
  TO_DO: 'TO_DO',
  DOING: 'DOING',
  DONE: 'DONE'
};

/** Orden de las columnas del tablero, de izquierda a derecha. */
const STATUS_ORDER = [
  STATUS.ON_HOLD,
  STATUS.BACKLOG,
  STATUS.TO_DO,
  STATUS.DOING,
  STATUS.DONE
];

const STATUS_LABEL = {
  ON_HOLD: 'On Hold',
  BACKLOG: 'Backlog',
  TO_DO: 'To Do',
  DOING: 'Doing',
  DONE: 'Done'
};

const PRIORITY = {
  BAJA: 'BAJA',
  MEDIA: 'MEDIA',
  ALTA: 'ALTA',
  CRITICA: 'CRITICA'
};

const PRIORITY_ORDER = [PRIORITY.BAJA, PRIORITY.MEDIA, PRIORITY.ALTA, PRIORITY.CRITICA];

const ROLE = {
  ADMIN: 'ADMIN',
  USER: 'USER'
};

/* ───────────────────────── Matriz de permisos ───────────────────────── */
/**
 * Comodines soportados:
 *   '*'        → todos los permisos
 *   'task.*'   → todos los permisos del namespace "task"
 *
 * Para agregar un rol basta añadir una entrada aquí. La lógica de negocio no
 * conoce los roles: solo pregunta por permisos.
 */
const PERMISSIONS = {
  ADMIN: ['*'],
  USER: [
    'app.access',
    'dashboard.read',
    'project.read',
    'task.read',
    'task.create',
    'task.update',
    'task.move',
    'subtask.read',
    'subtask.create',
    'subtask.update',
    'comment.read',
    'comment.create',
    'comment.delete.own',
    'audit.read.entity',
    'user.list.basic'
  ]
  // Nota: el USER no tiene 'project.update' ni 'project.delete'. La validación
  // adicional "solo el responsable del proyecto" que hay en Projects.gs es
  // defensa en profundidad y queda lista para un futuro rol intermedio.
};

/* ─────────────────────── Esquema del spreadsheet ────────────────────── */
/**
 * Tipos admitidos: 'string' | 'number' | 'bool' | 'date' | 'datetime' | 'json'
 * El orden de `fields` ES el orden de las columnas en la hoja.
 */
const SCHEMA = {

  USERS: {
    name: 'USERS',
    idField: 'userId',
    prefix: 'USR',
    fields: [
      ['userId', 'string'],
      ['email', 'string'],
      ['nombre', 'string'],
      ['rol', 'string'],
      ['activo', 'bool'],
      ['fechaCreacion', 'datetime'],
      ['fechaActualizacion', 'datetime'],
      ['ultimoAcceso', 'datetime']
    ]
  },

  PROJECTS: {
    name: 'PROJECTS',
    idField: 'projectId',
    prefix: 'PRJ',
    fields: [
      ['projectId', 'string'],
      ['nombre', 'string'],
      ['descripcion', 'string'],
      ['responsable', 'string'],
      ['fechaInicio', 'date'],
      ['fechaFin', 'date'],
      ['estado', 'string'],
      ['porcentajeAvance', 'number'],
      ['prioridad', 'string'],
      ['fechaCreacion', 'datetime'],
      ['creadoPor', 'string'],
      ['fechaActualizacion', 'datetime'],
      ['actualizadoPor', 'string'],
      ['activo', 'bool']
    ]
  },

  TASKS: {
    name: 'TASKS',
    idField: 'taskId',
    prefix: 'TSK',
    fields: [
      ['taskId', 'string'],
      ['projectId', 'string'],
      ['titulo', 'string'],
      ['descripcion', 'string'],
      ['estado', 'string'],
      ['prioridad', 'string'],
      ['porcentajeAvance', 'number'],
      // Añadido al modelo propuesto: distingue avance fijado a mano de avance
      // derivado de las subtareas. Ver docs/ARCHITECTURE.md §5.
      ['avanceManual', 'bool'],
      ['responsable', 'string'],
      ['fechaInicio', 'date'],
      ['fechaVencimiento', 'date'],
      ['fechaCompletado', 'datetime'],
      ['creadoPor', 'string'],
      ['fechaCreacion', 'datetime'],
      ['actualizadoPor', 'string'],
      ['fechaActualizacion', 'datetime'],
      ['ordenKanban', 'number'],
      ['activo', 'bool']
    ]
  },

  SUBTASKS: {
    name: 'SUBTASKS',
    idField: 'subtaskId',
    prefix: 'SUB',
    fields: [
      ['subtaskId', 'string'],
      ['taskId', 'string'],
      ['titulo', 'string'],
      ['descripcion', 'string'],
      ['completada', 'bool'],
      ['porcentajeAvance', 'number'],
      ['responsable', 'string'],
      ['fechaVencimiento', 'date'],
      ['fechaCreacion', 'datetime'],
      ['fechaActualizacion', 'datetime'],
      ['activo', 'bool']
    ]
  },

  COMMENTS: {
    name: 'COMMENTS',
    idField: 'commentId',
    prefix: 'CMT',
    fields: [
      ['commentId', 'string'],
      ['taskId', 'string'],
      ['userId', 'string'],
      ['comentario', 'string'],
      ['fechaCreacion', 'datetime'],
      ['activo', 'bool']
    ]
  },

  AUDIT_LOG: {
    name: 'AUDIT_LOG',
    idField: 'logId',
    prefix: 'LOG',
    fields: [
      ['logId', 'string'],
      ['userId', 'string'],
      ['email', 'string'],
      ['accion', 'string'],
      ['entidad', 'string'],
      ['entityId', 'string'],
      ['valorAnterior', 'json'],
      ['valorNuevo', 'json'],
      ['fecha', 'datetime']
    ]
  },

  CONFIG: {
    name: 'CONFIG',
    idField: 'clave',
    prefix: null,
    fields: [
      ['clave', 'string'],
      ['valor', 'string'],
      ['descripcion', 'string']
    ]
  }
};

/** Parámetros editables desde Administración → Configuración. */
const CONFIG_DEFAULTS = [
  ['DUE_SOON_DAYS', String(APP.DUE_SOON_DAYS), 'Días de antelación para marcar una tarea como "próxima a vencer".'],
  ['PROJECT_VISIBILITY', APP.PROJECT_VISIBILITY, 'Visibilidad de proyectos para el rol USER: ALL o INVOLVED.'],
  ['PROJECT_RISK_PCT', '40', 'Un proyecto se marca "en riesgo" si su avance es menor a este % cuando ya transcurrió el 70% del plazo.'],
  ['ALLOW_USER_CREATE_PROJECT', 'false', 'Permitir que el rol USER cree proyectos (true/false).']
];

/** Códigos de error del contrato de la API. */
const ERR = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  USER_INACTIVE: 'USER_INACTIVE',
  IDENTITY_UNAVAILABLE: 'IDENTITY_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INTERNAL: 'INTERNAL'
};
