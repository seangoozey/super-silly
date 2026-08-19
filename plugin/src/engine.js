// The Autolife engine: per-character tick loop that decides when characters
// reply, delay, ignore, catch up, double-text and journal — and generates
// their messages through Ollama, writing them into the SillyTavern chat and
// pushing them to bound transports (Telegram).

import { evaluate, sampleDelayMinutes, clamp01 } from './schedule.js';
import { buildSystemPrompt, buildChatMessages, buildJournalPrompt, buildMemoryContext, cleanModelOutput, NUM_PREDICT } from './llm.js';
import { messageKey } from './memory.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BACKOFF_MINUTES = [2, 5, 10, 20, 40];

export class Engine {
    /**
     * @param {{ cards: object, store: object, chatStore: object, ollama: object,
     *           memory?: object, rng?: {float:()=>number}, nowFn?: ()=>Date, log?: (msg:string)=>void,
     *           emit?: (type:string, data:object)=>void, transports?: Array<object> }} deps
     */
    constructor(deps) {
        this.cards = deps.cards;
        this.store = deps.store;
        this.chatStore = deps.chatStore;
        this.ollama = deps.ollama;
        this.memory = deps.memory ?? null;
        this.rng = deps.rng ?? { float: Math.random };
        this.nowFn = deps.nowFn ?? (() => new Date());
        this.log = deps.log ?? ((m) => console.log(`[Autolife] ${m}`));
        this.emit = deps.emit ?? (() => {});
        this.transports = deps.transports ?? [];
        this.settings = this.store.loadSettings();
        this.inFlight = new Map(); // character name -> Promise
        this.blockMemo = new Map(); // character name -> last initiative-block reason (audit on change)
        this.timer = null;
        this.running = false;
    }

    get tickSeconds() {
        return Number(this.settings.engine?.tick_seconds) > 0 ? this.settings.engine.tick_seconds : 30;
    }

    refreshSettings() {
        this.settings = this.store.loadSettings();
    }

    start() {
        if (this.timer) return;
        this.running = true;
        const loop = async () => {
            try {
                await this.tick();
            } catch (err) {
                this.log(`tick error: ${err?.stack ?? err}`);
            }
        };
        loop();
        this.timer = setInterval(loop, this.tickSeconds * 1000);
        this.timer.unref?.();
        this.log(`engine started (tick: ${this.tickSeconds}s)`);
    }

