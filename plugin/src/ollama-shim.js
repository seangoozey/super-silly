// Ollama-API compatibility shim for the llama.cpp backend.
//
// SillyTavern's web UI talks Ollama (its connection is seeded to
// http://127.0.0.1:11434, api_type 'ollama'); under AUTOLIFE_BACKEND=llamacpp
// nothing listens there. Instead of reconfiguring ST (settings.json +
// secrets.json internals, version-brittle), this shim listens on the same
// port and translates the Ollama API subset ST uses onto llama-server:
//   GET  /api/version   connectivity check
//   GET  /api/tags      model list (GGUFs in the models dir, real names)
//   POST /api/chat      chat — wakes the llama-server for that model; NDJSON
//                       streaming translated from OpenAI SSE
//   POST /api/generate  prompt-style generation (mapped to a user message)
//   POST /api/show      minimal model info stub
// Web-UI requests thus also lazy-spawn llama-server, exactly like engine ones.

import http from 'node:http';

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 2_000_000) reject(new Error('body too large'));
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * @param {{ client: object, port?: number, host?: string, log?: (m:string)=>void }} opts
 * @returns {{ server: http.Server, close: () => void } | null} null when the port is taken
 */
export function startOllamaShim(opts = {}) {
    const client = opts.client;
    const port = Number(opts.port ?? process.env.LLAMACPP_SHIM_PORT ?? 11434);
    const host = opts.host ?? '127.0.0.1';
    const log = opts.log ?? (() => {});

    const server = http.createServer(async (req, res) => {
        const url = (req.url ?? '').split('?')[0];
        const json = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        try {
            if (req.method === 'GET' && url === '/api/version') {
                return json(200, { version: 'autolife-shim 1.0 (llama.cpp)' });
            }

            if (req.method === 'GET' && url === '/api/tags') {
                const models = await client.tags().catch(() => []);
                return json(200, {
                    models: models.map((m) => ({
                        name: m.name,
                        model: m.name,
                        size: m.size ?? 0,
                        modified_at: '',
                        details: { family: 'llama', parameter_size: '', quantization_level: '', format: 'gguf' },
                    })),
                });
            }

            if (req.method === 'POST' && url === '/api/show') {
                const body = await readBody(req);
                return json(200, {
                    modelfile: '',
                    parameters: {},
                    template: '',
                    details: { family: 'llama', format: 'gguf' },
                });
            }

            if (req.method === 'POST' && (url === '/api/chat' || url === '/api/generate')) {
                const body = await readBody(req);
                const model = String(body.model ?? '');
                if (!model) return json(400, { error: 'model required' });
                if (!(await client.hasModel(model).catch(() => false))) {
                    return json(404, { error: `model "${model}" is not downloaded — pull it from the Autolife panel or via /model pull` });
                }
                const messages = url === '/api/chat'
                    ? (Array.isArray(body.messages) ? body.messages : [])
                    : [{ role: 'user', content: String(body.prompt ?? '') }];
                const o = body.options ?? {};
                const chatReq = {
                    model,
                    messages,
                    numPredict: o.num_predict,
                    temperature: o.temperature,
                    // default to thinking-off like the engine (thinking models
                    // otherwise spend the whole budget on hidden reasoning and
                    // return empty content); an explicit ST think=true wins
                    think: body.think === true ? 'on' : 'off',
                    // ST's ollama options ride along as per-request samplers
                    samplers: {
                        ...(o.temperature != null ? { temperature: o.temperature } : {}),
                        ...(o.top_p != null ? { top_p: o.top_p } : {}),
                        ...(o.top_k != null ? { top_k: o.top_k } : {}),
                        ...(o.repeat_penalty != null ? { repeat_penalty: o.repeat_penalty } : {}),
                        ...(o.min_p != null ? { min_p: o.min_p } : {}),
                    },
                };

                if (!body.stream) {
                    const content = await client.chat(chatReq);
                    return json(200, {
                        model,
                        created_at: new Date().toISOString(),
                        message: { role: 'assistant', content },
                        done: true,
                        done_reason: 'stop',
                    });
                }

                // streaming: OpenAI SSE -> Ollama NDJSON lines
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
                const line = (content, done) => res.write(`${JSON.stringify({
                    model,
                    created_at: new Date().toISOString(),
                    message: { role: 'assistant', content },
                    done,
                    ...(done ? { done_reason: 'stop' } : {}),
                })}\n`);
                try {
                    for await (const part of client.chatStream(chatReq)) {
                        if (part) line(part, false);
                    }
                } catch (err) {
                    log(`shim chat stream failed: ${err.message}`);
                }
                line('', true);
                res.end();
                return;
            }

            log(`shim: unmapped ${req.method} ${url} — if ST needs it, tell the Autolife dev`);
            return json(404, { error: `not implemented by shim: ${req.method} ${url}` });
        } catch (err) {
            log(`shim error on ${req.method} ${url}: ${err.message}`);
            if (!res.headersSent) return json(500, { error: String(err?.message ?? err) });
            try { res.end(); } catch { /* already gone */ }
        }
    });

    return new Promise((resolve) => {
        server.once('error', (err) => {
            log(`ollama shim not started on :${port} (${err.code ?? err.message}) — is a real ollama serving there?`);
            resolve(null);
        });
        server.listen(port, host, () => {
            log(`ollama shim listening on ${host}:${port} — SillyTavern's web UI can keep its Ollama connection`);
            resolve({ server, close: () => server.close() });
        });
    });
}
