# AGENTS.md

Contrato de trabajo para cualquier agente (Claude Code a través de `CLAUDE.md`, que sólo importa este
fichero; Copilot; opencode) y para quien contribuya. Si este fichero y el código discrepan, gana el código:
se corrige el fichero.

## Qué es misMEM

Memoria persistente para LLMs, expuesta como servidor MCP sobre una sola base SQLite que comparten todos los
clientes. Tiene tres capas: `episodes` (texto literal y fechado), `memories` (resúmenes que destila una
consolidación con LLM, con una saliencia que decae y se refuerza con el uso) y `traits` (patrones
cristalizados). Seis herramientas canónicas (`capture`, `recall`, `reinforce`, `consolidate`,
`crystallize`, `forget`) y alias `mem_*` de Engram. El resto de la forma del sistema:
[`docs/architecture.md`](docs/architecture.md).

Stack: TypeScript estricto, ESM, Node 22 o superior, `better-sqlite3` (WAL y FTS5), SDK de MCP, Zod y Vitest;
la interfaz es React, Vite y Tailwind. Gestor de paquetes: pnpm, nunca npm.

## Dónde vive qué

| Ruta | Qué posee | Se toca cuando |
|---|---|---|
| `engine/src/domain/` | `hash.ts` (hash del contenido, dedup de `capture`), `terms.ts` (tokenización compartida por la búsqueda y la medición de uso), `noise.ts` (marcadores de ruido y sus prefijos), `support.ts` (cuánto de un co-uso fue repetición, y el suelo de soporte). Sin I/O, entorno ni SQL | cambia uno de esos criterios |
| `engine/src/store/` | `db.ts` (`SCHEMA`, migraciones aditivas en `migrate()`, apertura con permisos `0600`), `probe.ts` (comprueba en sólo lectura que un fichero es una base de misMEM antes de abrirlo), `connectome.ts` (turnos, pares de uso, el NPMI de un par, la siembra del contador y el ranking de hubs), `rows.ts` (las formas de fila y `MEMORY_COLUMNS` que comparten el visor y la exportación, más `excludeNoiseSql`) | cambia una tabla, una columna o cómo se abre la base |
| `engine/src/memory/` | Una herramienta por fichero: `capture.ts`, `consolidate.ts`, `crystallize.ts`, `forget.ts`, `reinforce.ts` (con el registro de uso) y `pending.ts` (los episodios pendientes), más `edit.ts` (las escrituras que dispara el visor) y `salience.ts` (decay y refuerzo) | cambia lo que hace una herramienta, una escritura del visor o la fórmula de saliencia |
| `engine/src/recall/` | `fts.ts` (sintaxis FTS5), `rescue.ts` (rescate laxo y sus constantes), `lexical.ts` (candidatos léxicos), `fuse.ts` (fusión RRF con la saliencia), `recall.ts` (los dos caminos del recall y la forma del hit) y `bench.ts` (medición del recall) | cambia el ranking (pide `mismem-bench`) |
| `engine/src/queries/` | Las lecturas del visor, de los CLI `mismem-stats` e `mismem-ingest`, del alias `mem_get_observation` y de la exportación a Obsidian: un módulo por recurso (`stats.ts`, `recent.ts`, `scopes.ts`, `memories.ts`, `traits.ts`, `graph.ts`, `forget-impact.ts`, `observation.ts`, `export.ts`), más `views.ts` (la forma de una memoria y un rasgo) y `relations.ts` (memorias parecidas por vector, compartida con la exportación a Obsidian, y `coUseLinks`, el camino de lectura de la capa lateral). Reciben la base y devuelven datos planos | cambia una lectura del visor, de la exportación o de `mem_get_observation`, cómo se relacionan las memorias o la forma que devuelve |
| `engine/src/embeddings/` | `provider.ts` (configuración por entorno y cliente HTTP), `store.ts` (SQL de `memory_embeddings`, búsqueda y backfill), `vector.ts` (coseno) | cambia la capa semántica (pide `mismem-bench`) |
| `engine/src/consolidation/` | `run.ts` (la corrida: entorno, contexto y resumen), `scope.ts` (`processScope` con el `RunContext` fijo y el `RunState` de la corrida), `budget.ts` (presupuesto del prompt y recorte de episodios), `llm.ts` (proveedores), `prompts.ts`, `job.ts` (corrida en segundo plano desde la interfaz), `pareto.ts` (prefiltro heurístico que descarta ruido antes del LLM) y su `README.md` | cambia cómo se destilan los episodios |
| `engine/src/ingest/` | Importadores de ChatGPT y de VS Code, el recorrido de ficheros y `engram.ts` (abre una base de Engram en sólo lectura y la migra a episodios) | se importa un formato nuevo o cambia la migración de Engram |
| `engine/src/export/` | `obsidian.ts` (`exportObsidian`, que orquesta), `notes.ts` (el formato puro de cada nota: nombres, enlaces, frontmatter y cuerpo) y `vault.ts` (el manifiesto, la propiedad por frontmatter y la escritura o borrado en disco) | cambia la exportación |
| `engine/src/mcp/` | `engram-tools.ts` (el catálogo `ENGRAM_TOOLS`) y `engram-compat.ts` (el despacho de los alias `mem_*` y los helpers de argumentos; la lectura va por `queries/observation.ts` y la escritura por `memory/engram-update.ts`) | cambia la compatibilidad con Engram |
| `engine/src/http/` | `routes.ts` (el despacho completo, con sus dependencias inyectadas) y `respond.ts` (sus respuestas JSON y de texto), `guard.ts`, `host.ts`, `body.ts` (dirección de enlace y BasicAuth, guarda de `Host`, lectura del cuerpo con tope), `session.ts` y `login.ts` con `login-css.ts` (la sesión firmada del visor y su formulario) y `viewer/{read,api,actions}.ts` (validan, llaman a `queries/` o `memory/` y responden) | cambia qué petición se atiende o lo que el visor muestra y puede hacer |
| `engine/src/hooks/` | `inject.ts`, `usage.ts`, `client.ts`, `readiness.ts`: qué inyectar, qué se usó, cliente remoto y espera a que el servidor esté listo | cambia un hook |
| `engine/src/` (raíz) | Los binarios `mismem-*` (`*-cli.ts`, `*-args.ts`, `cli-args.ts`), `env.ts`, el borde de Zod (`schema.ts`, con el tipo `RecallHit`), las entradas `server.ts`, `server-core.ts` y `server-http.ts`, y `viewer-static.ts` con su CSP | cambia un CLI, un flag o una entrada |
| `engine/ui/` | La interfaz (React) en `ui/src`; se compila a `dist/ui`. `ui/src/components/ui/` es código de shadcn: Biome y knip lo tratan aparte | cambia lo que se ve |
| `engine/tests/` | Un `<área>.test.ts` por área; `fixtures/` (exports ficticios) y `support/` | cada cambio |
| `scripts/` | `install.sh` (instalador de Linux), `mismem-hook.sh` (envoltorio de los hooks), `backup-mismem-from-server.ps1` (respaldo desde Windows) | cambia la instalación o el respaldo |
| `engine/Dockerfile.mismem-brain`, `.github/` | La imagen, los workflows, las plantillas y las etiquetas | cambia el empaquetado o la CI |

