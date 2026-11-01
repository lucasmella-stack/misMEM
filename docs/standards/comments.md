# Comentarios

Un comentario explica **por qué** existe el código: la restricción, el motivo, lo que se descartó. Si repite lo
que ya dice la línea de debajo, se borra. Lo que se puede medir lo comprueba
[`engine/tests/comments.test.ts`](../../engine/tests/comments.test.ts): la cabecera, la longitud de bloque, el
idioma, `TODO` sin issue, código comentado y `biome-ignore` con motivo. La longitud del JSDoc y el porqué de
cada comentario son revisión.

## 1. Idioma

Todo comentario de `engine/src`, `engine/ui/src` y `engine/tests` va en inglés, sin mezclar idiomas en el mismo
fichero. Lo que lee el usuario (errores, logs, ayuda de los CLI, interfaz) y las descripciones de `it()` y
`describe()` siguen en castellano.

Bien:

```ts
// Below one top RRF slot (1/61 - 1/62 ≈ 0.00026), so salience only breaks ties there;
// lower down the slots shrink and a high salience can move two or three places.
const SALIENCE_RRF_WEIGHT = 0.0002;
```

Mal:

```ts
// Menor que un puesto de RRF en la cima: la saliencia desempata.
const SALIENCE_RRF_WEIGHT = 0.0002;
```

## 2. Cabecera de módulo

Es opcional. Si existe, ocupa tres líneas como mucho y dice qué posee el módulo y la restricción que lo obliga.
Nunca lleva un inventario (endpoints, variables de entorno, funciones, mapeos): eso vive en el código, en
[`DEPLOY.md`](../../DEPLOY.md) o en [`docs/`](../README.md).

Bien:

```ts
// Owns the FTS5 query syntax: what a question becomes before it reaches SQL.
// Kept apart from recall so the bench and the service cannot drift.
```

Mal:

```ts
// Endpoints (misma auth y mismo filtro de Host que el resto de /api):
// GET /api/scopes
// GET /api/memories
// GET /api/traits
// GET /api/graph
```

## 3. Cualquier otro bloque

Cinco líneas seguidas como mucho, cuenten `//` o un `/* */`. Una calibración, una tabla de medidas o un
razonamiento largo van a `docs/` (por ejemplo [`docs/recall.md`](../recall.md)) y el comentario enlaza.

Bien:

```ts
// The measured thresholds and why they moved: docs/recall.md#el-rescate.
const RESCUE_MIN_TERMS = 2;
```

Mal:

```ts
// Probé con 1, 2 y 3 términos sobre 40 preguntas:
// 1 término: MRR 0.31
// 2 términos: MRR 0.44
// 3 términos: MRR 0.45
// 4 términos: MRR 0.45
// con 5 volvía el ruido
const RESCUE_MIN_TERMS = 2;
```

## 4. JSDoc

Sólo si la firma no dice el contrato, y en una o dos líneas. Si el nombre y los tipos ya lo dicen, sobra.

Bien:

```ts
/** Opens the file read-only and checks that the misMEM tables exist, so openDb never migrates a foreign database. */
export function isMismemDb(path: string): boolean
```

Mal:

```ts
/**
 * Abre la base de datos.
 * @param path la ruta
 * @returns si es una base de misMEM
 */
export function isMismemDb(path: string): boolean
```

## 5. Prohibido

- Código comentado. Se borra: git lo recuerda.
- Historia y notas de PR ("antes", "used to", "before the extraction", "as it was"). El porqué de un cambio va
  en el commit y en el [`CHANGELOG.md`](../../CHANGELOG.md).
- `TODO` y `FIXME` sin issue: `TODO(#123): ...`, o se abre el issue y se quita el comentario.
- Una supresión de Biome sin motivo: `// biome-ignore lint/...: <motivo>`. `biome.json` es JSON estricto y no
  admite comentarios, así que el porqué de una regla desactivada va en el `CHANGELOG.md`.

Bien:

```ts
// TODO(#123): drop this once the viewer compiles its own manifest.
// biome-ignore lint/suspicious/noExplicitAny: the SDK types the error as unknown.
```

Mal:

```ts
// TODO: arreglar esto
// biome-ignore lint/suspicious/noExplicitAny
```

## Cómo se comprueba

`engine/tests/comments.test.ts` recorre `engine/src`, `engine/ui/src` (sin `components/ui`, que es shadcn) y
`engine/tests`, extrae los comentarios y aplica seis reglas, cada una con su etiqueta: `header` (tres líneas
para el primer grupo antes del primer statement), `block` (cinco líneas consecutivas, mezclando `//` y
`/* */`), `lang` (castellano, ignorando URLs y texto entrecomillado), `todo` (sin issue), `dead` (código
comentado) y `sup` (`biome-ignore` sin motivo). El escáner es el mismo que usa
`engine/tests/architecture.test.ts` para quitar comentarios. Las excepciones son un
`Record<"ruta (regla)", { motivo, count }>` que se mantiene vacío. El test falla si aparece una violación nueva en
un fichero ya exceptuado (el número es parte de la clave), si sobra una excepción y si una excepción ya no
cubre su cuenta. Una excepción nueva se justifica en la revisión.
