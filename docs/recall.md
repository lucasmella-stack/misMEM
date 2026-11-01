# Cómo busca recall

`recall` devuelve traits, después memories, después episodes. Dentro de las memories fusiona dos señales
con RRF: las palabras (FTS5) y, si hay un servidor de embeddings, el significado. La relevancia va antes
que la saliencia, que sólo desempata. Esta página cuenta el comportamiento; las constantes están en
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
encuentra memorias que dicen "deudas". El valor por defecto es Ollama (`ollama pull nomic-embed-text`), un modelo pensado para inglés.
Los vectores se guardan como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro.

La semántica cubre deliberadamente sólo `memories`; `episodes` y `traits` conservan búsqueda FTS5.
Backfill y reindexado: `mismem-embed` (`--status`, `--force`).

También habla con cualquier servidor compatible con OpenAI (`/v1/embeddings`, por ejemplo
`llama-server --embedding`). **Si las memorias no están en inglés, conviene EmbeddingGemma 2**: con memorias en
castellano encontró 34 de 50 paráfrasis frente a 4 de 50 de `nomic-embed-text` (medido en la issue #72), y
en CPU no gasta VRAM. Va con sus prefijos y un corte de 0,65 (con 0,68 sale casi igual):

```bash
MISMEM_EMBEDDING_PROVIDER=openai
MISMEM_EMBEDDING_URL=http://127.0.0.1:8080
MISMEM_EMBEDDING_MODEL=embeddinggemma-2
MISMEM_EMBEDDING_QUERY_PREFIX="task: search result | query: "
MISMEM_EMBEDDING_DOC_PREFIX="title: none | text: "
MISMEM_EMBEDDING_MIN_SCORE=0.65
```

`scripts/install.sh` lo monta si hay `llama-server` (baja el modelo sólo si se acepta, lo deja como servicio
de systemd de usuario en CPU, y en la GPU con `--embeddings-gpu`); `--embeddings gemma|nomic` elige el
modelo sin preguntas.

Con `nomic-embed-text` el corte por defecto es 0,65: con 0,5 el hook de inyección añadía recuerdos sin
relación a cada prompt. No hay que esperar paráfrasis: encuentra la memoria cuando la consulta comparte sus
palabras, no cuando la dice de otra forma. Un `MISMEM_EMBEDDING_MIN_SCORE` explícito gana siempre.

La búsqueda sólo compara vectores del modelo configurado. Cambiar de modelo reindexa solo en el siguiente
backfill (`mismem-embed`); cambiar un prefijo no se detecta y exige `mismem-embed --force`. Todas las
variables, con sus defaults, están en
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
([DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única)); `--mode auto` usa el semántico si el
embedder responde. Los datos viven en `engine/eval/golden/`, un `.jsonl` por dominio; su validación está en
`engine/src/recall/golden-corpus.ts` y su carga y medición en `engine/src/recall/golden.ts`. La puerta de CI
(`engine/tests/golden.test.ts`) exige que el modo léxico no baje del suelo por tipo de `floor.json` ni supere
`lexico_ajenas_max`, y que ningún marcador de ruido llegue al resultado. También comprueba el reparto del
corpus (doce dominios, 40 preguntas por dominio y los tipos esperados) y que `expect` o `evidence` no nombren
un id de pregunta; si el corpus no está, el test falla. Quien mejora el recall sube el suelo en el mismo PR.
No viaja en el paquete npm: se corre desde el repositorio.

Línea base del 2026-10-30 (tope 5, aciertos dentro del tope; caduca cuando cambia el corpus):

| Modo | Global | MRR | Paráfrasis | Episodio | Rasgo | Ajenas con algo | Recuerdos por pregunta |
|---|---|---|---|---|---|---|---|
| Léxico | 221/432 | 0,48 | 1/72 | 20/24 | 8/24 | 8/48 | 0,9 |
| Semántico (`embeddinggemma-2`, corte 0,65) | 368/432 | 0,80 | 64/72 | 0/24 | 0/24 | 11/48 | 4,8 |

Los dos ceros del semántico son el issue #154.

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
`gist` que empieza por `[noise] ` o `[pareto:l0] ` es un marcador de ruido: se carga, nunca se espera y nunca
se devuelve. Los tipos de pregunta son `literal`, `parafrasis`, `sinonimo`, `coloquial`, `sin_tildes`,
`errata`, `ingles`, `larga`, `clave`, `ambito`, `episodio`, `rasgo` y `ajena`.
