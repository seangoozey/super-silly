import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseModelName, modelFile, resolveHfFile, downloadToFile, LlamaServerManager, LlamaCppClient } from '../plugin/src/llamacpp.js';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'llamacpp-test-'));
}

test('parseModelName and modelFile: hf.co names, aliases, Windows-safe paths', () => {
    assert.deepEqual(parseModelName('hf.co/ReadyArt/Dark-Scarlett-27B-v2.0-GGUF:Q4_K_M'), {
        repo: 'ReadyArt/Dark-Scarlett-27B-v2.0-GGUF',
        tag: 'Q4_K_M',
    });
    // Ollama-style bare embed name resolves to the HF GGUF repo
    assert.deepEqual(parseModelName('nomic-embed-text'), {
        repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
        tag: 'f16',
    });
    assert.equal(parseModelName('llama3'), null);

    const dir = tmpDir();
    const f = modelFile(dir, 'hf.co/ReadyArt/Dark-Scarlett-27B-v2.0-GGUF:Q4_K_M');
    assert.ok(f.startsWith(dir));
    assert.ok(f.endsWith('.gguf'));
    assert.ok(!/[<>:"/\\|?*]/.test(path.basename(f)), 'filename is Windows-safe');
    assert.equal(modelFile(dir, 'llama3'), null);
});

test('resolveHfFile picks the matching single-file quant, never mmproj or splits', async () => {
    const mk = (files) => async () => ({
        ok: true,
        json: async () => ({ siblings: files.map((rfilename) => ({ rfilename })) }),
    });
    const files = [
        'mmproj-f16.gguf',
        'Dark-Scarlett-27B-v2.0-Q4_K_M.gguf',
        'Dark-Scarlett-27B-v2.0-Q8_0.gguf',
    ];
    assert.equal(await resolveHfFile('ReadyArt/x', 'Q4_K_M', mk(files)), 'Dark-Scarlett-27B-v2.0-Q4_K_M.gguf');

    await assert.rejects(
        () => resolveHfFile('ReadyArt/x', 'Q4_K_M', mk(['model-Q4_K_M-00001-of-00003.gguf'])),
        /split GGUF/,
    );
    await assert.rejects(
        () => resolveHfFile('ReadyArt/x', 'IQ3_XS', mk(files)),
        /no \.gguf matching/,
    );
});

test('downloadToFile streams to disk with normalized progress and renames from .part', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'model.gguf');
    const body = (async function* () {
        yield Buffer.from('hello ');
        yield Buffer.from('world');
    })();
    const events = [];
    await downloadToFile('https://x/f.gguf', dest, (e) => events.push(e), async () => ({
        ok: true,
        headers: { get: (k) => (k === 'content-length' ? '11' : null) },
        body,
    }));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'hello world');
    assert.ok(!fs.existsSync(`${dest}.part`));
    const last = events[events.length - 1];
    assert.equal(last.status, 'success');
    assert.equal(last.percent, 100);
    assert.equal(last.total, 11);
    assert.equal(last.completed, 11);
});

test('LlamaServerManager spawns with the right args, swaps models, and respawns lazily after exit', async () => {
    const dir = tmpDir();
    const spawns = [];
    const mkChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killCalls = 0;
        child.kill = () => { child.killCalls += 1; };
        spawns.push(child);
        return child;
    };
    const calls = [];
    const mgr = new LlamaServerManager({
        modelsDir: dir,
        numCtx: 4096,
        spawnImpl: (bin, args) => { calls.push({ bin, args }); return mkChild(); },
        fetchImpl: async (url) => {
            calls.push({ url });
            return { ok: true };
        },
        healthTimeoutMs: 3_000,
        log: () => {},
    });

    await mgr.ensureChatServer('hf.co/a/b:Q4', path.join(dir, 'b.gguf'));
    const firstArgs = calls.find((c) => c.args).args;
    assert.equal(calls.find((c) => c.args).bin, 'llama-server');
    assert.ok(firstArgs.includes('-m'));
    assert.equal(firstArgs[firstArgs.indexOf('-c') + 1], '4096');
    assert.equal(firstArgs[firstArgs.indexOf('-ngl') + 1], '999');
    assert.equal(firstArgs[firstArgs.indexOf('--port') + 1], '11440');
    assert.equal(mgr.loaded, 'hf.co/a/b:Q4');

    // same model again: no second spawn
    await mgr.ensureChatServer('hf.co/a/b:Q4', path.join(dir, 'b.gguf'));
    assert.equal(spawns.length, 1);

    // model switch: the old instance is killed
    await mgr.ensureChatServer('hf.co/a/c:Q4', path.join(dir, 'c.gguf'));
    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].killCalls, 1);

    // crash: child exits -> slot empties -> next call respawns
    spawns[1].emit('exit', 1);
    assert.equal(mgr.loaded, null);
    await mgr.ensureChatServer('hf.co/a/c:Q4', path.join(dir, 'c.gguf'));
    assert.equal(spawns.length, 3);

    mgr.stop();
    assert.equal(spawns[2].killCalls, 1);
});

