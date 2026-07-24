# Copilot Instructions — misMEM

Sistema de memoria persistente con MCP (3 capas: episodes \u2192 memories \u2192 traits).

## Stack
- **Engine**: Node 22, TypeScript strict ESM, better-sqlite3, MCP SDK, Zod, FTS5
- **Tests**: Vitest. Correr `pnpm test` desde `engine/` antes de commitear
- **Build**: `pnpm build` (tsc \u2192 `dist/`)
- **Container**: `mismem-brain` (Alpine multi-arch), expone HTTP/SSE en `:3200`
- **Deploy**: Docker en un VPS detrás de Traefik (ver `DEPLOY.md`)

## Convenciones de c\u00f3digo
- TypeScript estricto: nunca `any`, prefer\u00ed tipos expl\u00edcitos
- Validar todo input externo con Zod (ver `engine/src/schema.ts`)
- Funciones puras + DI para testabilidad (ej. `distillFn` en `consolidation/run.ts`)
- ESM: imports con extensi\u00f3n `.js` aunque el archivo sea `.ts`
- IDs: ULID (libreria `ulid`)
- DB: better-sqlite3 sincr\u00f3nico, todo dentro de `db.transaction(() => ...)`
- Comentarios solo PARA QU\u00c9, nunca QU\u00c9
- Nombres y c\u00f3digo en ingl\u00e9s; mensajes de log/UI en espa\u00f1ol

## Esquema (resumen)
- `episodes(id, scope, body, created_at, consolidated_into)` — verbatim, body NO `text`
- `memories(id, scope, gist, details, source_episode_ids JSON, salience, created_at, last_accessed_at)`
- `traits(id, scope, name, evidence_memory_ids JSON, strength, polarity, created_at, updated_at)`
- FTS5 virtual: `episodes_fts(body)`, `memories_fts(gist, details)`, `traits_fts(name)`

## MCP tools (en `engine/src/tools.ts`)
- `capture(scope, body)` \u2192 inserta episode
- `recall(query, scope?, limit?)` \u2192 ranking traits>memories>episodes + Hebbian salience refresh
- `consolidate(scope, gist, details?, source_episode_ids[])` \u2192 crea memory + marca episodes
- `crystallize(scope, name, evidence_memory_ids[], polarity?)` \u2192 crea trait
- `forget(scope?, ttl_days?, salience_threshold?)` \u2192 purga episodes consolidados + memories de baja salience

## Reglas de seguridad
- **NUNCA** leer/editar `.env*`. Tampoco mostrar secrets en respuestas
- **NUNCA** ejecutar `git push --force`, `git reset --hard`, `Remove-Item -Recurse` sin pedir
- **NUNCA** modificar `schema.ts` sin migration plan (rompe DB en producci\u00f3n)
- Validar inputs en bordes (Zod en MCP handlers, ya hecho)

## Flujo de trabajo t\u00edpico
1. Cambio en `engine/src/...`
2. `pnpm typecheck` + `pnpm test` (todo verde)
3. Commit con conventional: `feat:`, `fix:`, `test:`, `refactor:`, `chore:`
4. Si toca producci\u00f3n: rebuild imagen, redeploy, smoke test contra el endpoint HTTPS

## Backups
- Daily 3 AM (Windows Task Scheduler `misMEM-DailyBackup`) v\u00eda `scripts/backup-mismem-from-server.ps1`
- VACUUM INTO + scp \u2192 `~/.mismem/backups/mem-<timestamp>.db`, retiene 14 \u00faltimos

## Consolidaci\u00f3n LLM (4 AM diario)
- `mismem-consolidate` CLI \u2192 destila episodes pendientes via OpenRouter (DeepSeek V3 default)
- Ver `engine/src/consolidation/README.md` para detalles
- Idempotente (`WHERE consolidated_into IS NULL`)

## Anti-patterns
- `any` en TypeScript
- Comparar contra `text` (no existe; el campo es `body`)
- Pasar `null` donde Zod espera `string|undefined`
- Acceder a `db` fuera de transacci\u00f3n para writes m\u00faltiples
- Hardcodear scope (siempre par\u00e1metro)

## Engram protocol (memoria persistente)
Este repo se usa con su propio MCP server (mismem). Cuando un agente trabaje aqu\u00ed:
- Tras decisiones/bugfixes/discoveries: invocar `mem_save` (scope: `mismem`)
- Al inicio de sesi\u00f3n sobre temas previos: `mem_search` antes de responder
- Al cerrar sesi\u00f3n: `mem_session_summary` obligatorio
