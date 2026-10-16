# Arquitectura — Kanban Workspace (Google Apps Script)

> Revisión previa a la implementación. Cada decisión relevante está marcada
> como **DECISIÓN** con su justificación y el riesgo que mitiga.

---

## 1. Visión general

```
┌──────────────────────────── Navegador del usuario ────────────────────────────┐
│  HtmlService (sandbox IFRAME)                                                 │
│  Index.html → Styles.html + App.html + View*.html                             │
│  SPA sin recarga · estado en memoria · SortableJS (único CDN)                 │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ google.script.run  (RPC, 1 función = 1 endpoint)
┌───────────────────────────────▼───────────────────────────────────────────────┐
│  Apps Script (V8)                                                             │
│                                                                               │
│  Api.gs        ── única superficie pública. Todo pasa por handle_()            │
│      │            1) resuelve identidad  2) valida permiso  3) ejecuta         │
│      ▼                                                                         │
│  Auth.gs  Users.gs  Projects.gs  Tasks.gs  Subtasks.gs  Comments.gs  Audit.gs │
│      │            (reglas de negocio, validación, auditoría)                   │
│      ▼                                                                         │
│  Repo.gs   ── capa de datos: Table (read en bloque, write en bloque,           │
│               índice id→fila, caché invalidada por versión, LockService)       │
│      ▼                                                                         │
│  SpreadsheetApp · PropertiesService · CacheService · LockService · DriveApp    │
└───────────────────────────────────────────────────────────────────────────────┘
                                │
                      Google Sheet privado (datastore)
          USERS · PROJECTS · TASKS · SUBTASKS · GANTT · COMMENTS · AUDIT_LOG · CONFIG
```

Regla transversal: **el frontend nunca envía la identidad del usuario**. El
backend la deriva del contexto de ejecución en cada llamada.

---

## 2. El problema más importante: identidad del usuario vs. despliegue

Esta es la trampa central de las Web Apps de Apps Script y condiciona todo lo demás.

| Despliegue | `Session.getActiveUser().getEmail()` | ¿Hay que compartir el Sheet? |
|---|---|---|
| **Ejecutar como: yo** + Acceso: *solo mi dominio* | Devuelve el email real (mismo dominio Workspace) | **No.** El Sheet queda privado |
| **Ejecutar como: yo** + Acceso: *cualquiera con cuenta Google* | **Devuelve `""` para cuentas fuera del dominio** | No |
| **Ejecutar como: el usuario que accede** + *cualquiera con cuenta Google* | Devuelve el email real siempre | **Sí.** Cada usuario necesita acceso de edición al Sheet |

