# misMEM — engine

Memoria persistente con consolidación biológica (3 capas) sobre SQLite + FTS5, expuesta como MCP server stdio.

## Filosofía

> "Uno no recuerda exactamente lo que pasó ayer o hace 3 años, pero sí parte de eso."

La pérdida es **intencional y asimétrica**, como la memoria humana:

- **episodes** — verbatim, efímero. Lo crudo. TTL ~14-30d post-consolidación.
- **memories** — destilación con `salience` que decae si no se accede. Núcleo operativo.
- **traits** — patrones cristalizados. El **Soul Mirror** de Bardon. Permanente salvo borrado explícito.

## Invocaciones (5)

| Invocación    | Capa de origen → destino             | Quién decide  |
| ------------- | ------------------------------------ | ------------- |
| `capture`     | → episode                            | LLM (auto)    |
| `recall`      | episode + memory + trait → respuesta | LLM (auto)    |
| `consolidate` | N episodes → 1 memory                | LLM al cierre |
| `crystallize` | N memories → 1 trait                 | LLM o usuario |
| `forget`      | episodes/memories → ∅                | usuario       |

`recall` refuerza salience de memorias devueltas (Hebb).

## Scope

Un servidor por proyecto. Cada `scope` es un namespace lógico dentro del mismo .db. No hay cross-scope leakage en queries scoped.

## Dev

```powershell
cd engine
pnpm install
pnpm test
pnpm build
```

## Uso vía MCP (VS Code / Claude Code)

`mcp.json`:

```json
{
  "mcpServers": {
    "mismem": {
      "command": "node",
      "args": ["<ruta-al-repo>/misMEM/engine/dist/server.js"],
      "env": { "MISMEM_DB": "<home>/.mismem/mem.db" }
    }
  }
}
```

Default DB: `~/.mismem/mem.db` (configurable con `MISMEM_DB`).

## Roadmap

- [x] Fase 0: schema + 5 invocaciones + tests + MCP stdio
- [x] Fase 1: ingesta de exports (ChatGPT, transcripts VS Code) como semilla
- [x] Fase 2: servidor Streamable HTTP + capa engram-compat + deploy en VPS
- [x] Fase 3: consolidación LLM (episodes → memories vía OpenRouter) + pre-filtro Pareto
- [x] Fase 4: viewer read-only (`/viewer`) + CLIs (`mismem-stats`, `mismem-forget`, `mismem-migrate-engram`)
- [ ] Fase 5: embeddings (sqlite-vec + Ollama nomic-embed-text)
- [ ] Fase 6: binario empaquetado (bun --compile) + onboarding
