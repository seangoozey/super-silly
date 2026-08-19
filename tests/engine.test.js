import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../plugin/src/engine.js';
import { CardRegistry } from '../plugin/src/cards.js';
import { StateStore } from '../plugin/src/state.js';
import { ChatStore } from '../plugin/src/chat-store.js';
import { MemoryStore, messageKey } from '../plugin/src/memory.js';
import { normalizeAutolife } from '../plugin/src/autolife-schema.js';

// ---------------------------------------------------------------- helpers

function makeRng(values = []) {
    const queue = [...values];
    return { float: () => (queue.length ? queue.shift() : 0.999) };
}

function tmpUserDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autolife-test-'));
    return root;
}

function characterCard(name, autolifeOverrides = {}) {
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

function buildHarness({ card, now = new Date(Date.UTC(2026, 0, 15, 14, 0)), rngValues = [], reply = 'totally, what time?' } = {}) {
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
    const ollama = {
        hasModel: async () => true,
        chat: async (req) => {
            chatCalls.push(req.messages);
            return reply;
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
    });
    return { engine, cards, store, chatStore, memory, clock, delivered, composing, events, root, chatCalls };
}

async function lastCharMessage(chatStore, character, state) {
    const msgs = chatStore.readMessages(character, state.chatFile);
    return [...msgs].reverse().find((m) => !m.is_user) ?? null;
}

function stateOf(store, name) {
    return store.loadState(name, { initialRelationship: 20 });
}

// 2026-01-15 14:00 UTC — Thursday afternoon, character is FREE per card above.

test('inbound quick reply: decides, generates, writes chat, delivers', async () => {
    const card = characterCard('Quinn');
    const rngValues = [0.99, 0.0]; // ignore roll fails, quick roll passes
    const h = buildHarness({ card, rngValues });

    await h.engine.onInbound({ character: 'Quinn', mes: 'wanna get pizza tonight?', source: 'telegram' });

    const state = stateOf(h.store, 'Quinn');
    assert.ok(state.chatFile, 'chat created');
    const msgs = h.chatStore.readMessages('Quinn', state.chatFile);
    // greeting + user msg + char reply
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].is_user, false);
    assert.equal(msgs[1].mes, 'wanna get pizza tonight?');
    assert.equal(msgs[1].is_user, true);
    assert.equal(msgs[2].mes, 'totally, what time?');
    assert.equal(msgs[2].extra.autolife_kind, 'reply');
    assert.ok(msgs[2].send_date);
    assert.deepEqual(h.delivered, [{ character: 'Quinn', text: 'totally, what time?' }]);
    assert.ok(h.composing.includes('Quinn'));
    // relationship went up (+1 message, +2 not applicable)
    assert.equal(state.relationship, 21);
});

test('inbound while busy: delayed reply fires on a later tick', async () => {
    const card = characterCard('Delia');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0)); // Thu 10:00 UTC — free per card
    const rngValues = [0.99, 0.99]; // no ignore, no quick -> delayed
    const h = buildHarness({ card, now: start, rngValues });

    await h.engine.onInbound({ character: 'Delia', mes: 'you there?', source: 'telegram' });
    let state = stateOf(h.store, 'Delia');
    assert.ok(state.pendingReply, 'reply scheduled');
    assert.equal(h.delivered.length, 0);

    // a second inbound while pending must not re-roll
    await h.engine.onInbound({ character: 'Delia', mes: 'hello??', source: 'telegram' });
    state = stateOf(h.store, 'Delia');
    assert.ok(state.pendingReply);

    // advance clock 5 hours and tick — pending reply fires
    h.clock.now = new Date(start.getTime() + 5 * 3600_000);
    await h.engine.tick(h.clock.now);
    state = stateOf(h.store, 'Delia');
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 1);
    const msgs = h.chatStore.readMessages('Delia', state.chatFile);
    assert.equal(msgs.filter((m) => !m.is_user).length, 2); // greeting + reply
});

