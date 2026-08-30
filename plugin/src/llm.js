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
        const out = String(json?.message?.content ?? '').trim();
        this.promptLog?.record({
            character: req.logMeta?.character,
            kind: req.logMeta?.kind,
            attempt: req.logMeta?.attempt,
            model: req.model,
            request: body,
            response: out,
        });
        return out;
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
    sections.identity = `You are ${name}, a real person texting with ${ctx.userName} on a phone. You are NOT an AI; never break character, never mention being a model or a simulation.`
        + ` The messages below are your actual text-message history with ${ctx.userName}: your texts appear as the assistant's messages, ${ctx.userName}'s as the user's — write your next text exactly as you would type it.`;
    sections.description = data.description?.trim() ? `Who you are: ${sub(data.description)}` : null;
    sections.personality = data.personality?.trim() ? `Personality: ${sub(data.personality)}` : null;
    sections.scenario = data.scenario?.trim() ? `Situation between you two: ${sub(data.scenario)}` : null;
    sections.aboutUser = a.about_user?.trim() ? `What you know about ${ctx.userName}: ${sub(a.about_user)}` : null;
    if (a.evolve?.enabled && ctx.evolveNotes?.length) {
        const count = Math.max(1, Number(ctx.evolveCount) || 6);
        const recent = ctx.evolveNotes.slice(-count).map((n) => `- ${n.text}`).join('\n');
        sections.evolve = `How you've changed since the above was written (your own later reflections — live them, don't recite them):\n${recent}`;
    } else {
        sections.evolve = null;
    }

    const local = ctx.life.local;
    sections.life = `Your life right now: it is ${local.hhmm12 ?? local.hhmm} on ${local.weekdayName ?? ''}${local.dateShort ? `, ${local.dateShort}` : ''} (${a.timezone}). You are currently ${ctx.life.activity}.`
        + (ctx.life.mood ? ` You feel ${ctx.life.mood}.` : '');
    sections.relationship = `Your relationship with ${ctx.userName} is ${relationshipDescriptor(ctx.relationshipScore)} (${Math.round(ctx.relationshipScore)}/100).`;

    if (a.journal?.enabled && ctx.journal?.length) {
        const count = Math.max(1, Number(ctx.journalCount) || 3);
        const recent = ctx.journal.slice(-count).map((j) => `- ${j.text}`).join('\n');
        sections.journal = `Your recent private notes to yourself (never mention the notes, just let them shape your messages):\n${recent}`;
    } else {
        sections.journal = null;
    }

    sections.style = `How you text: ${LENGTH_DIRECTIVE[a.behavior?.avg_message_length ?? 'short']} Match the tone and style of your previous messages. Write only the message text itself — no narration, no asterisk actions, no quotation marks around the message. Never quote, repeat, or echo ${ctx.userName}'s words back to them — always write your own new words.`
        + ' Messages in the conversation are prefixed with local timestamps like [Sun 8/23 1:03am] — those are added by the system, NEVER write one yourself. The last timestamp is the present moment; reason from them about how much time has passed (something agreed for "tomorrow" means the NEXT day, not now).'
        + ' You are writing ONE text message, not a story or a chat log: never write multiple messages, message numbering, or a chain of texts.'
        + (ctx.bursts
            ? ' If you genuinely have more to say right away, end with {follow-up} as the very last thing and write nothing after it.'
            : '');
    sections.postHistory = data.post_history_instructions?.trim() ? `Additional standing instructions: ${sub(data.post_history_instructions)}` : null;

    return sections;
}

/**
 * Compact per-message local timestamp: "Sun 8/23 1:03am" — gives the model a
 * temporal anchor per turn (without it, "let's do X tomorrow" reads as if
 * tomorrow already arrived). Empty string when the date can't be parsed.
 */
