# Cómo busca recall

`recall` pone traits, memories y episodes en un solo ranking: las tres capas compiten por la misma plaza con
RRF. Cada señal aporta `peso / (60 + puesto)` y un recuerdo que encuentran varias señales sube; ninguna capa
conserva un escalón fijo. La saliencia sólo desempata entre memories. Las constantes están en
`engine/src/search.ts` y las variables, en la tabla de [DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Por palabras (siempre)

FTS5 exige que estén **todas** las palabras de la consulta, sin contar las vacías ("qué", "sobre", "the"...).

### El rescate

Si esa consulta estricta no devuelve nada y no hay capa semántica, `recall` reintenta con una consulta OR
sobre las mismas palabras menos un relleno más amplio: la estricta conserva las palabras de función que un
recuerdo puede contener, y el rescate ignora además verbos y adverbios coloquiales ("podemos", "antes", "cada",
"todo"). Antes de puntuar descarta las palabras que no aparecen en ningún candidato: en una pregunta larga
suelen ser contexto ("ayer", "oye") y antes contaban para exigir el 30 % de la frase entera. Conserva los
candidatos que comparten al menos dos términos, uno de ellos informativo (los que aparecen en el 5 % de memorias
más raras, con un mínimo de tres, o en todas); con una sola palabra de consulta basta una. Si las palabras
presentes no llegan al 30 % de las palabras de contenido de la consulta entera, antes del tope de doce términos
del rescate, no hay rescate: la pregunta habla de otra cosa. Los candidatos se ordenan por la suma de IDF de los
términos que comparten, y después por términos informativos y coincidencias. Devuelve hasta 3 por capa. El
rescate alcanza a rasgos, episodios y memorias, y no altera una búsqueda que ya encontró algo.

## Por significado (opcional)

Con un servidor de embeddings corriendo, `recall` suma búsqueda por significado: "problemas de plata"
encuentra memorias que dicen "deudas". El valor por defecto es Ollama (`ollama pull nomic-embed-text`), un modelo pensado para inglés.
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
episodios desplazaban a la memoria concreta que responde. El modo léxico, sin vectores, no aplica el tope. Backfill y reindexado: `mismem-embed`
(`--status`, `--force`), que recorre memorias, rasgos y episodios pendientes.

También habla con cualquier servidor compatible con OpenAI (`/v1/embeddings`, por ejemplo
`llama-server --embedding`). **Si tus memorias no están en inglés, usa EmbeddingGemma 2**: con memorias en
castellano encontró 34 de 50 paráfrasis frente a 4 de 50 de `nomic-embed-text` (medido en la issue #72), y
en CPU no gasta VRAM. Va con sus prefijos; su corte por defecto es 0,65 (la línea de abajo sólo lo hace
explícito):

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
palabras, no cuando la dice de otra forma.

Con EmbeddingGemma 2 el corte por defecto también es 0,65: en el golden eval, con 0,5 las 48 preguntas
ajenas traían 5 recuerdos cada una; con 0,65 sólo 11 traen algo y no se pierde ningún acierto, y con 0,66
ya se pierde uno (medido el 2026-10-30, issue #158). Un `MISMEM_EMBEDDING_MIN_SCORE` explícito gana siempre.

La búsqueda sólo compara vectores del modelo configurado. Cambiar de modelo reindexa solo en el siguiente
backfill (`mismem-embed`); cambiar un prefijo no se detecta y exige `mismem-embed --force`. Todas las
variables, con sus defaults, están en
[DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Medirlo

`mismem-bench` informa la posición del acierto (MRR, 1ª, entre las 3), los recuerdos devueltos por
pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0). Se corre antes y después de tocar
`tools.ts`, `search.ts` o `embeddings/`. El banco de preguntas es privado y sale de la propia memoria.
Cómo usarlo en un servidor: [DEPLOY.md](../DEPLOY.md#medir-el-recall).

El eval dorado (`pnpm eval`) mide lo mismo sobre un corpus sintético y público en castellano: una persona ficticia en doce
dominios. Sirve para comparar entre máquinas y para subir el suelo en CI. Desde `engine/`:

```bash
pnpm eval --mode lexico
node dist/eval-cli.js --mode semantico
```

El segundo exige `pnpm build` y las variables `MISMEM_EMBEDDING_*` del servidor de embeddings
([DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única)); `--mode auto` usa el semántico si el
embedder responde. Los datos viven en `engine/eval/golden/`, un `.jsonl` por dominio, y el formato y los
tipos de pregunta están en la cabecera de [`engine/src/golden.ts`](../engine/src/golden.ts). La puerta de CI
(`engine/tests/golden.test.ts`) exige que el modo léxico no baje del suelo por tipo de `floor.json` ni supere
`lexico_ajenas_max`, y que ningún marcador de ruido llegue al resultado. También comprueba el reparto del
corpus (doce dominios, 40 preguntas por dominio y los tipos esperados) y que `expect` o `evidence` no nombren
un id de pregunta; si el corpus no está, el test falla. Quien mejora el recall sube el suelo en el mismo PR.
No viaja en el paquete npm: se corre desde el repositorio.

Línea base del 2026-10-30 (tope 5, aciertos dentro del tope; caduca cuando cambia el corpus):

| Modo | Global | MRR | Paráfrasis | Episodio | Rasgo | Ajenas con algo | Recuerdos por pregunta |
|---|---|---|---|---|---|---|---|
| Léxico | 253/432 | 0,54 | 2/72 | 21/24 | 9/24 | 8/48 | 1,63 |
| Semántico (`embeddinggemma-2`, corte 0,65) | 411/432 | 0,87 | 64/72 | 23/24 | 19/24 | 11/48 | 4,87 |

En el semántico, las tres capas compiten en el mismo ranking: rasgos y episodios pendientes pasan de 0/24 a
19/24 y 23/24. El acierto en primera posición es 355/432 y el de las preguntas que esperan una memoria,
328/384, frente a 329/384 de la línea base sin vectores de capa. El episodio que sigue sin aparecer (`dev-q33`) no es un fallo del ranking: su texto no dice
"Lucía", que está sólo en el ámbito, y otro episodio parecido puntúa algo más alto.
