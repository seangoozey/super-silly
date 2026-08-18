#!/usr/bin/env node
// dump-prompt: render the EXACT prompt the Autolife engine would build for a
// character, using the same code path (llm.js). For auditing what the model
// actually sees.
//
//   node tools/dump-prompt.mjs cards/examples/maya.json
//   node tools/dump-prompt.mjs cards/examples/maya.json --kind initiative \
//        --time 2026-08-17T22:00:00Z --relationship 62 \
//        --journal "finished the client logo, feels good|gym was brutal today" \
//        --history "you: pizza tonight?|Maya: YES"

import fs from 'node:fs';
import { normalizeAutolife } from '../plugin/src/autolife-schema.js';
import { evaluate } from '../plugin/src/schedule.js';
import { buildSystemPrompt, buildChatMessages, NUM_PREDICT } from '../plugin/src/llm.js';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
    console.log('Usage: dump-prompt.mjs <card.json|card.png> [--time ISO] [--kind reply|initiative|followup|catchup] [--relationship N] [--journal "a|b"] [--history "you: x|Name: y"]');
    process.exit(1);
}

const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const card = file.endsWith('.json')
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : (await import('../plugin/src/card-io.js')).extractCardFromPng(fs.readFileSync(file)).card;

const data = card.data ?? card;
const autolife = normalizeAutolife(data.extensions?.autolife ?? {});
const now = new Date(flag('--time', new Date().toISOString()));
const life = evaluate(autolife, now);
const relationship = Number(flag('--relationship', autolife.relationship?.initial ?? 20));
const journal = String(flag('--journal', '')).split('|').filter(Boolean).map((text) => ({ ts: now.toISOString(), text }));
const history = String(flag('--history', '')).split('|').filter(Boolean).map((chunk) => {
    const sep = chunk.indexOf(':');
    const name = chunk.slice(0, sep).trim();
    return { name, is_user: /^you$/i.test(name), mes: chunk.slice(sep + 1).trim() };
});
const kind = flag('--kind', 'reply');

const system = buildSystemPrompt({
    card,
    autolife,
    life,
    relationshipScore: relationship,
    journal,
    userName: 'User',
});
const messages = buildChatMessages({ system, history, characterName: data.name, userName: 'User', kind });

console.log('=== life context used ===');
console.log(`local time: ${life.local.weekdayName} ${life.local.hhmm} (${autolife.timezone})`);
console.log(`activity:   ${life.activity}`);
console.log(`availability: ${life.availability} | mood: ${life.mood ?? '—'}`);
console.log(`num_predict: ${NUM_PREDICT[autolife.behavior?.avg_message_length ?? 'short']} | temperature: 0.9\n`);

for (const m of messages) {
    console.log(`--- [${m.role}] ---`);
    console.log(m.content);
}
