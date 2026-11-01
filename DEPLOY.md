# misMEM — Despliegue en producción

Guía para correr `mismem-brain` (el servidor MCP HTTP de misMEM) en un VPS con
Docker detrás de Traefik. `mem.example.com` se sustituye por el dominio propio.

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
        │
        ├──▶ servidor de embeddings (opcional, red interna): Ollama o llama-server
        └──▶ LLM de consolidación (opcional): DeepSeek, OpenRouter, OpenAI o un servidor compatible
```

- Transporte: **Streamable HTTP** (stateless: server+transport por request).
- Auth: BasicAuth (en Traefik como middleware, o nativa del server vía
  `MISMEM_AUTH_USER`/`MISMEM_AUTH_PASS`). **Sin ninguna de las dos el servidor
  queda abierto**: `/mcp`, el visor y `/api/*` responden a cualquiera que llegue
  al puerto, incluidos los otros contenedores de la misma red.
- Qué sale del servidor: nada, salvo que actives la consolidación. Ahí los
  episodios viajan textuales al proveedor del LLM (ver [Privacidad](#privacidad)).

---

## Pre-requisitos

- [ ] VPS con Docker + Docker Compose y Traefik ya funcionando (ACME configurado)
- [ ] DNS: A record de `mem.example.com` → IP del servidor
- [ ] Build local OK (`pnpm build`, `pnpm test`)

---

## Fase 1 — Obtener la imagen

Opción A — imagen multi-arch publicada, sin clonar nada:

```bash
docker pull ghcr.io/lucasmella-stack/mismem-brain:latest
```

Trae `linux/amd64` o `linux/arm64` según el servidor. Los tags son la versión exacta
(`X.Y.Z`), `major.minor` (`X.Y`) y `latest`, que sale del release estable más alto salvo en una
republicación manual (ver más abajo).

Opción B — build en el servidor, para probar un cambio sin pasar por un release:

```bash
ssh <tu-servidor>
git clone https://github.com/lucasmella-stack/misMEM.git mismem
cd mismem/engine
docker build -t mismem-brain:latest -f Dockerfile.mismem-brain .
```

### Cómo se publica la imagen

El workflow `docker.yml` corre al pushear un tag `v*` y publica
`ghcr.io/lucasmella-stack/mismem-brain` con la versión exacta, `major.minor` y, en un
push, `latest` sólo desde el tag estable más alto: una pre-release (`v1.0.0-rc1`) nunca
se lo lleva, y un `v0.4.0` puesto en retrospectiva tampoco, para no publicar el árbol
viejo encima del último release. Para republicar sin mover el tag, `workflow_dispatch`
sobre el tag que corresponda; lanzado desde una rama falla al arrancar, para no publicar
código sin release. Una republicación manual sí mueve `latest` con el árbol de ese tag,
así que sólo se despacha el release vigente.

**Si el push falla con `denied: permission_denied: read_package`**, el paquete existe
pero no le da escritura a este repositorio: GitHub lo creó desde un push y no lo vinculó
al repo. El workflow ya declara `permissions: packages: write`, y el paquete no aparece
en la lista de la cuenta por estar privado y sin vincular: hace falta la API
(`gh api "user/packages?package_type=container"`, con scope `read:packages`) para verlo.

Se arregla una sola vez desde *Package settings*
(`https://github.com/users/<usuario>/packages/container/mismem-brain/settings`):

1. *Manage Actions access* → *Add Repository* → `misMEM` con rol **Write**.
2. *Danger Zone* → *Change visibility* → **Public**, o el `docker pull` sigue pidiendo
   login aunque el push ya funcione.

Después, `gh workflow run docker.yml --ref vX.Y.Z`; no hace falta re-taggear. Si el
`docker pull` falla con `denied: denied` desde una máquina donde alguna vez hubo login,
son credenciales viejas: `docker logout ghcr.io`.

El paquete npm `@lucasmella/mismem` se publica a mano (`pnpm publish` desde `engine/`):
no hay workflow que lo haga. Tags anotados: `git tag -a vX.Y.Z -m 'misMEM X.Y.Z'`.

---

## Fase 2 — Servicio en `docker-compose.yml`

```yaml
  mismem-brain:
    # Con la opción B, el tag local: mismem-brain:latest
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

### Búsqueda por significado (opcional)

Sin servidor de embeddings, `recall` busca sólo por palabras. Para sumar
significado hace falta uno en la misma red interna, **sin** exponerlo por
Traefik (no tiene auth). Con [llama.cpp](https://github.com/ggml-org/llama.cpp)
y EmbeddingGemma 2, que cruza idiomas:

```yaml
  mismem-embed:
    image: ghcr.io/ggml-org/llama.cpp:server   # conviene fijar el digest probado
    container_name: mismem-embed
    restart: unless-stopped
    command: ["-m", "/models/embeddinggemma-2-Q8_0.gguf", "--embedding",
              "--host", "0.0.0.0", "--port", "8080", "-t", "2",
              "-c", "2048", "-b", "2048", "-ub", "2048"]
    volumes:
      - ./models:/models:ro
    networks:
      - internal
    deploy:
      resources:
        limits:
          memory: 2048M
```

Y en `mismem-brain` (sumándolo a la red `internal`):

```yaml
      MISMEM_EMBEDDING_URL: http://mismem-embed:8080
```

El modelo (296 MB) se baja una vez de
[ggml-org/embeddinggemma-2-GGUF](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF).
Con el límite de 2 GB el contenedor queda pegado al tope: se vigila con
`docker stats`. Después de levantarlo, o de sembrar una DB que traía vectores
de otro modelo, hay que indexar:

```bash
docker exec mismem-brain node dist/embed-cli.js --status   # cuántas memorias tienen vector del modelo activo
docker exec mismem-brain node dist/embed-cli.js            # completa las que faltan
```

Cambiar de **modelo** se detecta solo. Cambiar un **prefijo** o
`MISMEM_EMBEDDING_MAX_CHARS` no: los vectores viejos siguen contando como
válidos, así que hay que reindexar todo con `--force`. Mientras dura el
reindexado, la búsqueda por significado sólo ve las memorias ya procesadas.

---

## Fase 3 — Sembrar la DB (opcional)

Para llevar la memoria local al servidor:

```bash
scp ~/.mismem/mem.db <tu-servidor>:/tmp/mem.db
ssh <tu-servidor>
docker stop mismem-brain
docker run --rm -v mismem-data:/data -v /tmp:/in alpine \
  sh -c "cp /in/mem.db /data/mem.db && chown 1000:1000 /data/mem.db"
docker start mismem-brain
docker logs --tail 20 mismem-brain
```

Alternativa: ingestar un export de ChatGPT (el directorio con los
`conversations-*.json`) o los transcripts de VS Code dentro del contenedor:

```bash
docker cp <export-root> mismem-brain:/tmp/chatgpt
docker exec mismem-brain node dist/ingest-cli.js chatgpt /tmp/chatgpt
docker cp <user-dir> mismem-brain:/tmp/vscode
docker exec mismem-brain node dist/ingest-cli.js vscode /tmp/vscode
```

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

## Tareas programadas

Tres tareas en cuatro entradas del `crontab` del servidor: el respaldo y su
rotación, la consolidación y el olvido. El orden importa: el respaldo va antes de
todo lo que borra.

```bash
#!/bin/sh
# /usr/local/bin/mismem-backup — respaldo consistente (VACUUM INTO es seguro con WAL)
set -e
tmp=/tmp/mismem-backup.db
echo "VACUUM INTO '$tmp';" | docker exec -i mismem-brain sh -c "rm -f $tmp; sqlite3 /data/mem.db"
docker cp "mismem-brain:$tmp" "/opt/backups/mismem/mismem-$(date +%F).db"
docker exec mismem-brain rm -f "$tmp"
```

```cron
0 3 * * *  /usr/local/bin/mismem-backup
45 5 * * * find /opt/backups/mismem -name "mismem-*.db" -mtime +30 -delete
# Consolidación: episodios -> memorias (opcional, necesita la clave de un LLM)
0 4 * * *  docker exec mismem-brain node /app/dist/consolidate-cli.js >> /var/log/mismem-consolidation.log 2>&1
# Olvido: borra episodios ya consolidados y memorias de saliencia baja
30 4 * * * docker exec mismem-brain node /app/dist/forget-cli.js --before-days 90 --salience-below 0.1 >> /var/log/mismem-forget.log 2>&1
```

- **`mismem-forget` borra de verdad si no se le pasa `--dry-run`** (la tool MCP
  `forget`, en cambio, simula por defecto). Conviene probar primero con `--dry-run`.
- La consolidación marca como ruido lo que el LLM no usó, con saliencia 0,05;
  el olvido se lo lleva cuando la memoria cumple los 30 días de gracia y todos
  sus episodios superan `--before-days` (90 en el ejemplo), junto con ellos. Por
  eso el ejemplo guarda 30 días de respaldos: con menos, lo que se marcó mal ya
  no se recupera.
- Los logs del cron nombran ámbitos y los primeros caracteres de algunas
  memorias: se tratan como datos personales y se rotan (`logrotate`).
- `scripts/backup-mismem-from-server.ps1` hace el mismo respaldo desde Windows.

Detalle de la consolidación en
[engine/src/consolidation/README.md](engine/src/consolidation/README.md).

## Medir el recall

`mismem-bench` cuenta cuántas veces la memoria esperada sale entre las
devueltas, con un banco de preguntas armado desde la propia memoria. No
refuerza, así que se puede correr contra la base viva:

```bash
docker cp banco.jsonl mismem-brain:/tmp/banco.jsonl
docker exec mismem-brain node dist/bench-cli.js --bank /tmp/banco.jsonl --db /data/mem.db
```

El banco es privado: no lo subas a ningún repo.

---

## Privacidad

- La base vive en el volumen del servidor y no sale de ahí.
- El servidor de embeddings recibe el texto de cada memoria y de cada consulta:
  por eso va en la red interna.
- **La consolidación manda episodios textuales a un proveedor externo**
  (DeepSeek, OpenRouter u OpenAI) o al servidor compatible que configures:
  hasta 60.000 caracteres por llamada, con el nombre del ámbito. Es opcional:
  sin `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` ni
  `MISMEM_LLM_BASE_URL` no corre.

---

## Variables de entorno (referencia única)

Esta tabla es la única lista completa; el resto de la documentación apunta acá.
Los defaults son los del código (`engine/src`).

**Servidor**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_DB` | `~/.mismem/mem.db` (en la imagen: `/data/mem.db`) | Ruta SQLite |
| `MISMEM_HTTP_PORT` | `3200` | Puerto HTTP |
| `MISMEM_HTTP_HOST` | `127.0.0.1` | Bind address. Por defecto sólo loopback; los contenedores fijan `0.0.0.0` a propósito (Dockerfile y ejemplo de compose), y con esa dirección conviene definir `MISMEM_AUTH_*` |
| `MISMEM_ALLOWED_HOSTS` | — | Sin auth, el servidor sólo atiende `Host` de loopback (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) y responde 403 al resto, contra DNS rebinding. Lista separada por comas para añadir otros nombres. Con auth no se filtra |
| `MISMEM_HTTP_MAX_BODY_BYTES` | `4194304` (4 MiB) | Tope del cuerpo de `POST /mcp`; más grande responde 413 sin juntarlo en memoria |
| `MISMEM_SESSION_HOURS` | `12` | Cuánto dura la sesión del visor antes de volver a pedir la contraseña. La firma se deriva de `MISMEM_AUTH_*`: cambiar la contraseña cierra todas las sesiones vivas |
| `MISMEM_LOGIN_MAX_BODY_BYTES` | `4096` | Tope del cuerpo de `POST /login`. Nadie entra con más que eso |
| `MISMEM_VIEWER_ALLOW_DELETE` | apagado | `1` deja que la interfaz olvide memorias y rasgos, siempre en dos pasos con confirmación. Apagado, esos dos POST responden 403; corregir, deshacer una consolidación y cristalizar no dependen de él |
| `MISMEM_AUTH_USER` / `MISMEM_AUTH_PASS` | — | BasicAuth nativa. Sin ninguna, **sin auth**; con una sola, el servidor no arranca |
| `MISMEM_SALIENCE_HALF_LIFE_DAYS` | `90` | Días en que una memoria sin uso pierde la mitad de su saliencia |
| `MISMEM_REINFORCE_ON_RECALL` | `on` | `off` deja de reforzar lo que el recall devuelve; la saliencia pasa a subir sólo con `reinforce`. Ver "Refuerzo por uso" |

**Refuerzo por uso (hook del cliente, opcional)**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_HOOK_URL` | — | Base del misMEM remoto (`https://…`). Sin ella, `mismem-used` escribe en la base local |
| `MISMEM_HOOK_AUTH` | — | `usuario:clave` del BasicAuth del servidor. Nunca se imprime |
| `MISMEM_HOOK_AUTH_HEADER` | — | El header `Authorization` entero, ya armado. Gana sobre `MISMEM_HOOK_AUTH` y evita copiar la credencial a una variable nueva |
| `MISMEM_HOOK_MIN_OVERLAP` | `0.2` | Fracción de las palabras distintivas del recuerdo que la respuesta tiene que repetir |
| `MISMEM_HOOK_MIN_SHARED` | `3` | Piso de palabras compartidas: con pocas, un solapamiento alto es casualidad |

**Recuperación proactiva (hook del cliente, opcional)**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_HOOK_EXCLUDE_SCOPES` | — | Prefijos de ámbito que **no** se inyectan (`lucas,chatgpt`). `lucas` tapa `lucas/profile`, no `lucas-publico` |
| `MISMEM_HOOK_SCOPE` | — | Restringe la búsqueda a un solo ámbito |
| `MISMEM_HOOK_MAX_MEMORIES` | `3` | Cuántos recuerdos se adelantan como mucho |
| `MISMEM_HOOK_MAX_CHARS` | `1200` | Presupuesto de texto inyectado |
| `MISMEM_HOOK_MIN_PROMPT_TERMS` | `2` | Palabras con sustancia que necesita el prompt para que valga buscar |
| `MISMEM_HOOK_TIMEOUT_MS` | `2500` | Espera por la búsqueda contra el servidor remoto (`MISMEM_HOOK_URL`); si vence, no inyecta nada. Sin `MISMEM_HOOK_URL` no se aplica: la búsqueda local queda acotada sólo por `MISMEM_EMBEDDING_TIMEOUT_MS` |

`MISMEM_HOOK_URL` y `MISMEM_HOOK_AUTH` las comparten los dos hooks.

**Envoltorio de los hooks (`scripts/mismem-hook.sh`)**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_HOOK_CONFIG` | `~/.claude.json` | Config MCP del cliente de donde saca la URL y el `Authorization`. Acepta config global o por proyecto |
| `MISMEM_HOOK_SERVER` | `mismem` | Nombre del servidor MCP dentro de esa config |
| `MISMEM_DIST` | `<repo>/engine/dist` | Binarios que invoca el envoltorio |

**Instalador (`scripts/install.sh`)**

Las `MISMEM_INSTALL_*` contestan las preguntas del modo sin preguntas (`--yes`). Sin `--yes`, la base, el
modelo y la URL base se proponen como respuesta por defecto, y `MISMEM_INSTALL_API_KEY` y
`MISMEM_INSTALL_HOOKS` evitan su pregunta.

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_INSTALL_DB` | el `MISMEM_DB` de una instalación anterior, si no `~/.mismem/mem.db` | Dónde guardar la memoria |
| `MISMEM_INSTALL_PROVIDER` | el de una instalación anterior, si no `none` | Proveedor de consolidación: `deepseek`, `openrouter`, `openai`, `compatible` o `none`. Otro valor corta con código 64 |
| `MISMEM_INSTALL_API_KEY` | la clave de una instalación anterior | La clave del proveedor. Nunca por argumento: quedaría en el historial y en `ps`. Se guarda en `~/.config/mismem/env` con permisos 600 |
| `MISMEM_INSTALL_MODEL` | el de una instalación anterior, si no vacío | Modelo de consolidación. Obligatorio con `openai` y `compatible`; con los otros, vacío usa el de misMEM |
| `MISMEM_INSTALL_BASE_URL` | el de una instalación anterior, si no `http://127.0.0.1:11434/v1` | Con proveedor `compatible`, URL base del servidor (con `/v1`) |
| `MISMEM_INSTALL_HOOKS` | `yes` con `--yes` | `yes` o `no` para los hooks de Claude Code. Si la versión instalada no trae `mismem-inject` y `mismem-used`, queda en `no` |
| `MISMEM_INSTALL_GEMMA_GGUF` | `<XDG_DATA_HOME>/mismem/models/embeddinggemma-2-Q8_0.gguf` | Ruta de un GGUF de EmbeddingGemma 2 que ya se tenga; con `--embeddings gemma` evita la descarga |
| `MISMEM_INSTALL_VERSION` | `latest` | Al instalar desde npm (`--from-npm`), la versión del paquete |
| `REPLACE_EXISTING` | `no` | Con `yes`, el instalador reemplaza un MCP `mismem` de opencode que ya tiene otro comando; sin ella lo deja como está y avisa. En Claude Code, Claude Desktop, VS Code y Cursor la entrada `mismem` se reescribe siempre, y unos hooks de misMEM de Claude Code configurados de otra forma nunca se tocan |

**Respaldo desde Windows (`scripts/backup-mismem-from-server.ps1`)**

Sin default: si falta una de las dos (como variable o como parámetro del script), el script se detiene.

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_SSH_HOST` | — | Alias SSH o `usuario@host` del servidor donde corre el contenedor `mismem-brain`. Equivale al parámetro `-SshHost` |
| `MISMEM_HOST_VOLUME_DIR` | — | Ruta en el servidor que corresponde a `/data` dentro del contenedor (el directorio `_data` del volumen Docker). Equivale al parámetro `-HostVolumeDir` |

**Interfaz en desarrollo (`pnpm dev:ui`)**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_DEV_API` | `http://127.0.0.1:3200` | Destino del proxy `/api` de Vite mientras la interfaz corre fuera de `server-http` |

**Búsqueda por significado**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_EMBEDDINGS` | `auto` | `off` apaga la capa; con `auto`, si el servidor no responde se busca sólo por palabras |
| `MISMEM_EMBEDDING_URL` | `http://127.0.0.1:8080` | Servidor de embeddings con `/v1/embeddings`: llama-server, u Ollama en `http://127.0.0.1:11434` |
| `MISMEM_EMBEDDING_MODEL` | `embeddinggemma-2` | Modelo. Cambiarlo reindexa solo |
| `MISMEM_EMBEDDING_QUERY_PREFIX` / `_DOC_PREFIX` | los de EmbeddingGemma (`task: search result \| query: ` y `title: none \| text: `) si el modelo es de esa familia (su id contiene `embeddinggemma`, sin distinguir mayúsculas); si no, vacíos | Prefijos de consulta y documento. Vacíos a propósito (`=`) los quitan. Cambiarlos exige `mismem-embed --force` |
| `MISMEM_EMBEDDING_MIN_SCORE` | `0.65` con la familia EmbeddingGemma; `0.5` con cualquier otro modelo | Parecido mínimo (coseno) para que una memoria cuente. 0,65 es el mayor corte que no pierde aciertos con EmbeddingGemma (PR #181); `0` trae todo. Un valor explícito gana siempre |
| `MISMEM_EMBEDDING_MAX_CHARS` | `4000` | Tope del texto de cada memoria al indexar. Cambiarlo exige `--force` |
| `MISMEM_EMBEDDING_TIMEOUT_MS` | `3000` | Espera por consulta (el reindexado usa 120 s) |

**Consolidación**

| Var | Default | Descripción |
|-----|---------|-------------|
| `MISMEM_LLM_PROVIDER` | — | `deepseek`, `openrouter`, `openai` o `compatible`. Sin ella, el primero con su variable, en ese orden |
| `DEEPSEEK_API_KEY` | — | Consolida con DeepSeek directo |
| `OPENROUTER_API_KEY` | — | OpenRouter |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — / la oficial | OpenAI. Obliga a elegir `MISMEM_CONSOLIDATION_MODEL` |
| `MISMEM_LLM_BASE_URL` / `MISMEM_LLM_API_KEY` | — | Cualquier servidor compatible con la API de OpenAI (vLLM, LM Studio, Ollama en `/v1`); la clave es opcional y el modelo obligatorio |
| `MISMEM_CONSOLIDATION_MODEL` | `deepseek-chat` (OpenRouter: `deepseek/deepseek-chat`) | En DeepSeek un nombre con `/` se ignora |
| `DEEPSEEK_BASE_URL` / `OPENROUTER_BASE_URL` | las oficiales | Para un proxy o un servidor compatible |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE` | repo de misMEM / `misMEM` | Cabeceras de atribución de OpenRouter |
| `MISMEM_CONSOLIDATION_MAX_TOKENS` | `8192` | Tope de la respuesta; si se corta, la tanda se parte a la mitad |
| `MISMEM_CONSOLIDATION_TIMEOUT_MS` | `120000` | Tope por llamada al LLM; si vence, ese ámbito falla y sus episodios quedan para la próxima corrida |
| `MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS` | `60000` | Caracteres de episodios por llamada |
| `MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS` | `12000` | Un episodio más largo viaja recortado (principio y final) |
| `MISMEM_CONSOLIDATION_MAX_CALLS` | `60` | Llamadas por corrida; lo pendiente queda para la siguiente |
| `MISMEM_CONSOLIDATION_MAX_BATCH` | `60` | Episodios que se leen por tanda |
| `MISMEM_CONSOLIDATION_MIN_AGE_HOURS` | `24` | Edad mínima de un episodio para consolidarlo |
| `MISMEM_CONSOLIDATION_MIN_EPISODES` | `3` | Un ámbito con menos episodios pendientes espera a juntar ese mínimo |
| `MISMEM_CONSOLIDATION_QUIET_DAYS` | `14` | Si el ámbito lleva estos días sin episodios nuevos, se consolida aunque no llegue al mínimo |
| `MISMEM_CONSOLIDATION_UNCITED_STRIKES` | `3` | Tandas en que el LLM puede leer un episodio sin citarlo antes de darlo por ruido |

---

## Checklist final

- [ ] DNS resuelve al servidor
- [ ] `mismem-brain` UP y `healthz` OK
- [ ] Cert TLS de Traefik emitido
- [ ] `tools/list` responde vía HTTPS con auth
- [ ] Backup diario programado y probado (restaurar uno en otra máquina)
- [ ] Si hay búsqueda por significado: `embed-cli.js --status` sin memorias faltantes
- [ ] Si hay consolidación: primera corrida con `--dry-run` y logs con rotación

## Refuerzo por uso (hook del cliente)

Por defecto, `recall` refuerza todo lo que devuelve. Eso premia al recuerdo que aparece
siempre y no sirve nunca: en la medición de la 0.5.0, sobre 573 recuerdos devueltos en turnos
reales de Claude Code, la mediana de solapamiento entre el recuerdo y la respuesta es
**0,07**. La enorme mayoría de lo que se refuerza no se usó.

Con el hook `Stop` de Claude Code, la saliencia pasa a seguir el uso real:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "mismem-used" }] }
    ]
  }
}
```

Y en el entorno del hook:

```bash
MISMEM_REINFORCE_ON_RECALL=off   # en el servidor: que aparecer deje de contar
MISMEM_HOOK_URL=https://tu-mismem
MISMEM_HOOK_AUTH=usuario:clave
```

`mismem-used` lee el `transcript_path` del payload, mira el último turno, y manda a
`reinforce` sólo los recuerdos cuyas palabras distintivas reaparecen en la respuesta.
Nunca sale con error ni escribe en stdout: un hook que rompe no vale un punto de saliencia.

### Antes de apagar el refuerzo por aparición

Primero se puede ver qué reforzaría, sin escribir nada:

```bash
mismem-used --transcript ~/.claude/projects/<proyecto>/<sesión>.jsonl --dry-run
```

**Con los umbrales por defecto cuenta como usado el 9 % de lo devuelto (en la misma
medición, sobre esos 573 casos).** Es la señal que
se busca, pero cambia el balance con el olvido: si casi nada se refuerza, el decaimiento
manda y `forget` empieza a borrar memorias que antes se salvaban por aparecer. Conviene
dejar `MISMEM_REINFORCE_ON_RECALL=on` unos días, mirar los `--dry-run`, y sólo entonces
apagarlo — ajustando `MISMEM_SALIENCE_HALF_LIFE_DAYS` o el `salience_below` de `forget`
si hace falta.

## Recuperación proactiva (hook del cliente)

El modelo sólo recuerda lo que pide: si no llama a `recall`, no recuerda. Con el hook
`UserPromptSubmit`, misMEM adelanta lo relevante antes de que responda.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "mismem-inject" }] }
    ]
  }
}
```

`mismem-inject` busca con el prompt, descarta episodios, ámbitos privados y lo que el
contexto ya tiene, y devuelve unos pocos recuerdos por `additionalContext`. La búsqueda
va con `reinforce: false`: algo que el usuario no pidió no es uso y no puede subir la
saliencia. Ante timeout, servidor caído o prompt trivial no inyecta nada y sale bien.

### Se enciende solo cuando el servidor está listo

`recall` acepta `reinforce` desde 0.5.0. Contra un servidor anterior, Zod **descarta ese
campo en silencio**: el hook inyectaría y reforzaría, justo lo contrario de lo buscado. Para
que eso no pase, antes de inyectar se confirma que el servidor expone la tool `reinforce`.

El resultado se cachea en `hook-readiness.json`, al lado de la base: el "sí" dura 6 horas
para no preguntar en cada turno, y el "no" 10 minutos para que el hook arranque solo al poco
tiempo de desplegar. Así se puede dejar configurado antes del deploy sin riesgo.

### El envoltorio: credenciales donde ya viven

Se invoca con `bash` a propósito: así da igual si el bit de ejecución se perdió en el
clone o en un checkout, y el hook no falla por eso en cada prompt.

`scripts/mismem-hook.sh` saca la URL y el header `Authorization` de la config MCP del cliente
(`~/.claude.json` por defecto) en vez de pedir que se copien a `settings.json` o a otro
archivo. Nunca los imprime.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash /ruta/a/misMEM/scripts/mismem-hook.sh inject" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash /ruta/a/misMEM/scripts/mismem-hook.sh used" }] }
    ]
  }
}
```

### Antes de activarlo: qué sale de la máquina

Lo inyectado viaja en **cada prompt** al proveedor del modelo. Un recuerdo personal
entra en una conversación de trabajo salvo que lo excluyas:

```bash
MISMEM_HOOK_EXCLUDE_SCOPES=personal,chatgpt,lucas,bardon
```

Primero se puede ver qué inyectaría, sin mandar nada:

```bash
echo '{"prompt":"tu pregunta"}' | mismem-inject --dry-run
```

El `--dry-run` imprime los ids y los **ámbitos** de lo que elegiría, no el texto: sirve
para revisar el filtro sin volcar recuerdos en una terminal compartida.
