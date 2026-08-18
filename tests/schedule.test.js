import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, localParts, sampleDelayMinutes, relationshipDescriptor, parseHHMM } from '../plugin/src/schedule.js';
import { normalizeAutolife, validateAutolife, validateCard } from '../plugin/src/autolife-schema.js';

// 2026-01-15 is a Thursday. America/New_York is EST (UTC-5) in January.
const thu = (h, m) => new Date(Date.UTC(2026, 0, 15, h + 5, m)); // local Thu h:m

const card = normalizeAutolife({
    timezone: 'America/New_York',
    schedule: [
        { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', activity: 'at work', availability: 0.2, mood: 'focused' },
        { days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '07:00', activity: 'asleep', availability: 0.02 },
        { days: [1, 3], start: '19:00', end: '21:00', activity: 'at the gym', availability: 0.1, mood: 'in the zone' },
        { days: [0, 6], start: '22:00', end: '02:00', activity: 'out with friends', availability: 0.5 },
    ],
});

test('localParts resolves weekday/hours in the card timezone', () => {
    const p = localParts(new Date(Date.UTC(2026, 0, 15, 20, 5)), 'America/New_York'); // 15:05 local
    assert.equal(p.weekday, 4);
    assert.equal(p.hhmm, '15:05');
    assert.equal(p.weekdayName, 'Thursday');
});

test('evaluate: weekday work hours are busy', () => {
    const life = evaluate(card, thu(10, 0));
    assert.equal(life.activity, 'at work');
    assert.equal(life.availability, 0.2);
    assert.equal(life.mood, 'focused');
    assert.equal(life.isAsleep, false);
});

test('evaluate: weekend afternoon is free', () => {
    const sat = new Date(Date.UTC(2026, 0, 17, 18, 0)); // Sat 13:00 local
    const life = evaluate(card, sat);
    assert.equal(life.blockIndex, -1);
    assert.equal(life.activity, 'free with spare time');
    assert.equal(life.availability, 0.8);
});

test('evaluate: sleep block covers 3am', () => {
    const life = evaluate(card, thu(3, 0));
    assert.equal(life.activity, 'asleep');
    assert.equal(life.isAsleep, true);
});

test('evaluate: overnight block (22:00-02:00) matches both sides of midnight', () => {
    // 2026-01-17 is a Saturday; EST = UTC-5
    const sat23 = evaluate(card, new Date(Date.UTC(2026, 0, 18, 4, 0))); // Sat 23:00 local
    assert.equal(sat23.activity, 'out with friends');
    const sun0030 = evaluate(card, new Date(Date.UTC(2026, 0, 18, 5, 30))); // Sun 00:30 local
    assert.equal(sun0030.activity, 'out with friends');
    // the overnight block ends at 02:00; Monday 02:30 falls through to the sleep block
    const mon0230 = evaluate(card, new Date(Date.UTC(2026, 0, 19, 7, 30))); // Mon 02:30 local
    assert.equal(mon0230.activity, 'asleep');
});

test('evaluate: first match wins (work over sleep ordering)', () => {
    const overlapping = normalizeAutolife({
        timezone: 'UTC',
        schedule: [
            { days: [1], start: '00:00', end: '23:59', activity: 'all-day block A', availability: 0.9 },
            { days: [1], start: '10:00', end: '12:00', activity: 'block B', availability: 0.1 },
        ],
    });
    const monday = new Date(Date.UTC(2026, 0, 19, 11, 0));
    assert.equal(evaluate(overlapping, monday).activity, 'all-day block A');
});

test('sampleDelayMinutes respects min/max and busy multiplier', () => {
    const rng = { float: () => 0.5 }; // midpoint
    const freeCtx = { availability: 0.8 };
    const busyCtx = { availability: 0.1 };
    const b = { behavior: { delay_minutes_min: 10, delay_minutes_max: 30, busy_delay_multiplier: 3 } };
    assert.equal(sampleDelayMinutes(b, freeCtx, rng), 20);
    assert.equal(sampleDelayMinutes(b, busyCtx, rng), 60);
});

test('parseHHMM rejects garbage', () => {
    assert.equal(parseHHMM('25:00'), null);
    assert.equal(parseHHMM('9:5'), null);
    assert.equal(parseHHMM('09:05'), 545);
});

test('relationshipDescriptor buckets', () => {
    assert.match(relationshipDescriptor(5), /distant/);
    assert.match(relationshipDescriptor(30), /friendly/);
    assert.match(relationshipDescriptor(50), /close/);
    assert.match(relationshipDescriptor(70), /very close/);
    assert.match(relationshipDescriptor(90), /deeply bonded/);
});

// ---------------------------------------------------------------- schema

test('validateAutolife catches bad timezone, days, ranges', () => {
    const res = validateAutolife({
        version: '1.0',
        timezone: 'Not/AZone',
        schedule: [
            { days: [1, 1], start: 'banana', end: '17:00' },
            { days: [9], start: '09:00', end: '17:00', availability: 2 },
        ],
        behavior: { quick_reply_chance: 5, delay_minutes_min: 90, delay_minutes_max: 10 },
        initiative: { enabled: true, min_gap_minutes: 0 },
        relationship: { initial: 200 },
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('timezone')));
    assert.ok(res.errors.some((e) => e.includes('duplicates')));
    assert.ok(res.errors.some((e) => e.includes('start')));
    assert.ok(res.errors.some((e) => e.includes('days')));
    assert.ok(res.errors.some((e) => e.includes('availability')));
    assert.ok(res.errors.some((e) => e.includes('quick_reply_chance')));
    assert.ok(res.errors.some((e) => e.includes('min <= delay_minutes_max') || e.includes('min must be <= delay_minutes_max')));
    assert.ok(res.errors.some((e) => e.includes('min_gap_minutes')));
    assert.ok(res.errors.some((e) => e.includes('initial')));
});

test('validateAutolife rejects unknown major version', () => {
    assert.equal(validateAutolife({ version: '2.0' }).valid, false);
    assert.equal(validateAutolife({ version: '1.1' }).valid, true);
});

test('validateCard accepts a valid CCv3 card with autolife and flags one without', () => {
    const good = validateCard({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: 'X', description: 'd', extensions: { autolife: { version: '1.0' } } },
    });
    assert.equal(good.valid, true);
    assert.equal(good.hasAutolife, true);

    const noSpec = validateCard({ data: { name: 'X' } });
    assert.equal(noSpec.valid, false);

    const v2 = validateCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'X', description: 'd' } });
    assert.equal(v2.valid, true);
    assert.equal(v2.warnings.length, 1);
});
