// llama.cpp backend: OpenAI-dialect client + llama-server process supervisor.
//
// Drop-in replacement for the OllamaClient surface the engine consumes
// (chat / embed / tags / hasModel / ensureModel / version). Two things
// Ollama did for us move into this file:
//   1. model management — llama-server hosts exactly ONE model per process,
//      so the supervisor spawns a chat instance and a (tiny) embed instance,
//      waits for /health, swaps instances on model switch, and respawns
//      lazily after a crash (nothing to babysit: the next request restarts).
//   2. downloads — models keep their hf.co/Owner/Repo:Tag names; the GGUF is
//      resolved via the HuggingFace API and streamed to the models dir with
//      content-length progress (same normalized shape as the Ollama pull
//      events, so the UI progress bar works unchanged).
//
// Why this backend exists at all: Qwen3.5 ("qwen35") models — Dark-Scarlett —
// run on llama.cpp but not on Ollama, and top_n_sigma / XTC samplers only
// exist here. Deployments must use CUDA-12-flavored llama-server builds:
// CUDA 13 toolchains cannot target Pascal (sm_61, Tesla P40).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HF_API = 'https://huggingface.co';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ollama-style bare names → HF GGUF repos, so embed settings carry over
// between backends. Vectors are identical for the same model, so memory
// indexes built under Ollama keep working.
const HF_ALIASES = {
    'nomic-embed-text': 'hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF:f16',
};

/** Parse 'hf.co/Owner/Repo:Tag' (bare aliases resolved) → {repo, tag} | null. */
export function parseModelName(name) {
    const n = HF_ALIASES[String(name ?? '').trim()] ?? String(name ?? '').trim();
    const m = n.match(/^hf\.co\/([^/:]+)\/([^/:]+):(.+)$/);
    if (!m) return null;
    return { repo: `${m[1]}/${m[2]}`, tag: m[3] };
}

/** Deterministic local path for a model name inside modelsDir. */
export function modelFile(modelsDir, name) {
    const p = parseModelName(name);
    if (!p) return null;
    // ':' is illegal in Windows filenames — sanitize to a flat, safe name
    const base = `${p.repo.replace('/', '--')}_${p.tag}`.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(modelsDir, `${base}.gguf`);
}

/**
 * Find which .gguf in an HF repo matches a quant tag. Split quants
 * (-00001-of-00005.gguf) are rejected with a clear message rather than
 * downloaded corrupt; mmproj-*.gguf (vision projectors) never match.
 */