    stop() {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ------------------------------------------------------------ helpers

    #state(entry) {
        const state = this.store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial });
        // lazy relationship decay for absent days
        const now = this.nowFn();
        if (state.lastContactAt) {
            const absentDays = Math.floor((now.getTime() - new Date(state.lastContactAt).getTime()) / (24 * HOUR));
            if (absentDays >= 1) {
                state.relationship = Math.max(0, state.relationship - Math.min(absentDays, 3));
                state.lastContactAt = now.toISOString();
            }
        }
        return state;
    }

    #ensureChat(entry, state) {
        if (state.chatFile && this.chatStore.listChats(entry.name).includes(state.chatFile)) return state.chatFile;
        const greeting = entry.card?.data?.first_mes ?? null;
        const { file } = this.chatStore.getOrCreateChat(entry.name, greeting);
        state.chatFile = file;
        this.store.saveState(state);
        return file;
    }

    #localDateKey(autolife, now) {
        return evaluate(autolife, now).local.dateKey;
    }

    /**
     * Record an audit event: persisted per character, broadcast over SSE for
     * the web feed, and forwarded to transports (Telegram /audit subscribers).
     */
    #audit(character, kind, text, data = {}) {
        const entry = { ts: this.nowFn().toISOString(), character: character ?? null, kind, text, ...data };
        try {
            this.store.appendAudit(character, entry);
        } catch (err) {
            this.log(`audit write failed: ${err.message}`);
        }
        this.emit('audit', entry);
        for (const t of this.transports) {
            try {
                t.onAudit?.(entry);
            } catch { /* transport problems must not break the engine */ }
        }
    }

    /**
     * Re-schedule a failed generation with escalating backoff (max 5 attempts).
     * @returns {boolean} true if a retry was scheduled, false if it gave up
     */
    #repent(entry, state, now, kind, cause) {
        const attempts = (state.pendingReply?.attempts ?? 0) + 1;
        if (attempts > 5) {
            state.pendingReply = null;
            this.store.saveState(state);
            this.#audit(entry.name, 'gave_up', `gave up on the pending ${kind} after 5 attempts (${cause}) — send a new message to try again`);
            this.log(`"${entry.name}": gave up on ${kind} after 5 attempts`);
            return false;
        }
        const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
        state.pendingReply = { dueAt: new Date(now.getTime() + minutes * MINUTE).toISOString(), attempts };
        this.store.saveState(state);
        this.#audit(entry.name, 'gen_retry', `${kind} failed (${cause}) — retry ${attempts}/5 in ~${minutes} min`);
        return true;
    }

    effectiveModel() {
        return this.settings.model?.current || this.settings.model?.primary || 'llama3.2:3b';
    }

    // ------------------------------------------------------------ memory (RAG)

    /** Embed with the configured model; auto-pull it on first use; degrade quietly. */
    async #embedNow(text) {
        const model = this.settings.memory?.embed_model;
        if (!model || !this.memory) return null;
        try {
            const vec = await this.ollama.embed(text, model);
            this.embedFailNoted = false;
            return vec;
        } catch (err) {
            try {
                if (!(await this.ollama.hasModel(model))) {
                    this.#audit(null, 'model', `pulling embedding model ${model} (needed for character memory)`);
                    const ok = await this.ollama.ensureModel(model, (p) => this.emit('model_pull', { model, ...p }));
                    if (!ok) throw new Error('pull failed');
                    this.embedFailNoted = false;
                    return await this.ollama.embed(text, model);
                }
            } catch { /* fall through to degraded mode */ }
            if (!this.embedFailNoted) {
                this.embedFailNoted = true;
                this.#audit(null, 'memory', `embedding unavailable (${String(err?.message ?? err).slice(0, 120)}) — memory indexing paused until it works`);
            }
            return null;
        }
    }

    /** Index one message (user or character). Never throws. */
    async #remember(entry, chatFile, role, text, sendDate) {
        if (!this.memory || !text?.trim()) return;
        try {
            const vec = await this.#embedNow(text);
            if (!vec) return;
            this.memory.append(entry.name, {
                ts: this.nowFn().toISOString(),
                role,
                text,
                vec,
                chatFile,
                key: messageKey(sendDate, role, text),
            }, this.settings.memory?.embed_model);
        } catch (err) {
            this.log(`memory append failed for "${entry.name}": ${err.message}`);
        }
    }

    /** Retrieve relevant older texts as a prompt block (or null). */
    async #recallFor(entry, history) {
        const mem = entry.autolife.memory;
        if (!this.memory || !mem?.enabled || (mem.retrieve_count ?? 3) <= 0) return null;
        const lastUser = [...history].reverse().find((m) => m.is_user);
        if (!lastUser?.mes?.trim()) return null;
        const queryVec = await this.#embedNow(lastUser.mes);
        if (!queryVec) return null;
        const tail = history.slice(-24);
        const excludeKeys = new Set(tail.map((m) => messageKey(m.send_date, m.is_user ? 'user' : 'assistant', m.mes)));
        const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
        const excludeTextPrefixes = new Set(tail.map((m) => norm(m.mes)));
        const hits = this.memory.search(entry.name, queryVec, {
            k: mem.retrieve_count ?? 3,
            excludeKeys,
            excludeTextPrefixes,
        }).filter((h) => h.score > 0.15);
        if (!hits.length) return null;
        this.#audit(entry.name, 'memory', `recalled ${hits.length} older text${hits.length > 1 ? 's' : ''} for context (top match ${new Date(hits[0].ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, similarity ${(hits[0].score * 100).toFixed(0)}%)`);
        return buildMemoryContext(hits, this.chatStore.userName, entry.name);
    }

    // ------------------------------------------------------------ inbound

    /**
     * A user message arrived (from Telegram or the SillyTavern web UI).
     * For source 'web' the message is already written to the chat file by ST itself.
     */
    async onInbound({ character, mes, source = 'web' }) {
        const now = this.nowFn();
        const entry = this.cards.find(character);
        if (!entry?.autolife) {
            this.log(`inbound for "${character}": no autolife config, ignoring`);
            return;
        }
        const state = this.#state(entry);
        this.#ensureChat(entry, state);

        let sendDate = now.toISOString();
        if (source === 'telegram') {
            const userMsg = this.chatStore.userMessage(mes, now);
            sendDate = userMsg.send_date;
            this.chatStore.appendMessage(entry.name, state.chatFile, userMsg);
        }
        // index the user message for long-term memory (works from both surfaces)
        await this.#remember(entry, state.chatFile, 'user', String(mes ?? ''), sendDate);

        const life = evaluate(entry.autolife, now);
        const userRepliedToInitiative = state.lastInitiativeAt && (!state.lastUserMessageAt || new Date(state.lastInitiativeAt) > new Date(state.lastUserMessageAt));

        state.lastUserMessageAt = now.toISOString();
        state.lastContactAt = now.toISOString();
        state.followupDone = false;

        // relationship gains: +1 per message (max 5/day), +2 when replying to an initiative
        const day = this.#localDateKey(entry.autolife, now);
        if (state.relGainDay?.date !== day) state.relGainDay = { date: day, gained: 0 };
        let gain = 0;
        if (state.relGainDay.gained < 5) gain += 1;
        if (userRepliedToInitiative) gain += 2;
        state.relationship = Math.min(100, state.relationship + gain);
        state.relGainDay.gained += gain;

        if (!state.enabled || state.paused) {
            this.store.saveState(state);
            return;
        }

        // If a reply is already pending, additional messages don't re-roll —
        // the pending reply will see them in the chat tail.
        if (state.pendingReply) {
            this.store.saveState(state);
            this.log(`"${entry.name}": reply already pending, message absorbed`);
            this.#audit(entry.name, 'absorbed', `message absorbed — a reply is already pending (due ${Math.max(0, Math.round((new Date(state.pendingReply.dueAt) - now) / MINUTE))} min away)`);
            return;
        }

        const b = entry.autolife.behavior;
        const pIgnore = Math.min(0.5, b.ignore_chance * (1 + 2 * (1 - life.availability)));
        if (this.rng.float() < pIgnore) {
            state.ignoredAt = now.toISOString();
            this.store.saveState(state);
            this.log(`"${entry.name}" missed your message (${life.activity}, ${(life.availability * 100).toFixed(0)}% available)`);
            this.emit('ignored', { character: entry.name });
            this.#audit(entry.name, 'ignored', `missed your message — ${life.activity} (${Math.round(life.availability * 100)}% available)${b.catch_up ? ', will catch up later' : ''}`);
            return;
        }

        const pQuick = b.quick_reply_chance * clamp01(life.availability);
        if (this.rng.float() < pQuick) {
            this.store.saveState(state);
            this.#audit(entry.name, 'quick', `replying now (${life.activity}, ${Math.round(life.availability * 100)}% available)`);
            const ok = await this.#generate(entry, state, 'reply', now);
            if (!ok) this.#repent(entry, state, now, 'reply', 'generation failed');
            return;
        }

        const delayMinutes = sampleDelayMinutes(entry.autolife, life, this.rng);
        state.pendingReply = { dueAt: new Date(now.getTime() + delayMinutes * MINUTE).toISOString(), attempts: 0 };
        this.store.saveState(state);
        this.log(`"${entry.name}" will reply in ~${delayMinutes.toFixed(0)} min (${life.activity})`);
        this.emit('deferred', { character: entry.name, dueAt: state.pendingReply.dueAt });
        this.#audit(entry.name, 'deferred', `will reply in ~${delayMinutes.toFixed(0)} min — ${life.activity} (${Math.round(life.availability * 100)}% available)`);
    }

    // ------------------------------------------------------------ tick

    async tick(nowParam) {
        const now = nowParam ?? this.nowFn();
        this.refreshSettings();
        for (const entry of this.cards.autolifeCharacters()) {
            const state = this.#state(entry);
            if (!state.enabled || state.paused) continue;
            try {
                await this.#runCharacter(entry, state, now);
                await this.#backfillMemory(entry, state);
            } catch (err) {
                this.log(`"${entry.name}" tick failed: ${err?.stack ?? err}`);
            }
        }
    }

    /** Progressive backfill of chat history into the memory index, oldest first. */
    lastMemoryEmit = new Map();

    async #backfillMemory(entry, state) {
        const mem = entry.autolife.memory;
        if (!this.memory || !mem?.enabled || !state.chatFile) return;
        const { added, remaining } = await this.memory.backfill(
            entry.name,
            this.chatStore,
            state.chatFile,
            (t) => this.#embedNow(t),
            { limit: 20, maxEntries: mem.max_entries ?? 4000 },
        ).catch((err) => {
            this.log(`memory backfill failed for "${entry.name}": ${err.message}`);
            return { added: 0, remaining: 0 };
        });
        if (remaining > 0 || added > 0) {
            const last = this.lastMemoryEmit.get(entry.name) ?? 0;
            if (Date.now() - last > 60_000) {
                this.lastMemoryEmit.set(entry.name, Date.now());
                this.emit('memory', {
                    character: entry.name,
                    indexed: this.memory.count(entry.name, this.settings.memory?.embed_model),
                    remaining,
                });
            }
        }
    }

    async #runCharacter(entry, state, now) {
        const life = evaluate(entry.autolife, now);
        const init = entry.autolife.initiative;
        const b = entry.autolife.behavior;

        // 1. fire due delayed replies
        if (state.pendingReply) {
            if (new Date(state.pendingReply.dueAt).getTime() <= now.getTime()) {
                state.pendingReply = null;
                if (this.inFlight.has(entry.name)) {
                    state.pendingReply = { dueAt: new Date(now.getTime() + MINUTE).toISOString(), attempts: 0 }; // retry after current generation
                    this.store.saveState(state);
                } else {
                    this.store.saveState(state);
                    this.#audit(entry.name, 'pending_fired', 'delayed reply is due — generating now');
                    const ok = await this.#generate(entry, state, 'reply', now);
                    if (!ok) this.#repent(entry, state, now, 'reply', 'generation failed');
                }
            }
        }

        // 2. catch-up after an ignored message
        if (b.catch_up && state.ignoredAt
            && now.getTime() - new Date(state.ignoredAt).getTime() > 45 * MINUTE
            && life.availability > 0.4 && !state.pendingReply && !this.inFlight.has(entry.name)) {
            state.ignoredAt = null;
            this.store.saveState(state);
            this.log(`"${entry.name}" is catching up on a missed message`);
            this.#audit(entry.name, 'catchup', 'free again — catching up on the missed message');
            await this.#generate(entry, state, 'catchup', now);
        }

        // 3. proactive initiative
        if (init.enabled && !life.isAsleep && !state.pendingReply && !this.inFlight.has(entry.name)) {
            const day = life.local.dateKey;
            if (state.initiativeDay?.date !== day) state.initiativeDay = { date: day, count: 0 };
            const gapOk = !state.lastInitiativeAt || now.getTime() - new Date(state.lastInitiativeAt).getTime() >= init.min_gap_minutes * MINUTE;
            const quietOk = !state.lastCharMessageAt || now.getTime() - new Date(state.lastCharMessageAt).getTime() >= 20 * MINUTE;
            const capOk = state.initiativeDay.count < init.max_per_day;
            if (gapOk && quietOk && capOk) {
                const relFactor = 0.7 + state.relationship / 100;
                const pTick = Math.min(0.2, (this.tickSeconds / (init.min_gap_minutes * 60)) * (0.4 + 0.6 * life.availability) * relFactor);
                this.#blockReason(entry.name, null);
                if (this.rng.float() < pTick) {
                    this.log(`"${entry.name}" feels like texting you`);
                    this.#audit(entry.name, 'initiative_roll', `initiative roll passed (p=${(pTick * 100).toFixed(1)}% per tick) — texting you first`);
                    await this.#generate(entry, state, 'initiative', now);
                }
            } else {
                this.#blockReason(entry.name,
                    !gapOk ? `waiting out the ${init.min_gap_minutes} min gap since the last initiative`
                        : !quietOk ? 'messaged you less than 20 min ago'
                            : `daily initiative cap reached (${state.initiativeDay.count}/${init.max_per_day})`);
            }
        } else if (init.enabled) {
            this.#blockReason(entry.name,
                life.isAsleep ? `asleep/unreachable (${life.activity})`
                    : state.pendingReply ? 'a reply to you is pending — initiative paused so they don\'t talk over it'
                        : 'already generating');
        }

        // 4. one double-text nudge if the user left them on read
        if (init.enabled && init.followup_on_unread_hours > 0 && !state.followupDone
            && !state.pendingReply && !this.inFlight.has(entry.name)
            && state.lastCharMessageAt && state.lastUserMessageAt
            && new Date(state.lastCharMessageAt) > new Date(state.lastUserMessageAt)
            && now.getTime() - new Date(state.lastCharMessageAt).getTime() > init.followup_on_unread_hours * HOUR
            && life.availability >= 0.2
            && this.rng.float() < 0.1) {
            state.followupDone = true;
            this.store.saveState(state);
            this.log(`"${entry.name}" is following up on an unread message`);
            this.#audit(entry.name, 'followup', `you left them on read for ${init.followup_on_unread_hours}h — sending one nudge`);
            await this.#generate(entry, state, 'followup', now);
        }

        // 5. journal upkeep
        if (entry.autolife.journal?.enabled && !life.isAsleep
            && (!state.lastJournalAt || now.getTime() - new Date(state.lastJournalAt).getTime() > 3 * HOUR)
            && this.rng.float() < 0.08) {
            await this.#journal(entry, state, life, now);
        }
    }

    /** Audit initiative-block reasons only when they change (per tick would spam). */
    #blockReason(character, reason) {
        if ((this.blockMemo.get(character) ?? null) === reason) return;
        this.blockMemo.set(character, reason);
        if (reason) this.#audit(character, 'initiative_blocked', `initiative on hold: ${reason}`);
    }

    // ------------------------------------------------------------ generation

    async #generate(entry, state, kind, now) {
        const key = entry.name;
        const promise = this.#generateInner(entry, state, kind, now)
            .catch((err) => {
                this.log(`"${key}" generation (${kind}) failed: ${err?.stack ?? err}`);
                this.#audit(key, 'gen_failed', `generation (${kind}) failed: ${String(err?.message ?? err).slice(0, 200)}`);
                return false;
            })
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, promise);
        return promise;
    }

    async #generateInner(entry, state, kind, now) {
        const startedMs = Date.now();
        const life = evaluate(entry.autolife, now);
        this.#ensureChat(entry, state);
        this.transports.forEach((t) => t.onComposing?.(entry.name));

        let history = this.chatStore.readMessages(entry.name, state.chatFile, 24);
        if (!history.length && entry.card?.data?.first_mes) {
            history = [{ is_user: false, mes: this.chatStore.substituteMacros(entry.card.data.first_mes, entry.name) }];
        }

        const system = buildSystemPrompt({
            card: entry.card,
            autolife: entry.autolife,
            life,
            relationshipScore: state.relationship,
            journal: state.journal,
            userName: this.chatStore.userName,
        });

        const numPredict = NUM_PREDICT[entry.autolife.behavior?.avg_message_length ?? 'short'] ?? 160;
        const think = this.settings.model?.think ?? 'off';
        const genNumPredict = think === 'on' ? numPredict + 600 : numPredict; // thinking needs room beyond the message
        const memoryBlock = ['reply', 'catchup', 'followup'].includes(kind)
            ? await this.#recallFor(entry, history)
            : null;
        const candidates = [...new Set([this.settings.model?.current, this.settings.model?.fallback].filter(Boolean))];
        const messages = buildChatMessages({
            system,
            history,
            characterName: entry.name,
            userName: this.chatStore.userName,
            kind,
            memory: memoryBlock,
        });

        let text = '';
        let usedModel = null;
        for (const model of candidates) {
            try {
                if (!(await this.ollama.hasModel(model))) {
                    const ok = await this.ollama.ensureModel(model, (p) => this.emit('model_pull', { model, ...p }));
                    if (!ok) continue;
                }
                const raw = await this.ollama.chat({
                    model,
                    messages,
                    temperature: this.settings.model?.temperature ?? 0.9,
                    numPredict: genNumPredict,
                    think,
                });
                text = cleanModelOutput(raw);
                if (!text) {
                    // one nudge retry — models occasionally answer with empty strings
                    const retry = await this.ollama.chat({
                        model,
                        messages: [...messages, { role: 'assistant', content: '(continue — send the actual text message now)' }, { role: 'user', content: '...' }],
                        temperature: this.settings.model?.temperature ?? 0.9,
                        numPredict: genNumPredict,
                        think,
                    });
                    text = cleanModelOutput(retry);
                }
                if (text) {
                    usedModel = model;
                    break;
                }
            } catch (err) {
                this.log(`generation with "${model}" failed: ${err.message}`);
            }
        }

        if (!text) {
            this.log(`"${entry.name}" (${kind}) produced nothing — character got distracted`);
            this.emit('generation_failed', { character: entry.name, kind });
            this.#audit(entry.name, 'gen_failed', `generation (${kind}) returned empty output after retry — all candidate models exhausted`);
            return false;
        }
        if (text.length > 1500) text = text.slice(0, 1500).trim();

        const charMsg = this.chatStore.characterMessage(entry.name, text, now, { autolife_kind: kind });
        this.chatStore.appendMessage(entry.name, state.chatFile, charMsg);
        this.#remember(entry, state.chatFile, 'assistant', text, charMsg.send_date);
        state.lastCharMessageAt = now.toISOString();
        state.lastContactAt = now.toISOString();
        if (kind === 'initiative') {
            state.lastInitiativeAt = now.toISOString();
            if (state.initiativeDay?.date === life.local.dateKey) state.initiativeDay.count += 1;
            else state.initiativeDay = { date: life.local.dateKey, count: 1 };
        }
        this.store.saveState(state);

        this.log(`"${entry.name}" ${kind} → "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" [${usedModel}]`);
        this.emit('character_message', { character: entry.name, kind, mes: text, chatFile: state.chatFile });
        const kindLabel = { reply: 'replied', initiative: 'texted you first (initiative)', catchup: 'caught up on the missed message', followup: 'sent a follow-up nudge' }[kind] ?? kind;
        this.#audit(entry.name, 'sent', `${kindLabel} — "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" [${usedModel}, ${Date.now() - startedMs} ms]`);

        for (const t of this.transports) {
            try {
                await t.deliver?.(entry.name, text, { kind });
            } catch (err) {
                this.log(`transport ${t.name ?? '(unnamed)'} delivery failed: ${err.message}`);
            }
        }
        return true;
    }

    async #journal(entry, state, life, now) {
        const prompt = buildJournalPrompt({
            card: entry.card,
            life,
            userName: this.chatStore.userName,
        });
        try {
            const model = this.effectiveModel();
            if (!(await this.ollama.hasModel(model))) return;
            const raw = await this.ollama.chat({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.8,
                numPredict: 90,
            });
            const text = cleanModelOutput(raw);
            if (!text) return;
            state.journal = [...(state.journal ?? []), { ts: now.toISOString(), text }].slice(-40);
            state.lastJournalAt = now.toISOString();
            this.store.saveState(state);
            this.log(`"${entry.name}" journaled: ${text.slice(0, 60)}…`);
            this.#audit(entry.name, 'journal', `journal note: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`);
        } catch (err) {
            this.log(`journal for "${entry.name}" failed: ${err.message}`);
        }
    }

    // ------------------------------------------------------------ control surface (routes/commands)

    /** Force an action now: kind = 'reply' | 'initiative'. */
    async force(character, kind = 'initiative') {
        const entry = this.cards.find(character);
        if (!entry?.autolife) throw new Error(`No autolife character matching "${character}".`);
        const state = this.#state(entry);
        if (kind === 'reply') state.pendingReply = null;
        this.store.saveState(state);
        await this.#generate(entry, state, kind, this.nowFn());
    }

    status() {
        const now = this.nowFn();
        const bindings = this.store.loadBindings();
        const boundChats = Object.entries(bindings).filter(([, b]) => b?.character).map(([, b]) => b.character);
        const characters = this.cards.autolifeCharacters().map((entry) => {
            const state = this.#state(entry);
            const life = evaluate(entry.autolife, now);
            const init = entry.autolife.initiative;
            const todayCount = state.initiativeDay?.date === life.local.dateKey ? state.initiativeDay.count : 0;

            // initiative eligibility breakdown (mirrors #runCharacter's logic)
            let initiativeBlockedReason = null;
            if (!init.enabled) initiativeBlockedReason = 'initiative disabled for this character';
            else if (life.isAsleep) initiativeBlockedReason = `asleep/unreachable (${life.activity})`;
            else if (state.pendingReply) initiativeBlockedReason = 'a reply to you is pending';
            else if (this.inFlight.has(entry.name)) initiativeBlockedReason = 'generating right now';
            else if (state.lastInitiativeAt && now.getTime() - new Date(state.lastInitiativeAt).getTime() < init.min_gap_minutes * MINUTE) initiativeBlockedReason = `waiting out the ${init.min_gap_minutes} min gap since the last initiative`;
            else if (state.lastCharMessageAt && now.getTime() - new Date(state.lastCharMessageAt).getTime() < 20 * MINUTE) initiativeBlockedReason = 'messaged you less than 20 min ago';
            else if (todayCount >= init.max_per_day) initiativeBlockedReason = `daily initiative cap reached (${todayCount}/${init.max_per_day})`;
            const nextEligibleAt = (init.enabled && state.lastInitiativeAt && !initiativeBlockedReason?.includes('gap'))
                ? new Date(new Date(state.lastInitiativeAt).getTime() + init.min_gap_minutes * MINUTE).toISOString()
                : null;

            return {
                name: entry.name,
                file: entry.file,
                activity: life.activity,
                availability: life.availability,
                mood: life.mood,
                localTime: `${life.local.weekdayName} ${life.local.hhmm} (${entry.autolife.timezone})`,
                paused: !!state.paused,
                enabled: !!state.enabled,
                journal: state.journal ?? [],
                pendingReply: state.pendingReply ?? null,
                ignoredAt: state.ignoredAt ?? null,
                relationship: state.relationship,
                lastUserMessageAt: state.lastUserMessageAt ?? null,
                lastCharMessageAt: state.lastCharMessageAt ?? null,
                lastInitiativeAt: state.lastInitiativeAt ?? null,
                chatFile: state.chatFile,
                onTelegram: boundChats.includes(entry.name),
                memoryEntries: this.memory ? this.memory.count(entry.name, this.settings.memory?.embed_model) : 0,
                initiative: {
                    ...init,
                    todayCount,
                    blockedReason: initiativeBlockedReason,
                    nextEligibleAt,
                    followupDone: !!state.followupDone,
                },
            };
        });
        return { running: this.running, tickSeconds: this.tickSeconds, model: this.effectiveModel(), characters };
    }
}