Consecuencia: la combinación intuitiva ("ejecutar como yo, que entre cualquiera
con Gmail") **rompe el control de acceso**, porque el backend no puede saber
quién es el usuario. Muchas implementaciones caen aquí y terminan recibiendo el
email desde el frontend — lo que es trivialmente falsificable y anula toda la
seguridad.

### DECISIÓN 1 — Modo de despliegue configurable, con identidad defensiva

`Config.gs` expone `APP.DEPLOY_MODE`:

- **`EXECUTE_AS_OWNER`** (recomendado si todos los usuarios están en el mismo
  dominio Workspace): *Ejecutar como: yo* + *Acceso: usuarios de mi dominio*.
  El Sheet **no se comparte con nadie**: solo el script lo toca. Es la
  configuración con mejor postura de seguridad.
- **`EXECUTE_AS_USER`** (necesario si hay invitados `@gmail.com`):
  *Ejecutar como: el usuario que accede* + *Acceso: cualquiera con cuenta Google*.

El resolvedor de identidad:

```js
Session.getActiveUser().getEmail()            // siempre se intenta primero
  → si viene vacío y DEPLOY_MODE === 'EXECUTE_AS_USER':
Session.getEffectiveUser().getEmail()         // fallback seguro: en este modo
                                              // efectivo == activo
  → si sigue vacío: error IDENTITY_UNAVAILABLE, acceso denegado
```

El fallback a `getEffectiveUser()` **solo** se habilita en `EXECUTE_AS_USER`.
En `EXECUTE_AS_OWNER`, `getEffectiveUser()` es el **dueño del script**: usarlo
como fallback convertiría a cualquier anónimo en administrador. Este detalle es
un agujero de privilegios real y está bloqueado por configuración, no por
disciplina del programador.

Nunca se "degrada" a un acceso permisivo: sin email verificable → sin acceso.

### DECISIÓN 2 — Mitigación del Sheet compartido en `EXECUTE_AS_USER`

En este modo los usuarios autorizados necesitan permiso de edición sobre el
Sheet, por lo que **podrían editarlo directamente saltándose la app** (sin
validaciones y sin auditoría). No existe forma de evitarlo dentro de Apps
Script sin introducir un segundo Web App intermedio con verificación de
`ScriptApp.getIdentityToken()`, complejidad que no se justifica para un equipo
interno de 10–50 personas. Mitigaciones implementadas:

1. `setupApplication()` aplica **protecciones de rango** a todas las hojas:
   advertencia al editar y edición restringida al dueño donde es posible.
2. La hoja `AUDIT_LOG` registra solo lo que pasa por la app; las ediciones
   manuales quedan fuera — por eso el Sheet se trata como **infraestructura, no
   como interfaz**, y así está documentado.
3. El Sheet se comparte **solo** con los usuarios dados de alta, nunca con
   "cualquiera con el enlace".

Si el equipo migra a Workspace con dominio propio, basta cambiar
`DEPLOY_MODE` y dejar de compartir el Sheet. El código no cambia.

---

## 3. Google Sheets como base de datos: límites reales

| Límite | Valor | Impacto en este diseño |
|---|---|---|
| Celdas por spreadsheet | 10 000 000 | ~17 columnas × 580k filas. No es el cuello de botella |
| Tiempo por ejecución | 6 min (consumidor) / 30 min (Workspace) | Ninguna operación CRUD se acerca; sí importa en exportaciones masivas |
| Llamadas `UrlFetch`/día, lecturas | cuotas por usuario | Irrelevante: no hay servicios externos |
| Escrituras simultáneas | **sin transacciones** | Resuelto con `LockService` + reglas de escritura por bloque |
| Latencia por llamada a `SpreadsheetApp` | ~100–400 ms | **Este sí es el cuello de botella** |

### DECISIÓN 3 — Capa `Table`: lectura/escritura en bloque, nunca por celda

`Repo.gs` define una única abstracción:

- `all()` → **una** llamada `getDataRange().getValues()` por hoja y por
  ejecución, convertida a objetos con el nº de fila (`_row`) adjunto.
- Índice `id → fila` construido en memoria; actualizar un registro es
  `getRange(row, 1, 1, nCols).setValues([...])` — **una** llamada.
- `bulkUpdate()` para reordenamientos: agrupa filas contiguas y escribe rangos,
  no celdas.
- Prohibido `getRange()` dentro de bucles. Toda la app respeta esto.

### DECISIÓN 4 — Caché invalidada por versión, no por TTL

`CacheService.getScriptCache()` guarda el JSON de cada hoja bajo la clave
`t:<HOJA>:<versión>`. La versión vive en `PropertiesService` y **se incrementa
en cada escritura** sobre esa hoja. Ventajas:

- Un usuario nunca lee datos obsoletos tras la escritura de otro (el problema
  clásico de cachear con TTL en apps colaborativas).
- No hace falta borrar la caché: la clave antigua simplemente queda huérfana.
- Valores > 100 KB se **fragmentan** automáticamente (límite por entrada de
  `CacheService`); si la hoja supera el presupuesto de fragmentos, se omite la
  caché en silencio y se lee del Sheet. Nunca falla por caché.

### DECISIÓN 5 — Fechas como texto ISO-8601, no como `Date`

Los objetos `Date` cruzan `google.script.run` de forma inconsistente y las
celdas de fecha arrastran la zona horaria del spreadsheet. Se almacena:

- Fecha sola → `YYYY-MM-DD`
- Instante → `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC)

Ambos formatos **ordenan correctamente como texto**, así que los filtros y el
ordenamiento del Sheet siguen funcionando. La presentación en zona
`America/Santiago` ocurre solo en el frontend.

### DECISIÓN 6 — Orden Kanban con huecos y renormalización diferida

`ordenKanban` no es un índice consecutivo (que obligaría a reescribir toda la
columna en cada arrastre). Se asignan múltiplos de 1000 y al insertar se toma
el **punto medio** entre vecinos. Solo cuando el hueco se agota (< 1) se
renormaliza esa columna en una escritura por bloque. Un arrastre típico = 1
lectura + 1 escritura de 1 fila.

### DECISIÓN 7 — `LockService` acotado a las escrituras

`withLock_()` envuelve **solo** las operaciones de escritura (crear, actualizar,
mover, alta de usuario). Las lecturas no toman lock: con lock global en lecturas,
10 usuarios navegando serializarían la app. Timeout 20 s → error de concurrencia
legible, nunca un dato corrupto.

---

## 4. Modelo de permisos

Matriz declarativa en `Config.gs`, no condicionales dispersos:

```js
PERMISSIONS = {
  ADMIN: ['*'],
  USER : ['app.access','project.read','task.*','subtask.*','comment.*','audit.read.entity']
}
```

- Cada endpoint declara el permiso que exige; `handle_()` lo valida **antes** de
  ejecutar. Ocultar un botón en el frontend no es control de acceso: es cosmética.
- Agregar un rol (`VIEWER`, `MANAGER`) es añadir una fila a la matriz; no hay
  que tocar la lógica de negocio.
- `audit.read.entity` (historial de **una** tarea) vs `audit.read.global`
  (auditoría completa) están separados: el USER ve el historial de su tarea
  pero no la auditoría de la organización.

### Visibilidad de proyectos
`APP.PROJECT_VISIBILITY` admite `'ALL'` (equipo pequeño, por defecto) o
`'INVOLVED'` (el USER ve solo proyectos donde es responsable o tiene tareas
asignadas). Es el punto de extensión natural para una hoja `PROJECT_MEMBERS` en
fase 2; el filtro ya está centralizado en una función.

---

## 5. Decisiones menores pero deliberadas

| Tema | Decisión |
|---|---|
| **Borrado** | Soft delete (`activo = false`) en todas las entidades. Nada se borra físicamente, la trazabilidad se preserva |
| **XSS** | HtmlService ya aísla en IFRAME, pero todo texto de usuario se inyecta con `textContent` o pasa por `esc()`. Cero `innerHTML` con datos crudos |
| **Errores** | Contrato único `{success:true,data}` / `{success:false,errorCode,message}`. El stack trace va a `Logger`/Cloud Logging, nunca al navegador |
| **Campo añadido al esquema** | `TASKS.avanceManual` (boolean). El enunciado pide avance automático desde subtareas *con opción manual*: sin esta bandera es imposible distinguir "0 % calculado" de "0 % fijado por el usuario". Es la única desviación del modelo de datos propuesto |
| **Dependencias externas** | Una sola: SortableJS por CDN (drag & drop con soporte táctil real para tablet). Los gráficos del dashboard son SVG/CSS propios — una librería de charts no se justifica para 3 gráficos |
| **Hoja `CONFIG`** | Parámetros editables desde la app (días de "próxima a vencer", visibilidad de proyectos) sin volver a desplegar |
| **`AUDIT_LOG`** | Solo el *delta* de campos modificados, en JSON. Registrar el objeto completo haría crecer la hoja un orden de magnitud |

---

## 6. Cuándo este diseño deja de alcanzar

Dimensionado objetivo: 10–50 usuarios, 50–500 proyectos, miles de tareas. El
punto de quiebre no son las celdas, es la **latencia de lectura completa de
`TASKS`**: a partir de ~20 000 filas, `getDataRange()` empieza a costar segundos
y la caché deja de absorberlo.

Ruta de escalamiento, en orden de costo creciente:

1. **Particionar `TASKS` por proyecto** o archivar las tareas cerradas con más
   de N meses a una hoja `TASKS_ARCHIVE`. Barato y compatible con el código actual.
2. **Mover las lecturas a la Sheets API v4 vía `UrlFetchApp`** con rangos y
   `fields` selectivos: menos overhead que `SpreadsheetApp`.
3. **Cambiar el datastore a Firestore** (o Cloud SQL) manteniendo Apps Script
   como frontend. Solo habría que reimplementar `Repo.gs`: el resto de la app
   está escrito contra la interfaz `Table`, no contra `SpreadsheetApp`. Esto es
   el motivo real de que exista esa capa.

Límites que no se pueden evadir en Apps Script, y que conviene saber de entrada:
sin WebSockets (no hay colaboración en vivo; el refresco es por *polling* o
manual), cuotas diarias por usuario, y arranque en frío de ~1–2 s en la primera
llamada del día.
