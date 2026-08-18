# super-silly

SillyTavern + Ollama + **Autolife** in one Docker container — character cards with a schedule and a life of their own, delivered over Telegram like a texting simulator.

An Autolife character:

- has a **weekly schedule in its own timezone** (work, gym, sleep, nights out);
- **doesn't always reply** — sometimes instantly, sometimes in 40 minutes, sometimes never (with a later *"sorry, was slammed"* catch-up);
- **texts you first** — unprompted messages caused by its day, capped per day, never while asleep;
- **double-texts** if you left it on read;
- keeps a private **journal** and an evolving **relationship** score with you.

The web UI is a full SillyTavern install with an Autolife panel (card builder + life monitor). The Telegram bridge makes it a real texting sim that works 24/7 with no browser open. Chats are mirrored: everything lives in normal SillyTavern chat files.

```
Telegram you ⇄ Bot API ⇄┌──────────── one container ────────────┐
                        │ SillyTavern :8000  (+ Autolife panel) │
                        │ plugins/autolife — engine, 30s tick    │
                        │ ollama serve (127.0.0.1:11434)         │
                        └────────────────────────────────────────┘
```

## Quickstart

```bash
git clone <this repo> && cd super-silly
docker compose -f docker/docker-compose.yml up -d --build
```

First boot: the container starts Ollama, pulls the default model in the background (multi-GB — watch `docker logs -f supersilly`), and serves SillyTavern on **http://localhost:8000**. Three example characters (Maya, June, Marcus) are pre-installed.

**Dev machine with ≤16 GB VRAM** (e.g. RTX 5060): use the dev override, which runs the 12B model as primary and serves on port 8001:

```bash
docker compose -f docker/docker-compose.yml -f docker/compose.dev.yml up -d --build
```

**GPU:** install [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host, then uncomment `gpus: all` in `docker/docker-compose.yml` (or run with `--gpus all`). The image works CPU-only too — slow, but the long reply delays honestly fit the texting-sim vibe.

### Models

Defaults (override via env / `.env`):

| env | default | fits |
|---|---|---|
| `OLLAMA_MODEL` | `hf.co/ReadyArt/Dark-Scarlett-27B-v2.0-GGUF:Q4_K_M` (~17 GB) | Tesla P40 24 GB |
| `OLLAMA_FALLBACK_MODEL` | `hf.co/ReadyArt/Dark-Desires-12B-v1.0-GGUF:Q4_K_M` (~7 GB) | RTX 5060 16 GB |

Both pull directly from HuggingFace via Ollama's `hf.co/` namespace. Switch at runtime from the SillyTavern Autolife panel (**Model** section) or in Telegram (`/model list`, `/model use <name>`, `/model pull <name>`) — the engine pulls unknown models on demand.

### Telegram setup

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Get your numeric chat id (message [@userinfobot](https://t.me/userinfobot), or message your bot once and read the id from `docker logs supersilly`).
3. Either set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_IDS` in the environment, or paste them into the **Telegram** section of the Autolife panel (stored server-side only).
4. In Telegram: `/chars` → `/switch Maya` → text her like a person. `/status` shows what she's up to; `/upload` imports a `.png`/`.json` card you send as a document.

The allowlist is **fail-closed**: the bot ignores everyone not on it.

### Connect SillyTavern's UI to Ollama (optional, for manual chatting)

The Autolife engine talks to Ollama directly and needs nothing from the UI. To also chat manually in the web UI: **API Connections → Text Completion → API: Ollama → URL `http://127.0.0.1:11434` → Connect**, then pick the model.

## What's in the box

| Path | What |
|---|---|
| `spec/autolife-spec-v1.md` | **The Autolife card spec** — a formal extension on [Character Card V3](https://github.com/kwaroran/character-card-spec-v3), stored at `data.extensions.autolife`. Cards stay valid, portable CCv3 cards for every other app. |
| `plugin/` | SillyTavern **server plugin** (zero npm deps): the autonomous engine, Telegram bridge, HTTP+SSE routes. Installed at `plugins/autolife` in the image. |
| `ui/` | SillyTavern **UI extension** (Autolife panel): per-character schedule/behavior editor, life monitor, Telegram + model config. |
| `tools/card-tools.mjs` | CLI: `create` (from templates) / `embed` (card → PNG) / `validate` / `inspect`. |
| `cards/examples/` | Maya (busy friend), June (night owl), Marcus (coworker) — ready to import. |
| `docker/` | Dockerfile (Ubuntu 24.04 + Ollama + Node 22 + ST release), entrypoint, compose files, seed config. |

### Card tool quick reference

```bash
npm run card -- list-templates
npm run card -- create --name "Sam" --template night-owl --out sam.json
npm run card -- embed sam.json --avatar mypic.png -o Sam.png
npm run card -- validate Sam.png
```

Editing a character's life: open it in SillyTavern → Extensions drawer → **Autolife** → toggle enable, edit the weekly schedule grid, behavior/initiative sliders → **Save card**. The card round-trips through the plugin, preserving everything else in it.

## Deploying to TrueNAS (Tesla P40)

- TrueNAS SCALE (Electric Eel+) ships NVIDIA driver branch 550 — the **last branch supporting Pascal**. If a future update moves past it, pin the driver before upgrading.
- Use **Apps → Discover → Custom App** (or the host's docker compose) with the GPU assigned to the container; the P40 (compute 6.1) is supported by Ollama but has no tensor cores — expect modest token rates on the 27B (~17 GB Q4_K_M fits with context headroom; keep `ollama.keepAlive: -1`, already set in the seed config, so the model stays loaded).
- Mount persistent storage for `/home/node/app/config`, `/home/node/app/data`, `/root/.ollama`.
- Verify GPU visibility inside the container: `docker exec supersilly ollama ps` should show 100% GPU after a generation.

## Security notes

- `whitelistMode: false` + `listen: true` in the seed config: SillyTavern answers on your LAN **unauthenticated**. Fine on a home LAN; put it behind a reverse proxy with auth (or enable `basicAuthMode`) before exposing it further. Do **not** port-forward 8000 to the internet.
- The Telegram allowlist is mandatory and fail-closed; the bot token is stored server-side only.
- Server plugins run unsandboxed inside SillyTavern — don't mount arbitrary third-party plugins into this container.

## Development

```bash
npm test                      # engine/schedule/card-io/CLI unit tests (no deps)
docker compose -f docker/docker-compose.yml up -d --build
curl http://localhost:8000/api/plugins/autolife/status | jq
```

The plugin resolves SillyTavern's root as two directories up from `plugins/autolife` (override with `AUTOLIFE_ST_ROOT` / `AUTOLIFE_DATA_ROOT` env vars if you run it outside a container for development).

### How the engine decides (short version)

On each 30s tick per character: evaluate the schedule → current activity/availability. Inbound message → roll ignore (scaled by busyness) → else roll quick reply (scaled by availability) → else schedule a delayed reply. Separately: initiative rolls (gap + daily cap + awake), one double-text if left on read, catch-ups after missed messages, and occasional journal notes that feed later proactive messages. Full model: `spec/autolife-spec-v1.md`.

## Roadmap (Phase 2+)

Multi-message bursts · typing-speed simulation · deeper relationship tuning · journal-driven life events surfacing · group chats · media messages · Discord transport · charx asset polish · `/schedule` and `/journal` Telegram commands.

## License

TBD — pick one before publishing. (SillyTavern is AGPL-3.0; if you distribute an image containing it, AGPL applies to that composition regardless of what you choose for your own code.)
