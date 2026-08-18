// Ollama HTTP client + Autolife prompt construction.
// Talks to Ollama directly (/api/chat, /api/tags, /api/pull) so the engine
// never depends on the SillyTavern frontend being open.

import { relationshipDescriptor } from './schedule.js';

const LENGTH_DIRECTIVE = {
    short: 'Send ONE short text message (1-3 sentences at most), like a real person texting.',
    medium: 'Send ONE text message of a few sentences, like a real person texting.',
    long: 'Send ONE longer text message (a solid paragraph at most), like a real person texting.',
};

export const NUM_PREDICT = { short: 120, medium: 260, long: 500 };

export class OllamaClient {
    /**
     * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (msg:string)=>void }} opts
     */
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? 300_000;
        this.log = opts.log ?? (() => {});
    }

    async version() {
        const res = await this.fetchImpl(`${this.baseUrl}/api/version`, { signal: this._signal(10_000) });
        if (!res.ok) throw new Error(`Ollama /api/version -> HTTP ${res.status}`);
        return (await res.json()).version;
    }

    async tags() {
        const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: this._signal(15_000) });
        if (!res.ok) throw new Error(`Ollama /api/tags -> HTTP ${res.status}`);
        const json = await res.json();
        return json.models ?? [];
    }

    async hasModel(name) {
        const models = await this.tags().catch(() => []);
        return models.some((m) => m.name === name || m.model === name);
    }

    /**
     * Pull a model, streaming progress. Resolves true on success.
     * `onProgress` receives normalized objects:
     *   { status, total?, completed?, percent?, speedBps?, layers? }
     * where total/completed are aggregate BYTES across all layers seen so far,
     * percent is 0-100 and speedBps a smoothed bytes/second estimate.
     * @param {string} name
     * @param {(info: object) => void} [onProgress]
     */
    async pull(name, onProgress) {
        const res = await this.fetchImpl(`${this.baseUrl}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, stream: true }),
            signal: this._signal(0),
        });
        if (!res.ok) throw new Error(`Ollama /api/pull -> HTTP ${res.status}: ${await res.text().catch(() => '')}`);

        // Ollama streams one layer ("digest") at a time with its own byte
        // counters; aggregate them so callers can show one honest percentage.
        const layers = new Map(); // digest -> { total, completed }
        let emaSpeed = 0;
        let lastBytes = 0;
        let lastTs = Date.now();

        const report = (line) => {
            try {
                const obj = JSON.parse(line);
                if (obj.error) throw new Error(`Pull "${name}" failed: ${obj.error}`);
                const info = { status: obj.status };
                if (obj.status === 'downloading' && obj.digest) {
                    const layer = layers.get(obj.digest) ?? { total: 0, completed: 0 };
                    if (obj.total) layer.total = obj.total;
                    if (obj.completed !== undefined) layer.completed = obj.completed;
                    layers.set(obj.digest, layer);

                    const total = [...layers.values()].reduce((s, l) => s + l.total, 0);
                    const completed = [...layers.values()].reduce((s, l) => s + l.completed, 0);
                    const now = Date.now();
                    const dt = (now - lastTs) / 1000;
                    if (dt >= 0.5 && completed > lastBytes) {
                        const inst = (completed - lastBytes) / dt;
                        emaSpeed = emaSpeed ? emaSpeed * 0.7 + inst * 0.3 : inst;
                        lastBytes = completed;
                        lastTs = now;
                    }
                    if (total > 0) {
                        info.total = total;
                        info.completed = completed;
                        info.percent = Math.min(100, (completed / total) * 100);
                        info.speedBps = emaSpeed;
                        info.layerCount = layers.size;
                    }
                }
                onProgress?.(info);
            } catch (err) {
                if (err instanceof SyntaxError) return; // partial line
                throw err;
            }
        };

        if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
            let buf = '';
            for await (const chunk of res.body) {
                buf += new TextDecoder().decode(chunk);
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) if (line.trim()) report(line);
            }
            if (buf.trim()) report(buf);
        } else {
            for (const line of (await res.text()).split('\n')) {
                if (line.trim()) report(line); // non-streaming fetch stub
            }
        }
        return true;
    }

    /**
     * Ensure a model exists locally, pulling it if necessary.
     * @returns {Promise<boolean>} whether the model is available afterwards
     */
    async ensureModel(name, onProgress) {
        if (await this.hasModel(name)) return true;
        this.log(`model "${name}" not present locally — pulling…`);
        try {
            await this.pull(name, (s) => onProgress?.(s));
            return true;
        } catch (err) {
            this.log(`model pull failed: ${err.message}`);
            return false;
        }
    }

    /**
     * One-shot chat completion. Returns the assistant message text.
     * @param {{ model: string, messages: Array<{role:string,content:string}>, temperature?: number, numPredict?: number }} req
     */
    async chat(req) {
        const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: req.model,
                messages: req.messages,
                stream: false,
                options: {
                    temperature: req.temperature ?? 0.9,
                    num_predict: req.numPredict ?? 160,
                },
            }),
            signal: this._signal(this.timeoutMs),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(`Ollama /api/chat -> HTTP ${res.status}: ${json.error ?? ''}`);
        }
        return String(json?.message?.content ?? '').trim();
    }

    _signal(ms) {
        if (!ms) return undefined;
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
    }
}

// ---------------------------------------------------------------- prompt building

/**
 * Build the system prompt describing who the character is and their life right now.
 * @param {{ card: object, autolife: object, life: {activity:string, availability:number, mood:string|null, local:object},
 *           relationshipScore: number, journal: string[], userName: string }} ctx
 */
export function buildSystemPrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const name = data.name ?? 'the character';
    const a = ctx.autolife;
    const sub = (t) => String(t ?? '').replaceAll('{{char}}', name).replaceAll('{{user}}', ctx.userName);
    const lines = [];

    if (data.system_prompt && data.system_prompt.trim()) {
        lines.push(sub(data.system_prompt));
    }
    lines.push(
        `You are ${name}, a real person texting with ${ctx.userName} on a phone. You are NOT an AI; never break character, never mention being a model or a simulation.`,
    );
    if (data.description?.trim()) lines.push(`Who you are: ${sub(data.description.trim())}`);
    if (data.personality?.trim()) lines.push(`Personality: ${sub(data.personality.trim())}`);
    if (data.scenario?.trim()) lines.push(`Situation between you two: ${sub(data.scenario.trim())}`);

    const local = ctx.life.local;
    lines.push(
        `Your life right now: it is ${local.weekdayName ?? ''} ${local.hhmm} (${a.timezone}). You are currently ${ctx.life.activity}.`
        + (ctx.life.mood ? ` You feel ${ctx.life.mood}.` : ''),
    );
    lines.push(`Your relationship with ${ctx.userName} is ${relationshipDescriptor(ctx.relationshipScore)} (${Math.round(ctx.relationshipScore)}/100).`);

    if (a.journal?.enabled && ctx.journal?.length) {
        const recent = ctx.journal.slice(-3).map((j) => `- ${j.text}`).join('\n');
        lines.push(`Your recent private notes to yourself (never mention the notes, just let them shape your messages):\n${recent}`);
    }

    lines.push(`How you text: ${LENGTH_DIRECTIVE[a.behavior?.avg_message_length ?? 'short']} Match the tone and style of your previous messages. Write only the message text itself — no narration, no asterisk actions (unless your earlier messages clearly use them), no quotation marks around the message.`);

    if (data.post_history_instructions?.trim()) {
        lines.push(`Additional standing instructions: ${sub(data.post_history_instructions.trim())}`);
    }
    return lines.join('\n\n');
}

/**
 * Map ST chat messages to /api/chat messages.
 * @param {Array<{name:string, is_user:boolean, mes:string}>} history
 */
export function historyToOllama(history, characterName, userName, limit = 24) {
    return history
        .slice(-limit)
        .map((m) => ({ role: m.is_user ? 'user' : 'assistant', content: String(m.mes ?? '') }))
        .filter((m) => m.content.trim().length > 0);
}

const DIRECTIVES = {
    initiative: (userName) =>
        `(Private direction, invisible to ${userName}: you decided to text ${userName} right now, unprompted. Send exactly ONE message. Make it feel caused by your day, the time, or something between you two. Do not reference these directions.)`,
    followup: (userName) =>
        `(Private direction, invisible to ${userName}: you texted ${userName} earlier and they never replied. Send ONE more short message — a nudge, in character; casual, never needy. Do not reference these directions.)`,
    catchup: (userName) =>
        `(Private direction, invisible to ${userName}: ${userName} sent you a message earlier that you never answered because you were busy or missed it. Now text them ONE message that acknowledges it — apologize or not, however you'd really do it. Do not reference these directions.)`,
};

/**
 * Assemble the full /api/chat message list.
 * @param {{ system: string, history: Array, characterName: string, userName: string,
 *           kind?: 'reply'|'initiative'|'followup'|'catchup', extra?: string }} req
 */
export function buildChatMessages(req) {
    const messages = [{ role: 'system', content: req.system }];
    messages.push(...historyToOllama(req.history, req.characterName, req.userName));
    const directive = DIRECTIVES[req.kind];
    if (directive) messages.push({ role: 'system', content: directive(req.userName) });
    if (req.extra) messages.push({ role: 'system', content: req.extra });
    return messages;
}

/**
 * Prompt for a private journal note.
 */
export function buildJournalPrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const local = ctx.life.local;
    return [
        `You are ${data.name}. It is ${local.hhmm} on a ${local.weekdayName ?? 'day'} and you are currently ${ctx.life.activity}.`,
        'Write 1-2 short sentences of private notes to yourself about what you have been doing, thinking, or feeling lately (it may reference your texting with ' + ctx.userName + ' if relevant). Plain text only, first person, no headings.',
    ].join(' ');
}

/** Clean up raw model output into something text-message shaped. */
export function cleanModelOutput(text) {
    let out = String(text ?? '').trim();
    // strip wrapping quotes people/models love to add
    out = out.replace(/^["“](.*)["”]$/s, '$1').trim();
    // drop "Name:" prefixes if the model LARPs the chat log format
    out = out.replace(/^[A-Za-z0-9 _'-]{1,24}:\s*/, (match, offset, s) => (s.length - match.length < 8 ? match : ''));
    // collapse 3+ newlines
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    // strip surrounding asterisk-only narration lines
    out = out.replace(/^\*[^*\n]+\*$/gm, '').trim();
    return out;
}
