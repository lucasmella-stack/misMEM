<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.webp">
    <img alt="misMEM" src="docs/assets/logo.webp" width="200">
  </picture>
</p>

<h1 align="center">misMEM</h1>

<p align="center">
  <strong>Memoria persistente cooperativa para LLMs.</strong><br>
  Una SQLite, un protocolo MCP, todos tus clientes.
</p>

<p align="center">
  <a href="https://github.com/lucasmella-stack/misMEM/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lucasmella-stack/misMEM/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/lucasmella-stack/misMEM/releases/latest"><img alt="Última release" src="https://img.shields.io/github/v/release/lucasmella-stack/misMEM"></a>
  <a href="LICENSE"><img alt="Licencia MIT" src="https://img.shields.io/github/license/lucasmella-stack/misMEM"></a>
  <a href="engine/package.json"><img alt="Node 22 o superior" src="https://img.shields.io/node/v/@lucasmella/mismem"></a>
</p>

## Qué es y por qué

Cada instancia de un LLM nace sin memoria, y cada herramienta (Claude Code, Codex, Cursor, VS Code,
opencode...) guarda lo suyo en silos incompatibles: hay que repetir el contexto y la continuidad muere entre
sesiones. misMEM lo resuelve con **una base SQLite (`~/.mismem/mem.db`) y un protocolo MCP de seis
invocaciones**, accesible desde cualquier cliente que hable MCP. *La cooperatividad hace a la persistencia
de la información.*

La memoria tiene tres capas, como la biológica, y la pérdida es intencional: lo crudo se disuelve, lo
destilado persiste, lo cristalizado permanece.

```mermaid
flowchart LR
    C["Cualquier cliente MCP<br/>Claude Code, Codex, Cursor,<br/>VS Code, opencode..."]

    subgraph E["engine (Node 22)"]
        S["server.ts<br/>MCP por stdio"]
        H["server-http.ts<br/>MCP por HTTP y visor, :3200"]
    end

    subgraph D["SQLite (mem.db)"]
        EP["episodes<br/>texto literal"] -->|consolidación| ME["memories<br/>gist, saliencia"] -->|crystallize| TR["traits<br/>patrones estables"]
    end

    N["Consolidación nocturna<br/>mismem-consolidate"]
    L["LLM<br/>cualquiera con API compatible con OpenAI"]
    V["Servidor de embeddings<br/>cualquier modelo, por /v1/embeddings"]

    C -->|stdio| S
    C -->|HTTP| H
    S --> D
    H --> D
    N -->|episodios pendientes| L
    L -->|memorias destiladas| N
    N --> D
    V -.->|vectores, opcional| E
```

## Quickstart

### Linux: un script lo configura todo

```bash
git clone https://github.com/lucasmella-stack/misMEM.git && bash misMEM/scripts/install.sh
```

