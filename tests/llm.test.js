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

test('splitIntoTexts turns paragraphs into texting bursts', async () => {
    const { splitIntoTexts } = await import('../plugin/src/llm.js');
    assert.deepEqual(splitIntoTexts('one text only'), ['one text only']);
    assert.deepEqual(
        splitIntoTexts('first text\n\nsecond text\n\nthird text'),
        ['first text', 'second text', 'third text'],
    );
    // single newlines inside a paragraph collapse; long paragraphs sentence-split
    const long = 'Sentence one is here. Sentence two follows it. '.repeat(40);
    const parts = splitIntoTexts(long);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 910));
    // never more than six bursts
    const many = Array.from({ length: 12 }, (_, i) => `paragraph ${i}`).join('\n\n');
    assert.equal(splitIntoTexts(many).length, 6);
});

test('prompt templates place sections into placeholders and drop omissions', async () => {
    const { buildSystemPrompt, promptSections } = await import('../plugin/src/llm.js');
    const life = { activity: 'at the studio', availability: 0.2, mood: 'focused', local: { hhmm: '14:05', weekdayName: 'Monday' } };
    const card = { data: { name: 'Maya', description: 'designer', personality: 'warm', scenario: 'friends', system_prompt: '', post_history_instructions: '' } };
    const ctx = {
        card,
        autolife: { timezone: 'America/New_York', behavior: { avg_message_length: 'short' }, journal: { enabled: true } },
        life,
        relationshipScore: 58,
        journal: [{ ts: '2026-08-01T00:00:00Z', text: 'client logo again' }],
        userName: 'Sean',
    };

    // built-in assembly when no template
    const builtin = buildSystemPrompt(ctx);
    assert.ok(builtin.includes('Who you are: designer'));
    assert.ok(builtin.includes('at the studio'));

    // template reorders, omits, and uses raw placeholders
    const out = buildSystemPrompt({ ...ctx, template: '{{char}} texting {{user}} at {{time}} ({{activity}})\n{{description}}\n{{journal}}' });
    assert.ok(out.startsWith('Maya texting Sean at 14:05'));
    assert.ok(out.includes('at the studio'));
    assert.ok(out.includes('Who you are: designer'));
    assert.ok(out.includes('client logo again'));
    assert.ok(!out.includes('Personality:'), 'omitted sections are absent');

    // sections object exposes the named pieces
    const sections = promptSections(ctx);
    assert.ok(sections.life.includes('14:05'));
    assert.equal(sections.personality, 'Personality: warm');
});
