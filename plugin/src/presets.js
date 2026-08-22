// SillyTavern text-completion preset consumption — read-only.
//
// ST's presets are plain JSON in data/<user>/textgeneration-settings/ (the
// ReadyArt sampler specs ARE this format), edited/imported by ST's own preset
// manager. Autolife never writes there: the dashboard and /model preset only
// assign preset NAMES to models in our own settings, and the engine maps the
// fields onto backend sampler requests at generation time.

import fs from 'node:fs';
import path from 'node:path';

export function presetsDir(userDir) {
    return path.join(userDir, 'textgeneration-settings');
}

/** Preset names (filenames minus .json). Empty when the dir doesn't exist. */
export function listTextGenPresets(userDir) {
    try {
        return fs.readdirSync(presetsDir(userDir))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

/** Load one preset by name; null when missing or when the name tries to escape the dir. */
export function loadPreset(userDir, name) {
    if (!name || typeof name !== 'string' || name.includes('..') || /[\\/]/.test(name)) return null;
    const dir = presetsDir(userDir);
    const file = path.join(dir, `${name}.json`);
    if (path.dirname(file) !== dir) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Map an ST textgen preset onto our sampler set. ST presets use
 * textgeneration-webui field names; both spellings are accepted where they
 * vary (temp/temperature, rep_pen/repeat_penalty, nsigma/top_n_sigma).
 * Only keys present in the preset are returned — the client merges them
 * over the engine defaults, so a sparse preset keeps current behavior.
 *
 * Deliberately NOT mapped: seed (deterministic replies invite verbatim
 * recitation), max_length/n_ctx (a preset's 32k budget would OOM a 24GB
 * card), and the sampler-order/dynatemp knobs the backends don't share.
 */
export function presetToSamplers(preset) {
    const p = preset ?? {};
    const pick = (...keys) => {
        for (const k of keys) {
            const v = p[k];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        }
        return null;
    };
    const out = {};
    const set = (key, v) => { if (v !== null) out[key] = v; };
    const penalty = (v) => (v === null || v === 0 ? null : Math.max(-2, Math.min(2, v)));
    set('temperature', pick('temp', 'temperature'));
    set('top_p', pick('top_p'));
    set('top_k', pick('top_k'));
    set('min_p', pick('min_p'));
    set('repeat_penalty', pick('rep_pen', 'repeat_penalty'));
    set('frequency_penalty', penalty(pick('freq_pen', 'frequency_penalty')));
    set('presence_penalty', penalty(pick('presence_pen', 'presence_penalty')));
    set('top_n_sigma', pick('nsigma', 'top_n_sigma'));
    set('xtc_probability', pick('xtc_probability'));
    set('xtc_threshold', pick('xtc_threshold'));
    return out;
}