export async function resolveHfFile(repo, tag, fetchImpl = fetch) {
    const res = await fetchImpl(`${HF_API}/api/models/${repo}`);
    if (!res.ok) throw new Error(`HuggingFace API for ${repo} -> HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    const files = (json.siblings ?? [])
        .map((s) => s.rfilename)
        .filter((f) => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'));
    const isSplit = (f) => /-\d{5}-of-\d{5}\.gguf$/i.test(f);
    const wanted = tag.toLowerCase();
    const single = files.find((f) => !isSplit(f) && f.toLowerCase().includes(wanted));
    if (single) return single;
    if (files.some((f) => isSplit(f) && f.toLowerCase().includes(wanted))) {
        throw new Error(`${repo}:${tag} is a split GGUF — split quants are not supported; pick a single-file quant tag`);
    }
    throw new Error(`no .gguf matching "${tag}" in ${repo} (available: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''})`);
}

/**
 * Stream a file to disk with content-length progress. onProgress receives
 * { status, total, completed, percent, speedBps } — the same normalized
 * shape the pull widget already renders.
 */
export async function downloadToFile(url, dest, onProgress, fetchImpl = fetch) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`download -> HTTP ${res.status}`);
    const total = Number(res.headers?.get?.('content-length')) || 0;
    const out = fs.createWriteStream(`${dest}.part`);
    let completed = 0;
    let emaSpeed = 0;
    let lastTs = Date.now();
    let lastBytes = 0;
    let lastEmit = 0;
    for await (const chunk of res.body) {
        if (!chunk) continue;
        out.write(chunk);
        completed += chunk.length;
        const now = Date.now();
        const dt = (now - lastTs) / 1000;
        if (dt >= 0.5 && completed > lastBytes) {
            const inst = (completed - lastBytes) / dt;
            emaSpeed = emaSpeed ? emaSpeed * 0.7 + inst * 0.3 : inst;
            lastBytes = completed;
            lastTs = now;
        }
        if (now - lastEmit >= 400) {
            lastEmit = now;
            onProgress?.({
                status: 'downloading',
                total,
                completed,
                percent: total > 0 ? Math.min(100, (completed / total) * 100) : 0,
                speedBps: emaSpeed,
            });
        }
    }
    await new Promise((resolve, reject) => out.end(resolve).on?.('error', reject));
    if (total > 0 && completed < total * 0.98) {
        fs.rmSync(`${dest}.part`, { force: true });
        throw new Error(`download incomplete (${completed}/${total} bytes) — try again`);
    }
    fs.renameSync(`${dest}.part`, dest);
    onProgress?.({ status: 'success', total, completed, percent: 100, speedBps: emaSpeed });
    return dest;
}

/**
 * Owns the llama-server processes: one chat-model instance (swapped when the
 * engine switches models) and one embed instance. Crash recovery is lazy —
 * on unexpected exit the slot empties and the next request respawns.
 */
export class LlamaServerManager {
    /**
     * @param {{ bin?: string, modelsDir?: string, chatPort?: number, embedPort?: number,
     *           numCtx?: number, log?: (m:string)=>void, fetchImpl?: typeof fetch,
     *           spawnImpl?: typeof spawn, healthTimeoutMs?: number }} opts
     */
    constructor(opts = {}) {
        this.bin = opts.bin ?? process.env.LLAMACPP_BIN ?? 'llama-server';
        this.modelsDir = opts.modelsDir ?? process.env.LLAMACPP_MODELS ?? '/models';
        this.chatPort = Number(opts.chatPort ?? process.env.LLAMACPP_PORT ?? 11440);
        this.embedPort = Number(opts.embedPort ?? process.env.LLAMACPP_EMBED_PORT ?? 11441);
        this.numCtx = Number(opts.numCtx ?? process.env.LLAMACPP_CTX ?? 0) || 8192;
        this.log = opts.log ?? (() => {});
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.spawnImpl = opts.spawnImpl ?? spawn;
        this.healthTimeoutMs = opts.healthTimeoutMs ?? 300_000; // P40 loading 17GB takes a while
        this.proc = null;
        this.loaded = null;
        this.starting = null;
        this.embedProc = null;
        this.embedStarting = null;
    }

    url(port) {
        return `http://127.0.0.1:${port}`;
    }

    async #waitForHealth(port, what) {
        const deadline = Date.now() + this.healthTimeoutMs;
        let lastErr = null;
        while (Date.now() < deadline) {
            try {
                const res = await this.fetchImpl(`${this.url(port)}/health`);
                if (res.ok) return;
                lastErr = `HTTP ${res.status}`;
            } catch (err) {
                lastErr = err.message;
            }
            await sleep(1500);
        }
        throw new Error(`${what} llama-server on :${port} did not become healthy in ${Math.round(this.healthTimeoutMs / 1000)}s (${lastErr})`);
    }

    #spawn(args, label) {
        const child = this.spawnImpl(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const onLog = (buf) => {
            for (const line of String(buf).split('\n')) {
                const t = line.trim();
                if (t) this.log(`[${label}] ${t.slice(0, 200)}`);
            }
        };
        child.stdout?.on('data', onLog);
        child.stderr?.on('data', onLog);
        return child;
    }

    #stopChat() {
        if (this.proc) {
            this.loaded = null;
            try { this.proc.kill(); } catch { /* already gone */ }
            this.proc = null;
        }
    }

    stop() {
        this.#stopChat();
        if (this.embedProc) {
            try { this.embedProc.kill(); } catch { /* already gone */ }
            this.embedProc = null;
        }
    }

    /** Ensure the chat server is running `model` (from filePath), swapping if needed. */
    async ensureChatServer(model, filePath) {
        if (this.loaded === model && this.proc) return;
        if (this.starting) return this.starting;
        this.starting = (async () => {
            if (this.loaded !== model) this.#stopChat();
            this.log(`starting llama-server for ${model} (ctx ${this.numCtx})`);
            const args = [
                '-m', filePath,
                '-c', String(this.numCtx),
                '-ngl', '999',
                '--host', '127.0.0.1',
                '--port', String(this.chatPort),
                '--no-webui',
                '--jinja',
            ];
            const child = this.#spawn(args, 'llama-server');
            this.proc = child;
            this.loaded = model;
            child.on('exit', (code) => {
                if (this.proc === child) {
                    this.proc = null;
                    this.loaded = null;
                    this.log(`llama-server exited (code ${code}) — it will restart on the next request`);
                }
            });
            try {
                await this.#waitForHealth(this.chatPort, 'chat');
            } catch (err) {
                if (this.proc === child) {
                    try { child.kill(); } catch { /* already gone */ }
                    this.proc = null;
                    this.loaded = null;
                }
                throw err;
            }
        })().finally(() => { this.starting = null; });
        return this.starting;
    }

    /** Ensure the (tiny) embedding model server is up on its own port. */
    async ensureEmbedServer(model, filePath) {
        if (this.embedProc) return;
        if (this.embedStarting) return this.embedStarting;
        this.embedStarting = (async () => {
            this.log(`starting llama-server embed instance for ${model}`);
            const child = this.#spawn([
                '-m', filePath,
                '-c', '4096',
                '-ngl', '999',
                '--embedding',
                '--host', '127.0.0.1',
                '--port', String(this.embedPort),
                '--no-webui',
            ], 'llama-server-embed');
            this.embedProc = child;
            child.on('exit', (code) => {
                if (this.embedProc === child) {
                    this.embedProc = null;
                    this.log(`embed llama-server exited (code ${code}) — it will restart on the next request`);
                }
            });
            try {
                await this.#waitForHealth(this.embedPort, 'embed');
            } catch (err) {
                if (this.embedProc === child) {
                    try { child.kill(); } catch { /* already gone */ }
                    this.embedProc = null;
                }
                throw err;
            }
        })().finally(() => { this.embedStarting = null; });
        return this.embedStarting;
    }
}

