import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PromptLog } from '../plugin/src/prompt-log.js';
import { LlamaCppClient, LlamaServerManager, modelFile } from '../plugin/src/llamacpp.js';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'plog-test-'));
}

test('PromptLog: off by default, records full exchanges when enabled, prunes to keep', () => {
    const dir = tmpDir();
    let settings = { prompt_log: { enabled: false, keep: 3 } };
    const plog = new PromptLog(dir, { getSettings: () => settings, log: () => {} });

    // disabled: nothing is written
    assert.equal(plog.record({ character: 'Hannah', kind: 'reply', model: 'm', request: { messages: [] }, response: 'hi' }), null);
    assert.equal(plog.list().length, 0);

    // enabled: full request/response lands in one file; keep-cap prunes
    // (floor of 10 — write 12 with keep 10, expect the newest 10)
    settings = { prompt_log: { enabled: true, keep: 10 } };
    for (let i = 0; i < 12; i++) {
        const id = plog.record({ character: 'Hannah', kind: 'reply', attempt: 'main', model: `m${i}`, request: { messages: [{ role: 'system', content: 'x'.repeat(100) }] }, response: `r${i}` });
        assert.ok(id);
    }
    const listed = plog.list();
    assert.equal(listed.length, 10, 'keep-cap prunes to the newest 10');
    assert.equal(listed[0].model, 'm11', 'newest first');
    assert.equal(listed[0].messages, 1);
    assert.equal(listed[0].promptChars, 100);
    assert.ok(listed[0].responsePreview.startsWith('r'));

    const full = plog.get(listed[0].id);
    assert.equal(full.character, 'Hannah');
    assert.equal(full.kind, 'reply');
    assert.equal(full.response, 'r11');
    assert.equal(full.request.messages[0].role, 'system');

    // traversal-safe get
    assert.equal(plog.get('../evil'), null);
    assert.equal(plog.get('a/b'), null);

    // purge wipes everything
    assert.equal(plog.purge(), 10);
    assert.equal(plog.list().length, 0);
});

test('LlamaCppClient.chat records the exchange with engine meta when the log is attached', async () => {
    const dir = tmpDir();
    const model = 'hf.co/a/b:Q4';
    fs.writeFileSync(modelFile(dir, model), 'gguf');
    const settings = { prompt_log: { enabled: true, keep: 50 } };
    const plog = new PromptLog(path.join(dir, 'plog'), { getSettings: () => settings, log: () => {} });
    const mgr = new LlamaServerManager({
        modelsDir: dir,
        spawnImpl: () => new EventEmitter(),
        fetchImpl: async (url, opts) => {
            if (String(url).endsWith('/health')) return { ok: true };
            if (String(url).includes('/api/models/')) return { ok: true, json: async () => ({ siblings: [{ rfilename: 'b-Q4.gguf' }] }) };
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'the reply' } }] }), text: async () => '' };
        },
        log: () => {},
    });
    const client = new LlamaCppClient({ manager: mgr, fetchImpl: mgr.fetchImpl, log: () => {} });
    client.promptLog = plog;

    const out = await client.chat({
        model,
        messages: [{ role: 'system', content: 'You are B.' }, { role: 'user', content: 'hello' }],
        numPredict: 120,
        logMeta: { character: 'Hannah', kind: 'reply', attempt: 'main' },
    });
    assert.equal(out, 'the reply');
    const entries = plog.list();
    assert.equal(entries.length, 1, 'the template probe is plumbing — only the real request is captured');
    const real = entries.find((e) => e.kind === 'reply');
    assert.ok(real, 'engine meta tags the entry');
    const full = plog.get(real.id);
    assert.equal(full.character, 'Hannah');
    assert.equal(full.attempt, 'main');
    assert.equal(full.response, 'the reply');
    assert.equal(full.request.max_tokens, 120);
    assert.ok(full.request.messages.length >= 2);
});
