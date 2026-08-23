import test from 'node:test';
import assert from 'node:assert/strict';
import { startOllamaShim } from '../plugin/src/ollama-shim.js';

test('ollama shim serves the API subset SillyTavern uses', async () => {
    const MODEL = 'hf.co/ReadyArt/Dark-Desires-12B-v1.0-GGUF:Q4_K_M';
    const chatReqs = [];
    const fake = {
        tags: async () => [{ name: MODEL, size: 8030000000 }],
        hasModel: async (m) => m === MODEL,
        chat: async (req) => {
            chatReqs.push(req);
            return 'hello there';
        },
        chatStream: async function* () {
            yield 'hel';
            yield 'lo';
        },
    };
    const logs = [];
    const shim = await startOllamaShim({ client: fake, port: 0, log: (m) => logs.push(m) });
    assert.ok(shim, 'shim starts');
    const base = `http://127.0.0.1:${shim.server.address().port}`;
    try {
        // connectivity + model list
        const v = await (await fetch(`${base}/api/version`)).json();
        assert.ok(v.version.includes('shim'));
        const t = await (await fetch(`${base}/api/tags`)).json();
        assert.equal(t.models[0].name, MODEL);
        assert.equal(t.models[0].details.family, 'llama');

        // non-streaming chat: ST's ollama options map onto the request
        const r = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: 'user', content: 'hi' }],
                stream: false,
                options: { temperature: 0.5, top_p: 0.9, num_predict: 42 },
            }),
        }).then((x) => x.json());
        assert.equal(r.message.role, 'assistant');
        assert.equal(r.message.content, 'hello there');
        assert.equal(r.done, true);
        assert.equal(chatReqs.at(-1).numPredict, 42);
        assert.equal(chatReqs.at(-1).samplers.temperature, 0.5);
        assert.equal(chatReqs.at(-1).samplers.top_p, 0.9);

        // streaming chat: OpenAI SSE is translated to Ollama NDJSON lines
        const s = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            }),
        });
        assert.ok((s.headers.get('content-type') ?? '').includes('ndjson'));
        const lines = (await s.text()).trim().split('\n').map((l) => JSON.parse(l));
        assert.deepEqual(lines.map((l) => l.message.content), ['hel', 'lo', '']);
        assert.equal(lines.at(-1).done, true);

        // prompt-style generation maps to a single user message
        await fetch(`${base}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, prompt: 'continue this', stream: false }),
        });
        assert.deepEqual(chatReqs.at(-1).messages, [{ role: 'user', content: 'continue this' }]);

        // unknown model gets a clear ollama-style error
        const err = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nope', messages: [] }),
        });
        assert.equal(err.status, 404);
        assert.ok((await err.json()).error.includes('not downloaded'));

        // unmapped paths 404 loudly
        const unmapped = await fetch(`${base}/api/embeddings`, { method: 'POST', body: '{}' });
        assert.equal(unmapped.status, 404);
        assert.ok(logs.some((l) => l.includes('unmapped')));
    } finally {
        shim.close();
    }
});