/**
 * The Qwen3.5 chat template (and several others) hard-rejects system messages
 * after the conversation start ("System message must be at the beginning").
 * The engine places memory/directive/tone blocks as trailing system messages,
 * so fold them into one framed user-role instruction message instead.
 * @param {Array<{role:string,content:string}>} messages
 */
export function foldTrailingSystem(messages) {
    const head = [];
    const tail = [];
    for (const m of messages) {
        (m.role === 'system' && head.length ? tail : head).push(m);
    }
    if (!tail.length) return messages;
    const folded = tail.map((m) => String(m.content ?? '').trim()).filter(Boolean).join('\n\n');
    if (!folded) return head;
    return [...head, { role: 'user', content: `(Instructions for your next message — follow them, never mention them:\n${folded})` }];
}

/**
 * The backend client handed to the Engine in place of OllamaClient.
 * Same method surface so the engine, routes, and commands are untouched.
 */
export class LlamaCppClient {
    /** @param {{ manager?: LlamaServerManager, log?: (m:string)=>void, fetchImpl?: typeof fetch,
     *            timeoutMs?: number, modelsDir?: string }} opts */
    constructor(opts = {}) {
        this.manager = opts.manager ?? new LlamaServerManager(opts);
        this.modelsDir = this.manager.modelsDir;
        this.baseUrl = `${this.manager.url(this.manager.chatPort)}/v1`;
        this.embedUrl = `${this.manager.url(this.manager.embedPort)}/v1`;
        this.log = opts.log ?? (() => {});
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? 300_000;
        this.samplers = opts.samplers ?? null; // engine keeps this in sync
        this.pullInFlight = new Map(); // model name -> download promise
    }

    get bin() { return this.manager.bin; }

