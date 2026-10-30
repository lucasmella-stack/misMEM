# Changelog

## Sin publicar

- Sin servidor de embeddings, el recall léxico pasa de 221/432 a 253/432 en el eval dorado (MRR de 0,48 a 0,54),
  con las preguntas largas de 5/36 a 17/36 y las coloquiales de 24/36 a 26/36; ningún tipo baja y las ajenas
  siguen en 8/48 (9 recuerdos frente a 10). El rescate ya no exige el 30 % de todas las palabras: descarta las
  que no aparecen en ningún candidato, ordena por IDF y pide dos coincidencias con al menos una informativa, así
  que una pregunta llena de contexto ("oye", "ayer") puede rescatar su memoria. Ignora además un relleno
  coloquial propio ("podemos", "antes", "cada", "todo"...), en una lista aparte de la compartida: esa sigue
  mandando en la consulta estricta y en la medida de sustancia del prefiltro Pareto, que con las palabras nuevas
  descartaba hechos cortos como ruido. La puerta del 30 % se mide sobre la consulta entera y no sobre las
  palabras que caben en el tope de doce, y el suelo de dos coincidencias ya no finge crecer con la pregunta. Los
  suelos de `engine/eval/golden/floor.json` suben por tipo y la mitad de validación pasa de 104/216 a 123/216.
  Tests nuevos en `engine/tests/recall-relaxed.test.ts` (pregunta larga, puerta del 30 % a ambos lados y tope de
  doce), `engine/tests/terms.test.ts` y `engine/tests/pareto.test.ts`; la línea base nueva está en
  `docs/recall.md`.
