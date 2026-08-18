// Autolife card extension schema: defaults + validation.
// Pure module, no dependencies. Shared by the server plugin and the card CLI.

export const SPEC_VERSION = '1.0';
export const EXTENSION_KEY = 'autolife';

export const DEFAULTS = Object.freeze({
    version: SPEC_VERSION,
    timezone: 'UTC',
    schedule: [],
    behavior: {
        quick_reply_chance: 0.5,
        delay_minutes_min: 5,
        delay_minutes_max: 90,
        busy_delay_multiplier: 3.0,
        ignore_chance: 0.05,
        catch_up: true,
        avg_message_length: 'short',
    },
    initiative: {
        enabled: false,
        min_gap_minutes: 120,
        max_per_day: 4,
        followup_on_unread_hours: 6,
    },
    relationship: {
        initial: 20,
    },
    journal: {
        enabled: true,
    },
});

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function checkRange(obj, key, min, max, errors, label) {
    const v = obj?.[key];
    if (v === undefined) return;
    if (!isFiniteNumber(v)) {
        errors.push(`${label}.${key} must be a number (got ${JSON.stringify(v)}).`);
        return;
    }
    if (v < min || v > max) {
        errors.push(`${label}.${key} must be between ${min} and ${max} (got ${v}).`);
    }
}

/** Validate the schedule array in place of `obj.schedule` (missing = valid). */
function validateSchedule(obj, errors) {
    if (obj.schedule === undefined) return;
    if (!Array.isArray(obj.schedule)) {
        errors.push('schedule must be an array of blocks.');
        return;
    }
    obj.schedule.forEach((block, i) => {
        const label = `schedule[${i}]`;
        if (!isPlainObject(block)) {
            errors.push(`${label} must be an object.`);
            return;
        }
        for (const t of ['start', 'end']) {
            const v = block[t];
            if (typeof v !== 'string' || !TIME_RE.test(v)) {
                errors.push(`${label}.${t} must be a "HH:MM" 24h string (got ${JSON.stringify(v)}).`);
            }
        }
        if (block.days !== undefined) {
            if (!Array.isArray(block.days) || block.days.length === 0 || !block.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
                errors.push(`${label}.days must be a non-empty array of integers 0-6 (0=Sunday).`);
            } else if (new Set(block.days).size !== block.days.length) {
                errors.push(`${label}.days must not contain duplicates.`);
            }
        }
        checkRange(block, 'availability', 0, 1, errors, label);
        if (block.activity !== undefined && typeof block.activity !== 'string') {
            errors.push(`${label}.activity must be a string.`);
        }
        if (block.mood !== undefined && block.mood !== null && typeof block.mood !== 'string') {
            errors.push(`${label}.mood must be a string or null.`);
        }
    });
}

/**
 * Validate an `autolife` extension object.
 * @param {unknown} raw
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateAutolife(raw) {
    const errors = [];
    const warnings = [];

    if (raw === undefined || raw === null) {
        return { valid: false, errors: ['autolife extension object is missing.'], warnings };
    }
    if (!isPlainObject(raw)) {
        return { valid: false, errors: ['autolife must be an object.'], warnings };
    }

    if (raw.version !== undefined && typeof raw.version !== 'string') {
        errors.push('version must be a string.');
    } else if (typeof raw.version === 'string' && !/^1\.\d+$/.test(raw.version)) {
        // We target 1.x; reject clearly-foreign versions rather than guessing.
        errors.push(`Unsupported autolife version "${raw.version}" (expected "1.x").`);
    }

    if (raw.timezone !== undefined) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone });
        } catch {
            errors.push(`timezone "${raw.timezone}" is not a valid IANA timezone.`);
        }
    }

    validateSchedule(raw, errors);

    if (raw.behavior !== undefined) {
        if (!isPlainObject(raw.behavior)) {
            errors.push('behavior must be an object.');
        } else {
            const b = raw.behavior;
            checkRange(b, 'quick_reply_chance', 0, 1, errors, 'behavior');
            checkRange(b, 'ignore_chance', 0, 1, errors, 'behavior');
            checkRange(b, 'busy_delay_multiplier', 0.1, 100, errors, 'behavior');
            for (const k of ['delay_minutes_min', 'delay_minutes_max']) {
                checkRange(b, k, 0, 1440, errors, 'behavior');
            }
            if ([b.delay_minutes_min, b.delay_minutes_max].every(isFiniteNumber) && b.delay_minutes_min > b.delay_minutes_max) {
                errors.push('behavior.delay_minutes_min must be <= delay_minutes_max.');
            }
            if (b.catch_up !== undefined && typeof b.catch_up !== 'boolean') {
                errors.push('behavior.catch_up must be a boolean.');
            }
            if (b.avg_message_length !== undefined && !['short', 'medium', 'long'].includes(b.avg_message_length)) {
                errors.push('behavior.avg_message_length must be "short", "medium" or "long".');
            }
        }
    }

    if (raw.initiative !== undefined) {
        if (!isPlainObject(raw.initiative)) {
            errors.push('initiative must be an object.');
        } else {
            const init = raw.initiative;
            if (init.enabled !== undefined && typeof init.enabled !== 'boolean') {
                errors.push('initiative.enabled must be a boolean.');
            }
            checkRange(init, 'min_gap_minutes', 1, 10080, errors, 'initiative');
            checkRange(init, 'max_per_day', 0, 100, errors, 'initiative');
            checkRange(init, 'followup_on_unread_hours', 0, 168, errors, 'initiative');
            if (init.enabled && !(init.min_gap_minutes > 0)) {
                errors.push('initiative.min_gap_minutes must be >= 1 when initiative is enabled.');
            }
        }
    }

    if (raw.relationship !== undefined) {
        if (!isPlainObject(raw.relationship)) {
            errors.push('relationship must be an object.');
        } else {
            checkRange(raw.relationship, 'initial', 0, 100, errors, 'relationship');
        }
    }

    if (raw.journal !== undefined) {
        if (!isPlainObject(raw.journal)) {
            errors.push('journal must be an object.');
        } else if (raw.journal.enabled !== undefined && typeof raw.journal.enabled !== 'boolean') {
            errors.push('journal.enabled must be a boolean.');
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a full parsed character card (CCv2/CCv3 object).
 * @param {unknown} card
 * @returns {{ valid: boolean, errors: string[], warnings: string[], spec: string|null, hasAutolife: boolean }}
 */
