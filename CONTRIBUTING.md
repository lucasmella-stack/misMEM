# Contribuir a misMEM

El contrato de trabajo, para personas y agentes, es [`AGENTS.md`](AGENTS.md): stack, convenciones de
código, esquema, reglas de seguridad. Este fichero cubre la mecánica: cómo se prepara el entorno,
cómo se ramifica, qué lleva un cambio y cómo se llevan issues y PR. Qué se documenta y dónde:
[`docs/README.md`](docs/README.md). El detalle de cada norma: [`docs/standards/`](docs/standards/README.md).

## Preparar el entorno

Hace falta Node 22 o superior y pnpm (la versión exacta está en `packageManager` de
`engine/package.json`; `corepack enable` la instala).

```bash
git clone https://github.com/lucasmella-stack/misMEM.git
cd misMEM/engine
pnpm install
```

pnpm, no npm. Un script de instalación nuevo (`postinstall`) se audita antes de permitirlo en
`engine/pnpm-workspace.yaml`; hoy sólo `better-sqlite3` y `esbuild` lo tienen.

| Comando (desde `engine/`) | Para qué |
|---|---|
| `pnpm dev` | Servidor MCP por stdio, con tsx |
| `pnpm dev:http` | Servidor HTTP en `:3200`, con tsx |
| `pnpm dev:ui` | La interfaz en desarrollo, contra un servidor en `:3200` |
| `pnpm typecheck` | Tipos de `src/`, de `ui/` y de los tests |
| `pnpm test` | Vitest |
| `pnpm knip` | Ficheros, exports y dependencias sin uso |
| `pnpm dup` | Bloques copiados de 10 líneas o más |
| `pnpm lint` | Biome, sólo como linter |
| `pnpm build` | `tsc` más la interfaz, a `dist/` |

## Qué comprueba CI

Cada PR corre [`ci.yml`](.github/workflows/ci.yml). La columna de la derecha dice cómo reproducir un
fallo en local; donde está vacía, el job sólo corre en CI.

| Job | Qué protege | En local |
|---|---|---|
| `test` (Node 22 y 24) | Tipos, tests, código muerto, duplicación, lint, build | los seis comandos de arriba |
| `shell-scripts` | Sintaxis y errores de `scripts/*.sh` | `bash -n scripts/*.sh` y `shellcheck --severity=error scripts/*.sh` |
| `packaging` | La licencia del paquete idéntica a la raíz; el Dockerfile limpio de hadolint | `cmp LICENSE engine/LICENSE` |
| `docker-build` | La imagen compila y responde en `/healthz` | `docker build -f engine/Dockerfile.mismem-brain engine` |
| `workflow-lint` | Los workflows, con actionlint y zizmor | |
| `secret-scan` | Ninguna clave en la historia, con gitleaks | |

Aparte, [`labels.yml`](.github/workflows/labels.yml) compara `.github/labels.json` con las etiquetas
que tiene GitHub cuando ese fichero cambia.

## Flujo de trabajo

Trunk-based sobre `main`. Las ramas son cortas y salen de `main`; se borran al mergear. Nombres,
tipos y reglas: [Ramas](docs/standards/branches.md).

1. Abrir el issue primero, con su criterio de cierre (ver más abajo).
2. Rama `<tipo>/<tema>` en inglés, por ejemplo `fix/recall-empty-scope`. Un asunto por rama.
3. Commits convencionales en inglés: [Commits](docs/standards/commits.md).
4. Los comandos de la tabla de arriba, en verde, antes de abrir el PR.
5. PR contra `main` con `Closes #N`. Un issue por PR; el PR cierra el issue cuando se mergea.
6. CI en verde y una revisión (los dos responsables, de [`CODEOWNERS`](.github/CODEOWNERS), la reciben sola).
7. Merge commit, no squash: la historia conserva cada commit con su porqué. Rama borrada.

Cada cambio lleva en el mismo PR sus tests, su documentación y su línea en [`CHANGELOG.md`](CHANGELOG.md),
bajo `## Sin publicar`. Un cambio de comportamiento sin un test que lo ejercite no cuenta como terminado.

### Estándar de PR

Un PR, en este orden: resumen en términos de producto, el issue que cierra, y el plan de pruebas con
lo que se ejecutó de verdad. Debe poder revisarse: unas 400 líneas de código de producto como
referencia, sin reformateos ajenos ni refactors de paso.

GitHub sólo muestra la plantilla por defecto, [`pull_request_template.md`](.github/pull_request_template.md).
Las demás se piden añadiendo `?template=<nombre>.md` a la URL de comparación:

| Para | Plantilla | URL |
|---|---|---|
| Funcionalidad, corrección o refactor | por defecto | `https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1` |
| Una release | [`release.md`](.github/PULL_REQUEST_TEMPLATE/release.md) | `https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=release.md` |
| Dependencias | [`dependency.md`](.github/PULL_REQUEST_TEMPLATE/dependency.md) | `https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=dependency.md` |
| Sólo documentación | [`documentation.md`](.github/PULL_REQUEST_TEMPLATE/documentation.md) | `https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=documentation.md` |

Desde un fork, `<rama>` es `<usuario>:<rama>`.

### Estándar de issue

Un issue existe para poder cerrarse con evidencia.

- **Criterio de cierre en el primer mensaje.** "Arreglar X" no es un issue; "X se reproduce así y se
  cierra cuando un test lo reproduce y pasa" sí. Todos los formularios lo piden.
- **Evidencia antes que opinión.** Mediciones, logs y salidas de comandos. Nunca contenido de la memoria
  ni claves.
