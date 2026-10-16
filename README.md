# Kanban Workspace

Aplicación web de gestión de proyectos tipo Kanban construida íntegramente
sobre **Google Apps Script + Google Sheets**. Sin servidores externos, sin
bases de datos externas, sin servicios de pago.

```
Dashboard · Proyectos · Kanban (5 columnas, drag & drop) · Carta Gantt · Mis tareas
Subtareas · Comentarios · Historial · Auditoría · Mantenedor de usuarios
```

| | |
|---|---|
| **Backend** | Google Apps Script (V8), Google Sheets como datastore, PropertiesService, CacheService, LockService |
| **Frontend** | HTML Service · SPA sin recarga · CSS propio con modo claro/oscuro |
| **Dependencias externas** | 1 (SortableJS por CDN, para el drag & drop táctil) |
| **Dimensionado** | 10–50 usuarios · 50–500 proyectos · miles de tareas |

---

## 1. Estructura de archivos

Copia cada archivo al proyecto de Apps Script con el **mismo nombre**. El orden
no importa: Apps Script evalúa todos los `.gs` en un único ámbito global.

### Backend (`.gs`)

| Archivo | Responsabilidad |
|---|---|
| `Config.gs` | Constantes, esquema de las hojas, matriz de permisos. **Es el único archivo que se edita para parametrizar.** |
| `Utils.gs` | Errores (`AppError`), contrato de respuesta, IDs, fechas ISO, saneamiento, validación, `withLock_` |
| `Repo.gs` | Capa de datos: clase `Table` (lectura/escritura en bloque, caché por versión). **El único archivo que habla con `SpreadsheetApp`** |
| `Setup.gs` | `setupApplication()`, diagnóstico de despliegue, limpieza de caché, archivado de auditoría |
| `Auth.gs` | Resolución de identidad, matriz de permisos, visibilidad de proyectos |
| `Users.gs` | Mantenedor de usuarios y reglas de integridad (último admin, autodesactivación) |
| `Projects.gs` | CRUD de proyectos, métricas derivadas, cálculo de "en riesgo" |
| `Tasks.gs` | CRUD de tareas, tablero, movimiento y reordenamiento Kanban, avance |
| `Gantt.gs` | Actividades de la carta Gantt por proyecto (alta, mover/extender, eliminar) |
| `Subtasks.gs` | Subtareas y propagación del avance a la tarea padre |
| `Comments.gs` | Comentarios |
| `Audit.gs` | Registro y consulta de auditoría |
| `Dashboard.gs` | Resumen ejecutivo, "Mis tareas", exportación CSV, parámetros de CONFIG |
| `Code.gs` | `doGet`, `include` y **toda** la API expuesta a `google.script.run` |

### Frontend (`.html`)

| Archivo | Responsabilidad |
|---|---|
| `Index.html` | Esqueleto: pantalla de carga, acceso denegado, shell (barra lateral + cabecera) |
| `Styles.html` | Hoja de estilos única, con tokens de color y modo oscuro |
| `App.html` | Núcleo: `UI` (escapado, fechas, toasts, modales) y `App` (RPC, estado, router) |
| `ViewDashboard.html` | KPIs y gráficos |
| `ViewProjects.html` | Listado, alta, edición y archivado de proyectos |
| `ViewKanban.html` | Tablero, filtros y drag & drop |
| `ViewGantt.html` | Carta Gantt: escala semana…año, filas agrupadas, mover/extender con el mouse |
| `ViewTaskDetail.html` | Formulario de tarea, panel de detalle, subtareas, comentarios, historial |
| `ViewMyTasks.html` | "Mis tareas" ordenadas por urgencia |
| `ViewAdmin.html` | Usuarios, auditoría, configuración y perfil |

> Esta estructura difiere ligeramente de la propuesta inicial: en lugar de un
> `JavaScript.html` monolítico, cada vista lleva su propio archivo, y el núcleo
> (RPC + router + utilidades de UI) vive en `App.html`. Así una vista se puede
> tocar sin releer el resto, que es lo que más pesa al mantener.

