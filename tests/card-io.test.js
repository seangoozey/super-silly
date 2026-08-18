import test from 'node:test';
import assert from 'node:assert/strict';
import {
    crc32,
    generatePlaceholderAvatar,
    parseChunks,
    extractCardFromPng,
    embedCardInPng,
    readTextChunks,
    withAutolife,
    getAutolife,
    safeName,
} from '../plugin/src/card-io.js';

const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: 'Testa Carda',
        description: 'A test character.',
        extensions: { autolife: { version: '1.0', timezone: 'UTC' } },
    },
};

function buildTextChunk(keyword, text) {
    const payload = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'latin1')]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt', 'latin1'), payload])), 0);
    return Buffer.concat([len, Buffer.from('tEXt', 'latin1'), payload, crc]);
}

test('placeholder avatar is a valid PNG', () => {
    const png = generatePlaceholderAvatar('Testa Carda', 64);
    const chunks = parseChunks(png);
    assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
});

test('embed + extract roundtrip prefers ccv3 and preserves foreign chunks', () => {
    const withCard = embedCardInPng(generatePlaceholderAvatar('Testa Carda', 64), card);

    // inject a foreign tEXt chunk the way another tool might; embedding again must keep it
    const sig = withCard.subarray(0, 8);
    const patched = Buffer.concat([sig, buildTextChunk('note', 'hi'), withCard.subarray(8)]);

    const reEmbedded = embedCardInPng(patched, card);
    const texts = readTextChunks(parseChunks(reEmbedded));
    assert.equal(texts.get('note'), 'hi');
    assert.ok(texts.has('ccv3'));

    const out = extractCardFromPng(reEmbedded);
    assert.equal(out.chunk, 'ccv3');
    assert.equal(out.card.data.name, 'Testa Carda');
    assert.equal(getAutolife(out.card).timezone, 'UTC');
});

test('extract falls back to chara chunk when ccv3 absent', () => {
    const avatar = generatePlaceholderAvatar('X', 64);
    const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    const sig = avatar.subarray(0, 8);
    const idatAt = avatar.indexOf('IDAT') - 4;
    const patched = Buffer.concat([sig, avatar.subarray(8, idatAt), buildTextChunk('chara', b64), avatar.subarray(idatAt)]);

    const out = extractCardFromPng(patched);
    assert.equal(out.chunk, 'chara');
    assert.equal(out.card.spec, 'chara_card_v3');
});

test('withAutolife clones and replaces only the autolife block', () => {
    const original = structuredClone(card);
    const updated = withAutolife(card, { version: '1.0', timezone: 'Europe/Berlin' });
    assert.equal(card.data.extensions.autolife.timezone, 'UTC'); // original untouched
    assert.equal(updated.data.extensions.autolife.timezone, 'Europe/Berlin');
    assert.equal(updated.data.name, original.data.name);
});

test('safeName strips path-hostile characters', () => {
    assert.equal(safeName('Maya "The Boss" Chen/Maya v2'), 'Maya_The_Boss_Chen_Maya_v2');
    assert.equal(safeName('   '), 'character');
});