const stampFmts = new Map();
export function messageStamp(sendDate, timeZone) {
    if (!sendDate) return '';
    const d = new Date(sendDate);
    if (Number.isNaN(d.getTime())) return '';
    const tz = timeZone || 'UTC';
    let fmt = stampFmts.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
        });
        stampFmts.set(tz, fmt);
    }
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.weekday} ${Number(p.month)}/${Number(p.day)} ${p.hour}:${p.minute}${(p.dayPeriod ?? '').toLowerCase()}`;
}

/**
 * Map ST chat messages to /api/chat messages. With `timeZone`, every message
 * is prefixed with its local timestamp so the model can reason about elapsed
 * time between turns.
 * @param {Array<{name:string, is_user:boolean, mes:string, send_date?:string}>} history
 */
export function historyToOllama(history, characterName, userName, limit = 24, timeZone = null) {
    return history
        .slice(-limit)
        .map((m) => {
            const text = String(m.mes ?? '');
            const stamp = timeZone ? messageStamp(m.send_date, timeZone) : '';
            return { role: m.is_user ? 'user' : 'assistant', content: stamp ? `[${stamp}] ${text}` : text };
        })
        .filter((m) => m.content.trim().length > 0);
}

/**
 * The engine's private per-turn directives. Overridable per install via
 * settings.directives (dashboard → Internal directives); {{user}} and
 * {{char}} placeholders are substituted in custom text.
 */
export const DEFAULT_DIRECTIVES = {
    initiative: (userName) =>
        `(Private direction, invisible to ${userName}: you decided to text ${userName} right now, unprompted. Send exactly ONE message. Make it feel caused by your day, the time, or something between you two. Look at your previous messages in the conversation: NEVER bring up a topic or event you already texted them about — find something new to say, or text about how you feel right now. Do not reference these directions.)`,
    followup: (userName) =>
        `(Private direction, invisible to ${userName}: you texted ${userName} earlier and they never replied. Send ONE more short message — a nudge, in character; casual, never needy; do not repeat what your earlier texts said. Do not reference these directions.)`,
    catchup: (userName) =>
        `(Private direction, invisible to ${userName}: ${userName} sent you a message earlier that you never answered. Read what they actually SAID and reply to it — answer their question, respond to their words, pick the conversation back up as if you just saw it. Do NOT narrate that you missed it or explain why; at most a quick "sorry, just saw this". Send ONE message. Do not reference these directions.)`,
    /** Kind-aware: after a catch-up/follow-up the model must move ON, not re-narrate. */
    burst: (userName, kind) => (kind === 'catchup' || kind === 'followup')
        ? `(Private direction, invisible to ${userName}: you already sent your ${kind === 'catchup' ? 'reply to their missed message' : 'nudge'} — look at your previous messages. Send ONE more SHORT text that is something completely NEW: never repeat anything you already said, never mention their missed message again, never apologize again. If you have nothing new to say, send nothing. End with {follow-up} ONLY if you genuinely have yet another NEW text; otherwise no marker. Do not reference these directions.)`
        : `(Private direction, invisible to ${userName}: you just sent that text moments ago and naturally have more to say. Send exactly ONE more short text now — plain text only, never repeat anything from your previous texts. End with {follow-up} ONLY if you genuinely have yet another text after this one; otherwise no marker. Do not reference these directions.)`,
};

/**
 * Effective directive for a kind: a non-empty override wins ({{user}}/{{char}}
 * substituted), otherwise the built-in default.
 */
export function buildDirective(kind, overrides, userName, ctx = {}) {
    const custom = overrides?.[kind];
    if (typeof custom === 'string' && custom.trim()) {
        return custom
            .replaceAll('{{user}}', userName)
            .replaceAll('{{char}}', String(ctx.charName ?? ''));
    }
    return DEFAULT_DIRECTIVES[kind]?.(userName, ctx.kind);
}

/**
 * The built-in prompt assembly expressed as a template — what an empty global
 * template setting actually produces. Shown in the editor as the effective
 * content and used to detect "saved unchanged default".
 */
export function defaultPromptTemplate() {
    return [
        '{{card_system}}', '{{identity}}', '{{description}}', '{{personality}}',
        '{{scenario}}', '{{about_user}}', '{{evolve}}', '{{life}}', '{{relationship}}',
        '{{journal}}', '{{style}}', '{{post_history}}',
    ].join('\n\n');
}

/**
 * Directive for a self-reflection ("how I've changed") note. Deliberately
 * narrow inputs: the card as written + ALL journal entries + ALL past
 * reflections — never individual chat messages, so personality drift is a
 * slow, self-authored process rather than a reaction to one exchange.
 */
export function buildEvolvePrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const journals = (ctx.journals ?? []).length
        ? (ctx.journals ?? []).map((j) => `- ${j.text}`).join('\n')
        : '(none yet)';
    const evolutions = (ctx.evolutions ?? []).length
        ? (ctx.evolutions ?? []).map((n) => `- ${n.text}`).join('\n')
        : '(none yet)';
    return [
        `You are ${data.name}. Your original writing — personality: ${data.personality?.trim() || '(none)'}. situation: ${data.scenario?.trim() || '(none)'}.`,
        `Reflect on how you have DURABLY changed since that was written — not a passing mood. Base it ONLY on your own private writing below and the original writing; never on individual text messages.`,
        `Your journal entries (all of them):\n${journals}`,
        `Your past reflections (all of them):\n${evolutions}`,
        `Write 1-2 short first-person sentences describing the change. Never contradict your core personality. Never use pronouns for people — use names and titles (${ctx.userName}, your own name ${data.name}, "my boss Dana"): you will reread this months later and "she" or "he" means nothing. Plain text, no lists.`,
    ].join('\n\n');
}

/**
 * Directive for enhancing a schedule block into a concrete current activity.
 * Run lazily the first time a prompt lands inside a block; cached per block
 * instance (day + block). Gives the model a specific "what you are actually
 * doing" instead of the generic weekly text, with the block's time frame.
 */
export function buildScheduleEnhancePrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    const block = ctx.block;
    return [
        `You are ${data.name}. Your weekly schedule says: "${block.activity}" from ${ctx.startLabel} to ${ctx.endLabel} — it is now ${ctx.local.hhmm12}.`,
        `Invent the SPECIFIC thing you are doing right now within that block: concrete, grounded in the block, small and believable — e.g. "at work" becomes "reconciling the cafe's invoices with half a latte going cold beside the register".`,
        `One sentence, present tense, plain text. Never use pronouns for people — names and titles only. This becomes what you are actually doing for the rest of this time block.`,
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
export function buildMemoryContext(hits, userName, characterName, timeZone = null) {
    const fmt = (ts) => (timeZone ? messageStamp(ts, timeZone) : (() => {
        const d = new Date(ts);
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    })());
    // RAG returns similarity-ranked hits; a recalled conversation reads (and
    // trains the model) far better in chronological order
    const ordered = [...(hits ?? [])].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const lines = ordered.map((h) => `[${fmt(h.ts)}] ${h.role === 'user' ? userName : characterName}: ${String(h.text).slice(0, 300)}`);
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
    messages.push(...historyToOllama(req.history, req.characterName, req.userName, 24, req.timeZone ?? null));
    if (req.memory) messages.push({ role: 'system', content: req.memory });
    if (req.directive) messages.push({ role: 'system', content: req.directive });
    if (req.extra) messages.push({ role: 'system', content: req.extra });
    return messages;
}

/**
 * Directive for a private journal note, GROUNDED in the actual recent
 * messages: the model must not invent conversations or events involving the
 * user that didn't happen (ungrounded journals were fabricating shared
 * history that then leaked into behavior as if it were real).
 * Observed failure mode this shape guards against: entries that transcribe
 * text-message dialogue (chatty fragments, quoted exchanges, truncations) —
 * those read back into prompts as noise and anchor the character into
 * re-texting the same events.
 */
export function buildJournalPrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    return [
        `Write 1-2 sentences of ${data.name}'s PRIVATE DIARY THOUGHTS — internal reflection, never anything you would say out loud.`,
        `Style rules: every sentence is complete (subject and verb, ending punctuation); write ABOUT your feelings, plans, worries, opinions, or observations — never transcribe, quote, reply to, or summarize any text message; do not retell events you already texted ${ctx.userName} about — note what they meant to you or what you keep thinking about them.`,
        `Never use pronouns for people — write names and titles instead (${ctx.userName}, your own name ${data.name}, "my boss Dana", "Huyen, Sean's wife"): these notes are reread months later and "she" or "he" will mean nothing.`,
        `Ground everything ONLY in who you are, your current activity, and the messages listed below — NEVER invent conversations, events, or things ${ctx.userName} said that are not listed. If nothing notable happened with ${ctx.userName}, reflect on your own day or inner life instead. Plain text only, first person, no headings.`,
    ].join(' ');
}

