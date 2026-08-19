// Autolife server plugin entry point for SillyTavern.
// Layout when installed:  <SillyTavern>/plugins/autolife/{index.js, src/*}
// Provides: the autonomous engine (schedule-driven texting sim), Telegram
// bridge, HTTP routes + SSE for the paired UI extension.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './src/engine.js';
import { OllamaClient } from './src/llm.js';
import { ChatStore } from './src/chat-store.js';
import { CardRegistry } from './src/cards.js';
import { StateStore } from './src/state.js';
import { TelegramTransport } from './src/telegram.js';
import { createCommandRegistry } from './src/commands.js';
import { registerRoutes } from './src/routes.js';
import { MemoryStore } from './src/memory.js';

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
function seedWebUiConnection() {
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
const chatStore = new ChatStore({ dataRoot: DATA_ROOT, userHandle: USER_HANDLE });
const cards = new CardRegistry(path.join(USER_DIR, 'characters'));
const ollama = new OllamaClient({ baseUrl: process.env.OLLAMA_URL, log });
const memory = new MemoryStore(path.join(USER_DIR, 'autolife', 'memory'), (m) => log(`memory: ${m}`));

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
const engine = new Engine({ cards, store, chatStore, ollama, memory, log, emit: broadcast });
engine.transports = [];

// commands need the transport (to reply) and the transport needs the commands
// (to dispatch) — break the cycle with a late-bound holder.
const live = { transport: null };
const commandCtx = new Proxy({ engine, cards, store, chatStore, memory, log }, {
    get(target, prop) {
        if (prop === 'transport') return live.transport;
        return target[prop];
    },
});
const commands = createCommandRegistry(commandCtx);

// routes only need "is telegram on" — expose it dynamically
const transportView = {
    get enabled() {
        return !!live.transport?.enabled;
    },
};

function startTransport() {
    stopTransport();
    const settings = store.loadSettings();
    const transport = new TelegramTransport({
        token: settings.telegram?.token,
        allowedChatIds: settings.telegram?.allowed_chat_ids ?? [],
        store,
        engine,
        cards,
        chatStore,
        commands,
        log,
        emit: broadcast,
    });
    live.transport = transport;
    engine.transports = [transport];
    transport.start();
}

function stopTransport() {
    if (live.transport) {
        live.transport.stop();
        live.transport = null;
    }
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