export function validateCard(card) {
    const errors = [];
    const warnings = [];
    let spec = null;
    let hasAutolife = false;

    if (!isPlainObject(card)) {
        errors.push('Card must be a JSON object.');
        return { valid: false, errors, warnings, spec, hasAutolife };
    }

    spec = typeof card.spec === 'string' ? card.spec : null;
    if (spec === 'chara_card_v3') {
        if (card.spec_version !== undefined && Number(card.spec_version) < 3) {
            errors.push(`spec_version "${card.spec_version}" does not match spec "chara_card_v3".`);
        }
    } else if (spec === 'chara_card_v2') {
        warnings.push('Card is V2; it imports fine, but new cards should be created as chara_card_v3.');
    } else if (card.name && !card.data) {
        warnings.push('Card looks like V1 (flat, no spec/data fields).');
    } else {
        errors.push(`Card is missing a recognized "spec" field (expected "chara_card_v3" or "chara_card_v2", got ${JSON.stringify(spec)}).`);
    }

    const data = isPlainObject(card.data) ? card.data : card; // tolerate V1 flat cards
    if (!isPlainObject(card.data) && spec) {
        errors.push('Card has a spec field but no "data" object.');
    }
    if (typeof data.name !== 'string' || !data.name.trim()) {
        errors.push('data.name must be a non-empty string.');
    }
    if (typeof data.description !== 'string' || !data.description.trim()) {
        warnings.push('data.description is empty — the model will have almost nothing to work with.');
    }

    const ext = isPlainObject(data.extensions) ? data.extensions : undefined;
    const rawAutolife = ext ? ext[EXTENSION_KEY] : undefined;
    hasAutolife = isPlainObject(rawAutolife);
    if (hasAutolife) {
        const res = validateAutolife(rawAutolife);
        errors.push(...res.errors);
        warnings.push(...res.warnings);
    }

    return { valid: errors.length === 0, errors, warnings, spec, hasAutolife };
}

/**
 * Merge a (possibly partial) autolife object over defaults, in a new object.
 * Unknown keys are preserved. Schedule blocks are also defaulted per-block.
 * @param {object|undefined} raw
 */
export function normalizeAutolife(raw) {
    const d = DEFAULTS;
    const out = { ...d, ...(raw ?? {}) };
    out.behavior = { ...d.behavior, ...(raw?.behavior ?? {}) };
    out.initiative = { ...d.initiative, ...(raw?.initiative ?? {}) };
    out.relationship = { ...d.relationship, ...(raw?.relationship ?? {}) };
    out.journal = { ...d.journal, ...(raw?.journal ?? {}) };
    out.schedule = (Array.isArray(out.schedule) ? out.schedule : []).map((b) => ({
        days: b.days ?? [0, 1, 2, 3, 4, 5, 6],
        availability: b.availability ?? 0.5,
        activity: b.activity ?? 'busy',
        mood: b.mood ?? null,
        start: b.start,
        end: b.end,
    }));
    return out;
}