Instala misMEM desde el repo clonado, pregunta dónde guardar la memoria y con qué proveedor consolidar
(DeepSeek, OpenRouter, OpenAI, un servidor compatible o ninguno), guarda la clave en
`~/.config/mismem/env` con permisos 600 y configura los clientes MCP que encuentra en la máquina (en Claude
Code, también los hooks de inyección y refuerzo; `--help` da la lista). Para la búsqueda por significado
deja montado un servidor de embeddings local si hay `llama-server`; el modelo se cambia con dos variables
([cómo](docs/recall.md#por-significado-opcional)). Si se quiere, deja la consolidación nocturna como timer de
systemd. Los clientes llaman a
`~/.local/bin/mismem-run`, así que ninguna clave queda en su configuración. Volver a ejecutarlo actualiza
sin duplicar, y no pisa a ciegas una configuración de misMEM hecha a mano: los hooks de Claude Code que
ya estén configurados de otra forma y un MCP `mismem` de opencode con otro comando se respetan, y este
último sólo se reemplaza con `REPLACE_EXISTING=yes`. `--from-npm` instala el paquete publicado, que puede ir por detrás del repo; `--help` explica
el modo sin preguntas (`--yes`, `--clients`, `--timer`, `--embeddings`).

### Docker: un servidor para varias máquinas

```bash
docker run -d --name mismem-brain \
  -e MISMEM_AUTH_USER=brain -e MISMEM_AUTH_PASS=<contraseña> \
  -v mismem-data:/data -p 127.0.0.1:3200:3200 \
  ghcr.io/lucasmella-stack/mismem-brain:latest
curl http://127.0.0.1:3200/healthz
```

Imagen multi-arch (`linux/amd64` y `linux/arm64`), sin clonar nada. El visor queda en `/viewer` y el MCP
en `/mcp`. Para exponerlo con Traefik y TLS, o para construirla en el servidor, ver
[DEPLOY.md](DEPLOY.md).

### npm: sin clonar nada

En la configuración MCP del cliente (el nombre del fichero y de la clave cambian de uno a otro):

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

La base se crea sola en el primer uso (`~/.mismem/mem.db`, configurable con `MISMEM_DB`) y no sale de la
máquina; las dos funciones opcionales que mandan texto afuera están en [Privacidad](#privacidad).

<details>
<summary>Desde el código</summary>

```bash
git clone https://github.com/lucasmella-stack/misMEM.git
cd misMEM/engine
pnpm install
pnpm test        # todo verde antes de usar
pnpm build       # compila a dist/
```

Y en `mcp.json`: `"command": "node", "args": ["<ruta-al-repo>/misMEM/engine/dist/server.js"]`.

</details>

## Qué incluye

| | Qué hace | Más |
|---|---|---|
| **Seis invocaciones** | `capture`, `recall`, `reinforce`, `consolidate`, `crystallize`, `forget`, más una capa de compatibilidad con Engram (`mem_save`, `mem_search`, ...) | [Arquitectura](docs/architecture.md#seis-invocaciones) |
| **Recall híbrido** | Palabras (FTS5) y significado (embeddings, opcional) fusionados por RRF; si el servidor de embeddings cae, sigue por palabras | [Recall](docs/recall.md) |
| **Saliencia con decay** | Lo que no se usa pierde la mitad cada 90 días; el refuerzo sigue el uso real, no la aparición | [Arquitectura](docs/architecture.md#saliencia-decay-y-olvido) |
| **Índice hebbiano** | Cuenta qué recuerdos se usaron juntos en el mismo turno | [Arquitectura](docs/architecture.md#el-índice-hebbiano) |
| **Ámbitos** | Un `scope` por proyecto o cliente dentro de la misma base; una búsqueda con ámbito no mezcla los demás | [Arquitectura](docs/architecture.md#un-territorio-varias-instancias) |
| **Consolidación nocturna** | Un LLM destila los episodios en memorias, con prefiltro de ruido | [Consolidación](engine/src/consolidation/README.md) |
| **Visor web** | Memorias por saliencia, rasgos, lo pendiente, el origen de cada recuerdo y el grafo; con acciones opcionales | [Arquitectura](docs/architecture.md#componentes) |
| **Hooks de cliente** | Adelantan recuerdos antes de responder y refuerzan los que se usaron | [Hooks](docs/hooks.md) |
| **Ingesta y exportación** | Exports de ChatGPT, transcripts de VS Code, migración desde Engram, bóveda de Obsidian | [Arquitectura](docs/architecture.md#componentes) |
| **Servidor remoto** | MCP por Streamable HTTP con BasicAuth, guarda de `Host` y límite de cuerpo | [DEPLOY.md](DEPLOY.md) |

## El visor

Capturas del visor (`/viewer`): el grafo entero con sus ajustes, y el grafo local alrededor de una
memoria con su detalle al costado.

<p align="center">
  <img alt="Visor: grafo de episodios, memorias y rasgos, con los ajustes del grafo abiertos" src="docs/assets/viewer-grafo.webp" width="48%">
  <img alt="Visor: grafo local alrededor de una memoria, con su detalle al costado" src="docs/assets/viewer-grafo-detalle.webp" width="48%">
</p>

## Documentación

| Para | Ir a |
|---|---|
| Operar un servidor, y todas las variables de entorno | [DEPLOY.md](DEPLOY.md) |
| Entender el motor | [docs/architecture.md](docs/architecture.md), [docs/recall.md](docs/recall.md), [docs/hooks.md](docs/hooks.md) |
| Contribuir | [CONTRIBUTING.md](CONTRIBUTING.md) y las [normas](docs/standards/README.md) |
| Convenciones para agentes | [AGENTS.md](AGENTS.md) |
| Qué cambió en cada versión | [CHANGELOG.md](CHANGELOG.md) |
| Reportar una vulnerabilidad | [SECURITY.md](SECURITY.md) |
| Qué documento es para quién | [docs/README.md](docs/README.md) |

## Privacidad

La memoria es de quien la usa. La base (`*.db`), los volcados y los exports personales están en
`.gitignore`: **nunca** se commitean. El servidor HTTP sin `MISMEM_AUTH_USER` y `MISMEM_AUTH_PASS` corre
sin autenticación: así sólo en localhost.

Dos funciones opcionales mandan texto fuera del proceso, y sólo si se configuran:

- **Búsqueda por significado**: el servidor de embeddings recibe el texto de cada memoria y de cada
  consulta. Conviene correrlo en la propia máquina o en la red interna.
- **Consolidación con LLM**: los episodios viajan textuales al proveedor configurado (DeepSeek,
  OpenRouter, OpenAI o cualquier servidor compatible). Sin su clave no corre, y apuntándola a un servidor
  de la propia red no sale nada.

## Contribuir

Los issues y los PR son bienvenidos. El punto de partida es [CONTRIBUTING.md](CONTRIBUTING.md): entorno,
flujo, formularios de issue y plantillas de PR.

## Gracias

misMEM lo arrancó una persona sola, pero no siguió así.
[**@iDiagoValeta**](https://github.com/iDiagoValeta) colaboró en su desarrollo de forma activa como muestra
de su amor y apoyo incondicional hacia el Open-Source.

## Licencia

MIT. Ver [LICENSE](LICENSE).
