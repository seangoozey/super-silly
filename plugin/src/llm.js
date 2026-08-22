// Ollama HTTP client + Autolife prompt construction.
// Talks to Ollama directly (/api/chat, /api/tags, /api/pull) so the engine
// never depends on the SillyTavern frontend being open.

import { relationshipDescriptor } from './schedule.js';

const LENGTH_DIRECTIVE = {
    short: 'Send ONE short text message (1-3 sentences at most), like a real person texting.',
    medium: 'Send ONE text message of a few sentences, like a real person texting.',
    long: 'Send ONE longer text message (a solid paragraph at most), like a real person texting.',
};

export const NUM_PREDICT = { short: 200, medium: 360, long: 700 };

/**
 * Split model output into texting-style bursts: one message per paragraph
 * (blank-line separated), the way a real person sends several texts in a row.
 * Long single paragraphs are sentence-split around ~900 chars; at most 6 parts.
 */
export function splitIntoTexts(text) {
    const paragraphs = String(text ?? '')
        .split(/\n{2,}/)
        .map((p) => p.trim().replace(/\n/g, ' '))
        .filter(Boolean);
    const parts = [];
    for (const p of paragraphs) {
        if (p.length <= 900) {
            parts.push(p);
            continue;
        }
        // sentence-split oversized paragraphs
        const sentences = p.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [p];
        let buf = '';
        for (const s of sentences) {
            if ((buf + s).length > 900 && buf) {
                parts.push(buf.trim());
                buf = s;
            } else {
                buf += s;
            }
        }
        if (buf.trim()) parts.push(buf.trim());
    }
    if (parts.length > 6) {
        const head = parts.slice(0, 5);
        head.push(parts.slice(5).join(' '));
        return head;
    }
    return parts.length ? parts : [String(text ?? '').trim()].filter(Boolean);
}

export class OllamaClient {
    /**
     * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (msg:string)=>void }} opts
     */
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? 300_000;
        this.log = opts.log ?? (() => {});
        // default sampler set (temperature/top_p/top_k/repeat_penalty) the
        // engine keeps in sync with settings; per-request values still win
        this.samplers = opts.samplers ?? null;
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
                // Download progress lines: older Ollama says "downloading",
                // 0.32.x says "pulling <id>" — both carry digest/total/completed.
                const isProgressLine = obj.digest && (obj.status === 'downloading' || obj.status.startsWith('pulling ') || (obj.total !== undefined && obj.completed !== undefined));
                if (isProgressLine) {
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
     * @param {{ model: string, messages: Array<{role:string,content:string}>, temperature?: number,
     *           numPredict?: number, think?: 'on'|'off'|'auto' }} req
     * `think: 'on'|'off'` maps to Ollama's boolean `think` flag; 'auto'/undefined
     * omits it so the model's own chat template default decides. Models that
     * reject the flag fall back to an omit-retry.
     */
    async chat(req) {
        const send = async (body) => this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this._signal(this.timeoutMs),
        });

        // per-request preset overrides (ST textgen presets) merge over the
        // engine defaults; an explicit per-call temperature still wins
        const s = { ...(this.samplers ?? {}), ...(req.samplers ?? {}) };
        const body = {
            model: req.model,
            messages: req.messages,
            stream: false,
            // keep models resident in VRAM indefinitely — the engine texts at
            // arbitrary hours and reloading 17GB from disk on the P40 is brutal
            keep_alive: req.keepAlive ?? -1,
            options: {
                temperature: req.temperature ?? s.temperature ?? 0.7,
                num_predict: req.numPredict ?? 160,
                ...(req.numCtx && req.numCtx > 0 ? { num_ctx: req.numCtx } : {}),
                // neutral-by-default sampler overrides (ReadyArt spec): sent
                // explicitly so Ollama's own defaults don't silently apply
                ...(Number(s.top_p) > 0 && Number(s.top_p) <= 1 ? { top_p: Number(s.top_p) } : {}),
                ...(Number.isFinite(Number(s.top_k)) && Number(s.top_k) >= 0 ? { top_k: Number(s.top_k) } : {}),
                ...(Number(s.repeat_penalty) > 0 ? { repeat_penalty: Number(s.repeat_penalty) } : {}),
                ...(Number(s.min_p) > 0 && Number(s.min_p) <= 1 ? { min_p: Number(s.min_p) } : {}),
                ...(Number(s.frequency_penalty) ? { frequency_penalty: Number(s.frequency_penalty) } : {}),
                ...(Number(s.presence_penalty) ? { presence_penalty: Number(s.presence_penalty) } : {}),
            },
        };
        if (req.think === 'on') body.think = true;
        else if (req.think === 'off') body.think = false;

