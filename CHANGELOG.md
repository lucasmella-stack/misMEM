# Changelog

## 0.1.0 — 2026-07-24

Primera versión pública. Historia condensada del desarrollo (abril–julio 2026):

### Núcleo (abril 2026)
- Engine MCP stdio con schema de 3 capas (`episodes` → `memories` → `traits`),
  las 5 invocaciones (`capture`, `recall`, `consolidate`, `crystallize`, `forget`),
  FTS5 + refuerzo Hebbiano en recall, scopes jerárquicos y suite de tests (Vitest).
- Servidor **Streamable HTTP** stateless (server+transport por request) con capa
  **engram-compat** (`mem_save`, `mem_search`, `mem_context`, `mem_session_*`, …)
  para clientes que hablan el protocolo Engram.
- Dockerfile multi-arch (`mismem-brain`, Alpine) + guía de deploy con Traefik
  (TLS, BasicAuth, healthcheck) y estrategia de backup diario
  (`VACUUM INTO` + scp, retención 14 días).
- Viewer read-only en `/viewer` + `/api/{stats,recent,search}`.
- Fix de robustez: orden estable en `mem_context`, escape seguro de queries FTS5.

### Consolidación LLM (abril 2026)
- Destilación nocturna episodes → memories vía OpenRouter (DeepSeek V3 default):
  idempotente, anti-alucinación (filtra evidencia fuera del batch), memoria stub
  con salience baja cuando no hay señal, tolerante a salidas no conformes del LLM.
- **Pre-filtro Pareto**: clasificador que descarta ruido antes de gastar tokens.
- CLIs: `mismem-ingest` (exports ChatGPT / transcripts VS Code),
  `mismem-consolidate`, `mismem-forget`, `mismem-migrate-engram`, `mismem-stats`.

### Preparación pública (julio 2026)
- Line endings normalizados (`.gitattributes`), docs genéricos sin referencias a
  infraestructura personal, README con arquitectura y quickstart, historial fresco.
