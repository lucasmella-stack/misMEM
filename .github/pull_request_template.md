<!--
Plantilla por defecto: funcionalidad, corrección o refactor. Convenciones: CONTRIBUTING.md.
Orden: resumen en términos de producto, el issue, cómo se verificó.

Las otras plantillas no se ofrecen solas: GitHub sólo muestra la de por defecto. Se piden
añadiendo ?template=<nombre>.md a la URL de comparación:
  https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=release.md
  https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=dependency.md
  https://github.com/lucasmella-stack/misMEM/compare/main...<rama>?expand=1&template=documentation.md
-->
## Resumen

- Qué cambia, primero en términos de producto o de sistema; los símbolos, de apoyo.

## Issue

Closes #

## Etiquetas

<!-- labels:begin -->
Las del PR alimentan las notas de la release. Un tipo (`bug`, `enhancement`, `performance`,
`security`, `cleanup`, `research`), más `needs-bench` si cambia el ranking del recall o los embeddings,
y `breaking` si cambia un flag, una variable, una herramienta MCP o una respuesta HTTP.
<!-- labels:end -->

## Plan de pruebas

Desde `engine/`:

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm knip`
- [ ] `pnpm dup`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] Línea añadida en `CHANGELOG.md`, bajo "Sin publicar"
- [ ] Documentación actualizada en este mismo PR (la tabla de `DEPLOY.md` si cambia una variable)
- [ ] `mismem-bench` y `pnpm eval --mode lexico` antes y después, con las cifras abajo, si cambia el ranking del recall (`recall/`, `embeddings/`)
- [ ] Sin cambios en `engine/src/store/db.ts` sin plan de migración
