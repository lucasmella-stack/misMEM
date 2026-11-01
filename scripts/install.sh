#!/usr/bin/env bash
# Instalador de misMEM para Linux.
#
# Deja misMEM funcionando y configurado en los clientes que haya en la máquina, y pide
# sólo lo que es del usuario: dónde va la base y con qué proveedor consolidar. Las claves
# van a ~/.config/mismem/env (600) y nunca a la config de un cliente: los clientes llaman a
# ~/.local/bin/mismem-run, que carga ese fichero y lanza misMEM con la ruta absoluta de
# Node (los clientes de escritorio no heredan el PATH de la terminal).
#
#   bash scripts/install.sh                 # interactivo, desde este repo (lo compila)
#   bash scripts/install.sh --from-npm      # el paquete publicado en npm
#   bash scripts/install.sh --yes --clients claude-code,opencode --no-timer
#
# Sin preguntas (--yes), se leen MISMEM_INSTALL_DB, MISMEM_INSTALL_PROVIDER
# (deepseek|openrouter|openai|compatible|none), MISMEM_INSTALL_API_KEY,
# MISMEM_INSTALL_MODEL, MISMEM_INSTALL_BASE_URL y MISMEM_INSTALL_HOOKS (yes|no).
# Con llama-server en el PATH, --embeddings gemma monta EmbeddingGemma 2 (baja el modelo si
# falta; MISMEM_INSTALL_GEMMA_GGUF apunta a un GGUF que ya tengas). Sin esa opción, --yes
# conserva el modelo de embeddings que hubiera, salvo nomic-embed-text, que pasa a
# EmbeddingGemma 2; si no hay ninguno, monta EmbeddingGemma 2.
# La clave nunca va por argumento: quedaría en el historial y en `ps`.
#
# Re-ejecutarlo actualiza en vez de duplicar.
set -euo pipefail

# ---------------------------------------------------------------- argumentos

usage() {
  cat <<'EOF'
Uso: install.sh [opciones]

  --from-npm           Instala el paquete publicado en npm en vez de este repo
                       (puede ir por detrás del repo: sin hooks si su versión no los trae)
  --yes, -y            Sin preguntas: valores por defecto y variables MISMEM_INSTALL_*
  --clients LISTA      claude-code,opencode,claude-desktop,vscode,cursor | all | none
                       (por defecto, los que se detectan en la máquina)
  --timer / --no-timer Consolidación nocturna con systemd de usuario (por defecto pregunta)
  --embeddings MODO    gemma | off: EmbeddingGemma 2 (multilingüe, necesita llama-server en el
                       PATH) o sin búsqueda por significado
  --embeddings-gpu     EmbeddingGemma 2 en la GPU en vez de en la CPU
  --help               Esta ayuda
EOF
}

# Desde el repo si el script vive en uno (es lo que indica el README); npm es la alternativa.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_SOURCE=0
[ -f "$REPO/engine/package.json" ] && FROM_SOURCE=1
ASSUME_YES=0
CLIENTS=""
TIMER=""
EMBED_FLAG=""
GEMMA_GPU=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
    --from-npm) FROM_SOURCE=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --clients)
      [ $# -ge 2 ] || { echo "--clients necesita una lista" >&2; exit 64; }
      CLIENTS="$2"
      shift
      ;;
    --embeddings)
      [ $# -ge 2 ] || { echo "--embeddings necesita gemma u off" >&2; exit 64; }
      case "$2" in gemma | off) EMBED_FLAG="$2" ;; *) echo "--embeddings: gemma u off, no '$2'" >&2; exit 64 ;; esac
      shift
      ;;
    --embeddings-gpu) GEMMA_GPU=yes ;;
    --timer) TIMER=yes ;;
    --no-timer) TIMER=no ;;
    --help | -h) usage; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

# ---------------------------------------------------------------- ayudas

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