test('LlamaCppClient chat maps the request to OpenAI dialect and parses choices', async () => {
    const dir = tmpDir();
    const model = 'hf.co/ReadyArt/Dark-Desires-22B-v1.5-GGUF:Q5_K_M';
    const file = modelFile(dir, model);
    fs.writeFileSync(file, 'fake gguf');
    const bodies = [];
    const mgr = new LlamaServerManager({
        modelsDir: dir,
        spawnImpl: () => new EventEmitter(), // never reached: server "already healthy"
        fetchImpl: async (url, opts) => {
            if (String(url).endsWith('/health')) return { ok: true };
            bodies.push({ url: String(url), body: JSON.parse(opts.body) });
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: '  hey there  ' } }] }),
            };
        },
        log: () => {},
    });
    const client = new LlamaCppClient({ manager: mgr, fetchImpl: mgr.fetchImpl, log: () => {} });
    client.samplers = { temperature: 0.7, top_p: 1, top_k: 0, repeat_penalty: 1, top_n_sigma: 1.2, xtc_probability: 0.33, xtc_threshold: 0.05 };

    const out = await client.chat({ model, messages: [{ role: 'user', content: 'hi' }], numPredict: 220 });
    assert.equal(out, 'hey there');
    const req = bodies.find((b) => b.url.includes('/chat/completions'));
    assert.equal(req.body.max_tokens, 220);
    assert.equal(req.body.temperature, 0.7);
    assert.equal(req.body.top_p, 1);
    assert.equal(req.body.top_k, 0);
    assert.equal(req.body.repeat_penalty, 1);
    assert.equal(req.body.stream, false);
    // ReadyArt's llama.cpp-exclusive samplers ride along
    assert.equal(req.body.top_n_sigma, 1.2);
    assert.equal(req.body.xtc_probability, 0.33);
    assert.equal(req.body.xtc_threshold, 0.05);

    // zeros disable them: fields absent from the request entirely
    client.samplers = { temperature: 0.7, top_n_sigma: 0, xtc_probability: 0 };
    await client.chat({ model, messages: [{ role: 'user', content: 'again' }] });
    const req2 = bodies.filter((b) => b.url.includes('/chat/completions')).at(-1);
    assert.ok(!('top_n_sigma' in req2.body));
    assert.ok(!('xtc_probability' in req2.body));
    assert.ok(!('xtc_threshold' in req2.body));
});

test('LlamaCppClient chat rejects non-hf model names and missing files with clear errors', async () => {
    const client = new LlamaCppClient({ manager: new LlamaServerManager({ modelsDir: tmpDir(), spawnImpl: () => new EventEmitter(), fetchImpl: async () => ({ ok: true }), log: () => {} }), log: () => {} });
    await assert.rejects(() => client.chat({ model: 'llama3', messages: [] }), /hf\.co\/Owner\/Repo:Tag/);
    await assert.rejects(() => client.chat({ model: 'hf.co/a/b:Q4', messages: [] }), /not downloaded/);
});

test('LlamaCppClient tags lists GGUFs with sidecar names and sizes; hasModel checks the file', async () => {
    const dir = tmpDir();
    const model = 'hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF:f16';
    const file = modelFile(dir, model);
    fs.writeFileSync(file, 'abc');
    fs.writeFileSync(`${file}.name`, model);
    fs.writeFileSync(path.join(dir, 'orphan.gguf'), 'xy');

    const client = new LlamaCppClient({ manager: new LlamaServerManager({ modelsDir: dir, spawnImpl: () => new EventEmitter(), fetchImpl: async () => ({ ok: true }), log: () => {} }), log: () => {} });
    const tags = await client.tags();
    const named = tags.find((t) => t.name === model);
    assert.ok(named, 'sidecar name is listed');
    assert.equal(named.size, 3);
    assert.ok(tags.some((t) => t.name === 'orphan'), 'files without a sidecar fall back to the filename');
    assert.equal(await client.hasModel(model), true);
    assert.equal(await client.hasModel('hf.co/a/b:Q4'), false);
});

