// Engine-side vector memory (RAG) for long-running characters.
// One append-only JSONL index per character under data/<user>/autolife/memory/.
// Vectors are Float32 base64 blobs; search is plain cosine similarity — at
// chat scale (a few thousand entries, 768 dims) that's single-digit ms.

import fs from 'node:fs';
import path from 'node:path';
import { safeName } from './card-io.js';

export function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
}

const vecToB64 = (vec) => Buffer.from(Float32Array.from(vec).buffer).toString('base64');
const b64ToVec = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    return new Float32Array(arrayBuffer);
};

/** Stable key for dedupe between chat-file lines and index entries. */
export function messageKey(sendDate, role, text) {
    return `${role}:${sendDate}:${String(text).slice(0, 80)}`;
}

export class MemoryStore {
    /**
     * @param {string} dir data/<user>/autolife/memory
     * @param {(msg:string)=>void} log
     */
    constructor(dir, log = () => {}) {
        this.dir = dir;
        this.log = log;
        this.cache = new Map(); // character -> { model, entries: [{ts, role, text, vecB64, chatFile, key}], keys: Set }
        fs.mkdirSync(dir, { recursive: true });
    }

    #file(character) {
        return path.join(this.dir, `${safeName(character)}.jsonl`);
    }

    #load(character, model) {
        let c = this.cache.get(character);
        if (c && (!model || !c.model || c.model === model)) return c;
        if (c) this.cache.delete(character); // embedding model changed since load — reload from disk
        const file = this.#file(character);
        c = { model: null, entries: [], keys: new Set() };
        try {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
            const header = JSON.parse(lines[0]);
            if (header.type === 'autolife-memory') {
                if (model && header.model !== model) {
                    // embedding model changed — the old vectors are meaningless.
                    // Archive the index; backfill will rebuild from the chat file.
                    fs.renameSync(file, `${file}.bak-${Date.now()}`);
                    this.log(`memory index for "${character}" archived (embedding model changed ${header.model} -> ${model}); rebuilding`);
                } else {
                    c.model = header.model;
                    for (const line of lines.slice(1)) {
                        try {
                            const e = JSON.parse(line);
                            c.entries.push(e);
                            c.keys.add(e.key);
                        } catch { /* skip corrupt */ }
                    }
                }
            }
        } catch { /* no index yet */ }
        if (model && !c.model) {
            c.model = model;
            fs.writeFileSync(file, `${JSON.stringify({ type: 'autolife-memory', model, created: new Date().toISOString() })}\n`, 'utf8');
        }
        this.cache.set(character, c);
        return c;
    }

    /**
     * Store one embedded message. Returns true if stored, false if dup/empty.
     * @param {{ ts, role: 'user'|'assistant', text, vec: Array<number>, chatFile, key }} entry
     */
    append(character, entry, model) {
        const c = this.#load(character, model);
        if (!entry?.vec?.length || !entry.text?.trim() || c.keys.has(entry.key)) return false;
        c.entries.push({ ts: entry.ts, role: entry.role, text: String(entry.text).slice(0, 2000), vecB64: vecToB64(entry.vec), chatFile: entry.chatFile, key: entry.key });
        c.keys.add(entry.key);
        fs.appendFileSync(this.#file(character), `${JSON.stringify(c.entries[c.entries.length - 1])}\n`, 'utf8');
        return true;
    }

    /**
     * Top-k by cosine similarity against the query vector.
     * @param {{ k?: number, excludeKeys?: Set<string>, excludeTextPrefixes?: Set<string> }} opts
     */
    search(character, queryVec, opts = {}) {
        const c = this.#load(character);
        const k = opts.k ?? 3;
        const scored = [];
        const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
        for (const e of c.entries) {
            if (opts.excludeKeys?.has(e.key)) continue;
            if (opts.excludeTextPrefixes?.has(norm(e.text))) continue;
            const score = cosine(queryVec, b64ToVec(e.vecB64));
            scored.push({ score, entry: e });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, k).map((s) => ({ ...s.entry, score: s.score }));
    }

    count(character, model) {
        return this.#load(character, model).entries.length;
    }

    stats(character, model) {
        const c = this.#load(character, model);
        return { model: c.model, entries: c.entries.length };
    }

    /** Drop the index entirely (POST /memory/rebuild); cache resets on next load. */
    rebuild(character) {
        this.cache.delete(character);
        try {
            fs.rmSync(this.#file(character));
        } catch { /* nothing yet */ }
    }

    /** Keep the index bounded: rewrite without the oldest entries when it outgrows max+slack. */
    prune(character, maxEntries, model) {
        const c = this.#load(character, model);
        if (c.entries.length <= maxEntries + 200) return 0;
        const dropped = c.entries.length - maxEntries;
        c.entries = c.entries.slice(-maxEntries);
        c.keys = new Set(c.entries.map((e) => e.key));
        const file = this.#file(character);
        fs.writeFileSync(file, [JSON.stringify({ type: 'autolife-memory', model: c.model, created: new Date().toISOString() }), ...c.entries.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8');
        this.log(`memory index for "${character}" pruned to ${c.entries.length} entries (dropped ${dropped} oldest)`);
        return dropped;
    }

    /**
     * Embed chat-file messages that are not in the index yet, oldest first.
     * @param {function} embed async (text) => number[] | null
     * @returns {{ added: number, remaining: number }} remaining = unindexed messages left
     */
    async backfill(character, chatStore, chatFile, embed, { limit = 20, maxEntries = 4000 } = {}) {
        const messages = chatStore.readMessages(character, chatFile);
        const missing = [];
        const c = this.#load(character);
        for (const m of messages) {
            const role = m.is_user ? 'user' : 'assistant';
            const key = messageKey(m.send_date, role, m.mes);
            if (c.keys.has(key)) continue;
            missing.push({ m, key, role });
        }
        // index oldest first so long histories fill from the beginning
        missing.sort((a, b) => String(a.m.send_date).localeCompare(String(b.m.send_date)));
        let added = 0;
        for (const item of missing.slice(0, limit)) {
            const text = String(item.m.mes ?? '').trim();
            if (!text) continue;
            const vec = await embed(text);
            if (!vec) return { added, remaining: missing.length - added };
            this.append(character, { ts: new Date().toISOString(), role: item.role, text, vec, chatFile, key: item.key });
            added++;
        }
        this.prune(character, maxEntries);
        return { added, remaining: missing.length - added };
    }
}