# ask PREGUNTA DEFECTO: con --yes, el defecto.
ask() {
  local answer
  if [ "$ASSUME_YES" = 1 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1 [$2]: " answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}

# confirm PREGUNTA DEFECTO(y|n)
confirm() {
  local answer hint="[S/n]"
  [ "$2" = n ] && hint="[s/N]"
  if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
  read -r -p "$1 $hint: " answer </dev/tty || true
  answer="${answer:-$2}"
  case "$answer" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

# ask_secret PREGUNTA: no se muestra mientras se escribe.
ask_secret() {
  local answer
  read -r -s -p "$1: " answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

# ---------------------------------------------------------------- requisitos

[ "$(uname -s)" = Linux ] || { say "Por ahora este instalador es sólo para Linux."; exit 1; }

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  say "Hace falta Node 22 o superior y no está en el PATH."
  say "Instálalo con tu gestor de versiones (mise, nvm, fnm) o desde https://nodejs.org y vuelve a ejecutar esto."
  exit 1
fi
NODE="$(readlink -f "$NODE")"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "misMEM necesita Node 22 o superior; este es $("$NODE" --version)."
  exit 1
fi

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mismem"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mismem"
BIN_DIR="$HOME/.local/bin"
ENV_FILE="$CONF_DIR/env"
RUN="$BIN_DIR/mismem-run"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# ---------------------------------------------------------------- 1. instalar

step "Instalando misMEM"
if [ "$FROM_SOURCE" = 1 ]; then
  [ -f "$REPO/engine/package.json" ] || { say "No estoy dentro del repo de misMEM: usa --from-npm."; exit 1; }
  cd "$REPO/engine"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile >/dev/null
    pnpm build >/dev/null
  else
    npm ci --no-audit --no-fund >/dev/null
    npm run build >/dev/null
  fi
  cd - >/dev/null
  DIST="$REPO/engine/dist"
  say "  desde el repo: $REPO"
else
  mkdir -p "$DATA_DIR/app"
  # npm y no pnpm: viene con Node, y corre la descarga del binario de better-sqlite3 sin
  # tener que autorizar scripts de instalación a mano.
  npm install --prefix "$DATA_DIR/app" --no-audit --no-fund --loglevel=error \
    "@lucasmella/mismem@${MISMEM_INSTALL_VERSION:-latest}" >/dev/null
  DIST="$DATA_DIR/app/node_modules/@lucasmella/mismem/dist"
  say "  desde npm ($("$NODE" -p "require('$DATA_DIR/app/node_modules/@lucasmella/mismem/package.json').version")) en $DATA_DIR/app"
fi
[ -f "$DIST/server.js" ] || { say "No se encontró $DIST/server.js: la instalación falló."; exit 1; }

# ---------------------------------------------------------------- 2. configuración

# Lo que ya había (si se re-ejecuta) es el valor por defecto de cada pregunta.
prev() {
  [ -f "$ENV_FILE" ] || return 0
  (set -a; . "$ENV_FILE"; eval "printf '%s' \"\${$1:-}\"")
}

# defined VAR: si ENV_FILE la declara, aunque esté vacía. Un valor vacío es una elección (un prefijo
# vacío apaga el de EmbeddingGemma que ahora viene por defecto), así que prev no basta para verlo.
# engine_number VALOR: si el motor lo lee como número no negativo (env.ts usa Number() sobre el valor
# recortado). Lo que no, el motor lo trata como sin definir.
engine_number() {
  [ -n "$(printf '%s' "$1" | tr -d ' \t')" ] || return 1
  printf '%s\n' "$1" | awk '{ v = $0; gsub(/^[ \t]+|[ \t]+$/, "", v)
    exit !(v ~ /^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$/ && v + 0 >= 0) }'
}

defined() {
  [ -f "$ENV_FILE" ] || return 1
  (set -a; . "$ENV_FILE"; eval "[ \"\${$1+x}\" = x ]")
}

step "Configuración"
DB="${MISMEM_INSTALL_DB:-$(prev MISMEM_DB)}"
DB="$(ask "Dónde guardar la memoria" "${DB:-$HOME/.mismem/mem.db}")"

PREV_PROVIDER="$(prev MISMEM_LLM_PROVIDER)"
if [ "$ASSUME_YES" = 1 ]; then
  PROVIDER="${MISMEM_INSTALL_PROVIDER:-${PREV_PROVIDER:-none}}"
else
  say "La consolidación resume los episodios en memorias con un LLM. Cada tanda es una llamada"
  say "a la API del proveedor (cuesta dinero según el proveedor y el modelo)."
  say "  1) DeepSeek   2) OpenRouter   3) OpenAI   4) Servidor compatible con OpenAI (p. ej. Ollama)   5) Ninguno por ahora"
  case "$(ask "Proveedor" "${PREV_PROVIDER:-5}")" in
    1 | deepseek) PROVIDER=deepseek ;;
    2 | openrouter) PROVIDER=openrouter ;;
    3 | openai) PROVIDER=openai ;;
    4 | compatible) PROVIDER=compatible ;;
    *) PROVIDER=none ;;
  esac
fi

KEY_VAR=""
case "$PROVIDER" in
  deepseek) KEY_VAR=DEEPSEEK_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  openai) KEY_VAR=OPENAI_API_KEY ;;
  compatible) KEY_VAR=MISMEM_LLM_API_KEY ;;
  none) ;;
  *) say "Proveedor desconocido: $PROVIDER"; exit 64 ;;
esac