### Herramientas de desarrollo (no se suben a Apps Script)

| Archivo | Qué hace |
|---|---|
| `tools/verify.js` | Comprobaciones estáticas: sintaxis, colisiones de declaraciones, RPC ↔ API, `include` ↔ archivos, campos ↔ esquema, rutas ↔ vistas, heurística XSS |
| `tools/gasenv.js` | Simulador en memoria de los servicios de Apps Script |
| `tools/sim.js` | 135 pruebas funcionales del backend (instalación, permisos, Kanban, avance, auditoría…) |
| `tools/uitest.js` | 87 pruebas de extremo a extremo del frontend real sobre jsdom |

```bash
npm install jsdom
node tools/verify.js && node tools/sim.js && node tools/uitest.js
```

---

## 2. Modelo de datos

Cada hoja se crea automáticamente con sus encabezados. Las columnas no
numéricas quedan con **formato de texto**: así los ISO-8601 no se convierten en
objetos `Date` y un valor que empieza con `=` nunca se evalúa como fórmula.

**USERS** — `userId · email · nombre · rol · activo · fechaCreacion · fechaActualizacion · ultimoAcceso`

**PROJECTS** — `projectId · nombre · descripcion · responsable · fechaInicio · fechaFin · estado · porcentajeAvance · prioridad · fechaCreacion · creadoPor · fechaActualizacion · actualizadoPor · activo`

**TASKS** — `taskId · projectId · titulo · descripcion · estado · prioridad · porcentajeAvance · avanceManual · responsable · fechaInicio · fechaVencimiento · fechaCompletado · creadoPor · fechaCreacion · actualizadoPor · fechaActualizacion · ordenKanban · activo`

**SUBTASKS** — `subtaskId · taskId · titulo · descripcion · completada · porcentajeAvance · responsable · fechaVencimiento · fechaCreacion · fechaActualizacion · activo`

**GANTT** — `ganttId · projectId · grupo · fila · titulo · fechaInicio · fechaFin · orden · fechaCreacion · fechaActualizacion · activo`

Una fila del Gantt es el par `(grupo, fila)`; varias actividades con el mismo par comparten línea. La hoja se crea sola al primer uso (o al ejecutar `setupApplication()`).

**COMMENTS** — `commentId · taskId · userId · comentario · fechaCreacion · activo`

**AUDIT_LOG** — `logId · userId · email · accion · entidad · entityId · valorAnterior · valorNuevo · fecha`

**CONFIG** — `clave · valor · descripcion`

Convenciones:

- **Fechas**: `YYYY-MM-DD` para fechas y `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC) para
  instantes, siempre como texto. Ambos ordenan correctamente de forma
  lexicográfica, así que filtrar y ordenar en el Sheet sigue funcionando.
- **Borrado**: nunca físico. `activo = false` (soft delete) conserva la trazabilidad.
- **Auditoría**: se guarda solo el *delta* de campos modificados, en JSON.
- `avanceManual` es el único campo añadido al modelo propuesto: sin él es
  imposible distinguir "0 % calculado desde subtareas" de "0 % fijado a mano".

---

## 3. Instalación paso a paso

### 3.1 Crear el proyecto

1. Entra a <https://script.google.com> → **Nuevo proyecto**.
2. Ponle nombre, por ejemplo `Kanban Workspace`.
3. En **Configuración del proyecto**, marca *Mostrar el archivo de manifiesto
   `appsscript.json`* (útil para fijar la zona horaria).

### 3.2 Copiar el código

1. Crea un archivo por cada `.gs` de la carpeta `src/` (icono **+** → Secuencia
   de comandos) y pega su contenido. Borra el `Code.gs` vacío inicial o
   reemplaza su contenido por el del repositorio.
2. Crea un archivo por cada `.html` (**+** → HTML) con **exactamente el mismo
   nombre, sin la extensión**: `Index`, `Styles`, `App`, `ViewDashboard`,
   `ViewProjects`, `ViewKanban`, `ViewGantt`, `ViewTaskDetail`, `ViewMyTasks`, `ViewAdmin`.
3. Opcional: pega `src/appsscript.json` sobre el manifiesto del proyecto para
   fijar la zona horaria y el tipo de despliegue. **No declara `oauthScopes` a
   propósito**: Apps Script los infiere del código en cada guardado, y una lista
   incompleta escrita a mano es una fuente habitual de errores de autorización.

> Si prefieres automatizarlo, con [clasp](https://github.com/google/clasp)
> basta `clasp push` desde la carpeta `src/`.

### 3.3 Configurar el administrador inicial

En **Configuración del proyecto → Propiedades del script → Agregar propiedad**:

| Propiedad | Valor |
|---|---|
| `ADMIN_EMAIL` | tu correo de Google (será el primer ADMIN) |

Esta propiedad solo se usa durante la inicialización. Después, los usuarios se
gestionan desde **Administración → Usuarios**.

### 3.4 Ejecutar `setupApplication()`

1. Selecciona la función `setupApplication` en el desplegable del editor y pulsa
   **Ejecutar**.
2. Autoriza los permisos (Sheets, Drive y "ejecutarse como tú"). La primera vez
   Google muestra un aviso de app no verificada: **Configuración avanzada → Ir a
   \<nombre del proyecto\>**. Es tu propio script.
3. Revisa el registro de ejecución: indica la URL del spreadsheet creado, las
   hojas generadas y el administrador inicial.

`setupApplication()` es **idempotente**: se puede volver a ejecutar sin duplicar
nada. Al añadir campos nuevos al esquema, vuelve a ejecutarla para que cree las
columnas que falten.

### 3.5 Desplegar como aplicación web

**Implementar → Nueva implementación → Tipo: Aplicación web.**

La configuración correcta depende de las cuentas que van a usar la app. **Esta
es la decisión de seguridad más importante del despliegue** (el detalle está en
`docs/ARCHITECTURE.md` §2):

| Escenario | Ejecutar como | Quién tiene acceso | `APP.DEPLOY_MODE` | ¿Compartir el Sheet? |
|---|---|---|---|---|
| **Todos en un dominio Google Workspace** (recomendado) | Yo | Usuarios de *mi dominio* | `EXECUTE_AS_OWNER` | **No** |
| **Hay invitados @gmail.com** | El usuario que accede | Cualquier usuario con cuenta de Google | `EXECUTE_AS_USER` | Sí, solo con los usuarios dados de alta |

> La combinación intuitiva —*ejecutar como yo* + *cualquiera con cuenta de
> Google*— **no funciona**: en ese modo Apps Script devuelve un email vacío para
> las cuentas externas al dominio, y sin identidad no hay control de acceso. La
> app lo detecta y deniega el acceso en lugar de degradarse a algo inseguro.

El valor de `APP.DEPLOY_MODE` en `Config.gs` **debe coincidir** con el
despliegue real. Si algo falla, ejecuta `diagnoseDeployment()` desde el editor:
muestra qué está devolviendo `getActiveUser()` y qué configuración falta.

### 3.6 Si usas `EXECUTE_AS_USER`: compartir el Sheet

En ese modo el script se ejecuta con la identidad de cada usuario, así que cada
uno necesita **acceso de edición** al spreadsheet de datos.

1. Abre la URL del spreadsheet que imprimió `setupApplication()`.
2. **Compartir** → añade **solo** los correos dados de alta en la app, como editores.
3. **Nunca** uses "Cualquier persona con el enlace".

Limitación conocida y asumida: un usuario con ese acceso podría editar la
planilla directamente, saltándose validaciones y auditoría. Las hojas quedan
protegidas con advertencia y el Sheet se trata como infraestructura, no como
interfaz. Si el equipo migra a un dominio Workspace, cambia `DEPLOY_MODE` a
`EXECUTE_AS_OWNER`, deja de compartir el Sheet y el problema desaparece sin
tocar una línea de código.

### 3.7 Compartir la URL

Copia la URL `.../exec` de la implementación y repártela. Al entrar, Google
pedirá iniciar sesión y la app validará el correo contra la hoja `USERS`.

> Cada vez que cambies el código debes crear una **nueva versión** de la
> implementación (Implementar → Administrar implementaciones → lápiz → Versión:
> Nueva) para que los usuarios vean los cambios.

---

## 4. Configuración posterior

### Usuarios — Administración → Usuarios

Alta, edición, cambio de rol y activación/desactivación. Reglas que impone el
backend:

- No se puede desactivar la propia cuenta.
- No se puede quitar el rol ADMIN a uno mismo.
- Siempre debe quedar al menos un ADMIN activo.
- Un usuario desactivado pierde el acceso **de inmediato**, aunque tenga la app abierta.

### Parámetros — Administración → Configuración

| Clave | Para qué sirve |
|---|---|
| `DUE_SOON_DAYS` | Días de antelación con los que una tarea se marca "próxima a vencer" |
| `PROJECT_VISIBILITY` | `ALL` (todos ven todos los proyectos) o `INVOLVED` (el USER ve solo donde es responsable o tiene tareas) |
| `PROJECT_RISK_PCT` | Umbral de avance bajo el cual un proyecto se marca "en riesgo" al llevar el 70 % del plazo |
| `ALLOW_USER_CREATE_PROJECT` | Permite que el rol USER cree proyectos |

### Roles

| | ADMIN | USER |
|---|:---:|:---:|
| Ver proyectos | todos | según `PROJECT_VISIBILITY` |
| Crear / editar / archivar proyectos | ✓ | solo crear, y solo con `ALLOW_USER_CREATE_PROJECT` |
| Crear y editar tareas, mover en el Kanban, actualizar avance | ✓ | ✓ |
| Subtareas y comentarios | ✓ | ✓ |
| Historial de una tarea | ✓ | ✓ |
| Auditoría global | ✓ | ✗ |
| Administrar usuarios y configuración | ✓ | ✗ |

Agregar un rol nuevo (`VIEWER`, `MANAGER`…) es añadir una entrada a
`PERMISSIONS` en `Config.gs`. La lógica de negocio no conoce los roles: solo
pregunta por permisos.

### Mantenimiento

| Función (ejecutar desde el editor) | Para qué |
|---|---|
| `diagnoseDeployment()` | Diagnosticar problemas de identidad o configuración |
| `clearDataCache()` | Invalidar la caché tras editar la planilla a mano |
| `archiveAuditLog(180)` | Mover a `AUDIT_LOG_ARCHIVE` la auditoría de más de N días |

`archiveAuditLog` conviene programarla con un activador mensual cuando la hoja
`AUDIT_LOG` supere unas 20 000 filas.

---

## 5. Checklist de pruebas funcionales

Las marcadas con ✅ están cubiertas automáticamente por `tools/sim.js` y
`tools/uitest.js`; conviene repetirlas en el entorno real tras el despliegue.

### Acceso y seguridad

- [ ] ✅ Un usuario autorizado y activo entra y ve el Dashboard
- [ ] ✅ Una cuenta no registrada ve *"Tu cuenta no tiene permisos para acceder a esta aplicación. Contacta al administrador."*
- [ ] ✅ Un usuario desactivado pierde el acceso de inmediato
- [ ] ✅ Un USER que llama a `getUsers()` / `getAuditLog()` / `getAppConfig()` recibe `FORBIDDEN`
- [ ] ✅ Una cuenta no autorizada que llama a cualquier función recibe `UNAUTHORIZED`
- [ ] Abrir la consola del navegador y ejecutar `google.script.run.getUsers()` como USER → denegado
- [ ] ✅ Sin identidad verificable no se cae al dueño del script (no hay escalada de privilegios)

### Usuarios

- [ ] ✅ El ADMIN crea un usuario y este puede entrar
- [ ] ✅ No se admiten correos duplicados ni con formato inválido
- [ ] ✅ El ADMIN no puede desactivarse ni degradarse a sí mismo
- [ ] ✅ Siempre queda al menos un ADMIN activo
- [ ] ✅ Se registra el último acceso

### Proyectos

- [ ] ✅ Crear, editar y archivar un proyecto
- [ ] ✅ El nombre es obligatorio y la fecha objetivo no puede ser anterior al inicio
- [ ] ✅ El responsable debe ser un usuario activo de la aplicación
- [ ] ✅ Un proyecto archivado desaparece de los listados y puede reactivarse
- [ ] ✅ Las métricas (total / completadas / vencidas / avance) cuadran con las tareas

### Kanban

- [ ] ✅ El tablero muestra exactamente 5 columnas en el orden ON HOLD → DONE
- [ ] ✅ Crear una tarea desde el botón **+** de una columna la deja en esa columna
- [ ] Arrastrar una tarjeta entre columnas la persiste (recarga la página y sigue ahí)
- [ ] Arrastrar dentro de una columna conserva el orden tras recargar
- [ ] ✅ Al pasar a DONE el avance salta a 100 % y se registra la fecha de completado
- [ ] ✅ Al salir de DONE se limpia la fecha y el avance se recalcula
- [ ] Mover una tarjeta con la red caída muestra un error y el tablero vuelve a su estado real
- [ ] ✅ Los contadores de cada columna se actualizan sin recargar la página

### Carta Gantt

- [ ] La vista **Gantt** (o el botón *Gantt* de la tarjeta de un proyecto) muestra las actividades del proyecto elegido
- [ ] El selector de escala (Semana, Mes, Trimestre, Cuatrimestre, Semestre, Año) cambia las columnas y su agrupación sin alterar las fechas
- [ ] **+ Actividad** crea una cajita; doble clic en una fila crea otra en esa misma fila
- [ ] Arrastrar una cajita la mueve (y a otra fila si se suelta sobre ella); tirar de los bordes cambia inicio o término; se persiste al soltar
- [ ] Clic en una cajita abre su edición, con opción de eliminar

### Tareas, subtareas y comentarios

- [ ] ✅ Abrir una tarjeta muestra descripción, subtareas, comentarios e historial
- [ ] ✅ Crear, editar, completar y eliminar subtareas
- [ ] ✅ El avance se calcula automáticamente desde las subtareas (2 de 3 → 67 %)
- [ ] ✅ Fijar el avance a mano desactiva el cálculo automático y se respeta
- [ ] ✅ Volver al modo automático recalcula desde las subtareas
- [ ] ✅ Los comentarios se listan del más reciente al más antiguo
- [ ] ✅ Un usuario no puede borrar el comentario de otro; un ADMIN sí
- [ ] ✅ El historial muestra *"X cambió estado de TO DO → DOING"* con su fecha

### Filtros, dashboard y exportación

- [ ] ✅ Búsqueda por texto, filtros por responsable, prioridad, fechas, vencidas y "mis tareas"
- [ ] ✅ "Mis tareas" solo devuelve las tareas del usuario que consulta
- [ ] ✅ Los KPIs y los gráficos del dashboard cuadran con los datos
- [ ] ✅ La exportación CSV trae una fila por tarea

### Auditoría y persistencia

- [ ] ✅ Se registran: creación de proyecto/tarea, cambio de estado, de responsable, de avance, alta y baja de usuarios
- [ ] ✅ La auditoría se filtra por entidad, acción, usuario y rango de fechas
- [ ] Abrir el Google Sheet y comprobar que todas las filas están ahí
- [ ] Recargar la aplicación: todo lo creado sigue presente

### Interfaz

- [ ] ✅ Un título con HTML (`<img src=x onerror=...>`) se muestra como texto y no ejecuta nada
- [ ] ✅ El menú de administración no aparece para el rol USER
- [ ] Probar en pantalla de escritorio, notebook y tablet
- [ ] Probar el modo oscuro
- [ ] Los errores se muestran como mensajes comprensibles, nunca como trazas técnicas

---

## 6. Rendimiento y escalamiento

Decisiones ya implementadas:

- **Una lectura por hoja y por ejecución**, servida desde `CacheService` con
  invalidación **por versión de datos** (no por TTL): nadie lee datos obsoletos
  después de que otro usuario escriba.
- **Escrituras en bloque**: actualizar un registro es una sola llamada
  `setValues`; reordenar una columna agrupa filas contiguas. No hay ningún
  `getRange()` dentro de un bucle.
- **`LockService` solo en escrituras**: aplicarlo también a las lecturas
  serializaría a todos los usuarios navegando.
- **Orden Kanban con huecos**: un arrastre cuesta **una** escritura de una fila;
  la columna completa solo se renormaliza cuando el hueco entre vecinos se agota.

El punto de quiebre no son las celdas (el límite es 10 millones), sino la
latencia de leer `TASKS` completa: desde unas ~20 000 filas empieza a costar
segundos. La ruta de escalamiento, de menor a mayor costo:

1. Archivar las tareas cerradas con más de N meses a `TASKS_ARCHIVE`.
2. Leer con la Sheets API v4 vía `UrlFetchApp`, con rangos y campos selectivos.
3. Cambiar el datastore a Firestore. **Solo habría que reescribir `Repo.gs`**:
   el resto de la aplicación está escrito contra la interfaz `Table`, no contra
   `SpreadsheetApp`. Ese es el motivo real de que exista esa capa.

Limitaciones de Apps Script que no se pueden evadir: sin WebSockets (no hay
colaboración en vivo; el refresco es manual), cuotas diarias por usuario y
arranque en frío de 1–2 s en la primera llamada del día.

---

## 7. MVP entregado y fase 2

### Incluido en este MVP

Login y autorización con Google · mantenedor de usuarios · roles ADMIN/USER ·
proyectos · Kanban de 5 estados · alta y edición de tareas · drag & drop ·
fechas e indicadores de vencimiento · % de avance manual y automático ·
descripciones · subtareas · responsables · prioridades · comentarios ·
historial por tarea · dashboard con gráficos · búsqueda · filtros · auditoría ·
persistencia en Google Sheets.

Extras que no comprometían la estabilidad y ya vienen incluidos: duplicar
tarea (con sus subtareas), exportar a CSV, modo oscuro, atajos de teclado
(`d`, `p`, `k`, `m`), vista "Mis tareas" y parámetros editables desde la app.

### Fase 2 — pendiente por diseño

| Funcionalidad | Nota de implementación |
|---|---|
| Etiquetas / tags | Hoja `TAGS` + columna en `TASKS`; el filtro ya está centralizado |
| Varios responsables por tarea | Requiere pasar `responsable` a lista y una hoja `TASK_ASSIGNEES` |
| Adjuntos en Drive | `DriveApp` + carpeta por proyecto; la propiedad `DRIVE_FOLDER_ID` ya está reservada |
| Vista calendario | Sobre `Tasks_list_`, sin cambios en el backend |
| Filtros guardados | `PropertiesService` de usuario |
| Permisos por proyecto | Hoja `PROJECT_MEMBERS`; el punto de extensión es `canSeeProject_()` |
| Notificaciones por correo | `MailApp` + activador diario de vencimientos |
| Duplicar proyecto | Análogo a `Tasks_duplicate_` |

---

## 8. Documentos relacionados

- **`docs/ARCHITECTURE.md`** — revisión de arquitectura: el problema de la
  identidad según el modo de despliegue, los límites reales de Sheets como
  datastore, y las siete decisiones de diseño con su justificación.