- **Un tipo como mínimo.** El formulario pone el suyo; los modificadores, las áreas y la prioridad se
  añaden sólo cuando dicen algo que el tipo no dice.
- **El cierre lleva la prueba**: los números, los PR mergeados o la decisión razonada, incluido "no se
  hace". Un issue cerrado sin evidencia se reabre.
- Una vulnerabilidad o una clave filtrada no es un issue: se reporta en privado, ver
  [`SECURITY.md`](SECURITY.md).

Los formularios están en [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) y los issues en blanco
están desactivados.

| Formulario | Etiqueta | Para |
|---|---|---|
| Error | bug | Lo que misMEM hace mal; pide versión, modo de instalación, Node y cliente |
| Mejora | enhancement | Una capacidad nueva o un cambio de comportamiento |
| Documentación | documentation | Un documento está mal, falta o contradice el código |
| Medición de recall | performance | Un resultado de mismem-bench u otra medición, y lo que implica |

### Etiquetas

La fuente única es [`.github/labels.json`](.github/labels.json). Las tablas siguientes se mantienen a mano
a partir de él y un test comprueba que no se separan (ver "Dónde se hace cumplir").

<!-- labels:begin -->
<!-- Declaradas en .github/labels.json. engine/tests/contribution-standard.test.ts comprueba que lo que
     se nombra aquí está declarado y que lo declarado como parte del estándar se nombra aquí. Sin
     acentos graves en las descripciones: el test lee como etiqueta todo lo que va entre ellos. -->

Tipo, uno por issue:

| Etiqueta | Cuándo |
|---|---|
| `bug` | misMEM hace algo mal |
| `enhancement` | Una capacidad o un cambio de comportamiento que no existe |
| `documentation` | Los documentos están mal, faltan o contradicen el código |
| `performance` | Latencia, calidad del recall o consumo de recursos |
| `security` | Endurecimiento, o una vulnerabilidad ya reportada en privado |
| `cleanup` | Quitar lo que sobra, sin cambio de comportamiento |
| `research` | Una exploración cuyo resultado es una conclusión escrita |
| `dependencies` | Actualización de una dependencia; la pone Dependabot |

Modificadores, opcionales y acumulables:

| Etiqueta | Cuándo |
|---|---|
| `needs-decision` | Espera una decisión de los responsables; el issue dice cuál |
| `blocked` | No puede avanzar hasta que ocurra algo externo; el issue dice qué |
| `needs-bench` | Toca el ranking del recall o los embeddings: correr mismem-bench y pnpm eval --mode lexico antes y después |
| `breaking` | Cambia un flag, una variable, una herramienta MCP o una respuesta HTTP |

Áreas, cero o más:

| Etiqueta | Cubre |
|---|---|
| `area:mcp` | El servidor MCP, las seis herramientas y los alias de Engram |
| `area:search` | Recall léxico y semántico, ranking y embeddings |
| `area:consolidation` | Consolidación con LLM, prefiltro Pareto y olvido |
| `area:http` | Servidor HTTP, autenticación, guarda de Host y límites |
| `area:viewer` | La API del visor y la interfaz React |
| `area:ingest` | Importadores: ChatGPT, VS Code, recorrido de ficheros, migración de Engram |
| `area:cli` | Las herramientas de línea de comandos y su lectura de argumentos |
| `area:hooks` | Los hooks del cliente: inject y used |
| `area:deploy` | La imagen Docker, install.sh y el despliegue |
| `area:ci` | Workflows, herramientas y configuración del repositorio |

Prioridad, como mucho una, la pone quien tria:

| Etiqueta | Cuándo |
|---|---|
| `priority:high` | Antes que nada: pérdida de datos, recall incorrecto o una release rota |
| `priority:medium` | Planificado, sin fecha |
| `priority:low` | Cuando haya trabajo cercano abierto |
<!-- labels:end -->

Un issue sin prioridad no se ha triado. Las etiquetas que GitHub y Dependabot crean por su cuenta
(`duplicate`, `invalid`, `wontfix`, `question`, `good first issue`, `help wanted`, `docker`,
`github_actions`, `javascript`) también están declaradas en el fichero y no forman parte del estándar:
`wontfix` se pone al cerrar con su razonamiento, nunca en su lugar.

Añadir una etiqueta son tres pasos y ninguna ambigüedad: crearla en GitHub, declararla en
`.github/labels.json` y nombrarla en las tablas de arriba.

### Dónde se hace cumplir

Una norma sólo escrita se desvía; por eso lo comprobable se comprueba.

| Comprobación | Qué sostiene | Dónde corre |
|---|---|---|
| `engine/tests/contribution-standard.test.ts` | Formularios, plantillas de PR, `release.yml` y este fichero nombran sólo etiquetas declaradas, y cada tipo tiene formulario o excepción razonada | `pnpm test`, en CI |
| `.github/workflows/labels.yml` | `labels.json` coincide con las etiquetas que tiene GitHub | al cambiar ese fichero, y a demanda |
| `blank_issues_enabled: false` en `config.yml` | Todo issue nuevo parte de un formulario | GitHub |
| `ci.yml` | La tabla de "Qué comprueba CI" | cada PR |

## Releases

Una release es un tag anotado `vX.Y.Z`, la release de GitHub con sus notas y la sección del
`CHANGELOG.md` con su fecha. Los pasos, con el porqué de cada uno, están en
[Releases](docs/standards/releases.md); el PR de release usa la plantilla `release.md`.

## Seguridad

Las normas del repositorio (secretos, dependencias, imagen) están en
[Seguridad](docs/standards/security.md). Para reportar una vulnerabilidad: [`SECURITY.md`](SECURITY.md).