API_KEY=""
BASE_URL=""
MODEL="${MISMEM_INSTALL_MODEL:-$(prev MISMEM_CONSOLIDATION_MODEL)}"
if [ -n "$KEY_VAR" ]; then
  PREV_KEY="$(prev "$KEY_VAR")"
  if [ -n "${MISMEM_INSTALL_API_KEY:-}" ]; then
    API_KEY="$MISMEM_INSTALL_API_KEY"
  elif [ "$ASSUME_YES" = 1 ]; then
    API_KEY="$PREV_KEY"
  else
    hint="clave de $PROVIDER"
    [ "$PROVIDER" = compatible ] && hint="clave del servidor (vacía si no pide)"
    [ -n "$PREV_KEY" ] && hint="$hint (Enter para conservar la actual)"
    API_KEY="$(ask_secret "$hint")"
    API_KEY="${API_KEY:-$PREV_KEY}"
  fi
  if [ -z "$API_KEY" ] && [ "$PROVIDER" != compatible ]; then
    warn "Sin clave no se podrá consolidar; puedes volver a ejecutar esto cuando la tengas."
  fi
  if [ "$PROVIDER" = compatible ]; then
    BASE_URL="${MISMEM_INSTALL_BASE_URL:-$(prev MISMEM_LLM_BASE_URL)}"
    BASE_URL="$(ask "URL base del servidor (con /v1)" "${BASE_URL:-http://127.0.0.1:11434/v1}")"
  fi
  # Con OpenAI o un servidor compatible no hay modelo por defecto: es una decisión de coste.
  if [ "$PROVIDER" = openai ] || [ "$PROVIDER" = compatible ]; then
    MODEL="$(ask "Modelo (obligatorio con $PROVIDER)" "$MODEL")"
    [ -n "$MODEL" ] || warn "Sin modelo no se podrá consolidar con $PROVIDER."
  else
    MODEL="$(ask "Modelo (Enter para el de misMEM por defecto)" "$MODEL")"
  fi
fi

# ---------------------------------------------------------------- 3. embeddings

# EmbeddingGemma 2 detrás de llama-server. Con memorias que no estén en inglés encuentra muchas más
# paráfrasis que un modelo pensado para inglés (34 de 50 frente a 4 en las mediciones de la issue #72).
# Corre en CPU salvo que se pida la GPU: en CPU no gasta VRAM y una consulta tarda unos 15 ms.
GEMMA_PORT=8080
GEMMA_URL="http://127.0.0.1:$GEMMA_PORT"
GEMMA_FILE="embeddinggemma-2-Q8_0.gguf"
GEMMA_GGUF="${MISMEM_INSTALL_GEMMA_GGUF:-$DATA_DIR/models/$GEMMA_FILE}"
GEMMA_UNIT="$UNIT_DIR/mismem-embed.service"

# El /health de llama-server da 503 mientras carga el modelo: -f lo cuenta como "no responde".
embed_answers() { curl -fsS -m 3 "$1/health" >/dev/null 2>&1; }

has_user_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

# setup_gemma: deja listos el modelo y el servidor. Devuelve 1 si no se pudo o no se quiso bajar el modelo.
setup_gemma() {
  local llama cmd device="--device none" gpu_default=n ours=""
  llama="$(command -v llama-server || true)"
  has_user_systemd && systemctl --user is-active --quiet mismem-embed.service && ours=1
  if [ -z "$ours" ] && embed_answers "$GEMMA_URL"; then
    say "  Ya hay un servidor de embeddings en $GEMMA_URL: lo uso tal cual. Que sirva EmbeddingGemma 2 es cosa tuya."
    return 0
  fi
  if [ -z "$llama" ]; then
    warn "llama-server no está en el PATH y nada responde en $GEMMA_URL: dejo EmbeddingGemma 2 configurado, pero sin servidor."
    return 0
  fi

  if [ ! -f "$GEMMA_GGUF" ]; then
    confirm "  ¿Bajar EmbeddingGemma 2 (296 MB) de Hugging Face, ggml-org/embeddinggemma-2-GGUF?" y || return 1
    mkdir -p "$(dirname "$GEMMA_GGUF")"
    # A un .part y luego mv: una descarga cortada no se queda como si fuera el modelo.
    if ! curl -fL --progress-bar -o "$GEMMA_GGUF.part" \
      "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/$GEMMA_FILE"; then
      rm -f "$GEMMA_GGUF.part"
      warn "La descarga falló."
      return 1
    fi
    mv "$GEMMA_GGUF.part" "$GEMMA_GGUF"
  fi
  say "  Modelo: $GEMMA_GGUF"

  # Al re-ejecutar, lo que había (GPU o CPU) es el defecto: no se cambia sin que se pida.
  grep -qs -- '-ngl' "$GEMMA_UNIT" && gpu_default=y
  if [ "$GEMMA_GPU" = yes ] || { [ -z "$GEMMA_GPU" ] && confirm "  ¿Usar la GPU para EmbeddingGemma 2? (más rápido al indexar; unos 500 MiB de VRAM)" "$gpu_default"; }; then
    device="-ngl 99"
  fi
  # -c/-b/-ub a 2048: un documento largo no cabe en el lote por defecto y el servidor lo rechazaría.
  cmd="\"$llama\" -m \"$GEMMA_GGUF\" --embedding --host 127.0.0.1 --port $GEMMA_PORT -c 2048 -b 2048 -ub 2048 $device"

  if has_user_systemd && confirm "  ¿Dejar llama-server arrancado con un servicio de systemd de usuario?" y; then
    mkdir -p "$UNIT_DIR"
    cat >"$GEMMA_UNIT" <<EOF
# Generado por scripts/install.sh de misMEM.
[Unit]
Description=misMEM: servidor de embeddings (EmbeddingGemma 2)

[Service]
ExecStart=$cmd
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable mismem-embed.service >/dev/null 2>&1
    # restart y no start: al re-ejecutar, el servicio ya corriendo recoge el modelo y el dispositivo nuevos.
    systemctl --user restart mismem-embed.service
    for _ in $(seq 1 30); do embed_answers "$GEMMA_URL" && break; sleep 1; done
    say "  Servicio mismem-embed (systemd de usuario) en $GEMMA_URL."
  else
    say "  Arráncalo tú cuando quieras buscar por significado:"
    say "    $cmd"
  fi
  return 0
}

step "Búsqueda semántica"
EMBEDDINGS_OFF=""
CAN_GEMMA=""
{ command -v llama-server >/dev/null 2>&1 || embed_answers "$GEMMA_URL"; } && CAN_GEMMA=1

# Qué había: gemma es lo que monta este instalador y nomic lo que montaba antes, que se sustituye; cualquier
# otra cosa (otro modelo, otro servidor, otra URL) es del usuario y no se toca sin que lo pida.
PREV_EMBED="$(prev MISMEM_EMBEDDING_MODEL)"
PREV_URL="$(prev MISMEM_EMBEDDING_URL)"
PREV_PROVIDER_EMBED="$(prev MISMEM_EMBEDDING_PROVIDER)"
PREV_OLLAMA_URL="$(prev MISMEM_OLLAMA_URL)"
PREV_KIND=""
FROM_NOMIC=""
# nomic sólo es "lo que montaba este instalador" si apuntaba al Ollama local; con otro servidor es del
# usuario y pasa por la pregunta de conservarlo.
PREV_LOCAL_OLLAMA=""
if [ -z "$PREV_URL" ] && [ "$PREV_PROVIDER_EMBED" != openai ] &&
  [ "${PREV_OLLAMA_URL:-http://127.0.0.1:11434}" = http://127.0.0.1:11434 ]; then PREV_LOCAL_OLLAMA=1; fi
if [ -n "$PREV_EMBED$PREV_URL$PREV_PROVIDER_EMBED$PREV_OLLAMA_URL" ]; then
  PREV_KIND=custom
  case "$PREV_EMBED" in
    embeddinggemma-2) if [ "${PREV_URL:-$GEMMA_URL}" = "$GEMMA_URL" ]; then PREV_KIND=gemma; fi ;;
    nomic-embed-text*) if [ -n "$PREV_LOCAL_OLLAMA" ]; then PREV_KIND=nomic; fi ;;
    "")
      # Sin modelo, el motor usaba nomic-embed-text: una instalación de Ollama, o con su URL, es nomic
      # y se migra como las demás; no es una configuración propia que haya que conservar.
      if [ -n "$PREV_LOCAL_OLLAMA" ] && { [ "$PREV_PROVIDER_EMBED" = ollama ] || [ -n "$PREV_OLLAMA_URL" ]; }; then
        PREV_KIND=nomic
      fi
      ;;
  esac