        let res = await send(body);
        let json = await res.json().catch(() => ({}));
        if (res.status === 400 && body.think !== undefined && /think/i.test(String(json.error ?? ''))) {
            this.log(`model "${req.model}" rejected the think flag (${json.error}) — retrying without it`);
            delete body.think;
            res = await send(body);
            json = await res.json().catch(() => ({}));
        }
        if (!res.ok) {
            throw new Error(`Ollama /api/chat -> HTTP ${res.status}: ${json.error ?? ''}`);
        }
        return String(json?.message?.content ?? '').trim();
    }

    /**
     * Embed a text with an Ollama embedding model.
     * @returns {Promise<number[]>}
     */
    async embed(text, model) {
        const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: String(text).slice(0, 4000), keep_alive: -1 }),
            signal: this._signal(60_000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Ollama /api/embeddings -> HTTP ${res.status}: ${json.error ?? ''}`);
        if (!Array.isArray(json.embedding) || !json.embedding.length) throw new Error('Ollama returned an empty embedding');
        return json.embedding;
    }

    _signal(ms) {
        if (!ms) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        timer.unref?.(); // don't hold the process open for a pending abort
        return controller.signal;
    }
}

// ---------------------------------------------------------------- prompt building

/**
 * Build the system prompt describing who the character is and their life right now.
 * @param {{ card: object, autolife: object, life: {activity:string, availability:number, mood:string|null, local:object},
 *           relationshipScore: number, journal: string[], userName: string }} ctx
 */
/**
 * Build the system prompt describing who the character is and their life right now.
 * With ctx.template (card override or global default), sections are placed into
 * the template's {{placeholders}} instead of the built-in fixed assembly.
 */
export function buildSystemPrompt(ctx) {
    const s = promptSections(ctx);
    const template = (typeof ctx.template === 'string' && ctx.template.trim()) ? ctx.template : null;
    if (!template) {
        return [s.cardSystem, s.identity, s.description, s.personality, s.scenario, s.aboutUser, s.evolve, s.life, s.relationship, s.journal, s.style, s.postHistory]
            .filter(Boolean).join('\n\n');
    }
    const sub = (name) => s[name] ?? '';
    let out = template
        .replace(/\{\{card_system\}\}/gi, () => sub('cardSystem'))
        .replace(/\{\{identity\}\}/gi, () => sub('identity'))
        .replace(/\{\{description\}\}/gi, () => sub('description'))
        .replace(/\{\{personality\}\}/gi, () => sub('personality'))
        .replace(/\{\{scenario\}\}/gi, () => sub('scenario'))
        .replace(/\{\{about_user\}\}/gi, () => sub('aboutUser'))
        .replace(/\{\{evolve\}\}/gi, () => sub('evolve'))
        .replace(/\{\{life\}\}/gi, () => sub('life'))
        .replace(/\{\{relationship\}\}/gi, () => sub('relationship'))
        .replace(/\{\{journal\}\}/gi, () => sub('journal'))
        .replace(/\{\{style\}\}/gi, () => sub('style'))
        .replace(/\{\{post_history\}\}/gi, () => sub('postHistory'))
        .replace(/\{\{time\}\}/gi, () => ctx.life.local.hhmm)
        .replace(/\{\{weekday\}\}/gi, () => ctx.life.local.weekdayName ?? '')
        .replace(/\{\{activity\}\}/gi, () => ctx.life.activity)
        .replace(/\{\{char\}\}/gi, () => (ctx.card.data ?? ctx.card).name ?? '')
        .replace(/\{\{user\}\}/gi, () => ctx.userName);
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The named sections available to prompt templates (and the built-in order).
 * Empty/absent sections are null so templates can omit them cleanly.
 */
export function promptSections(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const name = data.name ?? 'the character';
    const a = ctx.autolife;
    const sub = (t) => String(t ?? '').replaceAll('{{char}}', name).replaceAll('{{user}}', ctx.userName);
    const sections = {};

    sections.cardSystem = data.system_prompt?.trim() ? sub(data.system_prompt) : null;
    sections.identity = `You are ${name}, a real person texting with ${ctx.userName} on a phone. You are NOT an AI; never break character, never mention being a model or a simulation.`;
    sections.description = data.description?.trim() ? `Who you are: ${sub(data.description)}` : null;
    sections.personality = data.personality?.trim() ? `Personality: ${sub(data.personality)}` : null;
    sections.scenario = data.scenario?.trim() ? `Situation between you two: ${sub(data.scenario)}` : null;
    sections.aboutUser = a.about_user?.trim() ? `What you know about ${ctx.userName}: ${sub(a.about_user)}` : null;
    if (a.evolve?.enabled && ctx.evolveNotes?.length) {
        const recent = ctx.evolveNotes.slice(-6).map((n) => `- ${n.text}`).join('\n');
        sections.evolve = `How you've changed since the above was written (your own later reflections — live them, don't recite them):\n${recent}`;
    } else {
        sections.evolve = null;
    }

    const local = ctx.life.local;
    sections.life = `Your life right now: it is ${local.weekdayName ?? ''} ${local.hhmm} (${a.timezone}). You are currently ${ctx.life.activity}.`
        + (ctx.life.mood ? ` You feel ${ctx.life.mood}.` : '');
    sections.relationship = `Your relationship with ${ctx.userName} is ${relationshipDescriptor(ctx.relationshipScore)} (${Math.round(ctx.relationshipScore)}/100).`;

    if (a.journal?.enabled && ctx.journal?.length) {
        const recent = ctx.journal.slice(-3).map((j) => `- ${j.text}`).join('\n');
        sections.journal = `Your recent private notes to yourself (never mention the notes, just let them shape your messages):\n${recent}`;
    } else {
        sections.journal = null;
    }

    sections.style = `How you text: ${LENGTH_DIRECTIVE[a.behavior?.avg_message_length ?? 'short']} Match the tone and style of your previous messages. Write only the message text itself — no narration, no asterisk actions, no quotation marks around the message. Never quote, repeat, or echo ${ctx.userName}'s words back to them — always write your own new words.`
        + ' If you want to send another text right away, end your message with {follow-up} — otherwise never write that marker.';
    sections.postHistory = data.post_history_instructions?.trim() ? `Additional standing instructions: ${sub(data.post_history_instructions)}` : null;

    return sections;
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
 * Directive for a self-reflection ("how I've changed") note. Cool generation,
 * grounded in journal + actual messages, hard-clamped against redefining core
 * personality.
 */
