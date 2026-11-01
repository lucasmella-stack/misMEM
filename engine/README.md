# misMEM

Memoria persistente cooperativa para LLMs, expuesta como servidor MCP. Tres capas (episodes, memories,
traits) sobre una sola base SQLite con FTS5, que comparten todos los clientes que hablen MCP.

## Uso

En la configuración MCP de cualquier cliente (opencode, Claude Code, Codex, Cursor, VS Code...), sin clonar
nada. El fichero, la clave y la forma cambian de uno a otro; éste es el de los que usan `mcpServers` en JSON:

```json
{
  "mcpServers": {
    "mismem": {
      "command": "npx",
      "args": ["-y", "@lucasmella/mismem"]
    }
  }
}
```

La base se crea sola en el primer uso: `~/.mismem/mem.db`, o la ruta de `MISMEM_DB`. Requiere Node 22 o
superior. Con un checkout del repositorio, la configuración apunta al `dist` compilado:

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

## Las seis invocaciones

| Invocación | Qué hace | Quién decide |
|---|---|---|
| `capture` | Inscribe un episode en un `scope` | el LLM |
| `recall` | Busca en traits, memories y episodes; refuerza lo devuelto salvo `reinforce: false` | el LLM |
| `reinforce` | Marca los recuerdos que una respuesta usó de verdad | un hook o el LLM |
| `consolidate` | Espesa N episodes en 1 memory | el LLM al cierre |
| `crystallize` | Fija N memories como 1 trait | el LLM o el usuario |
| `forget` | Borra episodes consolidados y memories de baja saliencia; simula por defecto | el usuario |

Además, la capa de compatibilidad con Engram (`mem_save`, `mem_search`, `mem_context`, ...).

El paquete instala también los binarios `mismem-http`, `mismem-ingest`, `mismem-consolidate`,
`mismem-forget`, `mismem-stats`, `mismem-embed`, `mismem-migrate-engram`, `mismem-bench`, `mismem-obsidian`,
`mismem-inject` y `mismem-used`. Qué hace cada uno: [Arquitectura](https://github.com/lucasmella-stack/misMEM/blob/main/docs/architecture.md#componentes).

## Más

Este README viaja dentro del paquete npm, así que los enlaces apuntan al repositorio.

- [Arquitectura](https://github.com/lucasmella-stack/misMEM/blob/main/docs/architecture.md): capas, componentes, saliencia y olvido.
- [Cómo busca recall](https://github.com/lucasmella-stack/misMEM/blob/main/docs/recall.md) y [hooks del cliente](https://github.com/lucasmella-stack/misMEM/blob/main/docs/hooks.md).
- [DEPLOY.md](https://github.com/lucasmella-stack/misMEM/blob/main/DEPLOY.md): servidor HTTP en Docker y la [tabla única de variables de entorno](https://github.com/lucasmella-stack/misMEM/blob/main/DEPLOY.md#variables-de-entorno-referencia-única).
- [CONTRIBUTING.md](https://github.com/lucasmella-stack/misMEM/blob/main/CONTRIBUTING.md) para desarrollar y [CHANGELOG.md](https://github.com/lucasmella-stack/misMEM/blob/main/CHANGELOG.md) para la historia.
