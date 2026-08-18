// Character card registry: scans SillyTavern's characters directory and
// caches parsed cards + their normalized autolife config (mtime-keyed).

import fs from 'node:fs';
import path from 'node:path';
import { extractCardFromPng, getAutolife } from './card-io.js';
import { normalizeAutolife } from './autolife-schema.js';

export class CardRegistry {
    /** @param {string} charactersDir data/<user>/characters */
    constructor(charactersDir) {
        this.dir = charactersDir;
        this.cache = new Map(); // file -> { mtimeMs, entry }
        this.lastScan = 0;
    }

    scan() {
        this.lastScan = Date.now();
        const found = [];
        if (!fs.existsSync(this.dir)) return found;
        for (const f of fs.readdirSync(this.dir).sort()) {
            const lower = f.toLowerCase();
            if (!lower.endsWith('.png') && !lower.endsWith('.json')) continue;
            const full = path.join(this.dir, f);
            let stat;
            try {
                stat = fs.statSync(full);
            } catch {
                continue;
            }
            let entry = this.cache.get(f);
            if (!entry || entry.mtimeMs !== stat.mtimeMs) {
                try {
                    const card = lower.endsWith('.png')
                        ? extractCardFromPng(fs.readFileSync(full)).card
                        : JSON.parse(fs.readFileSync(full, 'utf8'));
                    entry = {
                        file: f,
                        path: full,
                        mtimeMs: stat.mtimeMs,
                        card,
                        name: card?.data?.name ?? card?.name ?? path.basename(f, path.extname(f)),
                        autolifeRaw: getAutolife(card),
                    };
                } catch (err) {
                    console.warn(`[Autolife] skipping unparseable character file ${f}: ${err.message}`);
                    this.cache.set(f, { mtimeMs: stat.mtimeMs, broken: true });
                    continue;
                }
                entry.autolife = entry.autolifeRaw ? normalizeAutolife(entry.autolifeRaw) : null;
                this.cache.set(f, entry);
            }
            if (!entry.broken) found.push(entry);
        }
        return found;
    }

    /** All characters with a valid autolife block. */
    autolifeCharacters() {
        return this.scan().filter((c) => c.autolife);
    }

    /**
     * Find a character by (case-insensitive) name, fuzzy on substring.
     * @returns {object|null} registry entry
     */
    find(query) {
        const q = String(query ?? '').trim().toLowerCase();
        if (!q) return null;
        const all = this.scan();
        return (
            all.find((c) => c.name.toLowerCase() === q) ??
            all.find((c) => c.file.toLowerCase() === `${q}.png`) ??
            all.find((c) => c.name.toLowerCase().includes(q)) ??
            null
        );
    }

    /** Invalidate one file (after writing a card through card-io). */
    invalidate(file) {
        this.cache.delete(file);
    }
}