export function buildEvolvePrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    return [
        `You are ${data.name}. Your personality as originally written: ${data.personality?.trim() || '(none)'}.`,
        `Your situation as originally written: ${data.scenario?.trim() || '(none)'}.`,
        `Based on your recent journal notes and your ACTUAL messages with ${ctx.userName} shown in this conversation, reflect on how you have DURABLY changed since that was written — not a passing mood.`,
        `Write 1-2 short first-person sentences describing the change (e.g. "I have gotten much more sarcastic with them than I used to be.").`,
        'Rules: never contradict your core personality; describe change relative to the original writing; plain text only; no lists.',
    ].join(' ');
}

/**
 * Directive for a self-reflection ("how I've changed") note. Cool generation,
 * grounded in journal + actual messages, clamped against redefining core
 * personality.
 */
/**
 * Format retrieved memory hits as a compact system block for the prompt.
 * @param {Array<{ts: string, role: string, text: string, score: number}>} hits
 */
export function buildMemoryContext(hits, userName, characterName) {
    const fmt = (ts) => {
        const d = new Date(ts);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    const lines = hits.map((h) => `[${fmt(h.ts)}] ${h.role === 'user' ? userName : characterName}: ${String(h.text).slice(0, 300)}`);
    return `Texts from earlier in your history with ${userName} (your own memories of past exchanges — respond to them if relevant; NEVER quote, repeat, or recite them back):\n${lines.join('\n')}`;
}

/**
 * Assemble the full /api/chat message list.
 * @param {{ system: string, history: Array, characterName: string, userName: string,
 *           kind?: 'reply'|'initiative'|'followup'|'catchup', extra?: string,
 *           memory?: string }} req
 */
export function buildChatMessages(req) {
    const messages = [{ role: 'system', content: req.system }];
    messages.push(...historyToOllama(req.history, req.characterName, req.userName));
    if (req.memory) messages.push({ role: 'system', content: req.memory });
    const directive = DIRECTIVES[req.kind];
    if (directive) messages.push({ role: 'system', content: directive(req.userName) });
    if (req.extra) messages.push({ role: 'system', content: req.extra });
    return messages;
}

/**
 * Directive for a private journal note, GROUNDED in the actual recent
 * messages: the model must not invent conversations or events involving the
 * user that didn't happen (ungrounded journals were fabricating shared
 * history that then leaked into behavior as if it were real).
 */
export function buildJournalPrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const local = ctx.life.local;
    return [
        `You are ${data.name}. It is ${local.hhmm} on a ${local.weekdayName ?? 'day'} and you are currently ${ctx.life.activity}.`,
        `Write 1-2 short sentences of private notes to yourself about what you have been doing, thinking, or feeling.`,
        `Ground the notes ONLY in your current activity and the ACTUAL messages shown in this conversation. NEVER invent conversations, events, or things ${ctx.userName} said that are not shown — if nothing notable happened with ${ctx.userName}, write about your own day, thoughts or feelings instead. Plain text only, first person, no headings.`,
    ].join(' ');
}

