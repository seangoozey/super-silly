import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient, cleanModelOutput } from '../plugin/src/llm.js';

function pullFetch(lines, { splitMidLine = true } = {}) {
    const ndjson = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    // split the stream into awkward chunks (including mid-JSON-line) to test buffering
    const chunks = [];
    const mid = Math.floor(ndjson.length / 3);
    if (splitMidLine) {
        chunks.push(ndjson.slice(0, mid), ndjson.slice(mid, mid + 7), ndjson.slice(mid + 7));
    } else {
        chunks.push(ndjson);
    }
    const encoded = chunks.map((c) => new TextEncoder().encode(c));
    return async () => ({
        ok: true,
        body: (async function* () {
            for (const c of encoded) yield c;
        })(),
    });
}

test('pull() normalizes layer progress into aggregate percent/bytes', async () => {
    const client = new OllamaClient({ fetchImpl: pullFetch([
        { status: 'pulling manifest' },
        { status: 'downloading', digest: 'sha256:a', total: 1000, completed: 250 },
        { status: 'downloading', digest: 'sha256:a', total: 1000, completed: 1000 },
        { status: 'downloading', digest: 'sha256:b', total: 3000, completed: 1500 },
        { status: 'verifying sha256:b' },
        { status: 'success' },
    ]) });

    const events = [];
    const ok = await client.pull('test-model', (p) => events.push(p));
    assert.equal(ok, true);

    assert.equal(events.length, 6);
    assert.deepEqual(events[0], { status: 'pulling manifest' });

    assert.equal(events[1].status, 'downloading');
    assert.equal(events[1].layerCount, 1);
    assert.equal(events[1].total, 1000);
    assert.equal(events[1].completed, 250);
    assert.equal(events[1].percent, 25);

    // second layer discovered: aggregate denominator grows to 1000+3000
    assert.equal(events[3].layerCount, 2);
    assert.equal(events[3].total, 4000);
    assert.equal(events[3].completed, 2500);
    assert.equal(events[3].percent, 62.5);

    assert.equal(events[4].status, 'verifying sha256:b');
    assert.equal(events[5].status, 'success');
});

test('pull() surfaces ollama errors as rejections', async () => {
    const client = new OllamaClient({ fetchImpl: pullFetch([
        { status: 'pulling manifest' },
        { error: 'blob not found' },
    ]) });
    await assert.rejects(() => client.pull('nope', () => {}), /blob not found/);
});

test('pull() works with a non-streaming fetch stub', async () => {
    const ndjson = `${JSON.stringify({ status: 'pulling manifest' })}\n${JSON.stringify({ status: 'success' })}\n`;
    const client = new OllamaClient({
        fetchImpl: async () => ({ ok: true, body: null, text: async () => ndjson }),
    });
    const events = [];
    await client.pull('x', (p) => events.push(p));
    assert.equal(events[1].status, 'success');
});

test('chat(): think flag mapping + fallback when model rejects it', async () => {
    const bodies = [];
    const responses = [];
    const client = new OllamaClient({
        fetchImpl: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            if (bodies.length === 1) {
                return { ok: false, status: 400, json: async () => ({ error: 'model does not support thinking' }) };
            }
            return { ok: true, status: 200, json: async () => ({ message: { content: 'hi' } }) };
        },
    });

    await client.chat({ model: 'scarlett', messages: [], think: 'off' });
    assert.equal(bodies[0].think, false);
    // 400 mentioning think -> retried without the flag
    assert.equal(bodies[1].think, undefined);
    assert.equal('think' in bodies[1], false);

    await client.chat({ model: 'scarlett', messages: [], think: 'on' });
    assert.equal(bodies[2].think, true);

    await client.chat({ model: 'scarlett', messages: [], think: 'auto' });
    assert.equal('think' in bodies[3], false);
});

test('cleanModelOutput strips thinking blocks', () => {
    assert.equal(cleanModelOutput('<think>user is asking about pizza</think>yeah pizza sounds good'), 'yeah pizza sounds good');
    assert.equal(cleanModelOutput('<think>truncated thinking with no close tag'), '');
    assert.equal(cleanModelOutput('plain reply'), 'plain reply');
});
