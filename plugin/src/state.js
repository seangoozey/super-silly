// Persistent engine state: settings, per-character life state, telegram bindings.
// Everything lives under data/<user>/autolife/ — never inside the character card.

import fs from 'node:fs';
import path from 'node:path';
import { safeName } from './card-io.js';

const DEFAULT_PRIMARY = process.env.OLLAMA_MODEL || 'hf.co/ReadyArt/Dark-Scarlett-27B-v2.0-GGUF:Q4_K_M';
const DEFAULT_FALLBACK = process.env.OLLAMA_FALLBACK_MODEL || 'hf.co/ReadyArt/Dark-Desires-12B-v1.0-GGUF:Q4_K_M';

export function defaultSettings() {
    return {
        model: {
            primary: DEFAULT_PRIMARY,
            fallback: DEFAULT_FALLBACK,
            current: DEFAULT_PRIMARY,
            // Sampler spec follows ReadyArt's Qwen3 build recommendation:
            // temp 0.7 with everything else neutral. Sent explicitly because
            // Ollama otherwise applies its own defaults (temp 0.8, top_p 0.9,
            // top_k 40, repeat_penalty 1.1). The spec's top_n_sigma and XTC
            // samplers are not exposed through Ollama and are skipped.
            temperature: 0.7,
            top_p: 1,          // 1 = off
            top_k: 0,          // 0 = off
            repeat_penalty: 1, // 1 = off
            // llama.cpp-only samplers (the Ollama backend ignores these):
            // ReadyArt's full recipe — top_n_sigma prunes candidates
            // adaptively per token, XTC occasionally excludes the model's
            // top choices for livelier output. 0 disables either.
            top_n_sigma: 1.2,
            xtc_probability: 0.33,
            xtc_threshold: 0.05,
            // Per-model sampler presets: model name -> SillyTavern Text
            // Completion preset name (a .json in textgeneration-settings/).
            // The preset's sampler fields override the defaults above for
            // that model's generations; editing happens in ST's preset manager.
            preset_by_model: {},
            // Ollama context window (num_ctx). 0 = Ollama default (4096).
            // Raise to 8192 for long histories — needs VRAM headroom; with an
            // ~18GB Q6_K model on a 24GB card, drop to Q5 first.
            num_ctx: 0,
            // 'off' (default: fast short texts, thinking suppressed — recommended
            // for the texting sim), 'on' (model reasons first; needs a thinking-
            // capable model like Dark-Scarlett and gets extra token headroom),
            // 'auto' (omit the flag; the model's chat template default decides).
            think: 'off',
        },
        engine: {
            tick_seconds: 30,
            // Characters start STOPPED on every server boot; start them from
            // the Autolife panel or /start. Set false to keep them running
            // across restarts.
            start_stopped: true,
            // Busy characters text short and distracted; free evening characters
            // may ramble a little.
            availability_tone: true,
            // Close relationships reply faster (delay scaled 0.5x at rel 100,
            // 1.5x at rel 0).
            relationship_speed: true,
        },
        // Global feature kill-switches (independent of per-card settings):
        // flip these to disable a subsystem everywhere without touching cards.
        features: {
            memory: true,
            journal: true,
            evolve: true,
        },
        // Your sleep, not theirs: no engine-initiated texts inside this window,
        // due replies hold until it ends. Times in the given IANA timezone.
        quiet_hours: {
            enabled: false,
            start: '23:00',
            end: '07:00',
            timezone: 'UTC',
        },
        memory: {
            embed_model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
        },
        persona: {
            // How characters address you. Empty = auto-resolve from your
            // SillyTavern chat headers; falls back to 'User'.
            name: process.env.AUTOLIFE_USER_NAME || '',
        },
        prompt: {
            // Global default system-prompt template. Empty = built-in assembly.
            // Cards can override per character (autolife.prompt.template).
            template: '',
        },
        telegram: {
            // Token/allowlist: settings file wins, env (set by the container) is the fallback.
            token: '',
            allowed_chat_ids: [],
        },
    };
}

export class StateStore {
    /** @param {string} rootDir data/<userHandle>/autolife */
    constructor(rootDir) {
        this.root = rootDir;
        this.stateDir = path.join(rootDir, 'state');
        fs.mkdirSync(this.stateDir, { recursive: true });
    }

