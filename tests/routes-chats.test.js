import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../plugin/src/routes.js';
import { characterCard, buildHarness } from './helpers.js';

// Minimal express-free router capture so route handlers can be invoked
// directly with fake req/res.
function fakeRouter() {
    const routes = [];
    return {
        routes,
        get(path, handler) { routes.push(['GET', path, handler]); },
        post(path, handler) { routes.push(['POST', path, handler]); },
    };
}

function makeRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; },
    };
    return res;
}

async function call(router, method, path, req = {}) {
    const hit = router.routes.find(([m, p]) => m === method && p === path);
    if (!hit) throw new Error(`no route ${method} ${path}`);
    const res = makeRes();
    await hit[2]({ method, url: path, query: {}, body: req.body ?? undefined, ...req }, res);
    return res;
}

test('chat management routes: list, switch, and start fresh from the panel', async () => {
    const card = characterCard('Chatty');
    const h = buildHarness({ card });
    const router = fakeRouter();
    registerRoutes(router, {
        engine: h.engine,
        store: h.store,
        cards: h.cards,
        chatStore: h.chatStore,
        ollama: h.ollama,
        memory: h.memory,
        transport: { enabled: false, count: 0 },
        charactersDir: h.cards.dir,
        broadcast: () => {},
        addSseClient: () => {},
        restartTransport: () => {},
        log: () => {},
        userDir: h.root,
    });

    // first chat comes into being on demand (engine-style), then a second one
    const first = h.chatStore.createChat('Chatty', 'hey, Chatty here');
    const second = h.chatStore.createChat('Chatty', 'hey, Chatty here');

    // default active = latest; list both with counts and the active flag
    let r = await call(router, 'GET', '/chats', { query: { name: 'Chatty' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.chats.length, 2);
    const secondEntry = r.body.chats.find((c) => c.file === second);
    const firstEntry = r.body.chats.find((c) => c.file === first);
    assert.equal(secondEntry.active, true);
    assert.equal(firstEntry.messages, 1, 'message counts shown');
    assert.equal(firstEntry.active, false);

    // switch back to the first from the panel
    r = await call(router, 'POST', '/chat-file', { body: { name: 'Chatty', chatFile: first } });
    assert.equal(r.statusCode, 200);
    assert.equal(h.store.loadState('Chatty', { initialRelationship: 20 }).chatFile, first);
    r = await call(router, 'GET', '/chats', { query: { name: 'Chatty' } });
    assert.equal(r.body.chats.find((c) => c.file === first).active, true);

    // switching to a nonexistent file is rejected
    r = await call(router, 'POST', '/chat-file', { body: { name: 'Chatty', chatFile: 'ghost.jsonl' } });
    assert.equal(r.statusCode, 404);

    // fresh chat: created, seeded with the greeting, active, others intact
    r = await call(router, 'POST', '/chat/new', { body: { name: 'Chatty' } });
    assert.equal(r.statusCode, 200);
    const fresh = r.body.chatFile;
    assert.notEqual(fresh, first);
    assert.notEqual(fresh, second);
    const state = h.store.loadState('Chatty', { initialRelationship: 20 });
    assert.equal(state.chatFile, fresh);
    const msgs = h.chatStore.readMessages('Chatty', fresh);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].is_user, false, 'greeting seeded');
    assert.ok(h.chatStore.listChats('Chatty').includes(first), 'old chats preserved');

    // unknown character 404s
    r = await call(router, 'GET', '/chats', { query: { name: 'Nobody' } });
    assert.equal(r.statusCode, 404);
});