fi
# La URL que el motor anterior resolvía sin MISMEM_EMBEDDING_URL: Ollama y su 11434, salvo con el proveedor
# openai (el 8080 de llama-server). El código nuevo ya no conoce MISMEM_OLLAMA_URL, así que al conservar una
# configuración propia hay que dejarle la URL escrita o cambiaría de servidor.
PREV_RESOLVED_URL="$GEMMA_URL"
if [ "$PREV_PROVIDER_EMBED" != openai ]; then PREV_RESOLVED_URL="${PREV_OLLAMA_URL:-http://127.0.0.1:11434}"; fi
# Variables que se conservan tal cual cuando no se elige otro modelo.
EMBED_VARS="MISMEM_EMBEDDING_URL MISMEM_EMBEDDING_MODEL MISMEM_EMBEDDING_QUERY_PREFIX MISMEM_EMBEDDING_DOC_PREFIX
  MISMEM_EMBEDDING_MIN_SCORE MISMEM_EMBEDDING_MAX_CHARS MISMEM_EMBEDDING_TIMEOUT_MS"

# Sin opción, lo que hubiera se conserva: re-ejecutar no cambia el modelo (reindexar es caro).
EMBED_CHOICE="${PREV_KIND:-gemma}"
if [ -n "$EMBED_FLAG" ]; then
  EMBED_CHOICE="$EMBED_FLAG"
  if [ "$EMBED_CHOICE" = gemma ] && [ -z "$CAN_GEMMA" ]; then
    say "--embeddings gemma necesita llama-server en el PATH (o un servidor de embeddings en $GEMMA_URL)."
    exit 1
  fi