/**
 * Prompt scaffolding that must never reach the user: bracketed system labels
 * the model invents ("[SYSTEM_PROMPT]"), raw instruct-template tokens, and —
 * the observed failure — verbatim parroting of our own injected headers (the
 * memory block, journal/evolve sections, engine directives). Everything after
 * the first marker is hallucinated scaffolding, so we cut there.
 */
const LEAK_MARKER_RES = [
    /\[?\s*system[_ ]?prompt\s*\]?/i,
    /\[?\s*system\s+(?:message|note|block|instructions)\s*\]?/i,
    /\[\/?inst\]/i,
    /<<\s*sys\s*>>/i,
];
const LEAK_MARKER_STRINGS = [
    'Texts from earlier in your history with',          // buildMemoryContext header
    'Your recent private notes to yourself',            // journal section header
    "How you've changed since the above was written",   // evolve section header
    '(Private direction, invisible to',                 // DIRECTIVES prefix
];

/**
 * Remove leaked prompt scaffolding from model output.
 * @returns {{ text: string, leaked: boolean }} text cut at the first marker
 */
export function stripLeakedScaffolding(text) {
    const raw = String(text ?? '');
    let cutAt = -1;
    for (const re of LEAK_MARKER_RES) {
        const m = raw.match(re);
        if (m && (cutAt < 0 || m.index < cutAt)) cutAt = m.index;
    }
    const lower = raw.toLowerCase();
    for (const s of LEAK_MARKER_STRINGS) {
        const i = lower.indexOf(s.toLowerCase());
        if (i >= 0 && (cutAt < 0 || i < cutAt)) cutAt = i;
    }
    if (cutAt < 0) return { text: raw, leaked: false };
    return { text: raw.slice(0, cutAt).trim(), leaked: true };
}

