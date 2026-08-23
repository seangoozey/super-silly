// Autolife server plugin entry point for SillyTavern.
// Layout when installed:  <SillyTavern>/plugins/autolife/{index.js, src/*}
// Provides: the autonomous engine (schedule-driven texting sim), Telegram
// bridge, HTTP routes + SSE for the paired UI extension.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './src/engine.js';
import { OllamaClient } from './src/llm.js';
import { LlamaCppClient } from './src/llamacpp.js';
import { ChatStore } from './src/chat-store.js';
import { CardRegistry } from './src/cards.js';
import { StateStore } from './src/state.js';
import { TelegramTransport } from './src/telegram.js';
import { createCommandRegistry } from './src/commands.js';
import { registerRoutes } from './src/routes.js';
import { MemoryStore } from './src/memory.js';
import { startOllamaShim } from './src/ollama-shim.js';
import { PromptLog } from './src/prompt-log.js';

const log = (m) => console.log(`[Autolife] ${m}`);

// Locate the SillyTavern root by walking up from this plugin directory until
// we hit server.js. We try both the literal import path and its realpath
// (Node resolves symlinks for module URLs, which breaks naive "../.." math).
function findStRoot(startDir) {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const moduleUrl = fileURLToPath(import.meta.url);
const ST_ROOT = process.env.AUTOLIFE_ST_ROOT
    || findStRoot(path.dirname(moduleUrl))
    || findStRoot(path.dirname(fs.realpathSync(moduleUrl)))
    || path.resolve(path.dirname(moduleUrl), '..', '..');

const DATA_ROOT = process.env.AUTOLIFE_DATA_ROOT || path.join(ST_ROOT, 'data');
const USER_HANDLE = process.env.AUTOLIFE_USER || 'default-user';
const USER_DIR = path.join(DATA_ROOT, USER_HANDLE);

fs.mkdirSync(path.join(USER_DIR, 'autolife', 'state'), { recursive: true });
fs.mkdirSync(path.join(USER_DIR, 'autolife', 'memory'), { recursive: true });
fs.mkdirSync(path.join(USER_DIR, 'characters'), { recursive: true });

// Pre-connect the web UI to Ollama: fresh ST boots with AI Horde selected and
// no model, so manual web chatting fails with "No Horde model selected".
// Only touches the untouched default; any deliberate API choice is left alone.
// (llama.cpp backend: skip — its server is lazy and the UI connection is
// configured by hand as a Custom OpenAI-compatible source when needed.)
const BACKEND = (process.env.AUTOLIFE_BACKEND ?? 'ollama').toLowerCase();

function seedWebUiConnection() {
    if (BACKEND === 'llamacpp' || BACKEND === 'llama.cpp') return;
    try {
        const p = path.join(USER_DIR, 'settings.json');
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (s.main_api === 'koboldhorde' && !(s.horde_settings?.models ?? []).length) {
            s.main_api = 'textgenerationwebui';
            s.textgeneration_settings = { ...(s.textgeneration_settings ?? {}), api_server: 'ollama' };
            fs.writeFileSync(p, JSON.stringify(s, null, 4));
            log('web UI pre-connected: Text Completion -> Ollama (http://127.0.0.1:11434)');
        }
    } catch { /* settings.json not written yet on very first boot — entrypoint backstop covers it */ }
}
seedWebUiConnection();

const store = new StateStore(path.join(USER_DIR, 'autolife'));
let ollamaShim = null; // Ollama-API shim for ST's web UI (llamacpp backend)
// full prompt/response capture for debugging repeats — clients check the
// enabled flag per record, so it costs nothing while off
const promptLog = new PromptLog(path.join(USER_DIR, 'autolife', 'promptlog'), {
    getSettings: () => store.loadSettings(),
    log,
});
const chatStore = new ChatStore({ dataRoot: DATA_ROOT, userHandle: USER_HANDLE });
const cards = new CardRegistry(path.join(USER_DIR, 'characters'));
// Backend switch (env): 'ollama' (default) or 'llamacpp' — needed for Qwen3.5
// models (Dark-Scarlett) that Ollama can't load, plus top_n_sigma/XTC samplers.
// The variable is named `ollama` everywhere downstream because it's the
// engine's backend handle; both clients expose the same method surface.
const ollama = (BACKEND === 'llamacpp' || BACKEND === 'llama.cpp')
    ? new LlamaCppClient({ log, modelsDir: process.env.LLAMACPP_MODELS })
    : new OllamaClient({ baseUrl: process.env.OLLAMA_URL, log });
if (ollama.manager) {
    log(`backend: llama.cpp — models in ${ollama.modelsDir}, llama-server on :${ollama.manager.chatPort} (chat) / :${ollama.manager.embedPort} (embed)`);
    // SillyTavern's web UI talks Ollama on :11434 — put a translating shim
    // there so its existing connection keeps working (model list, streaming
    // chat) and web requests can wake the lazy llama-server too.
    startOllamaShim({ client: ollama, log }).then((shim) => { ollamaShim = shim; });
    // Warm the current model in the background (download if needed, load into
    // VRAM, run the template probe): the web UI connects green ~immediately
    // and the first texts of the day don't pay the load time.
    const warmUp = async () => {
        try {
            const model = store.loadSettings().model?.current;
            if (!model) return;
            log(`warming up ${model} — downloading if needed, then loading into VRAM`);
            const ok = await ollama.ensureModel(model).catch(() => false);
            if (!ok) return log(`warm-up: "${model}" could not be downloaded — pull it via the panel or /model pull`);
            await ollama.chat({ model, messages: [{ role: 'user', content: 'ready?' }], numPredict: 1 });
            log(`warm-up complete — ${model} resident`);
        } catch (err) {
            log(`warm-up skipped: ${err.message}`);
        }
    };
    warmUp();
}
const memory = new MemoryStore(path.join(USER_DIR, 'autolife', 'memory'), (m) => log(`memory: ${m}`));
ollama.promptLog = promptLog;

// ---- SSE hub (feeds the UI extension and mirrors engine events) ----
const sseClients = new Set();
function broadcast(type, data) {
    const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(payload);
        } catch {
            sseClients.delete(res);
        }
    }
}
function addSseClient(res) {
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
}