    _readJson(file, fallback) {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8'));
        } catch {
            return fallback;
        }
    }

    _writeJson(file, obj) {
        const full = path.join(this.root, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, JSON.stringify(obj, null, 4), 'utf8');
    }

    loadSettings() {
        const base = defaultSettings();
        const saved = this._readJson('settings.json', null);
        if (!saved) {
            // First boot: seed from environment (container sets these).
            const envToken = process.env.TELEGRAM_BOT_TOKEN || '';
            const envIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
                .split(/[,\s]+/)
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n !== 0);
            if (envToken) base.telegram.token = envToken;
            if (envIds.length) base.telegram.allowed_chat_ids = envIds;
            this._writeJson('settings.json', base);
            return base;
        }
        // env provides values only where the file never set them
        const merged = {
            ...base,
            ...saved,
            model: { ...base.model, ...(saved.model ?? {}) },
            engine: { ...base.engine, ...(saved.engine ?? {}) },
            memory: { ...base.memory, ...(saved.memory ?? {}) },
            persona: { ...base.persona, ...(saved.persona ?? {}) },
            prompt: { ...base.prompt, ...(saved.prompt ?? {}) },
            quiet_hours: { ...base.quiet_hours, ...(saved.quiet_hours ?? {}) },
            features: { ...base.features, ...(saved.features ?? {}) },
            telegram: { ...base.telegram, ...(saved.telegram ?? {}) },
        };
        if (!merged.telegram.token && process.env.TELEGRAM_BOT_TOKEN) merged.telegram.token = process.env.TELEGRAM_BOT_TOKEN;
        if ((!merged.telegram.allowed_chat_ids || !merged.telegram.allowed_chat_ids.length) && process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
            merged.telegram.allowed_chat_ids = process.env.TELEGRAM_ALLOWED_CHAT_IDS
                .split(/[,\s]+/)
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n) && n !== 0);
        }
        return merged;
    }

    saveSettings(settings) {
        this._writeJson('settings.json', settings);
    }

    /**
     * Load (or create) the life-state of a character.
     * @param {string} character display name (used verbatim; files are safeNamed)
     * @param {{ initialRelationship: number }} seed
     */
    loadState(character, seed) {
        const file = `state/${safeName(character)}.json`;
        const existing = this._readJson(file, null);
        if (existing) return existing;
        const fresh = {
            character,
            enabled: true,
            paused: false,
            relationship: seed?.initialRelationship ?? 20,
            chatFile: null,
            pendingReply: null, // { dueAt: ISO }
            ignoredAt: null, // ISO — an inbound that got no reply (catch-up candidate)
            followupDone: false,
            lastUserMessageAt: null,
            lastCharMessageAt: null,
            lastInitiativeAt: null,
            lastJournalAt: null,
            lastContactAt: null,
            initiativeDay: null, // { date: 'YYYY-MM-DD', count: n }
            relGainDay: null, // { date: 'YYYY-MM-DD', gained: n }
            journal: [], // [{ ts: ISO, text }]
        };
        this._writeJson(file, fresh);
        return fresh;
    }

    saveState(state) {
        if (state.journal?.length > 40) state.journal = state.journal.slice(-40);
        this._writeJson(`state/${safeName(state.character)}.json`, state);
    }

    /** Hard-reset a character's runtime state (purge). */
    purgeState(character) {
        try {
            fs.rmSync(path.join(this.stateDir, `${safeName(character)}.json`));
        } catch { /* nothing to remove */ }
    }

    /**
     * Telegram chat bindings, scoped per bot:
     *   { bots: { <botName>: { <chatId>: { character, chatFile, audit? } } } }
     * Legacy flat files ({ chatId: binding }) are treated as the 'default' bot.
     * @param {string} bot bot name ('default' for the shared bot)
     */
    loadBindings(bot = 'default') {
        const raw = this._readJson('bindings.json', null);
        if (!raw) return {};
        const shaped = raw.bots ? raw : { bots: { default: raw } }; // legacy flat migration
        return shaped.bots[bot] ?? {};
    }

    saveBindings(bot = 'default', bindings) {
        const raw = this._readJson('bindings.json', null);
        const shaped = raw ? (raw.bots ? raw : { bots: { default: raw } }) : { bots: {} };
        shaped.bots[bot] = bindings ?? {};
        this._writeJson('bindings.json', shaped);
    }

    /** Merged view across all bots: chatId -> { ...binding, bot }. */
    allBindings() {
        const raw = this._readJson('bindings.json', null);
        if (!raw) return {};
        const shaped = raw.bots ? raw : { bots: { default: raw } };
        const merged = {};
        for (const [bot, chats] of Object.entries(shaped.bots ?? {})) {
            for (const [chatId, b] of Object.entries(chats ?? {})) {
                if (b?.character) merged[`${bot}:${chatId}`] = { ...b, bot, chatId };
            }
        }
        return merged;
    }

    loadTelegramOffset() {
        return this._readJson('telegram-offset.json', { offset: 0 }).offset ?? 0;
    }

    saveTelegramOffset(offset) {
        this._writeJson('telegram-offset.json', { offset });
    }

    // ---- audit log (ring-buffer-ish JSONL per character + engine-wide) ----

    #auditFile(character) {
        return path.join(this.root, 'audit', `${safeName(character || '_engine')}.jsonl`);
    }

    /**
     * Append an audit entry. Files are trimmed to the last 300 entries once
     * they pass 400 so the disk footprint stays tiny.
     * @param {string|null} character null = engine-wide event
     * @param {{ ts: string, character: string|null, kind: string, text: string }} entry
     */
    appendAudit(character, entry) {
        const file = this.#auditFile(character);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let lines = [];
        try {
            lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        } catch { /* new file */ }
        lines.push(JSON.stringify({ character: character ?? null, ...entry }));
        if (lines.length > 400) lines = lines.slice(-300);
        fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    }

    /**
     * Read audit entries, newest last.
     * @param {string|null} character null/undefined = merge every audit file
     * @param {number} limit
     * @returns {Array<object>}
     */
    readAudit(character, limit = 100) {
        const files = character
            ? [this.#auditFile(character)]
            : (() => {
                const dir = path.join(this.root, 'audit');
                try {
                    return fs.readdirSync(dir).map((f) => path.join(dir, f));
                } catch {
                    return [];
                }
            })();
        const entries = [];
        for (const file of files) {
            try {
                for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        entries.push(JSON.parse(line));
                    } catch { /* skip corrupt line */ }
                }
            } catch { /* missing file */ }
        }
        entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        return entries.slice(-limit);
    }
}