/** Clean up raw model output into something text-message shaped. */
export function cleanModelOutput(text) {
    let out = String(text ?? '').trim();
    // strip reasoning/thinking blocks (Ollama usually separates these, but a
    // model with thinking enabled by its template can still leak them)
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    out = out.replace(/^<think>[\s\S]*$/i, '').trim(); // unclosed (truncated) thinking
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

/**
 * Mechanical texting-format enforcement (applied after cleanModelOutput):
 * - removes roleplay actions / stage directions in asterisks or underscores
 * - removes quotes wrapping a whole paragraph (dialogue formatting)
 * - removes bracketed meta lines the model sometimes emits
 *   ("[Continue from the last system prompt message]", "[OOC: ...]")
 * The prompt asks for plain texts; this guarantees them regardless of
 * model obedience.
 */
export function sanitizeTextingOutput(text) {
    let out = String(text ?? '');
    // bracketed meta lines, e.g. [Continue...], (OOC: ...)
    out = out.replace(/^\s*[\[(]\s*(continue|ooc|note|system|assistant)[^)\]]*[\])]\s*$/gim, '');
    // quote-style echo lines ("> what you said")
    out = out.replace(/^\s*>+\s?.*$/gm, '');
    // asterisk action spans (single-line, non-greedy)
    out = out.replace(/\*{1,3}[^*\n]{0,500}?\*{1,3}/g, ' ');
    out = out.replace(/(?<![\w])_[^_\n]{0,200}?_(?![\w])/g, ' ');
    // quotes wrapping an entire paragraph
    out = out
        .split(/\n{2,}/)
        .map((p) => {
            let t = p.trim();
            if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
                t = t.slice(1, -1).trim();
            }
            return t;
        })
        .filter(Boolean)
        .join('\n\n');
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/**
 * Detect echo: the "reply" repeats or quotes the user's own words back at
 * them (verbatim containment or near-identity after normalization) — a
 * common mid-size-model failure where it recites instead of answering.
 * @param {string} text generated output
 * @param {string[]} userTexts the user's messages (history + current)
 */
export function looksLikeEcho(text, userTexts) {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const n = norm(text);
    if (n.length < 8) return false;
    for (const ut of userTexts) {
        const u = norm(ut);
        if (u.length < 12) continue;
        if (n === u) return true;
        if (u.length >= 15 && n.includes(u)) return true;
        if (n.length >= 15 && u.includes(n) && n.length / u.length > 0.8) return true;
    }
    return false;
}

/**
 * Detect self-recitation: the character resends its own earlier texts
 * verbatim — a mid-size-model failure where, with nothing new to say (often
 * on a follow-up/initiative turn whose context tail is the character's own
 * last chain), it replays a previous chain word-for-word instead of writing
 * something new. Random sampling cannot reproduce a multi-text chain, so any
 * verbatim match here is recitation from context, not coincidence.
 * Short repeats (haha, ok, u up?) stay allowed — humans do those.
 * @param {string} text generated output
 * @param {string[]} ownTexts the character's own recent messages
 */
export function looksLikeSelfRepeat(text, ownTexts) {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const n = norm(text);
    if (n.length < 15) return false;
    for (const ot of ownTexts) {
        const o = norm(ot);
        if (o.length < 15) continue;
        if (n === o) return true;
        if (o.length >= 40 && n.includes(o)) return true; // recited with new padding around it
        if (n.length >= 40 && o.includes(n) && n.length / o.length > 0.75) return true; // partial resend of a long text
    }
    return false;
}

/**
 * The {follow-up} burst protocol: the model ends a text with {follow-up}
 * when it wants to send another text right away.
 * @returns {{ text: string, more: boolean }} text with the marker removed
 */
export function extractFollowUpMarker(text) {
    const raw = String(text ?? '');
    const m = raw.match(/\{\s*follow-?up\s*\}/i);
    if (!m) return { text: raw.trim(), more: false };
    return { text: raw.replace(m[0], '').trim(), more: true };
}