elif [ "$PREV_KIND" = custom ] && ! confirm "  Ya tienes embeddings configurados (${PREV_EMBED:-sin modelo}, ${PREV_URL:-$PREV_RESOLVED_URL}). ¿Conservarlos?" y; then
  EMBED_CHOICE=gemma
fi
# Una búsqueda apagada a propósito sigue apagada: re-ejecutar sin --embeddings no la enciende.
if [ -z "$EMBED_FLAG" ] && [ "$EMBED_CHOICE" != custom ] && [ "$(prev MISMEM_EMBEDDINGS)" = off ]; then
  EMBED_CHOICE=off
fi
if [ "$EMBED_CHOICE" = nomic ] && [ -z "$CAN_GEMMA" ]; then
  # Sin llama-server la migración dejaría la búsqueda apuntando a un puerto vacío: nomic, que funciona, se
  # conserva como configuración propia, con la URL, el modelo y el corte escritos.
  say "  Sin llama-server no puedo montar EmbeddingGemma 2: conservo nomic-embed-text de Ollama."
  PREV_KIND=custom
  EMBED_CHOICE=custom
elif [ "$EMBED_CHOICE" = nomic ]; then
  say "  nomic-embed-text ya no se usa: paso a EmbeddingGemma 2, y las memorias se reindexan solas."
  EMBED_CHOICE=gemma
  FROM_NOMIC=1
fi

if [ "$EMBED_CHOICE" = gemma ] && ! setup_gemma; then
  if [ -n "$FROM_NOMIC" ]; then
    # Sin el modelo nuevo, el nomic que funcionaba se conserva en vez de apagar la búsqueda.
    say "  Sin EmbeddingGemma 2, conservo nomic-embed-text de Ollama."
    PREV_KIND=custom
    EMBED_CHOICE=custom
  else
    say "  Sin el modelo, la búsqueda queda sólo por palabras."
    EMBED_CHOICE=off
  fi
fi

# Reescribir el bloque sólo si el resultado es otro que el que había.
EMBED_KEEP=""
if [ "$EMBED_CHOICE" = "$PREV_KIND" ]; then EMBED_KEEP=1; fi

# Sin búsqueda por significado, el servicio que montó este instalador seguiría ocupando el puerto y la memoria.
if [ "$EMBED_CHOICE" = off ] && grep -qs 'Generado por scripts/install.sh' "$GEMMA_UNIT" && has_user_systemd &&
  { systemctl --user is-enabled --quiet mismem-embed.service || systemctl --user is-active --quiet mismem-embed.service; }; then
  systemctl --user disable --now mismem-embed.service >/dev/null 2>&1 || true
  say "  Paro y desactivo el servicio mismem-embed (llama-server): ya no se usa y ocupaba el puerto $GEMMA_PORT y memoria."
fi

if [ "$EMBED_CHOICE" = custom ]; then
  say "  Conservo los embeddings que ya tenías (${PREV_EMBED:-sin modelo}, ${PREV_URL:-$PREV_RESOLVED_URL})."
  [ "$(prev MISMEM_EMBEDDINGS)" = off ] && EMBEDDINGS_OFF=1
elif [ "$EMBED_CHOICE" = gemma ]; then
  # Sin MISMEM_EMBEDDINGS=off: con el servidor parado la búsqueda ya degrada a palabras, y así no queda
  # apagada cuando el usuario lo arranque.
  embed_answers "$GEMMA_URL" || warn "Nada responde en $GEMMA_URL: hasta que arranques llama-server la búsqueda es sólo por palabras."
else
  # Apagada del todo: sin servidor, cada búsqueda esperaría el timeout del embedder para nada.
  EMBEDDINGS_OFF=1
  if [ -n "$CAN_GEMMA" ]; then
    say "  Búsqueda sólo por palabras. Para buscar por significado: vuelve a ejecutar esto con --embeddings gemma."
  else
    say "  Búsqueda sólo por palabras. Para buscar por significado: instala llama.cpp (llama-server) y vuelve a ejecutar esto."
  fi
fi

NEW_EMBED=""
[ "$EMBED_CHOICE" = gemma ] && NEW_EMBED=embeddinggemma-2
[ "$EMBED_CHOICE" = custom ] && NEW_EMBED="$PREV_EMBED"
if [ -n "$PREV_EMBED" ] && [ -n "$NEW_EMBED" ] && [ "$PREV_EMBED" != "$NEW_EMBED" ]; then
  say "  Cambia el modelo de embeddings: las memorias se reindexan solas en el siguiente backfill; para hacerlo ya: $RUN mismem-embed"
