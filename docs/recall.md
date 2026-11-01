# Cómo busca recall

`recall` pone traits, memories y episodes en un solo ranking: las tres capas compiten por la misma plaza con
RRF. Cada señal aporta `peso / (60 + puesto)` y un recuerdo que encuentran varias señales sube; ninguna capa
conserva un escalón fijo. La saliencia sólo puntúa a las memories: suma `saliencia * 0,0002` a su RRF, por
debajo de un puesto en la cabeza, así que ahí sólo desempata y más abajo puede mover dos o tres plazas; rasgos
y episodios no la llevan. Las constantes están en
`engine/src/recall/` y las variables, en la tabla de [DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Por palabras (siempre)

FTS5 exige que estén **todas** las palabras de la consulta, sin contar las vacías ("qué", "sobre", "the"...).

### El rescate

Si esa consulta estricta no devuelve nada y no hay capa semántica, `recall` reintenta con una consulta OR
y conserva sólo los candidatos que comparten al menos dos términos informativos. Con una sola palabra
basta una; en consultas largas, el 30 % de sus palabras. Devuelve hasta 3 por capa. El rescate alcanza a
rasgos, episodios y memorias, y no altera una búsqueda que ya encontró algo.

Con capa semántica el rescate apenas suma aciertos, empuja hacia abajo la respuesta buena y trae
memorias de preguntas que no vienen al caso; sin ella es lo que hace aparecer la paráfrasis que la
consulta estricta deja fuera. Por eso sólo entra cuando no hay nada que puntuar.

La rareza de un término que cuenta para el rescate tiene un suelo de 3 documentos y una fracción del 5 % de
la base, de modo que "pocos" significa lo mismo con 300 memorias que con 3.000. Se calibró con
`mismem-bench --off-topic`: se sube la fracción mientras las preguntas fuera de tema no devuelvan nada, y se
elige la mayor que las deje a cero.

## Por significado (opcional)

Con un servidor de embeddings corriendo, `recall` suma búsqueda por significado: "problemas de plata"
encuentra memorias que dicen "deudas". El modelo por defecto es EmbeddingGemma 2, multilingüe, servido por
`llama-server` en `http://127.0.0.1:8080`.
Los vectores se guardan como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro.

La semántica cubre las tres capas. Las memorias guardan su vector en `memory_embeddings`; los rasgos y los
episodios pendientes, en `layer_embeddings`. Esos vectores se escriben al capturar o cristalizar y en el
backfill, nunca al vuelo en una consulta. En el ranking por significado las tres capas forman una sola lista
ordenada por coseno, con una prima de 0,05 para la memoria consolidada; ninguna capa hereda una posición fija.
Un rasgo exige 0,06 de margen sobre el corte y un episodio pendiente 0,01, porque una regla corta y general se
parece a cualquier pregunta de su tema. Cuando hay vectores, el resultado se queda con el mejor rasgo y como
mucho dos episodios por consulta, elegidos por coseno antes de la fusión: una coincidencia exacta de palabras
no puede adelantar a un rasgo o un episodio que está más cerca por significado. Sin ese tope, los rasgos y los
episodios desplazaban a la memoria concreta que responde. El modo léxico, sin vectores, no aplica el tope.
Backfill y reindexado: `mismem-embed` (`--status`, `--force`), que recorre memorias, rasgos y episodios
pendientes. Los vectores se normalizan a norma 1
al entrar. Un vector con un componente no finito o con norma cero sólo se pierde a sí mismo: sus
compañeros de lote se guardan igual. En cambio, un vector sin dimensiones o un lote con dimensiones
mezcladas descarta el lote entero a propósito, como si el servidor no hubiera respondido, en vez de
guardar vectores que nunca puntuarían. Una tanda entera de vectores inválidos cuenta como fallida, y
dos seguidas abortan la corrida como si el servidor estuviera caído. El backfill reescribe además los
vectores inválidos que una versión anterior ya había guardado. `--status` cuenta esos vectores
inválidos en `invalid`, sin los marcadores de ruido, que el backfill nunca reescribe.

Habla un solo protocolo, el `/v1/embeddings` de OpenAI, que sirven `llama-server --embedding` y Ollama: otro
servidor u otro modelo se eligen con `MISMEM_EMBEDDING_URL` y `MISMEM_EMBEDDING_MODEL`. Con memorias en
castellano, EmbeddingGemma 2 encontró 34 de 50 paráfrasis frente a 4 de 50 de un modelo pensado para inglés
(medido en la issue #72), y en CPU no gasta VRAM. Con un modelo de la familia EmbeddingGemma van solos sus
prefijos de consulta y documento y un corte de 0,65, el mayor que no pierde aciertos (PR #181); otro modelo
arranca sin prefijos y con 0,5. Un `MISMEM_EMBEDDING_MIN_SCORE` explícito gana siempre.

`scripts/install.sh` lo monta si hay `llama-server` (baja el modelo sólo si se acepta, lo deja como servicio
de systemd de usuario en CPU, y en la GPU con `--embeddings-gpu`); `--embeddings gemma|off` lo elige o apaga
la capa sin preguntas.

Con EmbeddingGemma 2 el corte por defecto también es 0,65: en el golden eval, con 0,5 las 48 preguntas
ajenas traían 5 recuerdos cada una; con 0,65 sólo 11 traen algo y no se pierde ningún acierto, y con 0,66
ya se pierde uno (medido el 2026-10-30, issue #158). Un `MISMEM_EMBEDDING_MIN_SCORE` explícito gana siempre.

La búsqueda sólo compara vectores del modelo configurado. Cada vector guarda además una huella del texto
exacto que se envió al servidor (el prefijo de documento más el texto ya recortado). Cambiar de modelo, de
prefijo de documento o de `MISMEM_EMBEDDING_MAX_CHARS`, o editar el texto de una memoria, un rasgo o un
episodio, reindexa solo en el siguiente backfill (`mismem-embed`): `--status` cuenta en `outdated` los vectores
del modelo activo que ya no coinciden, y `--force` sigue sirviendo para reindexar todo aunque nada haya
cambiado. El prefijo de consulta no entra en la huella: cambiarlo no invalida ningún vector guardado. Todas
las variables, con sus defaults, están en
[DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Medirlo

`mismem-bench` informa la posición del acierto (MRR, 1ª, entre las 3), los recuerdos devueltos por
pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0). Se corre antes y después de tocar
`recall/` o `embeddings/`. El banco de preguntas es privado y sale de la propia memoria.
Cómo usarlo en un servidor: [DEPLOY.md](../DEPLOY.md#medir-el-recall).

El eval dorado (`pnpm eval`) mide lo mismo sobre un corpus sintético y público en castellano: una persona ficticia en doce
dominios. Sirve para comparar entre máquinas y para subir el suelo en CI. Desde `engine/`:

```bash
pnpm eval --mode lexico
node dist/eval-cli.js --mode semantico
```

El segundo exige `pnpm build` y las variables `MISMEM_EMBEDDING_*` del servidor de embeddings
([DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única)); `--mode auto` usa el semántico sólo si
el embedder deja todas las memorias embebidas sin un solo lote fallido. Si alguna se queda sin vector,
mide en léxico y la línea `modo:` lo dice. Los datos viven en `engine/eval/golden/`, un `.jsonl` por
dominio; su validación está en `engine/src/recall/golden-corpus.ts` y su carga y medición en
`engine/src/recall/golden.ts`. La puerta de CI
(`engine/tests/golden.test.ts`) exige que el modo léxico no baje del suelo por tipo de `floor.json` ni supere
`lexico_ajenas_max`, y que ningún marcador de ruido llegue al resultado. También comprueba el reparto del
corpus (doce dominios, 40 preguntas por dominio y los tipos esperados) y que `expect` o `evidence` no nombren
un id de pregunta; si el corpus no está, el test falla. Quien mejora el recall sube el suelo en el mismo PR.
El corpus no viaja en el paquete npm (el ejecutor sí, en `dist/`): se corre desde el repositorio.

Línea base del 2026-11-01 (tope 5, aciertos dentro del tope; caduca cuando cambia el corpus):

| Modo | Global | MRR | Paráfrasis | Episodio | Rasgo | Ajenas con algo | Recuerdos por pregunta |
|---|---|---|---|---|---|---|---|
| Léxico | 222/432 | 0,48 | 1/72 | 20/24 | 9/24 | 4/48 | 0,9 |
| Semántico (`embeddinggemma-2`, corte 0,65) | 411/432 | 0,87 | 64/72 | 23/24 | 19/24 | 11/48 | 4,87 |

En el semántico, las tres capas compiten en el mismo ranking: rasgos y episodios pendientes pasan de 0/24 a
19/24 y 23/24. El acierto en primera posición es 355/432 y el de las preguntas que esperan una memoria,
328/384, frente a 329/384 de la línea base sin vectores de capa. El episodio que sigue sin aparecer (`dev-q33`) no es un fallo del ranking: su texto no dice
"Lucía", que está sólo en el ámbito, y otro episodio parecido puntúa algo más alto.

### El corpus dorado

Un objeto JSON por línea, en `engine/eval/golden/<dominio>.jsonl`:

```json
{"type":"memory","key":"dev-01","scope":"lucia/dev","gist":"…","details":"…","days_ago":12,"salience":0.8}
{"type":"trait","key":"dev-t1","scope":"lucia/dev","name":"…","evidence":["dev-01"]}
{"type":"episode","key":"dev-e1","scope":"lucia/dev","body":"…","days_ago":1}
{"type":"query","id":"dev-q01","kind":"parafrasis","query":"…","expect":["dev-01"],"scope":"…"}
```

`details`, `salience` y el `scope` de una pregunta son opcionales. Las claves son únicas entre ficheros;
`expect` nombra cualquiera de ellas y sólo está vacío en `ajena`, una pregunta que no debe traer nada. Un
`gist` que empieza por `[noise] ` o `[pareto:l0] ` es un marcador de ruido: se carga y nunca se devuelve, así que
ninguna pregunta del corpus lo espera (el validador no lo impide: una pregunta así fallaría siempre). Los tipos de pregunta son `literal`, `parafrasis`, `sinonimo`, `coloquial`, `sin_tildes`,
`errata`, `ingles`, `larga`, `clave`, `ambito`, `episodio`, `rasgo` y `ajena`.