- Con EmbeddingGemma 2 y sin `MISMEM_EMBEDDING_MIN_SCORE`, el corte por defecto pasa de 0,5 a 0,65: en el
  golden eval, las preguntas ajenas que traen algo bajan de 48/48 a 11/48 sin perder ningún acierto (#158).
  Vale para cualquier id de la familia (`google/embeddinggemma-300m`, una ruta GGUF). Tests en
  `engine/tests/embeddings-provider.test.ts`; `DEPLOY.md` y `docs/recall.md` recogen el valor nuevo.

### Recall híbrido: las tres capas compiten en un solo ranking (#154)

- Con embeddings, `recall` devolvía cero episodios pendientes y cero rasgos: las memorias llenaban el tope y
  el rescate léxico se apagaba. Ahora rasgos, memorias y episodios pendientes se fusionan en un único ranking
  RRF, y rasgos y episodios se puntúan también por coseno. El resultado se queda con el mejor rasgo y como
  mucho dos episodios, elegidos por coseno antes de la fusión: una coincidencia exacta de palabras no puede
  adelantar a un rasgo o un episodio más cercano por significado. Sin ese tope, los rasgos y los episodios
  desplazaban a la memoria concreta. En
  el eval dorado (tope 5) el modo semántico pasa de 368/432 a 411/432, con episodio de 0/24 a 23/24 y rasgo
  de 0/24 a 19/24; el acierto en primera posición sube de 329 a 355, el MRR de 0,796 a 0,871 y las preguntas
  ajenas siguen en 11/48 con 32 recuerdos. Las preguntas que esperan una memoria aciertan en primera 328/384
  frente a 329/384 de la línea base, y ningún tipo de pregunta pierde más de un acierto frente a ella.
- Los vectores de rasgos y episodios pendientes viven en la tabla aditiva `layer_embeddings`, con borrado por
  disparador al consolidar o borrar el item. `mismem-embed`, `consolidate` y el backfill los reindexan igual
  que las memorias; `capture`, `crystallize`, los aliases `mem_save`, `mem_session_summary` y `mem_update`, y
  `/api/crystallize` del visor los embeben en el acto, sin romper la escritura si el embedder falla. Renombrar
  un rasgo por `mem_update` borra su vector viejo y embebe el nombre nuevo en el acto; con el mismo nombre no
  toca el vector. Guardar un vector de capa comprueba, dentro de la misma transacción, que el item sigue vivo,
  que el episodio sigue pendiente y que el texto es el que se embebió, así que una carrera con un renombrado o
  una consolidación no deja un vector obsoleto.
- `docs/recall.md` y `docs/architecture.md` describen el ranking nuevo y la línea base del 2026-10-30. El test
  de `fin-q35` recorre las capas reales por `recallHybrid` y comprueba que el hook recibe `fin-t1`. Tests en
  `engine/tests/hybrid-layers.test.ts`, `engine/tests/inject.test.ts` y `engine/tests/recall-relaxed.test.ts`.

### Un eval dorado público en castellano, con suelo en CI

- `pnpm eval` mide el recall sobre un corpus sintético de doce dominios con preguntas literales, paráfrasis,
  erratas y ajenas, y `engine/tests/golden.test.ts` impide que el modo léxico baje del suelo de
  `engine/eval/golden/floor.json`, supere las ajenas permitidas o devuelva marcadores de ruido. El test también
  comprueba el reparto del corpus (doce dominios, 40 preguntas por dominio y los tipos esperados), rechaza que
  `expect` o `evidence` nombren un id de pregunta y falla si el corpus no está. El corpus es público y
  reproducible, no viaja en el paquete npm, y quien mejora el recall sube el suelo en el mismo PR. La línea
  base y los comandos están en `docs/recall.md`.

## 0.6.0 — 2026-10-29

### El olvido respeta `before_days` también al borrar memorias

- `forget` borraba los episodios de una memoria de saliencia baja aunque alguno fuera más nuevo que `before_days`. Con los defaults de `mismem-forget` (90 y 30 días), un episodio de 40 días atado a una memoria olvidable se borraba antes de los 90 que promete `before_days`. Ahora la memoria sólo es olvidable cuando todos sus episodios ya superaron `before_days`; mientras quede uno más nuevo, la memoria y sus episodios esperan. Las memorias sin episodios o con todos viejos se borran igual que antes, y sus episodios con ellas para que `ON DELETE SET NULL` no los devuelva a pendientes.
- El conteo de `dry_run` sale de las mismas consultas que el borrado, y un test compara lo que anuncia con lo que después borra.

### Embeddings: mejores valores por defecto para quien instala misMEM (#72)

- Con `nomic-embed-text` el corte semántico de 0,5 no cortaba nada: las 10 preguntas ajenas de la
  medición traían 5 recuerdos cada una, así que el hook de inyección añadía recuerdos sin relación a
  cada prompt. Sin `MISMEM_EMBEDDING_MIN_SCORE`, el corte por defecto ahora depende del modelo: 0,65
  para `nomic-embed-text` (también con etiqueta, p. ej. `:latest`) y 0,5 para el resto. Con 0,65 las
  preguntas ajenas bajan a 0 recuerdos sin perder aciertos. Un valor explícito, incluido `0`, sigue
  ganando siempre.
- `scripts/install.sh`: si hay `llama-server`, ofrece EmbeddingGemma 2 como opción recomendada.
  Con memorias en castellano encontró 34 de 50 paráfrasis frente a 4 de 50 de `nomic-embed-text`
  (medición de la issue). Baja el GGUF (296 MB) sólo si el usuario dice que sí, deja `llama-server`
  como servicio de systemd de usuario (`mismem-embed`, en CPU; `--embeddings-gpu` o la pregunta
  interactiva lo pasan a la GPU) y escribe en `~/.config/mismem/env` el proveedor, los prefijos y el
  corte 0,65. `nomic-embed-text` por Ollama queda como alternativa ligera. Con `--yes` el modelo no
  cambia salvo que se pida con `--embeddings gemma|nomic`: re-ejecutarlo conserva tal cual cualquier
  configuración de embeddings que ya hubiera (otro modelo, otro servidor, prefijos, corte) y no duplica el
  servicio. Si se vuelve a nomic, el servicio `mismem-embed` que montó el instalador se para y se
  desactiva para no dejar ocupados el puerto y la memoria. Con EmbeddingGemma 2 elegido pero sin servidor
  arrancado no se escribe `MISMEM_EMBEDDINGS=off`: la búsqueda degrada a palabras y se activa sola cuando
  el servidor arranca.
- README y `DEPLOY.md` dicen claro que con memorias que no estén en inglés la opción es EmbeddingGemma 2,
  que con `nomic-embed-text` el corte es 0,65 y no hay que esperar paráfrasis, y que el corte de
  EmbeddingGemma 2 recomendado pasa de 0,68 a 0,65 (misma efectividad medida, con más recuerdos por
  pregunta).

- El timeout de embeddings y el puerto HTTP dejan de aceptar valores imposibles: un negativo, basura, 0 o vacío vuelven a 3000 ms y a 3200 (antes `MISMEM_EMBEDDING_TIMEOUT_MS=-5` hacía que `AbortSignal.timeout` lanzara `RangeError` y un `MISMEM_HTTP_PORT` con basura llegaba a `listen` como `NaN`); `prepublishOnly` usa pnpm.

### jscpd sube a 5.4.1, y sus dos clones de más desaparecen

- `jscpd` pasa de 4.3.0 a 5.4.1 (versión exacta). La 5 compara dos bloques que la 4 no veía: `recall` y
  `recallHybrid` montaban igual la lista de hits, ahora en `finalizeHits`, y `MemoryList`/`PendingList`
  repetían el `<ul>` y el pie de "cargar más", ahora en `PagedList`. `pnpm dup` sigue con umbral 0 y no
  encuentra clones; no hay cambios de comportamiento ni visibles.

### `AGENTS.md` como contrato de trabajo

- `AGENTS.md` deja de ser las antiguas instrucciones de Copilot: mapa del código actual, comandos, reglas duras con
  su porqué, convenciones y trampas propias del repo, y enlaces al resto de la documentación en vez de copiarla.

### Un estándar de contribución escrito, y comprobado

- Contribuir no tenía forma: ni formularios de issue, ni plantillas de PR, ni normas escritas, y el
  README mezclaba la presentación con material de referencia y con la historia de cada iteración. Ahora
  `CONTRIBUTING.md` es la puerta de entrada (entorno, flujo trunk-based, estándar de issue y de PR,
  etiquetas, releases) y `docs/standards/` fija ramas, commits, comentarios, estilo, tests, seguridad y
  releases, cada norma con su forma de comprobarla. `docs/README.md` dice qué documento es para quién y
  qué no se documenta.
- `.github/` gana cuatro formularios de issue (error, mejora, documentación y medición de recall, cada
  uno con su criterio de cierre), los issues en blanco desactivados con un enlace al reporte privado de
  vulnerabilidades, una plantilla de PR por defecto y tres más (`release`, `dependency`, `documentation`),
  `release.yml` para agrupar las notas por etiqueta y `CODEOWNERS`.
- Las etiquetas que citan los formularios, las plantillas, `release.yml` y `CONTRIBUTING.md` se declaran
  en `.github/labels.json`. `engine/tests/contribution-standard.test.ts` falla si alguno cita una que no
  existe, o si un tipo se queda sin formulario ni excepción razonada; el workflow `labels.yml` compara
  ese fichero con las etiquetas que tiene GitHub.
- Dependabot deja de proponer saltos de versión mayor de `node` en el Dockerfile: los majors se mueven a
  mano a una LTS.
- El README pasa a ser una guía: qué es, un diagrama del sistema, el Quickstart primero y un mapa de la
  documentación. Lo que era referencia se mueve sin perder nada: el comportamiento del recall y la
  búsqueda por significado a `docs/recall.md`, los hooks a `docs/hooks.md`, y las capas, los componentes,
  la saliencia y el índice hebbiano a `docs/architecture.md`. El roadmap por fases de `engine/README.md`
  desaparece (la historia es este fichero) y la consolidación deja de repetir el despliegue de `DEPLOY.md`.

### zod 4

- zod pasa de 3.25.76 a 4.6.7 (versión exacta): `.int()` rechaza enteros fuera del rango seguro de JS (y el `inputSchema` de `forget` lo anuncia), los límites de longitud cuentan *code points* en vez de unidades UTF-16 y cambian los textos de `ZodError`; `tests/tool-schemas.test.ts` compara con `z.toJSONSchema` en vez de leer internos de zod 3.


### Un solo diálogo de confirmación en el detalle

- `MemoryView` y `TraitView` repetían el pie del diálogo de confirmación y la forma de sus props. Ambos viven ahora en `DetailParts.tsx` (`ConfirmDialog` y `DetailViewProps`), sin cambios visibles, y `pnpm dup` pasa a exigir umbral 0: ningún bloque copiado de 10 o más líneas.

### `@vitejs/plugin-react` sube a 5.2.0

- `@vitejs/plugin-react` pasa de 4.7.0 a 5.2.0, fijado exacto. `ui/vite.config.ts` llama a `react()`
  sin opciones y la 5.x sólo deja de añadir `react`/`react-dom` a `resolve.dedupe`, que aquí sobra.

### Linter con Biome, y fuera las directivas de ESLint que no hacían nada

- No había linter ni formateador. Ahora Biome 2 es el único, sólo como linter: `pnpm lint` y un step
  de CI justo después de `pnpm dup`. El formato no se toca a propósito. `biome.json` limita el
  análisis a `src/`, `ui/src/` y `tests/` en TypeScript, y deja fuera `ui/src/components/ui`, que es
  shadcn vendorizado, además de CSS, JSON y fixtures.
- Las cinco directivas de supresión de ESLint no desactivaban nada: cuatro `no-console` en
  `server-http.ts` y `used-cli.ts`, y un `no-explicit-any` en `viewer-api.test.ts`. Ese `any`
  escondía dos huecos: el mock no implementa `ServerResponse` y el cuerpo de la respuesta no tenía
  tipo. Ahora el mock se ensancha una sola vez al pasarlo al handler y el cuerpo tiene `ApiBody`.
- Reglas recomendadas desactivadas, todas por patrones deliberados del repo: `noNonNullAssertion`
  (los guardas y los tests afirman con `!` justo después de comprobar longitud o nulidad; reescribir
  los 24 usos serían cambios cosméticos), `useSemanticElements` (los roles `search`, `group` y
  `meter` son ARIA válido sobre elementos con estilos; cambiarlos por `fieldset`, `meter` o
  `search` cambiaría el marcado y el CSS sin arreglar nada) y `noAutofocus` (el formulario de
  edición enfoca el campo al abrirse). `useExhaustiveDependencies` sigue activa pero no avisa de
  dependencias de más: `GraphView` repite `size.width` a propósito para reaplicar el estado cuando
  el canvas termina de montarse. `biome.json` es JSON estricto y Biome no acepta comentarios ahí,
  así que el porqué queda en esta entrada.
- Los errores que sí eran defectos, arreglados: ocho `let` sin tipo en los CLI y el `entries` de
  `walk.ts`, tres `return` que devolvían un `void` en `viewer-static.ts`, la comprobación de
  `content-type` sin cadena opcional en `http-body.ts`, un `break` con etiqueta que no hacía nada en
  `consolidation/run.ts`, los `any` de los tests y las claves por índice de los esqueletos de carga.

### Errores, claves y ayudas en el idioma del producto

- Los errores que ven un cliente MCP o el viewer salían en inglés (`Unknown tool`, `not found`,
  `is required`, `invalid layer`) mientras el resto del producto responde en español. Ahora están en
  español, con el mismo contenido y el mismo código de estado.
- La confirmación de olvido mezclaba claves en los dos idiomas (`impacto`, `memorias_que_cita`,
  `rasgos_que_la_citan`, `episodios`). Pasan a `impact`, `memories_cited`, `traits_citing` y
  `episodes`; la UI y los tests leen las nuevas claves.
- Las ayudas de `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-migrate-engram`,
  `mismem-obsidian` y `mismem-embed` usan los encabezados `Uso:` y `Variables:`, y la de
  `mismem-ingest`, que estaba entera en inglés, también está en español. Los encabezados de las ayudas
  pasan a `misMEM: CLI de ...`, el progreso de `mismem-migrate-engram` y la cabecera de `mismem-stats`
  están traducidos, y los fallos de todos los CLIs salen con el prefijo `ERROR:` en vez de `FATAL:` o
  `Error:`. Los flags y lo que hace cada comando no cambian.
- El servidor HTTP responde en español el 415 de `/mcp`, el error de parseo de JSON-RPC (mismo
  `-32700`), las acciones y endpoints desconocidos y los 404, también los del viewer. Los códigos de
  estado, los identificadores y los nombres de tools no cambian.

### Una conversación de ChatGPT sin texto no se importa

- `ingestChatGPTExport` decidía si saltarse una conversación mirando la cadena ya montada, y
  `flattenConversation` siempre emite la cabecera `# título` y `Created:`. Una conversación con
  todos los mensajes vacíos o de sistema se importaba como un episodio con sólo título y fecha.
  Ahora la decisión se toma sobre los mensajes con texto y esa conversación cuenta como `skipped`.

### Una sola versión, y comprobada

- La versión estaba escrita a mano en `engine/package.json`, `server.json` (dos campos) y
  `engine/src/server-core.ts`, y nada comparaba las cuatro. Un release podía anunciar por MCP una
  versión distinta de la publicada. Ahora `server-core.ts` lee `engine/package.json` al cargarse
  (`createRequire`, que funciona igual desde `src/` con tsx que desde `dist/`), y `tests/version.test.ts`
  falla si el `serverInfo` que ve un cliente MCP o cualquiera de los dos campos de `server.json` deja de
  coincidir con el paquete.
- `DEPLOY.md` recuerda que los tags van anotados (`git tag -a vX.Y.Z -m 'misMEM X.Y.Z'`).

### Higiene del repositorio: reportar en privado, dependencias y secretos

- `SECURITY.md` dice cómo reportar una vulnerabilidad en privado (GitHub Private Vulnerability
  Reporting), que sólo la última versión publicada recibe arreglos y qué cuenta como
  vulnerabilidad acá: la autenticación del modo HTTP, y esa DB que tiene toda la memoria. Antes
  no había ningún canal privado, así que el reporte terminaba en un issue público.
- Las convenciones pasan de `.github/copilot-instructions.md` a `AGENTS.md`, que leen todos los agentes (Claude Code a través de `CLAUDE.md`, que lo importa); el fichero de Copilot desaparece.
  `install.sh` configura Claude Code y opencode, y hasta ahora sólo Copilot cargaba esas
  convenciones: los otros dos agentes trabajaban sin ellas.
- `.github/dependabot.yml` saca la actualización de dependencias de la mano de nadie: npm en
  `engine/` (minor y patch agrupados en un PR), los actions, que están fijados por SHA y sin
  esto no se mueven nunca, y el `node:22-alpine` del Dockerfile.
- El job `secret-scan` de CI corre gitleaks sobre todos los commits en cada PR y en cada push a
  `main`, con la imagen fijada por digest. Nada buscaba una clave commiteada antes de que llegara
  a `main`.
- `.gitignore` cubre `*.db-journal`, el diario que SQLite deja al lado de la DB cuando no
  trabaja en modo WAL.

### Ningún CLI se traga un flag mal escrito

- `mismem-embed`, `mismem-bench`, `mismem-stats` y `mismem-migrate-engram` ignoraban los flags que no
  entendían: un `--scop daimon` reindexaba o contaba todos los ámbitos, un `--jsn` dejaba la salida en
  texto, un `--dryrun` migraba de verdad y un `--batch abc` caía al valor por defecto. `mismem-ingest`
  hacía lo mismo con los posicionales de más. Ahora cada uno parsea en su `<cli>-args.ts`, como
  `consolidate` y `forget`, y un flag o posicional inesperado corta con `argumento desconocido: <x>` y
  exit 64. Un valor ausente (`--scope`, `--batch`, `--limit`, `--source`) también corta, un posicional
  de ingest en blanco cuenta como ausente, y un subcomando de `mismem-ingest` que no existe se rechaza
  en vez de imprimir la ayuda.
- `mismem-stats` abría la base y, si una consulta fallaba, moría con la base abierta y sin mensaje.
  Ahora la cierra en un `finally` y el fallo sale por stderr como `[stats] FATAL: ...` con exit 1.

### La imagen y el paquete dejan de arrastrar lo que no usan

- Sin `engine/.dockerignore`, un `docker build` local mandaba al daemon `node_modules`, `dist`,
  `coverage` y cualquier `.db` que hubiera en `engine/`. El Dockerfile no los usa: sólo copia
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `src` y `ui`.
- Las dos etapas fijaban la base por tag (`node:22-alpine`), así que un rebuild meses después
  compilaba contra otra Alpine sin que nadie tocara el repositorio, y `better-sqlite3` es nativo.
  Ahora van por digest, con el tag legible al lado.
- La etapa runtime copiaba `node_modules` entero, con vite, typescript, react y vitest dentro de una
  imagen que sólo ejecuta `dist/server-http.js`. Tras `pnpm build` se hace `pnpm prune --prod`;
  `better-sqlite3` es dependencia de producción y se queda (probado con `docker build`).
- El paquete npm declaraba `MIT` sin llevar el texto de la licencia. `engine/LICENSE` es copia
  literal de la raíz y entra en `files`. En CI, `cmp LICENSE engine/LICENSE` falla si se separan, y
  hadolint revisa el Dockerfile con la imagen fijada por digest.

### `mismem-http` escucha sólo en loopback por defecto

- Sin `MISMEM_AUTH_*`, el servidor escuchaba en `0.0.0.0` y la guarda de `Host` sólo frena el
  DNS rebinding del navegador: cualquier cliente de la LAN puede mandar `Host: localhost`. Ahora el
  valor por defecto de `MISMEM_HTTP_HOST` es `127.0.0.1`. Para mantener el comportamiento anterior,
  `MISMEM_HTTP_HOST=0.0.0.0` junto con `MISMEM_AUTH_USER` y `MISMEM_AUTH_PASS`. Los contenedores no
  cambian: el Dockerfile y el ejemplo de compose ya fijan `0.0.0.0`.
- El fichero SQLite, con toda la memoria, se creaba con el umask por defecto. Ahora queda en `0600`
  (y sus `-wal` y `-shm`), y el directorio, si lo crea mismem, en `0700`. Un directorio que ya existía
  no se toca.

### Fuera el código muerto

- Se retiran `src/tools/dump-engram.ts`, `ingest-engram-dump.ts` y `smoke-recall.ts`: scripts de una sola vez
  que nada importaba ni documentaba, pero se compilaban dentro del paquete npm, y uno apagaba la
  verificación TLS antes de mandar la cabecera `Authorization`. Para migrar desde Engram sigue
  `mismem-migrate-engram`, que lee un `engram.db`. `ENGRAM_URL` y `ENGRAM_AUTH` salen de `.env.example`.
- `pnpm knip` corre en CI: falla con ficheros, exports o dependencias sin uso.

### El índice hebbiano empieza a existir

- `reinforce` recibía los `memory_ids` **juntos** —sabe que esos recuerdos se usaron en el mismo
  turno— y lo colapsaba en un bump de saliencia por recuerdo. Tiraba justo la co-ocurrencia, que
  es la señal hebbiana de verdad. Ahora la guarda: `memories.use_count` cuenta los turnos en que
  cada recuerdo se usó, y `co_use(memory_a, memory_b, n, last_at)` cuenta cada par que se usó junto.
- Se escribe desde `reinforce` y **no** desde `reinforceMemories`, porque a esa última la llama
  también el camino de recall, donde aparecer no es haberse usado. Con la reinyección por aparición
  apagada (`MISMEM_REINFORCE_ON_RECALL=off`) la señal arranca limpia: `use_count` en 0 para todos.
- Hacía falta porque `salience` hoy mide recencia, no uso: la pasada de decay escribe
  `salience_updated_at` en las 3.738 memorias, así que el campo no distingue "se usó" de "se
  marchitó". Medido sobre producción: de 1.351 memorias de más de 60 días sólo 14 tienen saliencia
  por encima de 0,85, y entre ésas hay tres marcadores de ruido `[pareto:l0]`. Ordenar por
  saliencia hoy pone arriba lo nuevo, no lo importante.
- Migración aditiva, verificada sobre copia de la DB de producción: 15 ms, `integrity_check` y
  `foreign_key_check` ok, 3.738 memorias y 216 rasgos intactos. Los pares se van por cascada
  cuando el recuerdo se borra.
- Para qué: es la fase 1 del ordenador de memoria.

### El refuerzo por uso ve lo que la inyección adelantó

- Los dos hooks no se enganchaban: `mismem-used` sólo reconocía resultados de `recall`, y lo que
  `mismem-inject` adelanta llega como adjunto `hook_additional_context`, no como `tool_result`. Un
  recuerdo inyectado y usado nunca sumaba saliencia. Medido sobre un transcript real: la inyección
  había dejado 6 ids en el turno y se veían 0.
- `parseInjection` es lo inverso de `formatInjection` y vive en el mismo archivo, para que el
  formato y su lectura no puedan derivar.
- `reinforce` cuenta los rasgos aparte (`traits`) en vez de meterlos en `unknown`. La inyección
  también adelanta rasgos, así que mezclarlos dejaba esa alarma —la de "alguien manda ids
  inventados"— sonando desde el primer día.
- Aportado por [@iDiagoValeta](https://github.com/iDiagoValeta) en #48, con el hallazgo de los
  rasgos que quedaba abierto ahí.

### El README dice lo que el código hace

- Seis gestos, no cinco: faltaba `reinforce`, y `recall` ya no refuerza siempre.
- Los binarios de los hooks (`mismem-inject`, `mismem-used`) y una sección que explica para qué
  sirven, qué no sale de la máquina y cómo se enciende el refuerzo por uso.
- Dos lugares seguían diciendo cinco invocaciones mientras el título decía seis. Ahora los tres
  dicen lo mismo.
- El viewer: la API de sólo lectura ya expone los ámbitos, el origen de cada recuerdo, los rasgos
  que lo citan y el grafo (`/api/{scopes,memories,memory/:id,trait/:id,graph}`), y el README
  mencionaba sólo los tres endpoints originales.
- La consolidación acepta OpenAI y cualquier servidor compatible desde #67, y tanto los
  componentes como la sección de privacidad hablaban sólo de DeepSeek y OpenRouter. Importa
  porque es lo que permite consolidar sin que el texto salga de la red propia.
- Una sección para el índice hebbiano.
- El README y DEPLOY.md mandaban a `docker pull ghcr.io/lucasmella-stack/mismem-brain:latest` como
  camino recomendado, y esa imagen **nunca se publicó**: las tres corridas de `docker.yml` fallan
  al empujar con `denied: permission_denied: read_package`, así que el `pull` responde `denied`.
  Cualquiera que siguiera el README se chocaba con eso. Ahora el camino documentado es el build
  local, que sí funciona, y la imagen publicada queda marcada como pendiente.
- Una sección de agradecimiento con lo que trajo [@iDiagoValeta](https://github.com/iDiagoValeta),
  que a esta altura es buena parte de lo que hace a misMEM instalable y auditable por alguien que
  no sea su autor.

### La memoria se puede exportar como bóveda de Obsidian

- `mismem-obsidian` escribe la memoria como bóveda en `<bóveda>/misMEM/`: una nota por memoria,
  rasgo y ámbito, enlazadas por origen y por parecido.
- Re-exportar sólo borra las notas cuyo frontmatter sigue declarando el id del manifiesto, y se
  niega si la base no tiene nada que exportar o el manifiesto no se puede leer: así una bóveda
  migrada a mano no se vacía por error.

### La interfaz deja de ser de sólo lectura

- UI React con shadcn y TanStack Query: listas, detalle, grafo 2D con filtros y búsqueda dentro
  del grafo.
- `viewer-actions.ts` expone POST desde el propio origen para corregir una memoria, deshacer su
  consolidación, cristalizar y lanzar una consolidación.
- Olvidar una memoria (con sus episodios) o un rasgo exige `MISMEM_VIEWER_ALLOW_DELETE=1` y dos
  pasos: el primero devuelve qué se perdería y un token de 60 s, y borra el segundo.

### La búsqueda léxica rescata paráfrasis

- Sin capa semántica, una consulta estricta (todas las palabras) que no encontraba nada dejaba
  fuera la paráfrasis que sí estaba. Ahora `recall` reintenta con una consulta OR y conserva sólo
  los candidatos que comparten al menos dos términos informativos (una con una consulta de una
  palabra, el 30 % en las largas), con un tope de 3 por capa (rasgos, episodios y memorias).
- El rescate sólo entra cuando la estricta no devolvió nada y no hay vectores comparables que
  puntuar, para no alterar una búsqueda que ya funcionaba.

### Instalación en Linux con un solo script

- `scripts/install.sh` instala y configura misMEM: elige dónde vive la DB y con qué proveedor
  consolidar, guarda la clave en `~/.config/mismem/env` con permisos 600 y deja los clientes
  llamando a `~/.local/bin/mismem-run`, sin credenciales en su configuración.

### El servidor HTTP se protege sin auth

- `MISMEM_ALLOWED_HOSTS`: sin auth, sólo se atienden `Host` de loopback y el resto responde 403,
  contra DNS rebinding.
- `MISMEM_HTTP_MAX_BODY_BYTES`: `POST /mcp` corta el cuerpo en 4 MiB con 413 sin juntarlo en
  memoria, y un `Content-Type` que no es JSON responde 415 antes de leer.

### El conectoma se puede mirar

- `/api/graph?co_use=1` suma una segunda capa lateral. La que ya había, `?related=1`, une memorias
  **parecidas**: sale de lo que cada una dice. Esta sale de lo que **pasó**: qué recuerdos usó junto
  un mismo turno. Las dos juntas valen más que cada una —parecidas que nunca se usan juntas son
  candidatas a que una reemplace a la otra— pero eso es otra entrada.
- El peso **no** es el conteo crudo, es NPMI. Un recuerdo que se usa en todos los turnos co-ocurre
  con todo, así que por conteo sería el centro del grafo sin orientar a nada: el mismo error de la
  saliencia midiendo recencia. Con NPMI, 0 es "indistinguible del azar" y 1 "nunca aparecen
  separados". Hay un test que construye el caso y falla si el ranking se ordena por grado;
  comprobado mutando el comparador.
- Hacía falta un denominador y no existía: la tabla `meta` guarda el total de turnos de uso medido,
  y se suma dentro de la misma transacción que los conteos de `co_use` para que no pueda quedar
  desfasado. Migración aditiva.
- Con pocos datos la fuerza es ruido por construcción —dos recuerdos usados una sola vez, esa vez
  juntos, dan 1—, así que cada arista viaja con su `n`, `?co_use_min_n=k` filtra por soporte y el
  resumen informa el tamaño de la muestra. Los costados de la interfaz tienen que poder decir "esto
  todavía no significa nada" en vez de pintar ruido.
- Sin el parámetro la respuesta no cambia: las aristas verticales no reciben campos nuevos y hay un
  test que compara las dos respuestas.
- Sobre copia de producción: migración en 18 ms, `integrity_check` y `foreign_key_check` ok, 3.805
  memorias y 216 rasgos intactos, y las seis aristas existentes dan fuerza 0 porque el contador nace
  ahora. Es correcto: son turnos que nadie midió, y 0 dice "no sé" en vez de inventar un número.

### El contador de turnos nace con la cota que los datos permiten

- Un cerebro que ya venía midiendo co-uso con la versión anterior guarda `n` y `use_count` de turnos
  que nadie contó. Con el contador en 0 toda fuerza vale 0, que es correcto —dice "no sé"—, pero
  **desde el primer turno medido después de actualizar** el cociente `n / turnos` se acota a 1 y cada
  par heredado se lee como asociación máxima: justo el club de los ricos que el peso existe para
  evitar. Duraba hasta que el contador pasaba por arriba de cada `n`.
- Al abrir, si el contador no existe, se siembra con el uso más alto registrado (`max(use_count)` y
  `max(n)` de `co_use`). Es una cota inferior de los turnos que hubo, porque cada uso ocupó un turno:
  subestima, nunca infla. Sólo cuando falta: un contador andando es la medición de verdad y no se pisa.
- Sobre copia de producción (2.527 memorias, 2.651 episodios, esquema previo a `use_count`): migración
  en 19 ms, nada perdido, y no siembra nada porque ahí no hay uso medido —un cerebro viejo no recibe un
  contador inventado—. Con 40 turnos reinyectados sobre ids reales, el par identidad+acompañante da
  0,112; sin semilla, el primer turno tras el deploy lo sube a **1**; con semilla (38, la cota) vuelve a
  **0**, que es la respuesta correcta para algo que acompaña a un recuerdo que está en todos los turnos.
  El par poco usado se queda en 1 con `n` de 3, y para eso está `?co_use_min_n=k`.
- El test que lo cubre afirma las dos lecturas, la de antes y la de después, así que el artefacto queda
  escrito en la suite en vez de en un comentario.

### La imagen de GHCR existe

- `ghcr.io/lucasmella-stack/mismem-brain` se publica de verdad: `0.5.0`, `0.5` y `latest`, multi-arch
  (`linux/amd64` y `linux/arm64`), con pull anónimo. Es la primera imagen que llega al registro desde
  que existe el repo, y `latest` deja de apuntar al `0.2.0` de julio de 2026.
- No hacía falta cambiar nada del workflow. Los push de v0.1.0 y v0.2.0 habían creado el paquete en
  julio, GitHub no lo vinculó al repositorio, y desde v0.3.0 todo push moría en `denied:
  permission_denied: read_package`. El paquete tampoco se veía en la lista de la cuenta por estar
  privado y sin vincular. Dos cambios en *Package settings*: el repo con rol **Write** en *Manage
  Actions access*, y la visibilidad a **Public**.
- El Quickstart de Docker del README pasa a ser `docker run ghcr.io/...` en vez de clonar y construir,
  y en `DEPLOY.md` la imagen publicada pasa a ser la opción A: el build en el servidor queda como la
  alternativa para probar un cambio sin pasar por un release. El diagnóstico queda escrito ahí, con el
  comando de `gh api` que hace visible un paquete privado sin vincular y el `docker logout ghcr.io`
  para las máquinas con credenciales viejas.

## 0.5.0 — 2026-10-23

### Que el LLM ignore un episodio ya no lo condena a la primera

- Un episodio que el LLM leía y no citaba en ninguna memoria quedaba atado a un marcador
  `[noise]` con `salience=0.05`, y `forget` lo borraba junto con el episodio. Una sola omisión del
  modelo bastaba para perder el contenido.
- Ahora cada tanda sin citar suma un strike (`uncited_count`). Recién al llegar a
  `MISMEM_CONSOLIDATION_UNCITED_STRIKES` (3, `--uncited-strikes`) el episodio pasa a ruido; mientras
  le queden, vuelve en la corrida siguiente. Reintentarlo cuesta los tokens de una tanda que ya se
  paga, no una llamada extra, y dentro de la misma corrida no se repaga.
- El resumen informa `episodes_uncited_pending`.
- Migración aditiva: `episodes.uncited_count` arranca en 0 para todo lo que ya existe.


### Una preferencia corta ya no se descarta antes del LLM

- El pre-filtro Pareto mandaba a L0 (ruido, sin pasar por el LLM) cualquier texto de menos de 40
  caracteres sin densidad: "prefiero Rust para el backend" entraba ahí, porque los patrones de
  densidad sólo reconocían código y decisiones.
- Se agregaron patrones de preferencia (`prefiero`, `uso`, `me gusta`, `dejé de`, `en vez de`,
  `elijo`, `mejor que`…), así que una preferencia breve suma densidad y llega al LLM.


### Los marcadores de ruido ya no compiten en el recall

- Las memorias `[noise] …` y `[pareto:l0] …` existen sólo para que `forget` sepa qué episodios
  borrar, pero entraban en FTS5 y en el índice semántico como cualquier otra. Desde que la relevancia
  manda sobre la saliencia, `salience=0.05` ya no alcanzaba para hundirlas: sobre la copia de
  producción, "señal" devolvía 4 marcadores de 5 memorias y "episodios" los 5 de 5.
- Ahora quedan afuera del recall por palabras y por significado, y tampoco gastan un embedding
  (`noise.ts` tiene la única definición de qué es un marcador). `forget` y el viewer los siguen viendo.
- Medido con `mismem-bench` sobre la copia de producción, con el servidor de embeddings arriba:
  `parafrasis` sube de 56/80 (70 %) a 58/80 (73 %), `literal` queda en 78/80 y las ajenas en 0/10.
  Los marcadores que llegaban al tope pasan de 43 a 0: ocupaban lugares que ahora son memorias reales.


### La saliencia puede seguir el uso en vez de la aparición

- `recall` reforzaba todo lo que devolvía, así que un recuerdo que aparece siempre y no sirve
  nunca ganaba importancia igual. Medido sobre 573 recuerdos devueltos en turnos reales de Claude
  Code, la mediana de solapamiento entre el recuerdo y la respuesta es **0,07**: casi nada de lo
  que se reforzaba se había usado.
- Herramienta MCP nueva `reinforce(memory_ids[], boost?)`: marca los recuerdos que una respuesta
  usó de verdad e informa cuántos ids no existían, así un cliente que inventa ids se nota.
- `MISMEM_REINFORCE_ON_RECALL=off` apaga el refuerzo por aparición. Por defecto sigue en `on`:
  apagarlo sin una fuente de refuerzo deja que el decaimiento mande.
- `mismem-used`: hook `Stop` de Claude Code que lee el transcript, mira el último turno y refuerza
  sólo los recuerdos cuyas palabras distintivas reaparecen en la respuesta. Habla con el servidor
  remoto por JSON-RPC (`MISMEM_HOOK_URL`) o con la base local. Tiene `--dry-run`, nunca escribe en
  stdout y nunca sale con error: un hook que rompe no vale un punto de saliencia.
- Umbrales calibrados contra esos 573 casos, no inventados: 0,2 de solapamiento y 3 palabras
  compartidas dejan pasar el 9 %, más o menos un recuerdo por llamada a `recall`.
- La tokenización de la búsqueda por palabras se movió a `terms.ts` y la comparte el hook: si las
  dos partieran el texto distinto, un recuerdo se encontraría con unas palabras y se daría por
  usado con otras.


### misMEM puede adelantar recuerdos antes de que el modelo los pida

- El modelo sólo recuerda lo que pide: si no llama a `recall`, no recuerda. `mismem-inject` es un
  hook `UserPromptSubmit` de Claude Code que busca con el prompt y devuelve unos pocos recuerdos
  por `additionalContext`.
- La búsqueda va con `reinforce: false` (campo nuevo en la entrada de `recall`): algo que el
  usuario no pidió no es uso y no puede subir la saliencia.
- Lo que inyecta queda acotado a propósito: sin episodios (son verbatim y `forget` los borra),
  3 recuerdos como mucho, 1.200 caracteres, nada que ya esté en el contexto, y nada de los ámbitos
  de `MISMEM_HOOK_EXCLUDE_SCOPES`. Un prompt sin dos palabras con sustancia ni gasta la llamada.
- **Lo inyectado viaja en cada prompt al proveedor del modelo.** `DEPLOY.md` explica cómo excluir
  los ámbitos personales y cómo revisar con `--dry-run`, que imprime ids y ámbitos pero no el texto.


### El bench dice dónde cayó el acierto, no sólo si cayó

- `mismem-bench` medía una sola cosa: si la memoria esperada estaba en el tope. Con eso, un cambio
  que mueve el acierto de la 5ª a la 1ª posición no se ve, y un cliente que muestra 3 recuerdos no
  encuentra lo que el recall@5 prometía.
- Ahora informa MRR, posición media del acierto, aciertos en la 1ª y entre las 3 primeras, y el
  reparto completo por posición.
- Del lado de la precisión: cuántos recuerdos devuelve por pregunta (el modelo los lee todos) y
  cuántos recuerdos trajeron las preguntas ajenas, no sólo cuántas trajeron algo.
- `noiseHits` cuenta los marcadores de ruido que llegaron a algún tope y tiene que ser 0. Es el
  guardia del filtro de `noise.ts`, y hay un test que falla si el filtro se cae.
- Medido sobre la copia de producción (80 preguntas, 2.527 memorias, EmbeddingGemma 2 local que
  reproduce los vectores guardados con coseno 0,9999):

  | variante | entre las 5 | en la 1ª | entre las 3 | MRR |
  |---|---|---|---|---|
  | `literal` | 78/80 (98 %) | 66 | 77 | 0,89 |
  | `literal_limpia` | 76/80 (95 %) | 66 | 76 | 0,88 |
  | `parafrasis` | 58/80 (73 %) | 41 | 52 | 0,59 |
  | `parafrasis_limpia` | 55/80 (69 %) | 36 | 49 | 0,54 |

  Ajenas 0/10 y 4,8 recuerdos devueltos de 5. Lo que el recall@5 no mostraba: con paráfrasis, un
  cliente que muestra 3 recuerdos encuentra 52 de 80 (65 %), no 73 %.


## 0.4.0 — 2026-10-12

### La búsqueda por palabras ya no tropieza con las palabras vacías

- FTS5 exige todas las palabras de la consulta, así que una pregunta entera ("¿qué decidimos sobre el
  deploy?") no encontraba nada por palabras: sólo las memorias, por significado. Ahora las palabras vacías
  (castellano e inglés) y las de una o dos letras no cuentan; los números cortos sí. Si la consulta es toda
  de palabras vacías, se busca tal cual vino.
- El modelo de embeddings sigue recibiendo la pregunta entera. Los clientes ya no necesitan limpiar la
  consulta antes de mandarla.
- Medido con `mismem-bench` (80 preguntas, 2.527 memorias): las memorias dan lo mismo que antes (70 % con
  otras palabras, 98 % con términos exactos, 0 de 10 ajenas). Lo que cambia es que rasgos y episodios, que
  sólo se buscan por palabras, ahora responden a una pregunta entera.

### Los ámbitos chicos ya no quedan pendientes para siempre

- Un ámbito con menos de `MISMEM_CONSOLIDATION_MIN_EPISODES` episodios se consolida igual cuando lleva
  `MISMEM_CONSOLIDATION_QUIET_DAYS` (14) sin episodios nuevos (`--quiet-days`). Antes una charla importada
  o un proyecto abandonado con uno o dos episodios no se consolidaba nunca y sólo se encontraba por palabras
  exactas. Con muchos ámbitos así, el tope de llamadas por corrida los reparte en varias noches.

### Un episodio que el LLM no logra procesar queda pendiente

- Si con un solo episodio la respuesta llega cortada o con JSON inválido, el episodio queda pendiente
  y la corrida sigue con el resto del ámbito. Antes, con JSON inválido se marcaba como ruido (y `forget`
  lo borraba a los 30 días) y con respuesta cortada el ámbito entero fallaba todas las noches contra el
  mismo episodio.
- El resumen de la corrida informa `episodes_skipped`.

### Documentación: una sola referencia de configuración

- `DEPLOY.md` tiene la única tabla completa de variables de entorno; el README, `engine/README.md`,
  la guía de consolidación y `.github/copilot-instructions.md` enlazan ahí en vez de repetir defaults.
- `DEPLOY.md` documenta lo que faltaba para un despliegue real: el servidor de embeddings, cuándo hay
  que reindexar, las tres tareas programadas (respaldo, consolidación, olvido) y qué texto sale a terceros.
- Corregido lo que ya no era cierto: la consolidación "vía OpenRouter", el TTL de los episodios (no
  existe: los borra `forget`), la firma de `forget`, el esquema y que la memoria "nunca sale de tu máquina"
  (con la consolidación activada, los episodios viajan al proveedor del LLM).

### Medir el recall sin tocarlo

- `mismem-bench --bank <banco.jsonl>` cuenta cuántas veces la memoria esperada sale entre las devueltas,
  por variante de pregunta y por grupo, y cuántas preguntas ajenas traen algo. Usa el mismo recall y el
  mismo servidor de embeddings que producción y no refuerza. El banco es privado y no va al repo.

### Bordes de configuración

- `MISMEM_EMBEDDING_MIN_SCORE=0` se respeta (traer todo); antes volvía a 0,5 sin avisar.
- Con `MISMEM_EMBEDDING_PROVIDER=openai` y sin `MISMEM_EMBEDDING_URL`, el default es
  `http://127.0.0.1:8080` (llama-server). Antes heredaba la URL de Ollama y la búsqueda por
  significado quedaba apagada en silencio.
- `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` más chico que la marca de recorte ya no produce
  episodios más largos que el tope.
- La ayuda de `mismem-embed` lista `MAX_CHARS` y `TIMEOUT_MS`, y aclara cuándo hace falta `--force`.

### La consolidación ya no descarta contenido válido como ruido

- Un resumen de más de 500 caracteres ya no invalida la memoria: el `gist` se recorta y el texto completo
  pasa a `details`. Antes la memoria se descartaba en silencio y, si era la única de la tanda, todos sus
  episodios quedaban marcados como "sin señal" y se borraban con el siguiente `forget`.
- Si el LLM devuelve alguna memoria mal formada, o un JSON sin la lista de memorias, la respuesta entera
  cuenta como inválida: la tanda se parte y se reintenta, igual que con un JSON roto.
- El error de un JSON roto ya no incluye el texto de la respuesta (terminaba en el log del cron).

### Un JSON roto de un solo episodio ya no traba el ámbito

- Si el LLM devuelve JSON inválido con un único episodio, ese episodio queda como ruido
  y la corrida sigue con el resto. Antes el ámbito entero fallaba y la próxima noche
  chocaba contra el mismo episodio.
- Si ese episodio venenoso sale, la tanda siguiente vuelve a llenarse. En
  `engram-compat` el tope se quedaba en 1 y procesaba de a uno. Si la respuesta
  se corta, el tope chico se mantiene (el modelo no entra más).

### Vectores y consolidación más robustos

- Una tanda de vectores que falla ya no deja sin vector a todas las siguientes; recién dos fallas seguidas
  cortan (el servidor está caído). En la primera corrida grande, 660 de 756 memorias nuevas quedaron sin
  vector por una sola tanda lenta.
- Al modelo de embeddings le llegan como mucho 4000 caracteres por memoria (`MISMEM_EMBEDDING_MAX_CHARS`):
  el resumen va adelante y no se pierde, y en CPU ARM rinde mucho más.
- La consolidación rellena vectores de a 8.
- Un JSON mal armado del LLM parte la tanda y reintenta, como una respuesta cortada.

### Embeddings desde cualquier servidor compatible con OpenAI

- `MISMEM_EMBEDDING_PROVIDER=openai` + `MISMEM_EMBEDDING_URL` piden `/v1/embeddings` (p. ej. llama-server);
  Ollama sigue siendo el default y no cambia.
- Prefijos distintos para consulta y documento (`MISMEM_EMBEDDING_QUERY_PREFIX` / `_DOC_PREFIX`).
- Corte de parecido configurable (`MISMEM_EMBEDDING_MIN_SCORE`, default 0,5).
- Medido sobre una copia real (1.353 memorias, 80 preguntas con otras palabras): con EmbeddingGemma 2,
  sus prefijos y corte 0,68, el recuerdo correcto sale entre los 5 primeros en 73 de 80 y ninguna de
  10 preguntas ajenas trae recuerdos (con nomic y 0,5 traían las 10).

### La consolidación vuelve a andar y tiene el costo acotado

- `DEEPSEEK_API_KEY` consolida con DeepSeek directo; OpenRouter queda como alternativa.
- Cada llamada pide como mucho 8192 tokens de respuesta, el máximo de `deepseek-chat`. Antes no había
  tope, OpenRouter reservaba unos 100.000 por llamada y respondía HTTP 402 por saldo.
- Si una respuesta igual llega cortada (`finish_reason: length`), la tanda se parte a la mitad y se
  reintenta; el ámbito sigue con ese tamaño. Antes se perdía la tanda entera con "JSON inválido".
- Un ámbito se consolida en tandas que entran en un presupuesto de caracteres; un episodio enorme viaja
  recortado (principio y final). Antes las tandas grandes pasaban el contexto del modelo (163.840
  tokens) y volvían con HTTP 400.
- Un ámbito se vacía en la misma corrida, hasta un tope de 60 llamadas por noche.
- Un 401/402/403 corta la corrida en el primer error en vez de repetirse por cada ámbito.
- Los episodios que el LLM leyó y no citó en ninguna memoria quedan como ruido (`[noise] N episodios sin
  citar`, saliencia 0,05) y no se vuelven a mandar ni a pagar. Si la tanda no dio ninguna memoria válida,
  quedan pendientes como antes.

### La relevancia manda sobre la saliencia

- La saliencia sólo desempata entre recuerdos casi igual de relevantes
  (`SALIENCE_RRF_WEIGHT` 0.02 → 0.0002). Antes un recuerdo muy usado tapaba al
  correcto: sobre una copia real (1.353 memorias, 80 preguntas con otras
  palabras), el correcto entraba entre los 5 primeros 4 veces; ahora 18, y 73
  con un modelo de embeddings multilingüe.
- La búsqueda por palabras ordena por coincidencia (bm25) y después por
  saliencia; la semántica desempata por saliencia a igual parecido.

## 0.3.0 — 2026-07-28

### Decay y olvido coherentes

- Decay exponencial de `salience` con checkpoint idempotente y vida media
  configurable (90 días por defecto).
- El refuerzo Hebbiano aplica primero el decay pendiente y actualiza el
  checkpoint de la memory.
- `forget --dry-run` calcula elegibilidad sin escribir; las memories tienen
  período de gracia y al purgarlas elimina sus episodes consolidados para que
  no reaparezcan.
- Migración automática y aditiva para DBs existentes.

### Recall híbrido consistente

- FTS5 y semántica se ejecutan sobre candidatos independientes de `limit`.
- Fusión RRF con salience, conservando prioridad traits > memories > episodes.
- MCP `recall`, `mem_search`, Engram directo y viewer comparten el mismo núcleo.
- El viewer no aplica refuerzo y vuelve a ser realmente read-only.
- Descripciones MCP actualizadas; `mem_context` permanece como contexto reciente.

### Índice semántico seguro

- No se mezclan modelos ni dimensionalidades incompatibles.
- Cambiar de modelo reindexa automáticamente sin borrar el vector anterior si
  Ollama falla.
- `mismem-embed --status` diagnostica el índice y `--force` permite reconstruirlo.
- Actualizar una memory invalida su embedding para el siguiente backfill.

### Documentación y calidad

- Explicación concisa de episodes, memories y traits.
- 80+ tests incluyendo decay, migraciones, consistencia entre superficies,
  propiedad de prefijo y cambio de modelo.
- `better-sqlite3` 12.11.1 para instalaciones precompiladas compatibles con
  Node 24, verificadas en CI junto con Node 22.

## 0.2.0 — 2026-07-24

Los dos "bordes conocidos" de la 0.1.0, liquidados:

### Dedup en captura e ingesta
- `capture` calcula `content_hash` (sha256) y re-capturar el mismo `(scope, body)`
  devuelve el id original en vez de duplicar. Re-ingestar un export completo
  ahora es idempotente.
- Migración automática y aditiva al abrir la DB: backfill de hashes para filas
  existentes (chunked, seguro para DBs grandes en producción).
- `mismem-ingest walk` reporta `chunksDeduped`.

### Búsqueda semántica opcional (recall híbrido)
- `recall` / `mem_search` ahora combinan FTS5 (léxico) con coseno sobre
  embeddings (semántico): "problemas de plata" encuentra "deudas".
- Embeddings vía **Ollama local** (`nomic-embed-text` default). Sin Ollama,
  degradación silenciosa a FTS5 puro — cero configuración obligatoria.
- Sin extensiones nativas: vectores como BLOB en la misma SQLite, coseno
  brute-force en JS (para memoria personal de miles de filas, <50ms).
- Nueva CLI `mismem-embed` para backfill idempotente; la consolidación
  nocturna embebe automáticamente las memorias nuevas.
- Hits semánticos marcados con `via: "semantic"` y con refuerzo Hebbiano.
- Env: `MISMEM_EMBEDDINGS=off`, `MISMEM_OLLAMA_URL`, `MISMEM_EMBEDDING_MODEL`.

## 0.1.0 — 2026-07-24

Primera versión pública. Historia condensada del desarrollo (abril–julio 2026):

### Núcleo (abril 2026)
- Engine MCP stdio con schema de 3 capas (`episodes` → `memories` → `traits`),
  las 5 invocaciones (`capture`, `recall`, `consolidate`, `crystallize`, `forget`),
  FTS5 + refuerzo Hebbiano en recall, scopes jerárquicos y suite de tests (Vitest).
- Servidor **Streamable HTTP** stateless (server+transport por request) con capa
  **engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …)
  para clientes que hablan el protocolo Engram.
- Dockerfile multi-arch (`mismem-brain`, Alpine) + guía de deploy con Traefik
  (TLS, BasicAuth, healthcheck) y estrategia de backup diario
  (`VACUUM INTO` + scp, retención 14 días).
- Viewer read-only en `/viewer` + `/api/{stats,recent,search}`.
- Fix de robustez: orden estable en `mem_context`, escape seguro de queries FTS5.

### Consolidación LLM (abril 2026)
- Destilación nocturna episodes → memories vía OpenRouter (DeepSeek V3 default):
  idempotente, anti-alucinación (filtra evidencia fuera del batch), memoria stub
  con salience baja cuando no hay señal, tolerante a salidas no conformes del LLM.
- **Pre-filtro Pareto**: clasificador que descarta ruido antes de gastar tokens.
- CLIs: `mismem-ingest` (exports ChatGPT / transcripts VS Code),
  `mismem-consolidate`, `mismem-forget`, `mismem-migrate-engram`, `mismem-stats`.

### Preparación pública (julio 2026)
- Line endings normalizados (`.gitattributes`), docs genéricos sin referencias a
  infraestructura personal, README con arquitectura y quickstart, historial fresco.