fi

# ---------------------------------------------------------------- 4. env y lanzador

step "Guardando la configuración"
mkdir -p "$CONF_DIR" "$BIN_DIR" "$(dirname "$DB")"
(
  umask 077
  tmp="$(mktemp "$CONF_DIR/env.XXXXXX")"
  {
    say "# Generado por scripts/install.sh de misMEM. Lo lee $RUN."
    printf 'MISMEM_DB=%q\n' "$DB"
    if [ -n "$EMBED_KEEP" ] || [ "$EMBED_CHOICE" = off ]; then
      # Lo que ya había se copia tal cual (también al apagar la búsqueda, que no tiene por qué borrarlo): el
      # instalador sólo reescribe esto cuando se elige otro modelo. Lo que el motor anterior resolvía solo y
      # el nuevo resolvería distinto se deja escrito.
      PREV_NOMIC=""
      case "${PREV_EMBED:-nomic-embed-text}" in nomic-embed-text*) PREV_NOMIC=1 ;; esac
      PREV_GEMMA_FAMILY=""
      case "$(printf '%s' "$PREV_EMBED" | tr '[:upper:]' '[:lower:]')" in *embeddinggemma*) PREV_GEMMA_FAMILY=1 ;; esac
      for v in $EMBED_VARS; do
        val="$(prev "$v")"
        if [ "$v" = MISMEM_EMBEDDING_MIN_SCORE ] && ! engine_number "$val" &&
          { [ -n "$PREV_GEMMA_FAMILY" ] || { [ "$PREV_KIND" != gemma ] && [ -n "$PREV_NOMIC" ]; }; }; then
          # Sin corte válido, el motor anterior daba 0,65 a nomic y 0,5 al resto; el nuevo da 0,65 a la
          # familia EmbeddingGemma y 0,5 al resto.
          if [ -n "$PREV_GEMMA_FAMILY" ]; then printf '%s=0.5\n' "$v"; else printf '%s=0.65\n' "$v"; fi
        elif [ -n "$val" ]; then
          printf '%s=%q\n' "$v" "$val"
        elif defined "$v"; then
          # Definida y vacía es una elección (un prefijo vacío apaga el de EmbeddingGemma): se copia vacía.
          printf '%s=\n' "$v"
        elif [ -n "$PREV_GEMMA_FAMILY" ] &&
          { [ "$v" = MISMEM_EMBEDDING_QUERY_PREFIX ] || [ "$v" = MISMEM_EMBEDDING_DOC_PREFIX ]; }; then
          # EmbeddingGemma configurado a mano sin prefijos se indexó sin ellos; el defecto nuevo los pondría.
          printf '%s=\n' "$v"
        elif [ "$v" = MISMEM_EMBEDDING_URL ] && [ "$PREV_KIND" != gemma ]; then
          # Sin URL propia, el motor resolvía una por su cuenta; se deja escrita para no cambiar de servidor.
          printf '%s=%q\n' "$v" "$PREV_RESOLVED_URL"
        elif [ "$v" = MISMEM_EMBEDDING_MODEL ] && [ "$PREV_KIND" != gemma ]; then
          # Sin modelo, el motor anterior usaba nomic-embed-text; el nuevo pondría EmbeddingGemma 2, que ese
          # servidor no tiene.
          printf '%s=%q\n' "$v" nomic-embed-text
        fi
      done
    elif [ "$EMBED_CHOICE" = gemma ]; then
      # Prefijos y corte son los medidos para este modelo (issue #72, README).
      printf 'MISMEM_EMBEDDING_URL=%q\n' "$GEMMA_URL"
      printf 'MISMEM_EMBEDDING_MODEL=embeddinggemma-2\n'
      printf 'MISMEM_EMBEDDING_QUERY_PREFIX=%q\n' "task: search result | query: "
      printf 'MISMEM_EMBEDDING_DOC_PREFIX=%q\n' "title: none | text: "
      printf 'MISMEM_EMBEDDING_MIN_SCORE=0.65\n'
    fi
    [ -n "$EMBEDDINGS_OFF" ] && printf 'MISMEM_EMBEDDINGS=off\n'
    if [ "$PROVIDER" != none ]; then
      printf 'MISMEM_LLM_PROVIDER=%q\n' "$PROVIDER"
      [ -n "$API_KEY" ] && printf '%s=%q\n' "$KEY_VAR" "$API_KEY"
      [ -n "$BASE_URL" ] && printf 'MISMEM_LLM_BASE_URL=%q\n' "$BASE_URL"
      [ -n "$MODEL" ] && printf 'MISMEM_CONSOLIDATION_MODEL=%q\n' "$MODEL"
    fi
    true
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
)
say "  $ENV_FILE (sólo tu usuario puede leerlo)"

