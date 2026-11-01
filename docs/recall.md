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

## Qué devuelve

Una búsqueda con resultados responde `{ hits }`: los traits primero, después las memories y después los
episodes, cada uno con su capa, su ámbito, la fecha UTC y `truncated` cuando un texto se recortó (2.000
caracteres de `text`, 1.200 de `details`). Un hit `truncated` se lee entero con `mem_get_observation` y su id.

Una búsqueda sin resultados añade dos campos, tanto en `recall` como en el alias `mem_search`,
porque un ámbito mal escrito y una memoria vacía se parecen demasiado:

- `scopes`: los ámbitos que sí tienen memorias, rasgos o episodios pendientes, de más a menos contenido y
  como mucho 20. Los marcadores de ruido no cuentan.
- `hint`: sólo cuando se pidió un `scope`. Dice que ese ámbito no tiene nada que coincida, y que se repita la
  búsqueda sin él o con otro de los de `scopes`.

Con resultados la respuesta no cambia: no lleva `scopes` ni `hint`.

## Medirlo

`mismem-bench` informa la posición del acierto (MRR, 1ª, entre las 3), los recuerdos devueltos por
pregunta y `noiseHits` (marcadores que se escaparon: tiene que ser 0). Se corre antes y después de tocar
`recall/` o `embeddings/`. El banco de preguntas es privado y sale de la propia memoria.
Cómo usarlo en un servidor: [DEPLOY.md](../DEPLOY.md#medir-el-recall).
