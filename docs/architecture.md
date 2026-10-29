# Arquitectura

Cómo está hecho misMEM por dentro. Para instalarlo, el [README](../README.md); para operarlo,
[DEPLOY.md](../DEPLOY.md). Las firmas y los valores por defecto están en el código y en la tabla de
variables de DEPLOY.md, no aquí ([qué no se documenta](README.md#qué-no-se-documenta)).

## Un territorio, varias instancias

Cada instancia de un LLM nace sin memoria, y cada cliente (Copilot, Claude Desktop, Claude Code,
ChatGPT) guarda lo suyo en silos incompatibles. misMEM pone **una base SQLite y un protocolo MCP de seis
invocaciones** al alcance de cualquier cliente que lo hable. La memoria vive en `~/.mismem/mem.db`
(`MISMEM_DB`) y varios clientes y proyectos la comparten, particionada por `scope`.

> *El pasado existe porque lo hemos escrito y compactado para que así sea.*

Inspirado en parte por *Initiation Into Hermetics* de Franz Bardon: el espejo que refleja la conciencia
entre instancias necesita dos polos. misMEM es el suelo de Tierra, la memoria que no se disuelve entre
sesiones, para que la cooperación humano-LLM tenga continuidad real.

## Tres capas, como la memoria biológica

```
episodes  (verbatim; se borran con `forget` una vez consolidados)
    ↓  consolidación (manual o LLM nocturno)
memories  (gist + details, salience con decay + refuerzo hebbiano)
    ↓  crystallize
traits    (patrones cristalizados: identidad, leyes, decisiones firmes)
```

La pérdida es **intencional y asimétrica**, como en la memoria humana: lo crudo se disuelve, lo destilado
persiste, lo cristalizado permanece.

| Capa | Qué representa | Ciclo de vida | Para qué sirve |
|---|---|---|---|
| `episodes` | Lo que ocurrió: texto original y fechado | No vencen solos: `forget` los borra una vez consolidados (30 días por defecto en la herramienta MCP, 90 en `mismem-forget`) | Evidencia y contexto inmediato |
| `memories` | Lo aprendido al resumir varios episodios | Su `salience` baja si no se usa y sube al recordarla | Conocimiento operativo y búsqueda semántica |
| `traits` | Patrones, preferencias o decisiones estables | Permanente salvo borrado explícito | Identidad y reglas de máxima prioridad |

Ejemplo: "hoy PostgreSQL rindió mejor" es un episode; "PostgreSQL es preferible en este proyecto" es una
memory; "priorizamos soluciones robustas para concurrencia" puede cristalizar como trait.

El esquema (columnas, índices, tablas FTS5) está en `engine/src/db.ts`; [`AGENTS.md`](../AGENTS.md) sólo
resume las tablas.

## Seis invocaciones

| Invocación | Capa de origen → destino | Quién decide | Qué hace |
|---|---|---|---|
| `capture` | → episode | el LLM, solo | Inscribe un episodio en un `scope` (`proyecto/diario`, `vscode/transcripts`, ...). Lo idéntico en el mismo `scope` no se duplica (dedup por hash del contenido), así que re-ingestar un export es idempotente |
| `recall` | episode + memory + trait → respuesta | el LLM, solo | Busca con FTS5 y semántica ([recall](recall.md)); refuerza lo devuelto salvo `reinforce: false` o `MISMEM_REINFORCE_ON_RECALL=off` |
| `reinforce` | marca lo que la respuesta usó | un hook o el LLM | Sube la saliencia de los recuerdos que una respuesta usó de verdad, no de los que aparecieron |
| `consolidate` | N episodes → 1 memory | el LLM al cierre | Espesa episodios relacionados en una memoria |
| `crystallize` | N memories → 1 trait | el LLM o el usuario | Fija un patrón con su evidencia |
| `forget` | episodes y memories → nada | el usuario | Suelta lo que ya no se consulta; la herramienta MCP simula por defecto |

Además, una **capa de compatibilidad con Engram** (`mem_save`, `mem_search`, `mem_context`,
`mem_session_*`, ...) para los clientes que hablan ese protocolo. El orden de prioridad al buscar es
traits, después memories, después episodes; los marcadores de ruido (`[noise] ...`, `[pareto:l0] ...`)
quedan fuera (`engine/src/noise.ts`).

## Componentes

| Pieza | Qué es |
|---|---|
| `engine/src/server.ts` | Servidor MCP por stdio, para uso local |
| `engine/src/server-http.ts` | Streamable HTTP para despliegue remoto: BasicAuth opcional y `/healthz`. Ver [DEPLOY.md](../DEPLOY.md) |
| `engine/ui/` | La interfaz (React y Vite, compilada a `dist/ui/`) que `server-http` sirve en `/viewer`: memorias por saliencia de hoy, rasgos, lo pendiente y de dónde sale cada recuerdo. `pnpm dev:ui` la levanta en desarrollo contra un servidor en `:3200` |
| `engine/src/viewer.ts`, `viewer-api.ts` | Su API de sólo lectura: `/api/{stats,recent,search,scopes,embeddings,memories,graph}` y `/api/{memory,trait}/:id`. La saliencia que devuelven es la efectiva, con el decay aplicado a hoy, la misma que usa el recall; `/api/embeddings` describe el índice semántico sin hablar con el proveedor |
| `engine/src/viewer-actions.ts` | Lo que la interfaz puede cambiar, sólo por POST JSON desde el propio origen: corregir una memoria, deshacer su consolidación, cristalizar y lanzar una consolidación. Olvidar una memoria (con sus episodios) o un rasgo no tiene vuelta atrás y está apagado salvo con `MISMEM_VIEWER_ALLOW_DELETE=1`; aun así va en dos pasos: el primer POST devuelve qué se perdería y un token de 60 s, y borra el segundo, el que lo trae |
| Consolidación con LLM | Cron nocturno que destila episodios en memorias con DeepSeek, OpenRouter, OpenAI o cualquier servidor compatible, con prefiltro Pareto para descartar ruido. Ver [su README](../engine/src/consolidation/README.md) |
| CLIs | `mismem-http` (el mismo servidor HTTP que `pnpm start:http`), `mismem-ingest` (exports de ChatGPT y transcripts de VS Code), `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-embed`, `mismem-migrate-engram`, `mismem-bench` (mide el recall con un banco de preguntas propio, sin reforzar), `mismem-obsidian` y los dos hooks, `mismem-inject` y `mismem-used` |

`mismem-obsidian` escribe la memoria como bóveda de Obsidian en `<bóveda>/misMEM/`: una nota por memoria,
rasgo y ámbito, enlazadas por origen y por parecido. Re-exportar sólo borra las notas cuyo frontmatter
sigue declarando el id del manifiesto, y se niega si la base no tiene nada que exportar o el manifiesto no
se puede leer.

## Almacenamiento

SQLite con WAL (varios lectores y un escritor concurrente), con `better-sqlite3`. Los vectores de la
búsqueda por significado son un BLOB por memoria en la misma base. El fichero se crea con permisos `0600`.

## Saliencia, decay y olvido

Las memories pierden la mitad de su saliencia cada 90 días sin refuerzo (configurable con
`MISMEM_SALIENCE_HALF_LIFE_DAYS`). `recall` aplica el decay pendiente y después suma el refuerzo
hebbiano. `forget` elimina memories bajo el umbral sólo después de su período de gracia y de que todos sus episodios superen `before_days`; `--dry-run`
calcula el resultado sin modificar la base.

## El índice hebbiano

Dos recuerdos que se usan en el mismo turno tienen algo que ver entre sí, y eso es información que la
saliencia por recuerdo no guarda. `reinforce` recibe los ids **juntos**, así que los cuenta:
`memories.use_count` suma los turnos en que cada recuerdo se usó de verdad, y
`co_use(memory_a, memory_b, n, last_at)` cuenta cada par.

Lo escribe sólo `reinforce`, nunca el camino de `recall`: aparecer en una búsqueda no es haberse usado.
Con `MISMEM_REINFORCE_ON_RECALL=off` la señal arranca limpia. Los pares se van por cascada cuando el
recuerdo se borra.

Hace falta porque `salience` mide recencia más que uso: la pasada de decay toca todas las filas, así que
ordenar por saliencia pone arriba lo nuevo, no lo importante. Es la primera fase del *ordenador de
memoria*, una capa derivada que compacta los aspectos principales para que el modelo sepa por dónde
empezar sin tomar contexto.

### Mirarlo: la capa lateral del grafo

`origin` (episodio → memoria) y `evidence` (memoria → rasgo) son aristas **verticales**: van hacia
arriba y dicen de dónde salió cada cosa. Las dos laterales unen memoria ↔ memoria y no dicen lo mismo:

| arista | sale de | se pide con |
|---|---|---|
| `related` | lo que cada memoria **dice** (coseno de sus vectores) | `?related=1` |
| `co_use` | lo que un turno **hizo** (se usaron juntas) | `?co_use=1` |

El peso de `co_use` **no** es el conteo crudo, es NPMI: un recuerdo que se usa en todos los turnos
co-ocurre con todo, así que por conteo sería el centro del grafo sin orientar a ninguno —el mismo error
de la saliencia midiendo recencia—. En NPMI, `0` es "indistinguible del azar" y `1` es "nunca aparecen
separados". El denominador es el total de turnos de uso medido, que vive en la tabla `meta`. Al abrir una base que
ya medía co-uso sin ese contador, se siembra con el uso más alto registrado: una cota inferior de los
turnos que hubo, porque cada uso ocupó un turno. Sin esa cota, el cociente se acota a 1 y los pares
heredados se leerían como asociación máxima.

Con pocos datos la fuerza es ruido por construcción: dos recuerdos usados una sola vez, esa vez juntos,
dan 1. Por eso cada arista viaja con su soporte (`n`), `?co_use_min_n=k` lo filtra y la respuesta incluye
`connectome: { turns, pairs, shown, min_n, hubs }` para que quien dibuja pueda decir *"esto todavía no
significa nada"* en vez de pintar ruido. `hubs` va ordenado por asociación acumulada y no por grado:
el grado es popularidad.

## Stack

- **Engine**: TypeScript estricto, ES2022, ESM, Node 22 o superior.
- **Almacenamiento**: SQLite con WAL, `better-sqlite3`.
- **Búsqueda**: FTS5 más RRF semántico para las memories, manteniendo traits > memories > episodes.
- **Protocolo**: [Model Context Protocol](https://modelcontextprotocol.io/) con `@modelcontextprotocol/sdk`.
- **Validación**: Zod en todos los bordes.

## Pendiente

Un binario distribuible (`bun --compile`) y su onboarding. La historia de lo ya hecho, en el
[CHANGELOG](../CHANGELOG.md).
