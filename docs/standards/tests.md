# Tests

Vitest, desde `engine/`: `pnpm test`. El typecheck también cubre los tests (`pnpm typecheck` incluye
`tsconfig.test.json`), así que un test que no compila falla en CI.

| Dónde | Protege |
|---|---|
| `engine/tests/<área>.test.ts` | El comportamiento de `engine/src` y de la interfaz (`ui-*.test.ts`) |
| `engine/tests/fixtures/` | Exports de ChatGPT y de VS Code ficticios, para los importadores |
| `engine/tests/contribution-standard.test.ts` | Que formularios, plantillas, `release.yml` y `CONTRIBUTING.md` nombren sólo etiquetas declaradas |
| `engine/tests/golden.test.ts` | El suelo del eval dorado público: el modo léxico no baja de `floor.json`, no supera `lexico_ajenas_max` y no devuelve ruido |
| `mismem-bench` | La calidad del recall sobre la memoria real, con un banco privado; **no corre en CI** |
| `pnpm eval` | La calidad del recall sobre el corpus dorado público, reproducible en cualquier máquina |

## Reglas

- **Un cambio de comportamiento lleva un test que lo ejercita.** Un test que pasa con y sin el cambio es
  un falso verde: al escribirlo se comprueba que falla sin el cambio.
- **Nunca se debilita un assert** para que algo pase; se arregla la causa o se discute en el issue.
- **Sin red ni reloj real.** La base va en memoria (`openDb(":memory:")`) y las funciones que dependen del
  tiempo reciben el instante (`at`). Un servidor de embeddings o un LLM se sustituye por un doble
  (`distillFn` en `consolidation/run.ts` es el modelo).
- **Un fichero temporal se crea en un directorio propio y se borra al terminar.** Ningún test toca
  `~/.mismem`.
- **Un test no usa memorias reales.** Ni en los fixtures ni en las salidas guardadas.
- **Un cambio en el ranking del recall** (`tools.ts`, `search.ts`, `embeddings/`) se mide además con
  `mismem-bench` y `pnpm eval` antes y después, y las cifras van en el PR (etiqueta `needs-bench`).
  `mismem-bench` mide la memoria real con el banco privado; `pnpm eval` mide el corpus público y su suelo
  en `engine/eval/golden/floor.json`, que se sube en el mismo PR que mejora el recall.
- **Un bug se arregla con su test de regresión**, que falla antes del arreglo.

Antes de abrir un PR: `pnpm typecheck && pnpm test && pnpm knip && pnpm dup && pnpm lint && pnpm build`.
