// The Autolife engine: per-character tick loop that decides when characters
// reply, delay, ignore, catch up, double-text and journal — and generates
// their messages through Ollama, writing them into the SillyTavern chat and
// pushing them to bound transports (Telegram).

import { evaluate, sampleDelayMinutes, clamp01 } from './schedule.js';
import { buildSystemPrompt, buildChatMessages, buildJournalPrompt, cleanModelOutput, NUM_PREDICT } from './llm.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class Engine {
    /**
     * @param {{ cards: object, store: object, chatStore: object, ollama: object,
     *           rng?: {float:()=>number}, nowFn?: ()=>Date, log?: (msg:string)=>void,
     *           emit?: (type:string, data:object)=>void, transports?: Array<object> }} deps
     */
    constructor(deps) {
        this.cards = deps.cards;
        this.store = deps.store;
        this.chatStore = deps.chatStore;
        this.ollama = deps.ollama;
        this.rng = deps.rng ?? { float: Math.random };
        this.nowFn = deps.nowFn ?? (() => new Date());
        this.log = deps.log ?? ((m) => console.log(`[Autolife] ${m}`));
        this.emit = deps.emit ?? (() => {});
        this.transports = deps.transports ?? [];
        this.settings = this.store.loadSettings();
        this.inFlight = new Map(); // character name -> Promise
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

    effectiveModel() {
        return this.settings.model?.current || this.settings.model?.primary || 'llama3.2:3b';
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

        if (source === 'telegram') {
            this.chatStore.appendMessage(entry.name, state.chatFile, this.chatStore.userMessage(mes, now));
        }

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
            return;
        }

        const b = entry.autolife.behavior;
        const pIgnore = Math.min(0.5, b.ignore_chance * (1 + 2 * (1 - life.availability)));
        if (this.rng.float() < pIgnore) {
            state.ignoredAt = now.toISOString();
            this.store.saveState(state);
            this.log(`"${entry.name}" missed your message (${life.activity}, ${(life.availability * 100).toFixed(0)}% available)`);
            this.emit('ignored', { character: entry.name });
            return;
        }

        const pQuick = b.quick_reply_chance * clamp01(life.availability);
        if (this.rng.float() < pQuick) {
            this.store.saveState(state);
            await this.#generate(entry, state, 'reply', now);
            return;
        }

        const delayMinutes = sampleDelayMinutes(entry.autolife, life, this.rng);
        state.pendingReply = { dueAt: new Date(now.getTime() + delayMinutes * MINUTE).toISOString() };
        this.store.saveState(state);
        this.log(`"${entry.name}" will reply in ~${delayMinutes.toFixed(0)} min (${life.activity})`);
        this.emit('deferred', { character: entry.name, dueAt: state.pendingReply.dueAt });
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
            } catch (err) {
                this.log(`"${entry.name}" tick failed: ${err?.stack ?? err}`);
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
                    state.pendingReply = { dueAt: new Date(now.getTime() + MINUTE).toISOString() }; // retry after current generation
                    this.store.saveState(state);
                } else {
                    this.store.saveState(state);
                    await this.#generate(entry, state, 'reply', now);
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
            await this.#generate(entry, state, 'catchup', now);
        }

        // 3. proactive initiative
        if (init.enabled && !life.isAsleep && !state.pendingReply && !this.inFlight.has(entry.name)) {
            const day = life.local.dateKey;
            if (state.initiativeDay?.date !== day) state.initiativeDay = { date: day, count: 0 };
            const gapOk = !state.lastInitiativeAt || now.getTime() - new Date(state.lastInitiativeAt).getTime() >= init.min_gap_minutes * MINUTE;
            const quietOk = !state.lastCharMessageAt || now.getTime() - new Date(state.lastCharMessageAt).getTime() >= 20 * MINUTE;
            if (gapOk && quietOk && state.initiativeDay.count < init.max_per_day) {
                const relFactor = 0.7 + state.relationship / 100;
                const pTick = Math.min(0.2, (this.tickSeconds / (init.min_gap_minutes * 60)) * (0.4 + 0.6 * life.availability) * relFactor);
                if (this.rng.float() < pTick) {
                    this.log(`"${entry.name}" feels like texting you`);
                    await this.#generate(entry, state, 'initiative', now);
                }
            }
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
            await this.#generate(entry, state, 'followup', now);
        }

        // 5. journal upkeep
        if (entry.autolife.journal?.enabled && !life.isAsleep
            && (!state.lastJournalAt || now.getTime() - new Date(state.lastJournalAt).getTime() > 3 * HOUR)
            && this.rng.float() < 0.08) {
            await this.#journal(entry, state, life, now);
        }
    }

    // ------------------------------------------------------------ generation

    async #generate(entry, state, kind, now) {
        const key = entry.name;
        const promise = this.#generateInner(entry, state, kind, now)
            .catch((err) => this.log(`"${key}" generation (${kind}) failed: ${err?.stack ?? err}`))
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, promise);
        await promise;
    }

    async #generateInner(entry, state, kind, now) {
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
        const messages = buildChatMessages({
            system,
            history,
            characterName: entry.name,
            userName: this.chatStore.userName,
            kind,
        });

        const numPredict = NUM_PREDICT[entry.autolife.behavior?.avg_message_length ?? 'short'] ?? 160;
        const candidates = [...new Set([this.settings.model?.current, this.settings.model?.fallback].filter(Boolean))];

        let text = '';
        let usedModel = null;
        for (const model of candidates) {
            try {
                if (!(await this.ollama.hasModel(model))) {
                    const ok = await this.ollama.ensureModel(model, (s) => this.emit('model_pull', { model, status: s }));
                    if (!ok) continue;
                }
                const raw = await this.ollama.chat({
                    model,
                    messages,
                    temperature: this.settings.model?.temperature ?? 0.9,
                    numPredict,
                });
                text = cleanModelOutput(raw);
                if (!text) {
                    // one nudge retry — models occasionally answer with empty strings
                    const retry = await this.ollama.chat({
                        model,
                        messages: [...messages, { role: 'assistant', content: '(continue — send the actual text message now)' }, { role: 'user', content: '...' }],
                        temperature: this.settings.model?.temperature ?? 0.9,
                        numPredict,
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
            return false;
        }
        if (text.length > 1500) text = text.slice(0, 1500).trim();

        this.chatStore.appendMessage(entry.name, state.chatFile, this.chatStore.characterMessage(entry.name, text, now));
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
            return {
                name: entry.name,
                file: entry.file,
                activity: life.activity,
                availability: life.availability,
                mood: life.mood,
                localTime: `${life.local.weekdayName} ${life.local.hhmm} (${entry.autolife.timezone})`,
                paused: !!state.paused,
                enabled: !!state.enabled,
                pendingReply: state.pendingReply ?? null,
                ignoredAt: state.ignoredAt ?? null,
                relationship: state.relationship,
                lastUserMessageAt: state.lastUserMessageAt ?? null,
                lastCharMessageAt: state.lastCharMessageAt ?? null,
                lastInitiativeAt: state.lastInitiativeAt ?? null,
                chatFile: state.chatFile,
                onTelegram: boundChats.includes(entry.name),
                initiative: entry.autolife.initiative,
            };
        });
        return { running: this.running, tickSeconds: this.tickSeconds, model: this.effectiveModel(), characters };
    }
}
