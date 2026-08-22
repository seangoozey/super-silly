// Shared test harness: one Engine wired to tmp dirs, a deterministic fake
// Ollama-shaped backend, and a recording transport. Imported by the engine
// and presets test suites.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../plugin/src/engine.js';
import { CardRegistry } from '../plugin/src/cards.js';
import { StateStore } from '../plugin/src/state.js';
import { ChatStore } from '../plugin/src/chat-store.js';
import { MemoryStore } from '../plugin/src/memory.js';
import { normalizeAutolife } from '../plugin/src/autolife-schema.js';

export function makeRng(values = []) {
    const queue = [...values];
    return { float: () => (queue.length ? queue.shift() : 0.999) };
}

export function tmpUserDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'autolife-test-'));
}

export function characterCard(name, autolifeOverrides = {}) {
    const autolife = normalizeAutolife({
        version: '1.0',
        timezone: 'UTC',
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '02:00', end: '07:00', activity: 'asleep', availability: 0.02 }],
        initiative: { enabled: false },
        ...autolifeOverrides,
    });
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name,
            description: `Test character ${name}.`,
            personality: 'cooperative',
            scenario: 'friends who text',
            first_mes: `hey, it's ${name}. what's up?`,
            mes_example: '<START>\n{{user}}: hi\n{{char}}: hey you',
            creator_notes: 'test',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['test'],
            creator: 'tests',
            character_version: '1.0',
            group_only_greetings: [],
            extensions: { autolife },
        },
    };
}

export function buildHarness({ card, now = new Date(Date.UTC(2026, 0, 15, 14, 0)), rngValues = [], reply = 'totally, what time?' } = {}) {
    const root = tmpUserDir();
    const charactersDir = path.join(root, 'characters');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.writeFileSync(path.join(charactersDir, `${card.data.name}.json`), JSON.stringify(card));

    const cards = new CardRegistry(charactersDir);
    const store = new StateStore(path.join(root, 'autolife'));
    // ChatStore joins dataRoot/userHandle; point it at the tmp root itself
    const chatStore = new ChatStore({ dataRoot: path.dirname(root), userHandle: path.basename(root) });

    const clock = { now };
    const chatCalls = [];
    // deterministic fake embeddings: italy/pizza/work keyword dims
    const fakeEmbed = (text) => {
        const v = [0, 0, 0];
        const t = String(text).toLowerCase();
        v[0] = (t.match(/italy/g) ?? []).length;
        v[1] = (t.match(/pizza/g) ?? []).length;
        v[2] = (t.match(/work/g) ?? []).length;
        const n = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
        return v.map((x) => x / n);
    };
    const replyQueue = Array.isArray(reply) ? [...reply] : null;
    const chatReqs = [];
    const ollama = {
        hasModel: async () => true,
        chat: async (req) => {
            chatCalls.push(req.messages);
            chatReqs.push(req);
            return replyQueue ? (replyQueue.shift() ?? 'ok') : reply;
        },
        embed: async (text) => fakeEmbed(text),
    };
    const memory = new MemoryStore(path.join(root, 'memory'), () => {});
    const delivered = [];
    const composing = [];
    const events = [];
    const transport = {
        name: 'test',
        async deliver(character, text) { delivered.push({ character, text }); },
        async onComposing(character) { composing.push(character); },
    };
    const engine = new Engine({
        cards,
        store,
        chatStore,
        ollama,
        memory,
        rng: makeRng(rngValues),
        nowFn: () => clock.now,
        emit: (type, data) => events.push({ type, data }),
        transports: [transport],
        userDir: root,
    });
    return { engine, cards, store, chatStore, memory, clock, delivered, composing, events, root, chatCalls, chatReqs };
}

export function stateOf(store, name) {
    return store.loadState(name, { initialRelationship: 20 });
}
