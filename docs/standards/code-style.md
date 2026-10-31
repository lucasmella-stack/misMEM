# Estilo de código

Las convenciones de lenguaje, idioma, CLI, formato y esquema están en
[`AGENTS.md`](../../AGENTS.md#convenciones-que-el-código-no-deja-ver) y no se repiten aquí. Esto es lo que
`AGENTS.md` no dice.

## Ficheros

- Minúsculas con guiones: `server-http.ts`, `migrate-engram-cli.ts`.
- Un fichero que supera con claridad su responsabilidad se parte por responsabilidades, no por tamaño.

## Lint y dependencias

- Una regla de Biome desactivada se justifica en el `CHANGELOG.md` ([Comentarios](comments.md)).
- `pnpm knip` falla con ficheros, exports y dependencias sin uso: no se deja código por si acaso.
- `pnpm dup` falla ante cualquier bloque copiado de 10 líneas o más (umbral 0): se extrae, no se pega.
- Una dependencia nueva se justifica en el PR y entra con versión exacta ([Seguridad](security.md)).
