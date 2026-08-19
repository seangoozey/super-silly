// Character card I/O: PNG tEXt chunk codec (CCv3 "ccv3" + V2 "chara" chunks),
// JSON cards, and a dependency-free placeholder avatar generator.
//
// PNG cards follow the Character Card V3 spec: the card JSON is stored
// base64-encoded in a tEXt chunk. V3 readers prefer the "ccv3" chunk and fall
// back to "chara". We write both (same payload) for maximum compatibility,
// matching SillyTavern's own writer.

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------- crc32

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------- chunk codec

/** @returns {Array<{type: string, data: Buffer}>} */
export function parseChunks(png) {
    if (!png || png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Not a PNG file (bad signature).');
    }
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > png.length) throw new Error(`Corrupt PNG: chunk "${type}" runs past end of file.`);
        const data = png.subarray(dataStart, dataEnd);
        chunks.push({ type, data, start: offset });
        offset = dataEnd + 4; // skip CRC
        if (type === 'IEND') break;
    }
    return chunks;
}

function buildChunk(type, data) {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    const crcInput = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    out.writeUInt32BE(crc32(crcInput), 8 + data.length);
    return out;
}

function buildTextChunk(keyword, text) {
    return buildChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** Read all tEXt chunks as {keyword -> text} (last wins). */
export function readTextChunks(chunks) {
    const texts = new Map();
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const nul = chunk.data.indexOf(0);
        if (nul <= 0) continue;
        const keyword = chunk.data.toString('latin1', 0, nul);
        const text = chunk.data.toString('latin1', nul + 1);
        texts.set(keyword, text);
    }
    return texts;
}

// ---------------------------------------------------------------- card read/write

/**
 * Extract the embedded character card from a PNG buffer.
 * Prefers the V3 "ccv3" chunk, falls back to the V2 "chara" chunk.
 * @returns {{ card: object, chunk: 'ccv3'|'chara' }}
 */
export function extractCardFromPng(png) {
    const texts = readTextChunks(parseChunks(png));
    for (const keyword of ['ccv3', 'chara']) {
        const raw = texts.get(keyword);
        if (!raw) continue;
        try {
            const json = Buffer.from(raw, 'base64').toString('utf8');
            const card = JSON.parse(json);
            if (card && (card.spec || card.name)) return { card, chunk: keyword };
        } catch {
            // fall through to next chunk
        }
    }
    throw new Error('No character card found in PNG (no readable "ccv3"/"chara" chunk).');
}

/**
 * Re-embed a card into an avatar PNG, preserving every other chunk.
 * Writes both "ccv3" and "chara" tEXt chunks right after IHDR and removes any
 * pre-existing card chunks.
 */
export function embedCardInPng(png, card) {
    const chunks = parseChunks(png);
    const json = JSON.stringify(card);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const parts = [PNG_SIGNATURE];
    let inserted = false;
    for (const chunk of chunks) {
        if (chunk.type === 'tEXt') {
            const nul = chunk.data.indexOf(0);
            const keyword = nul > 0 ? chunk.data.toString('latin1', 0, nul) : '';
            if (keyword === 'ccv3' || keyword === 'chara') continue; // drop old card chunks
        }
        parts.push(buildChunk(chunk.type, chunk.data));
        if (chunk.type === 'IHDR' && !inserted) {
            parts.push(buildTextChunk('ccv3', b64));
            parts.push(buildTextChunk('chara', b64));
            inserted = true;
        }
    }
    if (!inserted) {
        // degenerate PNG without IHDR — append after everything before IEND
        const iend = parts.pop();
        parts.push(buildTextChunk('ccv3', b64), buildTextChunk('chara', b64), iend);
    }
    return Buffer.concat(parts);
}

/** Parse a character card from a .json or .png file buffer. */
export function parseCardBuffer(buffer, filename = '') {
    if (filename.toLowerCase().endsWith('.json')) {
        return JSON.parse(buffer.toString('utf8'));
    }
    return extractCardFromPng(buffer).card;
}

/**
 * Remove ALL character-card chunks (ccv3/chara) from a PNG, leaving every
 * other chunk untouched — a clean avatar ready to be re-embedded later.
 */
export function purgeCardFromPng(png) {
    const chunks = parseChunks(png);
    const parts = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        if (chunk.type === 'tEXt') {
            const nul = chunk.data.indexOf(0);
            const keyword = nul > 0 ? chunk.data.toString('latin1', 0, nul) : '';
            if (keyword === 'ccv3' || keyword === 'chara') continue;
        }
        parts.push(buildChunk(chunk.type, chunk.data));
    }
    return Buffer.concat(parts);
}

export function getAutolife(card) {
    return card?.data?.extensions?.autolife ?? null;
}

/** Returns a shallow-cloned card with the autolife extension replaced. */
export function withAutolife(card, autolife) {
    const clone = structuredClone(card);
    clone.data = clone.data ?? {};
    clone.data.extensions = clone.data.extensions ?? {};
    clone.data.extensions.autolife = autolife;
    return clone;
}

/** Sanitize a character name into a safe file stem (SillyTavern-style). */
export function safeName(name) {
    return String(name)
        .replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'character';
}

// ---------------------------------------------------------------- placeholder avatar

function hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h * 12) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
    };
    return [f(0), f(8), f(4)];
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * Generate a small deterministic placeholder avatar PNG for a card name:
 * a solid colored square with a lighter diamond in the middle.
 */
export function generatePlaceholderAvatar(name, size = 256) {
    const h = hashString(String(name || 'x'));
    const [br, bg, bb] = hslToRgb(((h % 360) / 360), 0.45, 0.30);
    const [dr, dg, db] = hslToRgb((((h >> 9) % 360) / 360), 0.5, 0.55);

    const rowLen = size * 3 + 1; // +1 filter byte
    const raw = Buffer.alloc(rowLen * size);
    const mid = (size - 1) / 2;
    const half = size * 0.21;
    for (let y = 0; y < size; y++) {
        const rowStart = y * rowLen;
        raw[rowStart] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const inDiamond = Math.abs(x - mid) + Math.abs(y - mid) <= half;
            const px = rowStart + 1 + x * 3;
            raw[px] = inDiamond ? dr : br;
            raw[px + 1] = inDiamond ? dg : bg;
            raw[px + 2] = inDiamond ? db : bb;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        PNG_SIGNATURE,
        buildChunk('IHDR', ihdr),
        buildChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        buildChunk('IEND', Buffer.alloc(0)),
    ]);
}
