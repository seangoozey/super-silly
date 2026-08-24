import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTextGenPresets, loadPreset, presetToSamplers } from '../plugin/src/presets.js';
import { fileURLToPath } from 'node:url';
import { characterCard, buildHarness } from './helpers.js';

function tmpUserDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'presets-test-'));
}

// the ReadyArt spec file shape — an ST Text Completion preset verbatim
const READYART_PRESET = {
    temp: 0.7,
    temperature_last: true,
    top_p: 1,
    top_k: 0,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    typical_p: 1,
    min_p: 0,
    rep_pen: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    no_repeat_ngram_size: 0,
    nsigma: 1.2,
    xtc_threshold: 0.05,
    xtc_probability: 0.33,
    dry_multiplier: 0,
    mirostat_mode: 0,
    seed: -1,
    max_length: 32768,
    genamt: 4096,
    sampler_priority: ['penalties', 'dry', 'top_n_sigma', 'top_k'],
};

test('presetToSamplers maps textgen field names (and aliases), skips unsafe fields', () => {
    const s = presetToSamplers(READYART_PRESET);
    assert.equal(s.temperature, 0.7);
    assert.equal(s.top_p, 1);
    assert.equal(s.top_k, 0);
    assert.equal(s.repeat_penalty, 1); // rep_pen alias
    assert.equal(s.top_n_sigma, 1.2);  // nsigma alias
    assert.equal(s.xtc_probability, 0.33);
    assert.equal(s.xtc_threshold, 0.05);
    // deliberately not mapped: seed, context budgets, sampler ordering
    assert.ok(!('seed' in s));
    assert.ok(!('max_length' in s));
    assert.ok(!('sampler_priority' in s));

    // the alternate spellings used by some presets
    const alt = presetToSamplers({ temperature: 0.55, repeat_penalty: 1.05, top_n_sigma: 1.0 });
    assert.equal(alt.temperature, 0.55);
    assert.equal(alt.repeat_penalty, 1.05);
    assert.equal(alt.top_n_sigma, 1.0);

    // sparse/absent presets map nothing — engine defaults stay in charge
    assert.deepEqual(presetToSamplers({}), {});
    assert.deepEqual(presetToSamplers(null), {});
});

test('listTextGenPresets reads the ST dir; loadPreset rejects traversal', () => {
    const dir = tmpUserDir();
    const pdir = path.join(dir, 'TextGen Settings');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'ReadyArt Qwen3.json'), JSON.stringify(READYART_PRESET));
    fs.writeFileSync(path.join(pdir, 'ignore.txt'), 'not a preset');

    assert.deepEqual(listTextGenPresets(dir), ['ReadyArt Qwen3']);
    assert.deepEqual(listTextGenPresets(path.join(dir, 'nowhere')), []);
    assert.deepEqual(loadPreset(dir, 'ReadyArt Qwen3'), READYART_PRESET);
    assert.equal(loadPreset(dir, 'missing'), null);
    assert.equal(loadPreset(dir, '../secret'), null, 'traversal blocked');
    assert.equal(loadPreset(dir, 'a/b'), null, 'path separators blocked');
});

test('engine applies the assigned preset as per-request samplers and audits it', async () => {
    const card = characterCard('Presetted');
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'preset-powered reply, brand new words' });
    fs.mkdirSync(path.join(h.root, 'TextGen Settings'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'TextGen Settings', 'Spicy.json'), JSON.stringify({ temp: 1.1, min_p: 0.05, nsigma: 1.5, xtc_probability: 0.4, xtc_threshold: 0.1 }));

    const settings = h.store.loadSettings();
    settings.model.preset_by_model = { [settings.model.current]: 'Spicy' };
    h.store.saveSettings(settings);
    h.engine.refreshSettings();

    await h.engine.onInbound({ character: 'Presetted', mes: 'testing presets', source: 'telegram' });

    const req = h.chatReqs[0];
    assert.ok(req?.samplers, 'preset samplers ride on the request');
    assert.equal(req.samplers.temperature, 1.1);
    assert.equal(req.samplers.min_p, 0.05);
    assert.equal(req.samplers.top_n_sigma, 1.5);
    assert.equal(req.samplers.xtc_probability, 0.4);
    assert.equal(req.samplers.xtc_threshold, 0.1);
    assert.ok(h.store.readAudit('Presetted', 50).some((a) => a.kind === 'sent' && /preset: Spicy/.test(a.text)));
});