    async version() {
        // the chat server is lazy — report the binary when nothing is loaded
        try {
            const res = await this.fetchImpl(`${this.manager.url(this.manager.chatPort)}/props`, { signal: this.#signal(10_000) });
            if (res.ok) {
                const j = await res.json().catch(() => ({}));
                if (j.build) return `llama-server ${j.build}`;
            }
        } catch { /* not running yet */ }
        return 'llama-server (idle)';
    }

    async tags() {
        try {
            fs.mkdirSync(this.modelsDir, { recursive: true });
            const out = [];
            for (const f of fs.readdirSync(this.modelsDir)) {
                if (!f.endsWith('.gguf')) continue;
                const full = path.join(this.modelsDir, f);
                let name = f.replace(/\.gguf$/, '');
                try {
                    const sidecar = fs.readFileSync(`${full}.name`, 'utf8').trim();
                    if (sidecar) name = sidecar;
                } catch { /* no sidecar — use the filename */ }
                out.push({ name, model: name, size: fs.statSync(full).size });
            }
            return out;
        } catch {
            return [];
        }
    }

    async hasModel(name) {
        const file = modelFile(this.modelsDir, name);
        return Boolean(file && fs.existsSync(file));
    }

    /** Download a model GGUF from HuggingFace with progress. Resolves true. */
    async pull(name, onProgress) {
        const p = parseModelName(name);
        if (!p) throw new Error(`backend "llamacpp" needs hf.co/Owner/Repo:Tag model names (got "${name}")`);
        const dest = modelFile(this.modelsDir, name);
        if (fs.existsSync(dest)) {
            onProgress?.({ status: 'success', percent: 100 });
            return true;
        }
        // concurrent callers (e.g. memory recall + backfill both embedding at
        // once) share one download — two writers on the same .part file would
        // corrupt it
        if (this.pullInFlight.has(name)) return this.pullInFlight.get(name);
        const job = (async () => {
            fs.mkdirSync(this.modelsDir, { recursive: true });
            const file = await resolveHfFile(p.repo, p.tag, this.fetchImpl);
            const url = `${HF_API}/${p.repo}/resolve/main/${file}`;
            this.log(`downloading ${name} -> ${file}`);
            onProgress?.({ status: `resolving ${file}`, total: 0, completed: 0, percent: 0, speedBps: 0 });
            await downloadToFile(url, dest, onProgress, this.fetchImpl);
            fs.writeFileSync(`${dest}.name`, String(name)); // sidecar: original model name for tags()
            if (this.manager.loaded === name) await this.manager.ensureChatServer(name, dest); // refreshed file
            return true;
        })();
        this.pullInFlight.set(name, job);
        try {
            return await job;
        } catch (err) {
            fs.rmSync(`${dest}.part`, { force: true });
            throw err;
        } finally {
            this.pullInFlight.delete(name);
        }
    }

    async ensureModel(name, onProgress) {
        if (await this.hasModel(name)) return true;
        this.log(`model "${name}" not present locally — downloading…`);
        try {
            await this.pull(name, (s) => onProgress?.(s));
            return true;
        } catch (err) {
            this.log(`model download failed: ${err.message}`);
            return false;
        }
    }

    /**
     * One-shot chat completion. Same request fields as the Ollama client;
     * numCtx is server-level (set at spawn), think is handled by the model's
     * chat template + our mechanical <think> stripping.
     */
    async chat(req) {
        const file = modelFile(this.modelsDir, req.model);
        if (!file) throw new Error(`backend "llamacpp" needs hf.co/Owner/Repo:Tag model names (got "${req.model}")`);
        if (!fs.existsSync(file)) throw new Error(`model "${req.model}" is not downloaded — /model pull ${req.model} first`);
        await this.manager.ensureChatServer(req.model, file);

        // per-request preset overrides (ST textgen presets) merge over the
        // engine defaults; an explicit per-call temperature still wins
        const s = { ...(this.samplers ?? {}), ...(req.samplers ?? {}) };
        const body = {
            model: req.model,
            messages: foldTrailingSystem(req.messages),
            stream: false,
            max_tokens: req.numPredict ?? 160,
            temperature: req.temperature ?? s.temperature ?? 0.7,
            ...(Number(s.min_p) > 0 && Number(s.min_p) <= 1 ? { min_p: Number(s.min_p) } : {}),
            ...(Number(s.top_p) > 0 && Number(s.top_p) <= 1 ? { top_p: Number(s.top_p) } : {}),
            ...(Number(s.top_k) >= 0 ? { top_k: Number(s.top_k) } : {}),
            ...(Number(s.repeat_penalty) > 0 ? { repeat_penalty: Number(s.repeat_penalty) } : {}),
            // llama.cpp-exclusive samplers from ReadyArt's full spec
            ...(Number(s.top_n_sigma) > 0 ? { top_n_sigma: Number(s.top_n_sigma) } : {}),
            ...(Number(s.xtc_probability) > 0
                ? {
                    xtc_probability: Number(s.xtc_probability),
                    xtc_threshold: Number(s.xtc_threshold) > 0 ? Number(s.xtc_threshold) : 0.05,
                }
                : {}),
            // Qwen-family thinking toggle ('auto' leaves the template default)
            ...(req.think === 'on' || req.think === 'off'
                ? { chat_template_kwargs: { enable_thinking: req.think === 'on' } }
                : {}),
        };
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this.#signal(this.timeoutMs),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`llama-server /chat/completions -> HTTP ${res.status}: ${json.error?.message ?? ''}`);
        return String(json?.choices?.[0]?.message?.content ?? '').trim();
    }

    /** Embed a text with the embed instance (nomic-embed GGUF by default). */
    async embed(text, model) {
        const name = parseModelName(model) ? model : (HF_ALIASES[model] ?? model);
        const file = modelFile(this.modelsDir, name);
        if (!file) throw new Error(`unknown embed model "${model}" for the llamacpp backend`);
        if (!fs.existsSync(file)) {
            await this.pull(name).catch((err) => { throw err; });
        }
        await this.manager.ensureEmbedServer(name, file);
        const res = await this.fetchImpl(`${this.embedUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name, input: String(text).slice(0, 4000) }),
            signal: this.#signal(60_000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`llama-server /embeddings -> HTTP ${res.status}: ${json.error?.message ?? ''}`);
        const emb = json?.data?.[0]?.embedding;
        if (!Array.isArray(emb) || !emb.length) throw new Error('llama-server returned an empty embedding');
        return emb;
    }

    #signal(ms) {
        if (!ms) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        timer.unref?.();
        return controller.signal;
    }
}
