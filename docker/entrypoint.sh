#!/bin/bash
# super-silly container entrypoint:
#   1. seed config/data volumes (first boot), run SillyTavern's config init
#   2. start ollama serve in the background and wait for it
#   3. pull the primary model (fallback model if that fails) in the background
#   4. start SillyTavern (which loads the Autolife server plugin)
set -e

SEED=/autolife-seed
APP=/home/node/app

log() { echo "[supersilly] $*"; }

# ---------- 1. seed volumes ----------
mkdir -p "$APP/config" "$APP/data/default-user" "$APP/plugins"

if [ ! -f "$APP/config/config.yaml" ]; then
    log "seeding config.yaml"
    cp "$SEED/seed/config.yaml" "$APP/config/config.yaml"
fi

# UI extension (per-user, lives in the data volume). Always refreshed from the
# seed so image updates reach existing volumes — this dir is plugin code, not
# user data (settings live server-side).
log "installing/refreshing Autolife UI extension"
mkdir -p "$APP/data/default-user/extensions"
rm -rf "$APP/data/default-user/extensions/autolife-ui"
cp -r "$SEED/ui" "$APP/data/default-user/extensions/autolife-ui"

# example characters on first boot (only when the user has none yet)
if [ -z "$(ls -A "$APP/data/default-user/characters" 2>/dev/null)" ]; then
    log "installing example characters (Maya, June, Marcus)"
    mkdir -p "$APP/data/default-user/characters"
    cp "$SEED"/cards/*.png "$APP/data/default-user/characters/" 2>/dev/null || true
fi

cd "$APP"
log "running SillyTavern config init"
node src/server-init.js

# Backstop for the plugin's web-UI pre-connect (covers a very first boot where
# the plugin runs before settings.json exists): re-check shortly after start.
(
    sleep 15
    node -e "
const fs = require('fs');
const p = '$APP/data/default-user/settings.json';
try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (s.main_api === 'koboldhorde' && !(s.horde_settings?.models ?? []).length) {
        s.main_api = 'textgenerationwebui';
        s.textgeneration_settings = Object.assign({}, s.textgeneration_settings, { api_server: 'ollama' });
        fs.writeFileSync(p, JSON.stringify(s, null, 4));
        console.log('[supersilly] web UI pre-connected: Text Completion -> Ollama (http://127.0.0.1:11434)');
    }
} catch (e) { /* nothing to do */ }
"
) &

# ---------- 2. ollama ----------
log "starting ollama (supervised)"
# Watchdog keeps ollama alive for the container's lifetime — on an unattended
# server a wedged/killed ollama must restart itself or the whole system goes
# quietly dark (engine retries fail into backoff, characters go silent).
(
    while true; do
        ollama serve &
        OLLAMA_PID=$!
        wait "$OLLAMA_PID"
        echo "[supersilly] ollama exited (code $?) — restarting in 5s"
        sleep 5
    done
) &

log "waiting for ollama on :11434"
for i in $(seq 1 90); do
    if curl -sf http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
        log "ollama is up ($(curl -sf http://127.0.0.1:11434/api/version 2>/dev/null || true))"
        break
    fi
    sleep 2
done

# ---------- 3. model pull (background, with fallback) ----------
(
    sleep 3
    log "pulling model: $OLLAMA_MODEL"
    if ollama pull "$OLLAMA_MODEL"; then
        log "model ready: $OLLAMA_MODEL"
    else
        log "primary model pull failed — trying fallback: $OLLAMA_FALLBACK_MODEL"
        if ollama pull "$OLLAMA_FALLBACK_MODEL"; then
            log "fallback model ready: $OLLAMA_FALLBACK_MODEL"
        else
            log "WARNING: both model pulls failed. Start manually later:  docker exec <container> ollama pull <model>"
        fi
    fi
) &

# ---------- 4. SillyTavern ----------
log "starting SillyTavern on :8000"
exec node server.js --listen
