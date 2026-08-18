// Shared card import used by the Telegram /upload command and the plugin routes.

import fs from 'node:fs';
import path from 'node:path';
import { parseCardBuffer, embedCardInPng, generatePlaceholderAvatar, safeName, withAutolife, getAutolife } from './card-io.js';
import { validateCard, normalizeAutolife } from './autolife-schema.js';

/**
 * Validate + import a character card file buffer into the characters directory.
 * PNG cards are re-embedded (preserving the avatar); JSON cards get a generated
 * placeholder avatar. Existing files with the same name are overwritten.
 *
 * @param {{ buffer: Buffer, filename: string, charactersDir: string, requireAutolife?: boolean }} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[], name?: string, file?: string, hasAutolife?: boolean }}
 */
export function importCardBuffer(input) {
    const { buffer, filename, charactersDir } = input;

    let card;
    try {
        card = parseCardBuffer(buffer, filename);
    } catch (err) {
        return { ok: false, errors: [`Could not parse card: ${err.message}`], warnings: [] };
    }

    const check = validateCard(card);
    if (!check.valid) {
        return { ok: false, errors: check.errors, warnings: check.warnings };
    }

    const name = (card.data ?? card).name?.trim();
    const stem = safeName(name);
    let out;
    if (filename.toLowerCase().endsWith('.png')) {
        out = embedCardInPng(buffer, card);
    } else {
        out = embedCardInPng(generatePlaceholderAvatar(name), card);
    }

    fs.mkdirSync(charactersDir, { recursive: true });
    const file = `${stem}.png`;
    fs.writeFileSync(path.join(charactersDir, file), out);

    return {
        ok: true,
        errors: [],
        warnings: check.warnings,
        name,
        file,
        hasAutolife: !!getAutolife(card),
    };
}

/**
 * Write an autolife block back into an existing character card file
 * (used by the UI panel save). Preserves everything else in the card.
 * @returns {{ ok: boolean, errors: string[], name: string, file: string }}
 */
export function saveAutolifeToCharacter(charactersDir, entry, autolifeRaw) {
    const card = withAutolife(entry.card, autolifeRaw);
    let out;
    if (entry.file.toLowerCase().endsWith('.png')) {
        out = embedCardInPng(fs.readFileSync(entry.path), card);
    } else {
        out = Buffer.from(JSON.stringify(card, null, 4), 'utf8');
        fs.writeFileSync(path.join(charactersDir, entry.file), out);
        return { ok: true, errors: [], name: entry.name, file: entry.file };
    }
    fs.writeFileSync(entry.path, out);
    return { ok: true, errors: [], name: entry.name, file: entry.file };
}

/** Normalized autolife helper for callers that already hold the card. */
export function normalizedAutolife(card) {
    const raw = getAutolife(card);
    return raw ? normalizeAutolife(raw) : null;
}