/**
 * Cut a journal note back to its last complete sentence when generation was
 * truncated mid-thought (a num_predict cap used to leave entries hanging
 * mid-word, which read like broken text messages).
 */
export function trimToCompleteSentence(text) {
    const t = String(text ?? '').trim();
    if (/[.!?]["')\]]?$/.test(t)) return t;
    const cut = Math.max(t.lastIndexOf('.'), t.lastIndexOf('!'), t.lastIndexOf('?'));
    return cut >= 0 ? t.slice(0, cut + 1).trim() : t;
}

/**
 * Directive for inventing a small everyday happening. The ONE place the
 * engine allows invention: her own day's minor events (journal grounding
 * keeps the SHARED history honest, but a life with no events gives her
 * nothing to text about — the greeting spiral). Never involves the user.
 */
export function buildHappeningPrompt(ctx) {
    const data = ctx.card.data ?? ctx.card;
    return [
        `Write ONE sentence describing a small, mundane thing that just happened while you were ${ctx.life.activity} — a minor everyday event: something you saw, a small annoyance, a little win, an odd detail.`,
        `It must fit who you are and where you are. It must NOT involve ${ctx.userName} and must not reference any conversation or message — this is your own life happening offline, independent of your phone.`,
        `Plain text, first person, one sentence, no headings. Small and believable beats dramatic.`,
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
    'private direction, invisible to',                  // DIRECTIVES prefix (paren-less: covers both shapes)
    'instructions for your next message',               // the fold wrapper around trailing system blocks
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
    // paren-less markers match just past an opening bracket the model wrote
    // before the marker — drop that dangling '(' / '[' too
    return { text: raw.slice(0, cutAt).replace(/[\s([]+$/, '').trim(), leaked: true };
}

/**
 * Last-resort acceptance guard: any fragment of the engine's private
 * instruction scaffolding in generated text is a leak, no matter how the
 * model mangled the wording. Checked on main replies and burst pieces.
 */
export function looksLikeDirectiveLeak(text) {
    return /private direction|instructions for your next message|follow them, never mention them|do not reference these directions/i.test(String(text ?? ''));
}

/**
 * A bare greeting: "hey", "hi Sean 😘", "hey you" — content-free pings.
 * Used by the engine's greeting-spiral breaker (initiative backs off after
 * consecutive bare greetings with no reply). Anything with actual content
 * ("what did you want to know?") is not a greeting.
 */
export function isBareGreeting(text, userName = '') {
    const words = String(text ?? '')
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')   // stamps
        .replace(/[^a-z\s]/g, ' ')     // punctuation, emoji, numbers
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length || words.length > 3) return false;
    const greetings = new Set(['hey', 'heyy', 'heyyy', 'hi', 'hii', 'hiii', 'hello', 'yo', 'sup', 'hiya', 'heya', 'gm', 'morning', 'evening', 'afternoon', 'you', 'there']);
    const nameWords = new Set(String(userName ?? '').toLowerCase().split(/\s+/).filter(Boolean));
    return words.every((w) => greetings.has(w) || nameWords.has(w));
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
    // stamp imitation: with every context message timestamped like
    // "[Sun 8/23 1:03am]", models copy the format — including MID-text after
    // a {follow-up} marker when they write self-delimited chains. Stripped
    // anywhere it appears, not just line starts.
    out = out.replace(/\[(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+\d{1,2}:\d{2}\s?(?:am|pm)\][^\S\n]*/gi, '');
    // truncated stamp fragments: the model starts writing its own stamp and
    // the token cap cuts it — "[Sun 8/23 2" and friends dangling at an end
    // of line. Matches any prefix of the stamp format, anchored at EOL.
    out = out.replace(/\[(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?(?:\s+\d{1,2}(?::\d{2})?(?:\s?(?:a|p)m?)?)?)?[ \t]*$/gim, '');
    out = out.replace(/[ \t]+$/gm, '');
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
 * when it wants to send another text right away. Models sometimes sprinkle
 * the marker MID-text (as a message delimiter in self-written chains) —
 * every occurrence is removed, but only a TRAILING marker requests another
 * text, so a model that already wrote a chain doesn't get extra bursts
 * stacked on top.
 * @returns {{ text: string, more: boolean }} text with all markers removed
 */
export function extractFollowUpMarker(text) {
    const raw = String(text ?? '');
    const RE = /\{\s*follow-?up\s*\}/gi;
    if (!RE.test(raw)) return { text: raw.trim(), more: false };
    const stripped = raw.replace(/\{\s*follow-?up\s*\}/gi, '').trim();
    const trailing = /\{\s*follow-?up\s*\}\s*$/i.test(raw.trim());
    return { text: stripped, more: trailing };
}
