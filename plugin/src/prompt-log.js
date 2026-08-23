// Full-fidelity prompt logging for debugging repeats/echoes: every request
// the backend clients send (and the raw response they got) is written as one
// self-contained JSON file — prompts are too long for a feed. Individual
// files keep the viewer lazy: the list endpoint reads only summary fields,
// full content loads on demand. A keep-cap prunes old entries on write.

import fs from 'node:fs';
import path from 'node:path';

let seq = 0;

function stamp(d = new Date()) {
    return d.toISOString().replace(/[:.]/g, '-'); // 2026-08-23T18-02-48-123Z
}

export class PromptLog {
    /**
     * @param {string} dir storage directory
     * @param {{ getSettings?: () => object, log?: (m:string)=>void }} opts
     */
    constructor(dir, opts = {}) {
        this.dir = dir;
        this.getSettings = opts.getSettings ?? (() => ({}));
        this.log = opts.log ?? (() => {});
    }

    get enabled() {
        return this.getSettings().prompt_log?.enabled === true;
    }

    /**
     * Persist one generation exchange. `entry` = { character, kind, model,
     * attempt?, request (full body incl. messages), response (raw text) }.
     * @returns {string|null} entry id, or null when disabled
     */
    record(entry) {
        if (!this.enabled) return null;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const id = `${stamp()}_${String(seq++).padStart(3, '0')}`;
            const file = `${id}.json`;
            fs.writeFileSync(path.join(this.dir, file), JSON.stringify({
                id,
                ts: new Date().toISOString(),
                ...entry,
            }, null, 2));
            this.#prune();
            return id;
        } catch (err) {
            this.log(`prompt log write failed: ${err.message}`);
            return null;
        }
    }

    /** Summaries, newest first (full files read, messages projected out). */
    list(limit = 200) {
        try {
            const files = fs.readdirSync(this.dir)
                .filter((f) => f.endsWith('.json'))
                .sort()
                .reverse()
                .slice(0, limit);
            const entries = [];
            for (const f of files) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
                    entries.push({
                        id: j.id,
                        ts: j.ts,
                        character: j.character ?? '(engine)',
                        kind: j.kind ?? 'chat',
                        attempt: j.attempt,
                        model: j.model,
                        messages: Array.isArray(j.request?.messages) ? j.request.messages.length : 0,
                        promptChars: Array.isArray(j.request?.messages)
                            ? j.request.messages.reduce((s, m) => s + String(m.content ?? '').length, 0) : 0,
                        responsePreview: String(j.response ?? '').slice(0, 120),
                    });
                } catch { /* skip corrupt */ }
            }
            return entries;
        } catch {
            return [];
        }
    }

    /** One full entry by id (path-traversal safe). */
    get(id) {
        if (!id || typeof id !== 'string' || id.includes('..') || /[\\/]/.test(id)) return null;
        const file = path.join(this.dir, `${id}.json`);
        if (path.dirname(file) !== this.dir) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }

    /** Delete every logged entry. @returns {number} removed */
    purge() {
        try {
            const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
            for (const f of files) fs.rmSync(path.join(this.dir, f), { force: true });
            return files.length;
        } catch {
            return 0;
        }
    }

    #prune() {
        const keep = Math.max(10, Number(this.getSettings().prompt_log?.keep) || 500);
        try {
            const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
            for (const f of files.slice(0, Math.max(0, files.length - keep))) {
                fs.rmSync(path.join(this.dir, f), { force: true });
            }
        } catch { /* nothing to prune */ }
    }
}
