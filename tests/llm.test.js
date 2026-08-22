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
        { status: 'pulling 797b70c4edf8', digest: 'sha256:a', total: 1000, completed: 250 },
        { status: 'pulling 797b70c4edf8', digest: 'sha256:a', total: 1000, completed: 1000 },
        { status: 'pulling c71d239df917', digest: 'sha256:b', total: 3000, completed: 1500 },
        { status: 'verifying sha256:b' },
        { status: 'success' },
    ]) });

    const events = [];
    const ok = await client.pull('test-model', (p) => events.push(p));
    assert.equal(ok, true);

    assert.equal(events.length, 6);
    assert.deepEqual(events[0], { status: 'pulling manifest' });

    assert.equal(events[1].status, 'pulling 797b70c4edf8');
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

test('pull() accepts both progress dialects (downloading + pulling <id>)', async () => {
    const lines = [
        { status: 'pulling manifest' },
        { status: 'downloading', digest: 'sha256:x', total: 500, completed: 100 },
        { status: 'pulling abc123', digest: 'sha256:y', total: 500, completed: 500 },
        { status: 'success' },
    ];
    const ndjson = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const chunks = [ndjson.slice(0, 20), ndjson.slice(20)];
    const client = new OllamaClient({
        fetchImpl: async () => ({
            ok: true,
            body: (async function* () {
                for (const c of chunks.map((c) => new TextEncoder().encode(c))) yield c;
            })(),
        }),
    });
    const events = [];
    await client.pull('m', (p) => events.push(p));
    const dl = events.find((e) => e.status === 'downloading');
    assert.equal(dl.percent, 20); // 100 / (500+500)
    const pl = events.find((e) => e.status === 'pulling abc123');
    assert.equal(pl.percent, 60); // 600 / 1000
    assert.equal(events[events.length - 1].status, 'success');
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

test('sanitizeTextingOutput enforces plain-text formatting mechanically', async () => {
    const { sanitizeTextingOutput } = await import('../plugin/src/llm.js');
    // asterisk actions removed
    assert.equal(sanitizeTextingOutput('*sighs and looks away* hey, it\'s me'), 'hey, it\'s me');
    // inline actions removed mid-text
    assert.equal(sanitizeTextingOutput('so tired *yawns* today was a lot'), 'so tired today was a lot');
    // quotes wrapping the whole paragraph stripped
    assert.equal(sanitizeTextingOutput('"Hi cutey. How are you doing?"'), 'Hi cutey. How are you doing?');
    // multi-paragraph: each paragraph handled independently
    assert.equal(
        sanitizeTextingOutput('"first text"\n\n*walks to the window*\n\nsecond text'),
        'first text\n\nsecond text',
    );
    // bracketed meta lines removed
    assert.equal(sanitizeTextingOutput('[Continue from the last system prompt message]\nactual text'), 'actual text');
    // plain text passes through untouched
    assert.equal(sanitizeTextingOutput('plain text stays 100% intact'), 'plain text stays 100% intact');
});

test('extractFollowUpMarker detects and strips the burst marker', async () => {
    const { extractFollowUpMarker } = await import('../plugin/src/llm.js');
    assert.deepEqual(extractFollowUpMarker('hey, guess what\n{follow-up}'), { text: 'hey, guess what', more: true });
    assert.deepEqual(extractFollowUpMarker('plain end'), { text: 'plain end', more: false });
    assert.deepEqual(extractFollowUpMarker('{Follow-Up} one more thing'), { text: 'one more thing', more: true });
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

test('stripLeakedScaffolding cuts parroted prompt scaffolding', async () => {
    const { stripLeakedScaffolding } = await import('../plugin/src/llm.js');

    // the exact observed failure: a fine text with the memory-block header
    // (and a fabricated [SYSTEM_PROMPT] label) rambling after it
    const observed = 'omg i had the best day [SYSTEM_PROMPT]Texts from earlier in your history with Sean (your own memories of past exchanges — respond to them if relevant; NEVER quote, repeat, or recite them back): [Aug 22] Hannah: can i do that?[Aug 22';
    const out = stripLeakedScaffolding(observed);
    assert.equal(out.leaked, true);
    assert.equal(out.text, 'omg i had the best day');

    // whole output is scaffolding -> nothing usable, flagged
    const allLeak = stripLeakedScaffolding('Texts from earlier in your history with Sean:\n[Feb 1] Hannah: hi');
    assert.equal(allLeak.leaked, true);
    assert.equal(allLeak.text, '');

    // other marker families
    assert.equal(stripLeakedScaffolding('sure! [INST] what are you up to').text, 'sure!');
    assert.equal(stripLeakedScaffolding('hm okay <<sys>> be nice').text, 'hm okay');
    assert.equal(stripLeakedScaffolding('yeah (Private direction, invisible to Sean: text him now)').text, 'yeah');
    assert.equal(stripLeakedScaffolding('right Your recent private notes to yourself: nothing').text, 'right');

    // clean texting output passes through untouched
    const clean = stripLeakedScaffolding('haha stop it you 😂 what are you up to tonight?');
    assert.equal(clean.leaked, false);
    assert.equal(clean.text, 'haha stop it you 😂 what are you up to tonight?');
});

test('looksLikeSelfRepeat catches verbatim self-recitation, allows short human repeats', async () => {
    const { looksLikeSelfRepeat } = await import('../plugin/src/llm.js');
    const own = ['just got home from the studio, what are you up to tonight?', 'haha ok', 'u up?'];

    // exact resend (punctuation/case differences don't matter after normalization)
    assert.ok(looksLikeSelfRepeat('Just got home from the studio, what are you up to tonight?', own));
    // recitation padded with new words around it
    assert.ok(looksLikeSelfRepeat('hey! just got home from the studio, what are you up to tonight? so anyway', own));
    // short repeats are human — allowed
    assert.ok(!looksLikeSelfRepeat('haha ok', own));
    assert.ok(!looksLikeSelfRepeat('u up?', own));
    // fresh text passes
    assert.ok(!looksLikeSelfRepeat('totally different plans tonight, wanna hear?', own));
    assert.ok(!looksLikeSelfRepeat('anything at all', []));
});

test('OllamaClient chat applies sampler defaults and per-request overrides', async () => {
    const bodies = [];
    const ok = () => new Response(JSON.stringify({ message: { content: 'hi' } }), { status: 200 });
    const client = new OllamaClient({ fetchImpl: async (url, opts) => { bodies.push(JSON.parse(opts.body)); return ok(); } });

    // no sampler set: only temperature default, Ollama's own defaults left alone
    await client.chat({ model: 'm', messages: [], temperature: 0.5 });
    assert.equal(bodies[0].options.temperature, 0.5);
    assert.ok(!('top_p' in bodies[0].options));
    assert.ok(!('top_k' in bodies[0].options));
    assert.ok(!('repeat_penalty' in bodies[0].options));

    // ReadyArt-spec samplers: everything explicit and neutral
    client.samplers = { temperature: 0.7, top_p: 1, top_k: 0, repeat_penalty: 1 };
    await client.chat({ model: 'm', messages: [] });
    assert.equal(bodies[1].options.temperature, 0.7);
    assert.equal(bodies[1].options.top_p, 1);
    assert.equal(bodies[1].options.top_k, 0);
    assert.equal(bodies[1].options.repeat_penalty, 1);

    // per-request temperature (journal 0.8 / evolve 0.6) still wins
    await client.chat({ model: 'm', messages: [], temperature: 0.6 });
    assert.equal(bodies[2].options.temperature, 0.6);
});