`engine/tests/architecture.test.ts` hace cumplir esa estructura: la lista exacta de ficheros de la raíz, la
matriz de dependencias entre carpetas (sólo hacia abajo, más `env.ts`, `cli-args.ts` y `schema.ts`), la
pureza de `domain/` (sin I/O ni `process.env`), la ausencia de SQL en la entrega (`http/`, `mcp/`, `hooks/`,
`export/` y la raíz) y el trinquete de 400 líneas en `src/` y `ui/src/`. Sus excepciones son explícitas y
sólo encogen: el test falla también si una deja de hacer falta.

Las tablas de la base, en `engine/src/store/db.ts`:

| Tabla | Qué guarda |
|---|---|
| `episodes` | Texto literal en `body` (no `text`; el recall lo expone como `text`), con `consolidated_into`, `content_hash` y `uncited_count` |
| `memories` | `gist` y `details`, `source_episode_ids` (JSON), `salience`, `use_count` y las marcas de tiempo del decay |
| `traits` | `name` único por `scope`, `evidence_memory_ids` (JSON), `strength` y `polarity` |
| `co_use` | Pares de memorias usadas en el mismo turno; sólo lo escribe `reinforce` |
| `meta` | Claves sueltas del motor; entre ellas el contador de turnos, que es el denominador del NPMI del conectoma |
| `memory_embeddings` | Un vector (BLOB) por memoria y el modelo que lo generó |
| `episodes_fts`, `memories_fts`, `traits_fts` | Índices FTS5 que mantienen disparadores |