test('inbound ignored at low-probability roll: no reply, catch-up later', async () => {
    const card = characterCard('Ivy');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0));
    const h = buildHarness({ card, now: start, rngValues: [0.0] }); // ignore roll passes
    await h.engine.onInbound({ character: 'Ivy', mes: 'ping', source: 'telegram' });

    let state = stateOf(h.store, 'Ivy');
    assert.ok(state.ignoredAt);
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 0);

    // ticks soon after: no catch-up yet (<45 min), journal/initiative disabled by default rng
    await h.engine.tick(new Date(start.getTime() + 30 * 60_000));
    assert.equal(h.delivered.length, 0);

    // after 90 minutes (free): catch-up fires
    await h.engine.tick(new Date(start.getTime() + 90 * 60_000));
    state = stateOf(h.store, 'Ivy');
    assert.equal(state.ignoredAt, null);
    assert.equal(h.delivered.length, 1);
});

test('initiative: fires when enabled, respects max_per_day and sleep', async () => {
    const card = characterCard('Rico', { initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 1, followup_on_unread_hours: 0 } });
    const start = new Date(Date.UTC(2026, 0, 15, 12, 0)); // free time
    const h = buildHarness({ card, now: start, rngValues: [0.0] }); // initiative roll passes

    await h.engine.tick(start);
    let state = stateOf(h.store, 'Rico');
    assert.equal(h.delivered.length, 1, 'initiative message sent');
    assert.ok(state.lastInitiativeAt);
    assert.equal(state.initiativeDay.count, 1);

    // another tick same day: max_per_day = 1 blocks further initiative
    const rng2 = makeRng([0.0]);
    h.engine.rng = rng2;
    await h.engine.tick(new Date(start.getTime() + 3 * 3600_000));
    state = stateOf(h.store, 'Rico');
    assert.equal(state.initiativeDay.count, 1);
    assert.equal(h.delivered.length, 1);

    // at 04:00 UTC the character is asleep — no initiative even with a passing roll
    h.engine.rng = makeRng([0.0]);
    const nextDay = new Date(Date.UTC(2026, 0, 16, 4, 0));
    await h.engine.tick(nextDay);
    state = stateOf(h.store, 'Rico');
    assert.equal(state.initiativeDay.count, 1, 'still blocked by daily cap');
});

test('memory RAG: old texts get recalled into reply prompts', async () => {
    const card = characterCard('Remmy');
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'on it' });

    // an "old" message from weeks ago, already in the memory index
    const oldText = 'we finally booked the italy flights for the spring trip';
    const oldTs = '2026-07-01T12:00:00.000Z';
    h.memory.append('Remmy', {
        ts: oldTs,
        role: 'user',
        text: oldText,
        vec: await Promise.resolve(fakeVec('italy italy italy')),
        chatFile: 'old.jsonl',
        key: messageKey(oldTs, 'user', oldText),
    }, 'nomic-embed-text');

    // the fake ollama embeds with italy/pizza/work dims; the harness ollama
    // uses the same scheme, so a new message about italy retrieves the old one
    function fakeVec(text) {
        const t = String(text).toLowerCase();
        const v = [(t.match(/italy/g) ?? []).length, (t.match(/pizza/g) ?? []).length, (t.match(/work/g) ?? []).length];
        const n = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
        return v.map((x) => x / n);
    }

    await h.engine.onInbound({ character: 'Remmy', mes: 'hey did we ever finish the italy itinerary?', source: 'telegram' });

    // reply generated; the last chat call should contain a system message with the old text
    assert.ok(h.chatCalls.length >= 1);
    const lastCall = h.chatCalls[h.chatCalls.length - 1];
    const memMsg = lastCall.find((m) => m.role === 'system' && m.content.includes('from your own memory'));
    assert.ok(memMsg, 'memory context block present in prompt');
    assert.ok(memMsg.content.includes('italy flights'));
    // and the recall was audited
    assert.ok(h.store.readAudit('Remmy', 50).some((a) => a.kind === 'memory' && /recalled 1 older text/.test(a.text)));
    // both the old user message and the new exchange got indexed
    assert.ok(h.memory.count('Remmy', 'nomic-embed-text') >= 3);
});

test('applyBootPolicy stops everyone on server start (unless disabled)', async () => {
    const card = characterCard('Boota');
    const h = buildHarness({ card });
    let state = stateOf(h.store, 'Boota');
    state.enabled = true;
    h.store.saveState(state);

    const stopped = h.engine.applyBootPolicy();
    assert.equal(stopped, 1);
    state = stateOf(h.store, 'Boota');
    assert.equal(state.enabled, false);

    // policy off -> characters keep running across restarts
    h.engine.settings.engine.start_stopped = false;
    state.enabled = true;
    h.store.saveState(state);
    assert.equal(h.engine.applyBootPolicy(), 0);
    assert.equal(stateOf(h.store, 'Boota').enabled, true);
});

