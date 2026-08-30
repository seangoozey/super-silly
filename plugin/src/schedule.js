// Schedule evaluation + delay sampling. Pure functions, injectable RNG/time.

/**
 * Local time parts of `date` inside `timeZone`.
 * @returns {{ weekday: number (0=Sunday), minutes: number, hhmm: "HH:MM", dateKey: "YYYY-MM-DD" }}
 */
export function localParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const hour = Number(parts.hour) % 24; // hour can be "24" with hour12:false in some locales
    const minute = Number(parts.minute);
    const weekday = weekdayMap[parts.weekday];
    const h12 = ((hour + 11) % 12) + 1;
    return {
        weekday,
        weekdayName: weekdayNames[weekday],
        minutes: hour * 60 + minute,
        hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        // unambiguous for the model: "10:30pm" can't be misread as morning
        hhmm12: `${h12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`,
        dateShort: `${Number(parts.month)}/${Number(parts.day)}/${String(parts.year).slice(2)}`,
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

export function parseHHMM(s) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

/** "14:05" -> "2:05pm" for prompt-facing labels. */
export function label12(hhmm) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''));
    if (!m) return String(hhmm ?? '');
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Resolve the character's life context at a point in time.
 * @param {{ timezone?: string, schedule?: Array }} autolife normalized autolife config
 * @param {Date} date
 * @returns {{ activity: string, availability: number, mood: string|null, blockIndex: number, isAsleep: boolean, local: object }}
 */
export function evaluate(autolife, date) {
    const tz = autolife.timezone || 'UTC';
    const local = localParts(date, tz);
    const blocks = Array.isArray(autolife.schedule) ? autolife.schedule : [];

    const FREE = { activity: 'free with spare time', availability: 0.8, mood: null, blockIndex: -1 };

    let winner = null;
    for (let i = 0; i < blocks.length && !winner; i++) {
        const block = blocks[i];
        const start = parseHHMM(block.start);
        const end = parseHHMM(block.end);
        if (start === null || end === null) continue;

        const days = Array.isArray(block.days) && block.days.length ? block.days : [0, 1, 2, 3, 4, 5, 6];
        if (start === end) {
            // whole-day block
            if (days.includes(local.weekday)) winner = { block, i };
        } else if (start < end) {
            if (days.includes(local.weekday) && local.minutes >= start && local.minutes < end) {
                winner = { block, i };
            }
        } else {
            // wraps midnight: [start..24h) on start day, [0..end) the next morning
            const afterStartToday = days.includes(local.weekday) && local.minutes >= start;
            const earlyMorning = local.minutes < end && days.includes((local.weekday + 6) % 7);
            if (afterStartToday || earlyMorning) winner = { block, i };
        }
    }

    const ctx = winner
        ? {
            activity: winner.block.activity ?? 'busy',
            availability: clamp01(winner.block.availability ?? 0.5),
            mood: winner.block.mood ?? null,
            blockIndex: winner.i,
        }
        : FREE;

    return {
        ...ctx,
        isAsleep: ctx.availability < 0.05,
        local,
    };
}

export function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

/**
 * Sample a reply delay in minutes per the behavior model.
 * @param {{ behavior?: object }} autolife
 * @param {{ availability: number }} lifeCtx current life context
 * @param {{ float: () => number, int: (min:number,max:number)=>number }} rng
 * @returns {number} minutes (may be fractional)
 */
export function sampleDelayMinutes(autolife, lifeCtx, rng) {
    const b = autolife.behavior;
    const min = Number.isFinite(b.delay_minutes_min) ? b.delay_minutes_min : 5;
    const max = Number.isFinite(b.delay_minutes_max) ? b.delay_minutes_max : 90;
    let minutes = min + rng.float() * Math.max(0, max - min);
    const busy = (lifeCtx.availability ?? 0.8) < 0.35;
    if (busy) {
        minutes *= Number.isFinite(b.busy_delay_multiplier) ? b.busy_delay_multiplier : 3;
    }
    return Math.min(minutes, 24 * 60);
}

/** Relationship score -> descriptor fed to the model. */
export function relationshipDescriptor(score) {
    if (score < 20) return 'distant — you barely know each other';
    if (score < 40) return 'friendly';
    if (score < 60) return 'close';
    if (score < 80) return 'very close';
    return 'deeply bonded';
}