test('LlamaCppClient pull downloads, writes the sidecar, and reports progress', async () => {
    const dir = tmpDir();
    const model = 'hf.co/ReadyArt/x:Q4_K_M';
    const gguf = 'x-Q4_K_M.gguf';
    const events = [];
    const client = new LlamaCppClient({
        manager: new LlamaServerManager({ modelsDir: dir, spawnImpl: () => new EventEmitter(), fetchImpl: async () => ({ ok: true }), log: () => {} }),
        fetchImpl: async (url) => {
            if (String(url).includes('/api/models/')) {
                return { ok: true, json: async () => ({ siblings: [{ rfilename: gguf }, { rfilename: 'mmproj-f16.gguf' }] }) };
            }
            return {
                ok: true,
                headers: { get: (k) => (k === 'content-length' ? '5' : null) },
                body: (async function* () { yield Buffer.from('ggufs'); })(),
            };
        },
        log: () => {},
    });
    await client.pull(model, (e) => events.push(e));
    const file = modelFile(dir, model);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ggufs');
    assert.equal(fs.readFileSync(`${file}.name`, 'utf8'), model);
    assert.ok(events.some((e) => e.status === 'success' && e.percent === 100));
    assert.equal(await client.hasModel(model), true);
    const tags = await client.tags();
    assert.ok(tags.some((t) => t.name === model));
});

test('foldTrailingSystem merges post-start system blocks into one user message', async () => {
    const { foldTrailingSystem } = await import('../plugin/src/llamacpp.js');
    // engine shape: system, history..., memory, directive, tone — all trailing
    const out = foldTrailingSystem([
        { role: 'system', content: 'You are June.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
        { role: 'system', content: 'memory block' },
        { role: 'system', content: '(Private direction...)' },
    ]);
    assert.equal(out.length, 4);
    assert.equal(out[0].role, 'system');
    assert.equal(out.at(-1).role, 'user');
    assert.ok(out.at(-1).content.includes('memory block'));
    assert.ok(out.at(-1).content.includes('(Private direction...)'));

    // no trailing systems -> untouched
    const plain = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }];
    assert.equal(foldTrailingSystem(plain), plain);

    // only leading system -> untouched
    assert.deepEqual(foldTrailingSystem([{ role: 'system', content: 'a' }]), [{ role: 'system', content: 'a' }]);
});

test('joining an in-flight pull receives progress events too (no silent ride)', async () => {
    const dir = tmpDir();
    const model = 'hf.co/ReadyArt/big:Q4';
    let release;
    const gate = new Promise((r) => { release = r; });
    const mkClient = () => new LlamaCppClient({
        manager: new LlamaServerManager({ modelsDir: dir, spawnImpl: () => new EventEmitter(), fetchImpl: async () => ({ ok: true }), log: () => {} }),
        fetchImpl: async (url) => {
            if (String(url).includes('/api/models/')) {
                return { ok: true, json: async () => ({ siblings: [{ rfilename: 'big-Q4.gguf' }] }) };
            }
            return {
                ok: true,
                headers: { get: (k) => (k === 'content-length' ? '4' : null) },
                body: (async function* () { yield Buffer.from('ab'); await gate; yield Buffer.from('cd'); })(),
            };
        },
        log: () => {},
    });
    const first = mkClient();
    const firstEvents = [];
    const started = first.pull(model, (e) => firstEvents.push(e)); // engine starts the download
    await new Promise((r) => setTimeout(r, 30)); // let it reach the gate

    // dashboard Pull clicks while in flight — same client, second caller,
    // must get events instead of riding silently
    const joinEvents = [];
    const joined = first.pull(model, (e) => joinEvents.push(e));

    release();
    assert.equal(await started, true);
    assert.equal(await joined, true);
    assert.ok(firstEvents.some((e) => e.status === 'success'));
    assert.ok(joinEvents.some((e) => e.status === 'success'), 'the joining caller sees progress');
    assert.equal(fs.readFileSync(modelFile(dir, model), 'utf8'), 'abcd');
});

test('long downloads log throttled progress lines into the container log', async () => {
    const dir = tmpDir();
    const model = 'hf.co/ReadyArt/loggy:Q4';
    const lines = [];
    const client = new LlamaCppClient({
        manager: new LlamaServerManager({ modelsDir: dir, spawnImpl: () => new EventEmitter(), fetchImpl: async () => ({ ok: true }), log: (m) => lines.push(m) }),
        fetchImpl: async (url) => {
            if (String(url).includes('/api/models/')) {
                return { ok: true, json: async () => ({ siblings: [{ rfilename: 'loggy-Q4.gguf' }] }) };
            }
            return {
                ok: true,
                headers: { get: (k) => (k === 'content-length' ? '4' : null) },
                body: (async function* () {
                    for (let i = 0; i < 3; i++) {
                        yield Buffer.from('ab');
                        await new Promise((r) => setTimeout(r, 25));
                    }
                })(),
            };
        },
        log: (m) => lines.push(m),
        pullLogEveryMs: 30, // tight for the test; production default is 10s
    });
    await client.pull(model);
    const progressLines = lines.filter((l) => /^pulling /.test(l));
    assert.ok(progressLines.length >= 1, 'periodic progress reaches the container log');
    assert.ok(/pulling hf\.co\/ReadyArt\/loggy:Q4: 0\.00\/0\.00 GB \(0%\)/.test(lines.join('\n')) || progressLines.length >= 1);
    assert.ok(lines.some((l) => /download complete/.test(l)), 'completion is logged');
});