test('persona name resolves from SillyTavern chat headers, not the placeholder', async () => {
    const card = characterCard('Namer');
    const h = buildHarness({ card });
    // engine-created chats carry the default 'User' — resolution must skip those
    await h.engine.onInbound({ character: 'Namer', mes: 'hello', source: 'telegram' });

    // a web-style chat written by ST itself with the real persona name
    const chatDir = h.chatStore.chatDir('Namer');
    const webChat = `${chatDir}${path.sep}web.jsonl`.split(path.sep).join(path.sep);
    h.chatStore.appendMessage('Namer', 'web.jsonl', h.chatStore.userMessage('hi', new Date()));
    // rewrite that file's header to look like an ST-authored chat with persona 'Sean'
    const full = path.join(chatDir, 'web.jsonl');
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines[0] = JSON.stringify({ chat_metadata: {}, user_name: 'Sean', character_name: 'Namer' });
    fs.writeFileSync(full, lines.join('\n'), 'utf8');

    assert.equal(h.chatStore.resolveUserName(), 'Sean');
    h.engine.refreshSettings();
    assert.equal(h.chatStore.userName, 'Sean');
});

test('status() summarizes life state', async () => {
    const card = characterCard('Sasha');
    const h = buildHarness({ card });
    const s = h.engine.status();
    assert.equal(s.running, false); // never started
    assert.equal(s.characters.length, 1);
    const c = s.characters[0];
    assert.equal(c.name, 'Sasha');
    assert.ok(c.availability > 0); // free time
    assert.ok(c.localTime.includes('UTC'));
});

test('failed delayed reply retries with backoff and audits each step', async () => {
    const card = characterCard('Flint');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0));
    const h = buildHarness({ card, now: start, rngValues: [0.99, 0.99] }); // -> delayed

    await h.engine.onInbound({ character: 'Flint', mes: 'you up?', source: 'telegram' });
    let state = stateOf(h.store, 'Flint');
    assert.ok(state.pendingReply);
    assert.equal(state.pendingReply.attempts, 0);

    // make generation fail
    h.engine.ollama.chat = async () => { throw new Error('model exploded'); };
    h.clock.now = new Date(start.getTime() + 5 * 3600_000); // past due
    await h.engine.tick(h.clock.now);

    state = stateOf(h.store, 'Flint');
    assert.ok(state.pendingReply, 'reply re-pended after failure');
    assert.equal(state.pendingReply.attempts, 1);
    const audit = h.store.readAudit('Flint', 50).map((a) => a.kind);
    assert.ok(audit.includes('deferred'));
    assert.ok(audit.includes('pending_fired'));
    assert.ok(audit.includes('gen_failed'));
    assert.ok(audit.includes('gen_retry'));
    assert.equal(h.delivered.length, 0);

    // recovery: generation works again, second attempt fires and delivers
    h.engine.ollama.chat = async () => 'back online, sorry!';
    h.clock.now = new Date(state.pendingReply.dueAt.getTime ? state.pendingReply.dueAt : new Date(state.pendingReply.dueAt));
    h.clock.now = new Date(new Date(state.pendingReply.dueAt).getTime() + 1000);
    await h.engine.tick(h.clock.now);
    state = stateOf(h.store, 'Flint');
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 1);
    assert.ok(h.store.readAudit('Flint', 50).some((a) => a.kind === 'sent'));
});

test('initiative blocks are visible in status', async () => {
    const card = characterCard('Nora', { initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 1, followup_on_unread_hours: 0 } });
    const h = buildHarness({ card });
    let s = h.engine.status();
    let n = s.characters[0];
    assert.equal(n.initiative.blockedReason, null); // eligible

    // send a message that gets a quick reply -> then "just messaged" blocks initiative
    h.engine.rng = makeRng([0.99, 0.0]);
    await h.engine.onInbound({ character: 'Nora', mes: 'hi', source: 'telegram' });
    s = h.engine.status();
    n = s.characters[0];
    assert.match(n.initiative.blockedReason, /less than 20 min/);
});
