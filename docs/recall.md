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
encuentra memorias que dicen "deudas". El modelo por defecto es EmbeddingGemma 2, multilingüe, servido por
`llama-server` en `http://127.0.0.1:8080`. Si ese puerto ya lo ocupa otra cosa, el instalador monta el
servidor en el primero libre y escribe `MISMEM_EMBEDDING_URL`.
Los vectores se guardan como BLOB en la misma SQLite y la búsqueda es coseno en JS, sin extensiones
nativas. Si el servidor no responde, todo degrada silenciosamente a FTS5 puro.

La semántica cubre deliberadamente sólo `memories`; `episodes` y `traits` conservan búsqueda FTS5.
Backfill y reindexado: `mismem-embed` (`--status`, `--force`). Los vectores se normalizan a norma 1
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

La búsqueda sólo compara vectores del modelo configurado. Cambiar de modelo reindexa solo en el siguiente
backfill (`mismem-embed`); cambiar un prefijo no se detecta y exige `mismem-embed --force`. Todas las
variables, con sus defaults, están en
[DEPLOY.md](../DEPLOY.md#variables-de-entorno-referencia-única).

## Qué devuelve

Cada hit lleva `layer`, `id`, `scope`, su `text`, `created_at` tal cual lo guarda la base y, cuando la
búsqueda los trae, `salience` y `via`. El `recall` por MCP añade además:

- `date`: `created_at` como YYYY-MM-DD en UTC, para que el modelo lea una fecha y no un epoch. Se omite
  cuando el valor no es finito, cae fuera del rango de `Date` o su año no cabe en cuatro cifras (un epoch
  en microsegundos, por ejemplo).
- `details`: el detalle destilado de una memoria. Se omite cuando está vacío.
- `polarity`: la polaridad de un rasgo, `shadow` o `light`. Se omite cuando es `neutral`, porque la
  ausencia ya es el caso neutro.

Dos topes, en puntos de código y con los puntos suspensivos dentro del tope: 2.000 en `text` y 1.200 en
`details`. Cuando alguno se recorta, el hit lleva `truncated: true` sin decir cuál. La copia entera, que no
se recorta, se lee con `mem_get_observation` y el id del hit.

## Medirlo

`mismem-bench` informa la posición del acierto (MRR, 1ª, entre las 3), los recuerdos devueltos por
pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0). Se corre antes y después de tocar
`recall/` o `embeddings/`. El banco de preguntas es privado y sale de la propia memoria.
Cómo usarlo en un servidor: [DEPLOY.md](../DEPLOY.md#medir-el-recall).