test('engine without an assignment sends no preset samplers', async () => {
    const card = characterCard('Plain');
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'a perfectly ordinary reply with fresh words' });
    await h.engine.onInbound({ character: 'Plain', mes: 'hi', source: 'telegram' });
    assert.ok(h.chatReqs.length > 0);
    assert.ok(!h.chatReqs[0].samplers, 'no preset override');
});

test('shipped preset files map cleanly (Scarlett card values; Desires full spec)', async () => {
    const { presetToSamplers: map } = await import('../plugin/src/presets.js');
    const repoPresets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
    const read = (f) => JSON.parse(fs.readFileSync(path.join(repoPresets, f), 'utf8'));

    const scarlett = map(read('ReadyArt Dark-Scarlett-27B.json'));
    assert.equal(scarlett.temperature, 1.0);
    assert.equal(scarlett.top_p, 0.92);
    assert.equal(scarlett.top_k, 0);
    assert.equal(scarlett.repeat_penalty, 1);
    assert.equal(scarlett.frequency_penalty, undefined, 'zero penalties map to nothing sent');
    assert.equal(scarlett.presence_penalty, undefined);
    assert.equal(scarlett.top_n_sigma, 0, 'sigma explicitly off — engine default must NOT leak in');
    assert.equal(scarlett.xtc_probability, 0, 'XTC explicitly off');

    const desires = map(read('ReadyArt Dark-Desires.json'));
    assert.equal(desires.temperature, 0.7);
    assert.equal(desires.top_p, 1);
    assert.equal(desires.top_n_sigma, 1.2);
    assert.equal(desires.xtc_probability, 0.33);
    assert.equal(desires.xtc_threshold, 0.05);
});

test('trimToCompleteSentence cuts mid-thought truncation', async () => {
    const { trimToCompleteSentence } = await import('../plugin/src/llm.js');
    assert.equal(trimToCompleteSentence('I keep thinking about the package. It made me feel'), 'I keep thinking about the package.');
    assert.equal(trimToCompleteSentence('Short!'), 'Short!');
    assert.equal(trimToCompleteSentence('no punctuation at all in this one'), 'no punctuation at all in this one', 'too short to cut — kept whole');
});

test('journal prompt demands diary-style thoughts, not message transcription', async () => {
    const { buildJournalPrompt, DIRECTIVES } = await import('../plugin/src/llm.js');
    const p = buildJournalPrompt({ card: { data: { name: 'Hannah' } }, life: { activity: 'in her room', local: { hhmm: '23:10', weekdayName: 'Sunday' } }, userName: 'Sean' });
    assert.ok(/PRIVATE DIARY THOUGHTS/.test(p));
    assert.ok(/never transcribe, quote/.test(p));
    assert.ok(/do not retell events you already texted/.test(p));
    assert.ok(/complete \(subject and verb/.test(p));
    // initiative directive now points at previous messages to break topic loops
    assert.ok(/NEVER bring up a topic or event you already texted/.test(DIRECTIVES.initiative('Sean')));
    assert.ok(/do not repeat what your earlier texts said/.test(DIRECTIVES.followup('Sean')));
});

test('presetsDir prefers the existing ST directory, either generation', async () => {
    const { presetsDir, listTextGenPresets } = await import('../plugin/src/presets.js');
    const dir = tmpUserDir();

    // neither exists -> modern default
    assert.equal(presetsDir(dir), path.join(dir, 'TextGen Settings'));

    // modern dir wins when both exist
    fs.mkdirSync(path.join(dir, 'TextGen Settings'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'textgeneration-settings'), { recursive: true });
    assert.equal(presetsDir(dir), path.join(dir, 'TextGen Settings'));

    // legacy-only install still reads
    const legacy = tmpUserDir();
    fs.mkdirSync(path.join(legacy, 'textgeneration-settings'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'textgeneration-settings', 'Old.json'), '{"temp":0.5}');
    assert.deepEqual(listTextGenPresets(legacy), ['Old']);
});
