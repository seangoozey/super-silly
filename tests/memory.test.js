import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, cosine, messageKey } from '../plugin/src/memory.js';
import { ChatStore } from '../plugin/src/chat-store.js';

// deterministic fake embeddings: one basis dim per keyword
const fakeEmbed = (text) => {
    const t = String(text).toLowerCase();
    const v = [
        (t.match(/\bpizza\b/g) ?? []).length,
        (t.match(/\bgym\b/g) ?? []).length,
        (t.match(/\bwork\b/g) ?? []).length,
        (t.match(/\bitaly\b/g) ?? []).length,
    ];
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
};

function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autolife-mem-'));
    return new MemoryStore(path.join(dir, 'memory'), () => {});
}

test('cosine sanity', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('append + search ranks semantically and survives reload', async () => {
    const store = tmpStore();
    const entries = [
        { ts: '2026-08-01T10:00:00Z', role: 'user', text: 'pizza friday was great', key: 'user:t1:pizza friday was great' },
        { ts: '2026-08-02T10:00:00Z', role: 'assistant', text: 'gym session destroyed me', key: 'assistant:t2:gym session destroyed me' },
        { ts: '2026-08-03T10:00:00Z', role: 'user', text: 'big work deadline shipped', key: 'user:t3:big work deadline shipped' },
    ];
    for (const e of entries) store.append('Maya', { ...e, vec: fakeEmbed(e.text), chatFile: 'c.jsonl' }, 'fake-embed');

    const hits = store.search('Maya', fakeEmbed('want pizza again?'), { k: 2 });
    assert.equal(hits[0].text, 'pizza friday was great');
    assert.ok(hits[0].score > hits[hits.length - 1].score);

    // dedupe: same key twice is not stored twice
    store.append('Maya', { ...entries[0], vec: fakeEmbed(entries[0].text) }, 'fake-embed');
    assert.equal(store.count('Maya', 'fake-embed'), 3);

    // survives a cold reload (new store instance, same dir)
    const store2 = new MemoryStore(store.dir, () => {});
    assert.equal(store2.count('Maya', 'fake-embed'), 3);
    assert.equal(store2.search('Maya', fakeEmbed('pizza?'), { k: 1 })[0].text, 'pizza friday was great');
});

test('search excludes tail keys and text prefixes', async () => {
    const store = tmpStore();
    const mk = (t, ts, role = 'user') => ({ ts, role, text: t, key: messageKey(ts, role, t), vec: fakeEmbed(t), chatFile: 'c.jsonl' });
    store.append('Maya', mk('pizza friday was great', '2026-08-01T10:00:00Z'), 'fake-embed');
    store.append('Maya', mk('pizza again tonight', '2026-08-30T10:00:00Z'), 'fake-embed'); // in live tail
    const hits = store.search('Maya', fakeEmbed('pizza?'), {
        k: 5,
        excludeKeys: new Set([messageKey('2026-08-30T10:00:00Z', 'user', 'pizza again tonight')]),
    });
    assert.deepEqual(hits.map((h) => h.text), ['pizza friday was great']);
});

test('backfill indexes chat history once, oldest first', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autolife-chat-'));
    const chatStore = new ChatStore({ dataRoot: path.dirname(root), userHandle: path.basename(root) });
    const file = chatStore.createChat('Vera', 'hi');
    chatStore.appendMessage('Vera', file, chatStore.userMessage('first message about pizza', new Date('2026-08-01T10:00:00Z')));
    chatStore.appendMessage('Vera', file, chatStore.userMessage('second message about work', new Date('2026-08-02T10:00:00Z')));
    chatStore.appendMessage('Vera', file, chatStore.characterMessage('Vera', 'third message about gym', new Date('2026-08-03T10:00:00Z')));
    // 4 messages total: greeting + 3

    const store = tmpStore();
    const r1 = await store.backfill('Vera', chatStore, file, fakeEmbed, { limit: 2, maxEntries: 100 });
    assert.equal(r1.added, 2);
    assert.equal(r1.remaining, 2);

    const r2 = await store.backfill('Vera', chatStore, file, fakeEmbed, { limit: 20, maxEntries: 100 });
    assert.equal(r2.added, 2);
    assert.equal(r2.remaining, 0);

    const r3 = await store.backfill('Vera', chatStore, file, fakeEmbed, { limit: 20, maxEntries: 100 });
    assert.equal(r3.added, 0); // fully indexed, no rework

    assert.equal(store.stats('Vera', 'fake-embed').entries, 4);
});

test('changing embedding model archives and resets the index', async () => {
    const store = tmpStore();
    store.append('Vera', { ts: '2026-08-01T10:00:00Z', role: 'user', text: 'hello', key: 'user:t:hello', vec: fakeEmbed('hello'), chatFile: 'c.jsonl' }, 'model-a');
    assert.equal(store.count('Vera', 'model-a'), 1);
    // different model -> fresh index under the same store
    assert.equal(store.count('Vera', 'model-b'), 0);
    const backups = fs.readdirSync(store.dir).filter((f) => f.includes('.bak-'));
    assert.equal(backups.length, 1);
});
