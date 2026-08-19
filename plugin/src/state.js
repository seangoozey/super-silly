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
            temperature: 0.9,
            // 'off' (default: fast short texts, thinking suppressed — recommended
            // for the texting sim), 'on' (model reasons first; needs a thinking-
            // capable model like Dark-Scarlett and gets extra token headroom),
            // 'auto' (omit the flag; the model's chat template default decides).
            think: 'off',
        },
        engine: {
            tick_seconds: 30,
        },
        memory: {
            embed_model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
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

    /** Telegram chat bindings: chatId -> { character, chatFile } */
    loadBindings() {
        return this._readJson('bindings.json', {});
    }

    saveBindings(bindings) {
        this._writeJson('bindings.json', bindings ?? {});
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