// ---- engine + telegram ----
const engine = new Engine({ cards, store, chatStore, ollama, memory, log, emit: broadcast, userDir: USER_DIR });
engine.transports = [];

// One transport per configured bot (the shared "default" bot plus any extra
// per-character bots from settings.telegram.bots). Commands are bound late to
// their own bot's transport, so /switch etc. operate on the bot that received
// them and each bot's chat bindings stay fully separated.
const live = { transports: [] };

function makeCommandCtx() {
    const holder = { transport: null };
    return {
        ctx: new Proxy({ engine, cards, store, chatStore, memory, log }, {
            get(target, prop) {
                if (prop === 'transport') return holder.transport;
                return target[prop];
            },
        }),
        holder,
    };
}

const transportView = {
    get enabled() {
        return live.transports.some((t) => t.enabled);
    },
    get count() {
        return live.transports.filter((t) => t.enabled).length;
    },
};

function startTransport() {
    stopTransport();
    const settings = store.loadSettings();
    const botDefs = [
        { name: 'default', token: settings.telegram?.token, allowed: settings.telegram?.allowed_chat_ids ?? [] },
        ...(settings.telegram?.bots ?? []).map((b) => ({ name: String(b.name ?? 'bot'), token: b.token, allowed: b.allowed_chat_ids ?? [] })),
    ];
    live.transports = botDefs.filter((d) => d.token).map((def) => {
        const { ctx, holder } = makeCommandCtx();
        const commands = createCommandRegistry(ctx);
        const transport = new TelegramTransport({
            token: def.token,
            allowedChatIds: def.allowed,
            store,
            engine,
            cards,
            chatStore,
            commands,
            log,
            emit: broadcast,
            botName: def.name,
        });
        holder.transport = transport;
        return transport;
    });
    engine.transports = live.transports;
    for (const t of live.transports) t.start();
    const names = live.transports.map((t) => t.botName).join(', ');
    log(`telegram bots running: ${live.transports.length} (${names})`);
}

function stopTransport() {
    for (const t of live.transports) t.stop();
    live.transports = [];
    engine.transports = [];
}

// ---- plugin lifecycle ----

async function init(router) {
    registerRoutes(router, {
        engine,
        store,
        cards,
        chatStore,
        ollama,
        memory,
        transport: transportView,
        charactersDir: cards.dir,
        userDir: USER_DIR,
        promptLog,
        broadcast,
        addSseClient,
        restartTransport: startTransport,
        log,
    });
    engine.start();
    startTransport();
    const count = cards.autolifeCharacters().length;
    log(`ready — ${count} autolife character(s), data at ${USER_DIR}`);
}

async function exit() {
    engine.stop();
    stopTransport();
    ollamaShim?.close();
    ollama.manager?.stop();
    for (const res of sseClients) {
        try {
            res.end();
        } catch { /* already closed */ }
    }
    sseClients.clear();
    log('stopped');
}

export const info = {
    id: 'autolife',
    name: 'Autolife',
    description: 'Characters with schedules and a life of their own — autonomous replies, initiative, Telegram bridge.',
};

export { init, exit };
export default { init, exit, info };