## Comandos

Desde `engine/`, tras `pnpm install --frozen-lockfile` (como CI). Antes de dar un cambio por hecho, lo mismo que corre CI en el job `test`:

```bash
pnpm typecheck && pnpm test && pnpm knip && pnpm dup && pnpm lint && pnpm build
```

- Los demás jobs de CI (scripts de shell, licencia y Dockerfile, imagen y `/healthz`, workflows, secretos) y cómo
  reproducirlos en local: [Qué comprueba CI](CONTRIBUTING.md#qué-comprueba-ci). Un cambio en `scripts/`, en el
  Dockerfile o en `.github/` los toca.
- Un test suelto: `pnpm test tests/<área>.test.ts`.
- Desarrollo: `pnpm dev` (MCP por stdio), `pnpm dev:http` (servidor en `:3200`, sin interfaz compilada) y
  `pnpm dev:ui` (la interfaz, con `/api` hacia el servidor de `MISMEM_DEV_API`, por defecto `:3200`).
- Medir el recall, tras `pnpm build`: `node dist/bench-cli.js --bank <banco.jsonl> --db <base.db>`.
  Informa MRR, la posición del acierto, los recuerdos devueltos por pregunta y `noiseHits`, que tiene que ser 0.
  El banco es privado y sale de la propia memoria: no se sube a ningún sitio.

## Reglas duras

| Regla | Por qué |
|---|---|
| Nunca leer ni editar `.env*`, ni mostrar un secreto en una respuesta, un log o un issue | Ahí viven las claves de los proveedores y las credenciales del servidor; `.env.example` sólo lleva marcadores |
| Sin `git push --force` ni reescribir la historia sin permiso expreso | Se mergea con merge commit y la historia publicada conserva el porqué de cada commit |
| El esquema cambia sólo con migraciones aditivas en `migrate()` de `engine/src/store/db.ts`: se añaden columnas, índices y tablas, y cada paso comprueba el estado y se puede repetir. `migrate()` sí puede borrar y recrear disparadores heredados y rellenar columnas nuevas; nunca borra una tabla ni una columna con datos. Con su test y su línea en el CHANGELOG | La base de cada persona ya existe y se abre con el código nuevo: un error rompe datos reales. `CODEOWNERS` pide revisión de los dos responsables |
| Quien toca el ranking o los embeddings (`recall/`, `embeddings/`) corre `mismem-bench` antes y después y pone las cifras en el PR, con la etiqueta `needs-bench` ([Tests](docs/standards/tests.md)) | Sin esa medida no hay forma de saber si el cambio mejora el recall: los tests no la dan y el bench no corre en CI |
| Toda dependencia que se añade o se sube entra con versión exacta (sin `^` ni `~`) y publicada hace 14 días o más; los `^` que ya hay se fijan la próxima vez que se suban ([Seguridad](docs/standards/security.md)). Un script de instalación nuevo se lee, y sólo entonces se aprueba, uno a uno, en `allowBuilds` de `engine/pnpm-workspace.yaml` (hoy `better-sqlite3` y `esbuild`) | Cadena de suministro: lo recién publicado es lo que más se compromete, y un `postinstall` ejecuta código al instalar |
| Los hooks `mismem-inject` y `mismem-used` nunca fallan ni bloquean un prompt: errores a stderr, salida sin error, y ante la duda no hacen nada; contra un servidor remoto (`MISMEM_HOOK_URL`) llevan además un tope de tiempo | Corren en cada turno del cliente; un hook roto cuesta más que un recuerdo sin inyectar |
| `engine/src/server-http.ts` escucha al importarse: sólo lee el entorno, abre la base, compone y escucha. El despacho va en `http/routes.ts`, que se importa sin abrir puerto y se prueba en `tests/http-routes.test.ts`; la guarda de `Host`, la auth y el cuerpo viven en `http/host.ts`, `http/guard.ts` y `http/body.ts` | Un test no puede importar `server-http.ts` sin abrir un puerto; el test del servidor lo lanza como proceso hijo |
| Datos de usuario nunca en tests, fixtures, capturas, documentación, issues ni logs | La memoria es personal. Los tests usan `openDb(":memory:")` o un directorio temporal propio y jamás tocan `~/.mismem` |
| Las herramientas de la propia memoria (`capture`, `recall`) son para las notas del agente: nunca guardan secretos ni datos de terceros | Lo capturado queda en una base que se respalda, se consolida con un LLM externo y se lee desde el visor |

## Convenciones que el código no deja ver

- **Idioma**: identificadores, claves JSON, comentarios y commits (Conventional Commits) en inglés. Mensajes
  de cara al usuario (errores, logs, ayuda de los CLI, interfaz), Markdown y las descripciones de `it()` y
  `describe()` en español neutro (formas impersonales, ni voseo ni vosotros). Todo comentario de
  `engine/src`, `engine/ui/src` y `engine/tests` va en inglés.
- **Comentarios**: dicen el porqué (la restricción, el motivo, lo que se descartó), nunca el qué. Cabecera de
  módulo de tres líneas como mucho, sin inventarios; ningún otro bloque pasa de cinco, y una calibración o un
  razonamiento largo va a `docs/`. Sin código comentado, sin historia ni notas de PR, sin `TODO`/`FIXME` sin
  issue (`TODO(#123)`) y sin `biome-ignore` sin motivo. Lo comprueba `engine/tests/comments.test.ts` (cabecera,
  bloque, idioma, `TODO`, código comentado y `biome-ignore`); la longitud del JSDoc y el porqué de cada
  comentario son revisión. La norma completa está en [`docs/standards/comments.md`](docs/standards/comments.md).
- **Tipos y módulos**: sin `any`. Los imports relativos a `engine/src` llevan extensión `.js`, también
  en los tests; la interfaz no la lleva y usa el alias `@/`. Ids con `ulid`. Los writes múltiples, dentro de
  `db.transaction`.
- **Zod en los bordes**: las entradas de las herramientas MCP (`schema.ts`), los cuerpos POST del visor, la
  salida del LLM y el banco de `mismem-bench`. Los argumentos de un CLI se validan en su `*-args.ts`. La
  entrada estándar de un hook y la respuesta del servidor remoto no pasan por Zod: se parsean a la defensiva
  (`try/catch`, sin romper el turno).
- **Funciones puras con dependencias inyectadas**: el reloj entra como `at`, el embedder como `embedFn`, el LLM
  como `distillFn`. Así un test no necesita red ni reloj real.
- **Variables numéricas** de entorno: se leen con `engine/src/env.ts` (`envPositiveNumber`, que trata como "sin
  definir" lo vacío, lo no numérico y lo no positivo), o con `envNonNegativeNumber` cuando el 0 es un valor válido.
- **Un CLI con flags** son dos ficheros, `<cli>-cli.ts` (lo ejecuta) y `<cli>-args.ts` (lee los argumentos
  sin tocar la base). Un error de uso (por ejemplo `argumento desconocido: <x>`) imprime `[<cli>] <mensaje>` por stderr y sale
  con 64 (`EXIT_USAGE`); cualquier otro fallo sale con 1 y una línea de error por stderr, cuyo formato varía entre CLIs. Excepciones: `inject-cli.ts` y
  `used-cli.ts` son hooks y leen sus argumentos en línea ignorando lo que no entienden; `obsidian-cli.ts`
  los lee estrictos, también en línea. Un binario nuevo se declara en `bin` y se llama `mismem-<cosa>`.
- **Tests**: `engine/tests/<área>.test.ts`, fixtures ficticios en `engine/tests/fixtures/`. Un cambio de
  comportamiento lleva un test que falla sin el cambio, y un assert nunca se debilita para que algo pase.
- **Formato**: Biome sólo como linter; se imita el formato del fichero (dos espacios, comillas dobles, punto
  y coma).
- **Variables de entorno**: la lista completa es la tabla de `DEPLOY.md`. Se añade o se cambia allí y sólo allí.
- **CHANGELOG**: cada PR añade su entrada bajo `## Sin publicar`, con sus tests y su documentación.

## Trampas de este repositorio

- **La CSP del visor** (`engine/src/viewer-static.ts`) no admite scripts en línea ni fuentes de otro origen:
  la tipografía sale del paquete (`@fontsource-variable/jetbrains-mono`) y el tema se aplica en
  `engine/ui/src/main.tsx` antes del primer render, no desde `index.html`.
- **La interfaz hay que compilarla**: sin `dist/ui` (por ejemplo con `pnpm dev:http`), `/viewer` responde 503.
- **La base pasa a `0600`** (y sus `-wal` y `-shm`) en cada `openDb`, salvo `:memory:` y las URI `file:`.
  Un sistema de ficheros que no admite `chmod` no impide abrirla.
- **`SCHEMA` y `migrate()`**: `SCHEMA` sólo crea lo que falta. Lo que ya existe cambia en `migrate()`, y los
  disparadores `memories_au` y `traits_au` viven únicamente allí.
- **La consolidación es idempotente** porque sólo mira `consolidated_into IS NULL`. Una consulta nueva de
  episodios pendientes usa esa misma condición, como `pendingEpisodes` en `memory/pending.ts`.
- **`recall` refuerza lo que devuelve** salvo con `reinforce: false` o `MISMEM_REINFORCE_ON_RECALL=off`.
  Una búsqueda que nadie pidió (el hook de inyección, el visor, el bench) pasa `reinforce: false`; sólo
  `reinforce` escribe `use_count` y `co_use`.
- **Los marcadores de ruido** (`[noise] ...`, `[pareto:l0] ...`) no compiten en el recall ni gastan un
  embedding: las consultas que alimentan al modelo y las listas de la interfaz los excluyen con
  `excludeNoiseSql`. `forget` los ve, y el endpoint en bruto `/api/recent?layer=memory` también.
- **Los alias `mem_*`** (`engine/src/mcp/engram-compat.ts`, con el catálogo en `engram-tools.ts`)
  tienen que seguir funcionando: hay clientes que vienen de Engram y no se reconfiguran. No todos delegan
  en las seis herramientas: `mem_save`, `mem_search`, `mem_session_summary` y `mem_save_prompt` sí;
  `mem_context` lee los episodios pendientes por `memory/pending.ts`, `mem_get_observation` una fila por
  `queries/observation.ts` y `mem_update` escribe por `memory/engram-update.ts`; `mem_suggest_topic_key`,
  `mem_session_start` y `mem_session_end` son una heurística y dos no-ops.
- **Dos sitios para cada herramienta**: los `inputSchema` de `server-core.ts` se escriben a mano y reflejan
  los de `schema.ts`; `engine/tests/tool-schemas.test.ts` falla si se separan.
- **Borrar desde el visor** está apagado salvo con `MISMEM_VIEWER_ALLOW_DELETE=1`, y aun así va en dos
  pasos con un token de 60 s.
- **`pnpm dup` tiene umbral 0** (`--min-lines 10`, sobre `src` y `ui/src`): un bloque copiado de diez líneas
  o más falla; se extrae, no se pega.
- **Escuchar en loopback es el valor por defecto** (`bindHost`). La imagen Docker fija
  `MISMEM_HTTP_HOST=0.0.0.0` a propósito, porque en un contenedor loopback no se alcanza; no se quita ni se
  cambia el valor por defecto del código. Con sólo una de `MISMEM_AUTH_USER` y `MISMEM_AUTH_PASS`, el
  servidor no arranca.

## Dónde está documentado

| Para | Dónde |
|---|---|
| Entorno, flujo de ramas, estándar de issue y de PR, etiquetas, releases | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Ramas, commits, comentarios, estilo, tests, seguridad y releases, cada norma comprobable | [`docs/standards/`](docs/standards/README.md) |
| Las capas, las herramientas, el almacenamiento y los componentes | [`docs/architecture.md`](docs/architecture.md) |
| Cómo busca `recall` y cómo se mide | [`docs/recall.md`](docs/recall.md) |
| Los hooks del cliente y qué sale de la máquina | [`docs/hooks.md`](docs/hooks.md) |
| La consolidación con LLM | [`engine/src/consolidation/README.md`](engine/src/consolidation/README.md) |
| Operación, respaldos y la tabla única de variables de entorno | [`DEPLOY.md`](DEPLOY.md) |
| Qué cambió en cada versión y por qué | [`CHANGELOG.md`](CHANGELOG.md) |
| Reportar una vulnerabilidad | [`SECURITY.md`](SECURITY.md) |
| Qué documento es para quién y qué no se documenta | [`docs/README.md`](docs/README.md) |
