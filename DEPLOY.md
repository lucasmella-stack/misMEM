# misMEM — Despliegue en producción

Guía para correr `mismem-brain` (el servidor MCP HTTP de misMEM) en un VPS con
Docker detrás de Traefik. Reemplazá `mem.example.com` por tu dominio.

---

## Arquitectura

```
Cliente MCP (VS Code / Claude Code / Claude Desktop / agente)
        │  HTTPS + BasicAuth
        ▼
   Traefik (TLS via ACME)
        │
        ▼
 mismem-brain :3200  ──  SQLite en volumen `mismem-data`
```

- Transporte: **Streamable HTTP** (stateless: server+transport por request).
- Auth: BasicAuth (en Traefik como middleware, o nativa del server vía
  `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS`).

---

## Pre-requisitos

- [ ] VPS con Docker + Docker Compose y Traefik ya funcionando (ACME configurado)
- [ ] DNS: A record de `mem.example.com` → IP del servidor
- [ ] Build local OK (`pnpm build`, `pnpm test`)

---

## Fase 1 — Obtener la imagen

Opción A — imagen oficial multi-arch desde GHCR (recomendada):

```bash
docker pull ghcr.io/lucasmella-stack/mismem-brain:latest
```

Opción B — build en el servidor (arquitectura nativa):

```bash
ssh <tu-servidor>
git clone https://github.com/lucasmella-stack/misMEM.git mismem
cd mismem/engine
docker build -t mismem-brain:latest -f Dockerfile.mismem-brain .
```

---

## Fase 2 — Servicio en `docker-compose.yml`

```yaml
  mismem-brain:
    image: ghcr.io/lucasmella-stack/mismem-brain:latest
    container_name: mismem-brain
    restart: unless-stopped
    environment:
      MISMEM_HTTP_PORT: 3200
      MISMEM_HTTP_HOST: 0.0.0.0
      MISMEM_DB: /data/mem.db
      MISMEM_AUTH_USER: ${MISMEM_BRAIN_USER}
      MISMEM_AUTH_PASS: ${MISMEM_BRAIN_PASS}
    volumes:
      - mismem-data:/data
    networks:
      - traefik-network
    labels:
      traefik.enable: "true"
      traefik.docker.network: "traefik-network"
      traefik.http.routers.mismem.rule: "Host(`mem.example.com`)"
      traefik.http.routers.mismem.entrypoints: "websecure"
      traefik.http.routers.mismem.tls.certresolver: "le"
      traefik.http.services.mismem.loadbalancer.server.port: "3200"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3200/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  mismem-data:
```

Y en el `.env` del compose (NUNCA en git):

```env
MISMEM_BRAIN_USER=brain
MISMEM_BRAIN_PASS=<generar con: openssl rand -hex 24>
```

Levantar y validar:

```bash
docker compose up -d mismem-brain
docker logs -f mismem-brain     # esperar "misMEM HTTP listening on …"

curl -s https://mem.example.com/healthz
# {"status":"ok","service":"mismem"}

curl -s -u brain:$MISMEM_BRAIN_PASS https://mem.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

> Recomendado: añadir un middleware de rate-limit en Traefik
> (`ratelimit.average=10`, `burst=30`, `period=1s`).

---

## Fase 3 — Sembrar la DB (opcional)

Si querés llevar tu memoria local al servidor:

```bash
scp ~/.mismem/mem.db <tu-servidor>:/tmp/mem.db
ssh <tu-servidor>
docker stop mismem-brain
docker run --rm -v mismem-data:/data -v /tmp:/in alpine \
  sh -c "cp /in/mem.db /data/mem.db && chown 1000:1000 /data/mem.db"
docker start mismem-brain
docker logs --tail 20 mismem-brain
```

Alternativa: exportar desde otra fuente a JSONL e ingestar con
`node dist/ingest-cli.js` (soporta exports de ChatGPT y transcripts de VS Code).

---

## Fase 4 — Conectar clientes

### VS Code / Claude Code (`mcp.json`)

```json
"mismem": {
  "type": "http",
  "url": "https://mem.example.com/mcp",
  "headers": {
    "Authorization": "Basic <base64(user:pass)>"
  }
}
```

### Clientes que solo hablan stdio

```json
"mismem": {
  "command": "npx",
  "args": ["-y", "supergateway", "--streamableHttp",
           "https://mem.example.com/mcp",
           "--header", "Authorization: Basic <base64(user:pass)>"]
}
```

---

## Backups

- Diario vía `scripts/backup-mismem-from-server.ps1` (Windows Task Scheduler)
  o el equivalente cron en Linux.
- Estrategia: `VACUUM INTO` dentro del contenedor (consistente con WAL) + `scp`
  → retiene los últimos 14 snapshots.

## Consolidación LLM (opcional)

Cron diario que destila episodios en memorias vía OpenRouter.
Ver [engine/src/consolidation/README.md](engine/src/consolidation/README.md).

---

## Variables de entorno (resumen)

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_HTTP_PORT` | `3200` | Puerto HTTP |
| `MISMEM_HTTP_HOST` | `0.0.0.0` | Bind address |
| `MISMEM_DB` | `~/.mismem/mem.db` (host) o `/data/mem.db` (contenedor) | Ruta SQLite |
| `MISMEM_AUTH_USER` | `—` | BasicAuth user (si vacío, sin auth) |
| `MISMEM_AUTH_PASS` | `—` | BasicAuth pass |

---

## Checklist final

- [ ] DNS resuelve al servidor
- [ ] `mismem-brain` UP y `healthz` OK
- [ ] Cert TLS de Traefik emitido
- [ ] `tools/list` responde vía HTTPS con auth
- [ ] Backup diario programado y probado