cat >"$RUN" <<EOF
#!/usr/bin/env bash
# Generado por scripts/install.sh de misMEM: carga $ENV_FILE y lanza un binario de misMEM.
#   mismem-run mismem | mismem-http | mismem-inject | mismem-used | mismem-consolidate | ...
set -euo pipefail
set -a
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
set +a
cmd="\${1:-mismem}"
[ \$# -gt 0 ] && shift
case "\$cmd" in
  mismem) file=server.js ;;
  mismem-http) file=server-http.js ;;
  mismem-inject) file=inject-cli.js ;;
  mismem-used) file=used-cli.js ;;
  mismem-consolidate) file=consolidate-cli.js ;;
  mismem-forget) file=forget-cli.js ;;
  mismem-stats) file=stats-cli.js ;;
  mismem-embed) file=embed-cli.js ;;
  mismem-ingest) file=ingest-cli.js ;;
  mismem-obsidian) file=obsidian-cli.js ;;
  *) echo "mismem-run: comando desconocido: \$cmd" >&2; exit 64 ;;
esac
exec "$NODE" "$DIST/\$file" "\$@"
EOF
chmod 755 "$RUN"
say "  $RUN"

# ---------------------------------------------------------------- 5. clientes

# json_edit FICHERO: aplica el JS de $EDIT a `config` (el JSON, o {} si no existe) y lo
# escribe de forma atómica. Un JSON roto no se pisa: se avisa y se sigue.
json_edit() {
  FILE="$1" RUN="$RUN" "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const file = process.env.FILE, run = process.env.RUN;
    let config = {};
    if (fs.existsSync(file)) {
      try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.error(`  ! ${file} no es JSON válido; no lo toco.`); process.exit(3); }
    }
    const result = new Function("config", "run", process.env.EDIT)(config, run);
    if (result === "skip") process.exit(4);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.mismem-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmp, file);
  '
}

detected() {
  case "$1" in
    claude-code) command -v claude >/dev/null 2>&1 ;;
    opencode) command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ] ;;
    claude-desktop) [ -d "$HOME/.config/Claude" ] ;;
    vscode) [ -d "$HOME/.config/Code" ] ;;
    cursor) [ -d "$HOME/.cursor" ] ;;
  esac
}

ALL_CLIENTS="claude-code opencode claude-desktop vscode cursor"
case "$CLIENTS" in
  all) CLIENTS="$ALL_CLIENTS" ;;
  none) CLIENTS="" ;;
  "")
    CLIENTS=""
    for c in $ALL_CLIENTS; do detected "$c" && CLIENTS="$CLIENTS $c"; done
    ;;
  *) CLIENTS="${CLIENTS//,/ }" ;;
esac

