import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFromTemplate, TEMPLATES } from '../tools/templates.mjs';
import { validateCard } from '../plugin/src/autolife-schema.js';
import { extractCardFromPng } from '../plugin/src/card-io.js';

const CLI = path.resolve('tools/card-tools.mjs');

test('all templates produce valid autolife cards', () => {
    for (const key of Object.keys(TEMPLATES)) {
        const card = buildFromTemplate(key, `Template ${key}`, {});
        const check = validateCard(card);
        assert.equal(check.valid, true, `${key}: ${check.errors.join('; ')}`);
        assert.equal(check.hasAutolife, true);
        assert.equal(card.spec, 'chara_card_v3');
        assert.ok(card.data.extensions.autolife.schedule.length > 0);
    }
});

test('bundled example cards validate', () => {
    const dir = path.resolve('cards/examples');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 3, 'expected at least three example cards');
    for (const f of files) {
        const card = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const check = validateCard(card);
        assert.equal(check.valid, true, `${f}: ${check.errors.join('; ')}`);
    }
});

test('cli: create + validate + embed + inspect roundtrip', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardtools-'));
    const json = path.join(tmp, 'cli-test.json');
    const png = path.join(tmp, 'CliTest.png');

    const out = execFileSync('node', [CLI, 'create', '--name', 'Cli Test', '--template', 'busy-friend', '--out', json], { encoding: 'utf8' });
    assert.match(out, /Created/);

    const vout = execFileSync('node', [CLI, 'validate', json], { encoding: 'utf8' });
    assert.match(vout, /✓/);

    execFileSync('node', [CLI, 'embed', json, '-o', png]);
    assert.ok(fs.statSync(png).size > 1000, 'png written');

    const card = extractCardFromPng(fs.readFileSync(png)).card;
    assert.equal(card.data.name, 'Cli Test');
    assert.equal(card.data.extensions.autolife.version, '1.0');

    const insp = execFileSync('node', [CLI, 'inspect', png], { encoding: 'utf8' });
    assert.match(insp, /name:\s+Cli Test/);
    assert.match(insp, /autolife:\s+v1\.0/);

    // validate the png too
    const vout2 = execFileSync('node', [CLI, 'validate', png], { encoding: 'utf8' });
    assert.match(vout2, /✓/);
});

test('cli: validate fails on a broken card', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cardtools-bad-'));
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ spec: 'chara_card_v3', data: { name: '' } }));
    let failed = false;
    try {
        execFileSync('node', [CLI, 'validate', bad], { encoding: 'utf8', stdio: 'pipe' });
    } catch {
        failed = true;
    }
    assert.ok(failed, 'validator should exit non-zero');
});
