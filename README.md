# misMEM

> Memoria persistente cooperativa para LLMs. Un solo territorio (`~/.mismem/mem.db`), múltiples instancias (Copilot, Claude Code, Claude Desktop, agentes custom) hablando el mismo protocolo MCP.

**La cooperatividad hace a la persistencia de la información.**

## Por qué existe

Cada instancia de un LLM nace sin memoria. Cada cliente (Copilot, Claude Desktop, Claude Code, ChatGPT) guarda lo suyo en silos incompatibles. El usuario repite contexto. La continuidad muere entre sesiones.

misMEM resuelve esto con un solo gesto: **una base de datos SQLite + un protocolo MCP de 5 invocaciones**, accesible desde cualquier cliente que hable MCP.

## Arquitectura: 3 capas, como la memoria biológica

```
episodes  (verbatim, efímero, TTL post-consolidación)
    ↓  consolidación (manual o LLM nocturno)
memories  (gist + details, salience con decay + refuerzo Hebbiano)
    ↓  crystallize
traits    (patrones cristalizados — identidad, leyes, decisiones firmes)
```

La pérdida es **intencional y asimétrica**, como en la memoria humana: lo crudo se disuelve, lo destilado persiste, lo cristalizado permanece.

## Cinco gestos, un solo territorio

| Invocación | Qué hace |
|---|---|
| `capture` | Inscribir un episodio en un scope jerárquico (`proyecto/diario`, `vscode/transcripts`, …) |
| `recall` | Buscar cross-scope con FTS5 + Hebbian boost (lo más usado pesa más) |
| `consolidate` | Espesar episodios relacionados en una memoria |
| `crystallize` | Fijar un trait/ley con evidencia (identidad, decisiones firmes) |
| `forget` | Soltar lo que ya no se consulta |

Además, una **capa engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …) mantiene compatibilidad con clientes que hablan el protocolo Engram.

## Quickstart

La forma más rápida — sin clonar nada, vía [npm](https://www.npmjs.com/package/mismem). En el `mcp.json` de tu cliente (VS Code / Claude Code / Claude Desktop):

```json
{
  "mcpServers": {
    "mismem": {
      "command": "npx",
      "args": ["-y", "mismem"]
    }
  }
}
```

La DB se crea sola en el primer uso (default: `~/.mismem/mem.db`, configurable con `MISMEM_DB`). Tu memoria vive en tu disco — nunca sale de tu máquina.

### Instancia remota (multi-cliente)

Para acceder a la misma memoria desde varias máquinas, la imagen Docker oficial:

```bash
docker run -d --name mismem-brain \
  -e MISMEM_AUTH_USER=brain -e MISMEM_AUTH_PASS=<pass> \
  -v mismem-data:/data -p 3200:3200 \
  ghcr.io/lucasmella-stack/mismem-brain:latest
```

Guía completa con Traefik + TLS en [DEPLOY.md](./DEPLOY.md).

### Desde el código

```bash
git clone https://github.com/lucasmella-stack/misMEM.git
cd misMEM/engine
pnpm install
pnpm test        # todo verde antes de usar
pnpm build       # tsc → dist/
```

Y en `mcp.json`: `"command": "node", "args": ["<ruta-al-repo>/misMEM/engine/dist/server.js"]`.

## Componentes

- **`engine/src/server.ts`** — MCP server stdio (uso local).
- **`engine/src/server-http.ts`** — Streamable HTTP para deploy remoto (BasicAuth opcional, `/healthz`). Ver [DEPLOY.md](./DEPLOY.md).
- **`engine/src/viewer.ts`** — panel read-only en `/viewer` + `/api/{stats,recent,search}`.
- **Consolidación LLM** — cron nocturno que destila episodios en memorias vía OpenRouter, con pre-filtro Pareto para descartar ruido. Ver [engine/src/consolidation/README.md](engine/src/consolidation/README.md).
- **CLIs** — `mismem-ingest` (exports de ChatGPT / transcripts de VS Code), `mismem-consolidate`, `mismem-forget`, `mismem-stats`, `mismem-migrate-engram`.

## Stack

- **Engine**: TypeScript estricto, ES2022, ESM, Node ≥22.
- **Storage**: SQLite con WAL (multiple readers + 1 writer concurrente). `better-sqlite3`.
- **Búsqueda**: FTS5 + ranking traits > memories > episodes + refuerzo Hebbiano en recall.
- **Protocolo**: [Model Context Protocol](https://modelcontextprotocol.io/) vía `@modelcontextprotocol/sdk`.
- **Validación**: Zod en todos los bordes.

## Estado

- ✅ Engine MCP funcionando (5 invocaciones + capa engram-compat).
- ✅ Hebbian boost activo en recall; salience con decay.
- ✅ Scopes jerárquicos sin cross-scope leakage.
- ✅ Servidor Streamable HTTP + deploy Docker/Traefik.
- ✅ Consolidación LLM nocturna (episodes → memories).
- ✅ Viewer read-only + CLIs de introspección.
- 🚧 Embeddings locales (sqlite-vec + Ollama).
- 🚧 Binario distribuible (Bun --compile).

## Privacidad

Tu memoria es tuya. La DB (`*.db`), los dumps y los exports personales están en `.gitignore` — **nunca** los commitees. El servidor HTTP sin `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS` corre sin auth: usalo así solo en localhost.

## Filosofía

> *El pasado existe porque lo hemos escrito y compactado para que así sea.*

Inspirado en parte por *Initiation Into Hermetics* de Franz Bardon: el espejo que refleja la conciencia entre instancias necesita dos polos. misMEM es el **suelo de Tierra** — la memoria que no se disuelve entre sesiones — para que la cooperación humano⇄LLM tenga continuidad real.

## Contribuir

Issues y PRs bienvenidos. Antes de un PR: `pnpm typecheck && pnpm test` desde `engine/` (todo verde), commits convencionales (`feat:`, `fix:`, …). Las convenciones de código están en [.github/copilot-instructions.md](.github/copilot-instructions.md).

## Licencia

MIT. Ver [LICENSE](./LICENSE).