step "Clientes"
[ -n "${CLIENTS// /}" ] || say "  Ninguno detectado. Puedes elegirlos con --clients."
CONFIGURED=""
for client in $CLIENTS; do
  confirm "Configurar misMEM en $client?" y || continue
  case "$client" in
    claude-code)
      if ! command -v claude >/dev/null 2>&1; then
        warn "claude no está en el PATH; no puedo registrar el MCP en Claude Code."
        continue
      fi
      claude mcp remove -s user mismem >/dev/null 2>&1 || true
      claude mcp add -s user mismem -- "$RUN" mismem >/dev/null
      say "  Claude Code: MCP 'mismem' registrado para tu usuario."
      hooks="${MISMEM_INSTALL_HOOKS:-}"
      # La versión de npm puede ir por detrás del repo y no traer los hooks todavía.
      if [ ! -f "$DIST/inject-cli.js" ] || [ ! -f "$DIST/used-cli.js" ]; then
        warn "Esta versión de misMEM no trae los hooks (mismem-inject, mismem-used); instálala desde el repo para tenerlos."
        hooks=no
      fi
      if [ -z "$hooks" ]; then
        say "  Los hooks adelantan recuerdos relevantes en cada prompt (que viajan al modelo) y"
        say "  refuerzan los que la respuesta usa."
        confirm "  ¿Activarlos?" y && hooks=yes || hooks=no
      fi
      if [ "$hooks" = yes ]; then
        EDIT='
          const hooks = (config.hooks ??= {});
          const mine = (h) => (h.hooks ?? []).some((x) => String(x.command ?? "").includes(run));
          const other = (h) => (h.hooks ?? []).some((x) => /mismem-(inject|used|hook)/.test(String(x.command ?? "")) && !mine(h));
          if ([...(hooks.UserPromptSubmit ?? []), ...(hooks.Stop ?? [])].some(other)) return "skip";
          for (const [event, cmd, timeout] of [["UserPromptSubmit", "mismem-inject", 10], ["Stop", "mismem-used", 15]]) {
            hooks[event] = (hooks[event] ?? []).filter((h) => !mine(h));
            hooks[event].push({ hooks: [{ type: "command", command: `"${run}" ${cmd}`, timeout }] });
          }' json_edit "$HOME/.claude/settings.json" && say "  Claude Code: hooks de inyección y refuerzo activados." || {
          [ $? -eq 4 ] && warn "Ya hay hooks de misMEM configurados de otra forma en ~/.claude/settings.json; no los duplico."
          true
        }
      fi
      ;;
    opencode)
      if [ -f "$HOME/.config/opencode/opencode.jsonc" ] && [ ! -f "$HOME/.config/opencode/opencode.json" ]; then
        warn "opencode usa opencode.jsonc (con comentarios): añade a mano en \"mcp\": \"mismem\": {\"type\": \"local\", \"command\": [\"$RUN\", \"mismem\"], \"enabled\": true}"
        continue
      fi
      EDIT='
        const mcp = (config.mcp ??= {});
        const current = JSON.stringify(mcp.mismem?.command ?? null);
        if (mcp.mismem && !current.includes(run) && process.env.REPLACE !== "yes") return "skip";
        mcp.mismem = { type: "local", command: [run, "mismem"], enabled: true };' \
        REPLACE="${REPLACE_EXISTING:-no}" json_edit "$HOME/.config/opencode/opencode.json" && say "  opencode: MCP 'mismem' en opencode.json." || {
        [ $? -eq 4 ] && warn "opencode ya tiene un MCP 'mismem' con otro comando; no lo cambio (REPLACE_EXISTING=yes para reemplazarlo)."
        true
      }
      ;;
    claude-desktop)
      EDIT='(config.mcpServers ??= {}).mismem = { command: run, args: ["mismem"] };' \
        json_edit "$HOME/.config/Claude/claude_desktop_config.json" && say "  Claude Desktop: MCP 'mismem' configurado."
      ;;
    vscode)
      EDIT='(config.servers ??= {}).mismem = { type: "stdio", command: run, args: ["mismem"] };' \
        json_edit "$HOME/.config/Code/User/mcp.json" && say "  VS Code: MCP 'mismem' en mcp.json del usuario."
      ;;
    cursor)
      EDIT='(config.mcpServers ??= {}).mismem = { command: run, args: ["mismem"] };' \
        json_edit "$HOME/.cursor/mcp.json" && say "  Cursor: MCP 'mismem' en ~/.cursor/mcp.json."
      ;;
    *) warn "Cliente desconocido: $client" ; continue ;;
  esac
  CONFIGURED="$CONFIGURED $client"
done

# ---------------------------------------------------------------- 6. consolidación nocturna

if [ "$PROVIDER" != none ] && [ "$TIMER" != no ] && command -v systemctl >/dev/null 2>&1 &&
  systemctl --user show-environment >/dev/null 2>&1; then
  step "Consolidación nocturna"
  if [ -z "$TIMER" ]; then
    confirm "¿Consolidar cada noche a las 4:00 con un timer de systemd de usuario?" n && TIMER=yes || TIMER=no
  fi
  if [ "$TIMER" = yes ]; then
    mkdir -p "$UNIT_DIR"
    cat >"$UNIT_DIR/mismem-consolidate.service" <<EOF
[Unit]
Description=misMEM: consolidar episodios en memorias

[Service]
Type=oneshot
ExecStart=$RUN mismem-consolidate
EOF
    cat >"$UNIT_DIR/mismem-consolidate.timer" <<'EOF'
[Unit]
Description=misMEM: consolidación nocturna

[Timer]
OnCalendar=*-*-* 04:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now mismem-consolidate.timer >/dev/null
    say "  Timer activo: $(systemctl --user list-timers mismem-consolidate.timer --no-legend | awk '{print $1, $2, $3}')"
  fi
fi

# ---------------------------------------------------------------- 7. comprobación

step "Comprobación"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh","version":"0"}}}'
if printf '%s\n' "$INIT" | timeout 20 "$RUN" mismem 2>/dev/null | grep -q '"serverInfo"'; then
  say "  El servidor MCP responde."
else
  warn "El servidor MCP no respondió al initialize; prueba a mano: $RUN mismem"
fi
"$RUN" mismem-stats >/dev/null 2>&1 && say "  La base abre bien: $DB" || warn "mismem-stats falló; revisa $ENV_FILE"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  Nota: $BIN_DIR no está en tu PATH; los clientes no lo necesitan, pero para usar mismem-run a mano añádelo." ;;
esac

step "Listo"
say "  Clientes configurados:${CONFIGURED:- ninguno}"
say "  Reinícialos para que carguen misMEM. La interfaz: $RUN mismem-http y abre http://127.0.0.1:3200/viewer"
