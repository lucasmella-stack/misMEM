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
| `engine/src/db.ts` | `SCHEMA`, migraciones aditivas (`migrate()`), apertura de la base con permisos `0600` | cambia una tabla, una columna o un índice |
| `engine/src/schema.ts` | Inputs Zod de las herramientas y el tipo `RecallHit` | cambia lo que una herramienta acepta o devuelve |
| `engine/src/tools.ts` | Las operaciones MCP: `capture`, `recall` y `recallHybrid`, `reinforce`, `consolidate`, `crystallize`, `forget` y la lista de episodios pendientes | cambia lo que hace una herramienta |
| `engine/src/search.ts` | Ranking del recall: consulta FTS5, rescate y fusión RRF con la saliencia | cambia el ranking (pide `mismem-bench` y `pnpm eval`) |
| `engine/src/embeddings/` | `provider.ts` (configuración por entorno y cliente HTTP), `store.ts` (SQL de `memory_embeddings`, búsqueda y backfill), `vector.ts` (coseno) | cambia la capa semántica (pide `mismem-bench` y `pnpm eval`) |
| `engine/src/salience.ts` | Decay y refuerzo de la saliencia | cambia la fórmula de saliencia |
| `engine/src/noise.ts`, `engine/src/terms.ts`, `engine/src/hash.ts` | Marcadores de ruido, tokenización compartida por la búsqueda y la medición de uso, hash del contenido (dedup de `capture`) | cambia uno de esos tres criterios |
| `engine/src/relations.ts` | Lecturas que comparten el visor y la exportación a Obsidian (memorias parecidas por vector) | cambia cómo se relacionan las memorias |
| `engine/src/server-core.ts` | Descriptores de las herramientas MCP y su despacho; lo usan `server.ts` (stdio) y `server-http.ts` | se añade o cambia una herramienta |
| `engine/src/engram-compat.ts` | Los alias `mem_*` y su mapeo a las seis herramientas | cambia la compatibilidad con Engram |
| `engine/src/server-http.ts` | Servidor HTTP: `/mcp`, `/healthz`, `/viewer` y `/api/*` | se añade una ruta; la lógica va a otro módulo |
| `engine/src/http-guard.ts`, `engine/src/http-host.ts`, `engine/src/http-body.ts` | Dirección de enlace y BasicAuth, guarda de `Host`, lectura del cuerpo con tope | cambia qué petición se atiende |
| `engine/src/viewer.ts`, `engine/src/viewer-api.ts`, `engine/src/viewer-actions.ts`, `engine/src/viewer-static.ts` | API de lectura del visor, sus escrituras por POST, y la interfaz compilada con su CSP | cambia lo que el visor muestra o puede hacer |
| `engine/ui/` | La interfaz (React) en `ui/src`; se compila a `dist/ui`. `ui/src/components/ui/` es código de shadcn: Biome y knip lo tratan aparte | cambia lo que se ve |
| `engine/src/consolidation/` | `run.ts` (la corrida), `llm.ts` (proveedores), `prompts.ts`, `job.ts` (corrida en segundo plano desde la interfaz) y su `README.md` | cambia cómo se destilan los episodios |
| `engine/src/pareto/classifier.ts` | Prefiltro heurístico que descarta ruido antes del LLM | cambia qué se descarta sin LLM |
| `engine/src/ingest/` | Importadores de ChatGPT y de VS Code, y el recorrido de ficheros | se importa un formato nuevo |
| `engine/src/inject.ts`, `engine/src/usage.ts`, `engine/src/hook-client.ts`, `engine/src/hook-readiness.ts` | Lógica de los hooks: qué inyectar, qué se usó, cliente remoto y espera a que el servidor esté listo | cambia un hook |
| `engine/src/obsidian.ts` | Exportación como bóveda de Obsidian | cambia la exportación |
| `engine/src/bench.ts`, `engine/src/golden.ts`, `engine/eval/golden/` | Medición del recall: banco privado (`mismem-bench`) y eval dorado público (`pnpm eval`) con su suelo de CI | cambia una medición o el corpus |
| `engine/src/*-cli.ts`, `engine/src/*-args.ts`, `engine/src/cli-args.ts`, `engine/src/env.ts` | Los binarios `mismem-*`, la lectura estricta de sus argumentos y la lectura de variables numéricas | cambia un CLI o un flag |
| `engine/tests/` | Un `<área>.test.ts` por área; `fixtures/` (exports ficticios) y `support/` | cada cambio |
| `scripts/` | `install.sh` (instalador de Linux), `mismem-hook.sh` (envoltorio de los hooks), `backup-mismem-from-server.ps1` (respaldo desde Windows) | cambia la instalación o el respaldo |
| `engine/Dockerfile.mismem-brain`, `.github/` | La imagen, los workflows, las plantillas y las etiquetas | cambia el empaquetado o la CI |

Las tablas de la base, en `engine/src/db.ts`:

| Tabla | Qué guarda |
|---|---|
| `episodes` | Texto literal en `body` (no `text`; el recall lo expone como `text`), con `consolidated_into`, `content_hash` y `uncited_count` |
| `memories` | `gist` y `details`, `source_episode_ids` (JSON), `salience`, `use_count` y las marcas de tiempo del decay |
| `traits` | `name` único por `scope`, `evidence_memory_ids` (JSON), `strength` y `polarity` |
| `co_use` | Pares de memorias usadas en el mismo turno; sólo lo escribe `reinforce` |
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
- Medir el recall sobre el corpus público en castellano, desde `engine/`: `pnpm eval --mode lexico`;
  tras `pnpm build`, `node dist/eval-cli.js --mode semantico` con las variables `MISMEM_EMBEDDING_*`. La puerta
  de CI es `tests/golden.test.ts`; quien mejora el recall sube el suelo en `engine/eval/golden/floor.json` en el
  mismo PR. La línea base y cómo se corre están en [docs/recall.md](docs/recall.md#medirlo).

## Reglas duras

| Regla | Por qué |
|---|---|
| Nunca leer ni editar `.env*`, ni mostrar un secreto en una respuesta, un log o un issue | Ahí viven las claves de los proveedores y las credenciales del servidor; `.env.example` sólo lleva marcadores |
| Sin `git push --force` ni reescribir la historia sin permiso expreso | Se mergea con merge commit y la historia publicada conserva el porqué de cada commit |
| El esquema cambia sólo con migraciones aditivas en `migrate()` de `engine/src/db.ts`: se añaden columnas, índices y tablas, y cada paso comprueba el estado y se puede repetir. `migrate()` sí puede borrar y recrear disparadores heredados y rellenar columnas nuevas; nunca borra una tabla ni una columna con datos. Con su test y su línea en el CHANGELOG | La base de cada persona ya existe y se abre con el código nuevo: un error rompe datos reales. `CODEOWNERS` pide revisión de los dos responsables |
| Quien toca el ranking o los embeddings (`tools.ts`, `search.ts`, `embeddings/`) corre `mismem-bench` y `pnpm eval` antes y después y pone las cifras en el PR, con la etiqueta `needs-bench` ([Tests](docs/standards/tests.md)) | Sin esa medida no hay forma de saber si el cambio mejora el recall: los tests sólo vigilan el suelo del eval, y el bench de la memoria real no corre en CI |
| Toda dependencia que se añade o se sube entra con versión exacta (sin `^` ni `~`) y publicada hace 14 días o más; los `^` que ya hay se fijan la próxima vez que se suban ([Seguridad](docs/standards/security.md)). Un script de instalación nuevo se lee, y sólo entonces se aprueba, uno a uno, en `allowBuilds` de `engine/pnpm-workspace.yaml` (hoy `better-sqlite3` y `esbuild`) | Cadena de suministro: lo recién publicado es lo que más se compromete, y un `postinstall` ejecuta código al instalar |
| Los hooks `mismem-inject` y `mismem-used` nunca fallan ni bloquean un prompt: errores a stderr, salida sin error, y ante la duda no hacen nada; contra un servidor remoto (`MISMEM_HOOK_URL`) llevan además un tope de tiempo | Corren en cada turno del cliente; un hook roto cuesta más que un recuerdo sin inyectar |
| `engine/src/server-http.ts` escucha al importarse: su lógica va a módulos que se puedan importar y probar (`http-guard.ts`, `http-host.ts`, `http-body.ts`) | Un test no puede importarlo sin abrir un puerto; el test del servidor lo lanza como proceso hijo |
| Datos de usuario nunca en tests, fixtures, capturas, documentación, issues ni logs | La memoria es personal. Los tests usan `openDb(":memory:")` o un directorio temporal propio y jamás tocan `~/.mismem` |
| Las herramientas de la propia memoria (`capture`, `recall`) son para las notas del agente: nunca guardan secretos ni datos de terceros | Lo capturado queda en una base que se respalda, se consolida con un LLM externo y se lee desde el visor |

## Convenciones que el código no deja ver

- **Idioma**: identificadores, claves JSON, comentarios nuevos o reescritos y commits (Conventional
  Commits) en inglés. Mensajes de cara al usuario (errores, logs, ayuda de los CLI, interfaz) y Markdown en
  español neutro (formas impersonales, ni voseo ni vosotros). Los comentarios en español que ya existen no se traducen en masa.
- **Comentarios**: dicen el porqué (la restricción, el motivo, lo que se descartó), nunca el qué. Sin código
  comentado. Una supresión de Biome lleva su motivo; un `TODO` lleva su issue.
- **Tipos y módulos**: sin `any`. Los imports relativos a `engine/src` llevan extensión `.js`, también
  en los tests; la interfaz no la lleva y usa el alias `@/`. Ids con `ulid`. Los writes múltiples, dentro de
  `db.transaction`.
- **Zod en los bordes**: las entradas de las herramientas MCP (`schema.ts`), los cuerpos POST del visor, la
  salida del LLM, el banco de `mismem-bench` y el corpus del eval dorado con su suelo. Los argumentos de un
  CLI se validan en su `*-args.ts`. La entrada estándar de un hook y la respuesta del servidor remoto no pasan
  por Zod: se parsean a la defensiva (`try/catch`, sin romper el turno).
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
  episodios pendientes usa esa misma condición, como `pendingEpisodes` en `tools.ts`.
- **`recall` refuerza lo que devuelve** salvo con `reinforce: false` o `MISMEM_REINFORCE_ON_RECALL=off`.
  Una búsqueda que nadie pidió (el hook de inyección, el visor, el bench) pasa `reinforce: false`; sólo
  `reinforce` escribe `use_count` y `co_use`.
- **Los marcadores de ruido** (`[noise] ...`, `[pareto:l0] ...`) no compiten en el recall ni gastan un
  embedding: las consultas que alimentan al modelo y las listas de la interfaz los excluyen con
  `excludeNoiseSql`. `forget` los ve, y el endpoint en bruto `/api/recent?layer=memory` también.
- **Los alias `mem_*`** (`engine/src/engram-compat.ts`) tienen que seguir funcionando: hay clientes que
  vienen de Engram y no se reconfiguran. No todos delegan en las seis herramientas: `mem_save`, `mem_search`,
  `mem_session_summary` y `mem_save_prompt` sí; `mem_context`, `mem_get_observation` y `mem_update` leen o
  escriben con SQL propio, y `mem_suggest_topic_key`, `mem_session_start` y `mem_session_end` son una
  heurística y dos no-ops.
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
