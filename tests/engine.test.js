import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../plugin/src/engine.js';
import { CardRegistry } from '../plugin/src/cards.js';
import { StateStore } from '../plugin/src/state.js';
import { ChatStore } from '../plugin/src/chat-store.js';
import { MemoryStore, messageKey } from '../plugin/src/memory.js';
import { normalizeAutolife } from '../plugin/src/autolife-schema.js';
import { makeRng, characterCard, buildHarness, stateOf } from './helpers.js';


async function lastCharMessage(chatStore, character, state) {
    const msgs = chatStore.readMessages(character, state.chatFile);
    return [...msgs].reverse().find((m) => !m.is_user) ?? null;
}


// 2026-01-15 14:00 UTC — Thursday afternoon, character is FREE per card above.

test('inbound quick reply: decides, generates, writes chat, delivers', async () => {
    const card = characterCard('Quinn');
    const rngValues = [0.99, 0.0]; // ignore roll fails, quick roll passes
    const h = buildHarness({ card, rngValues });

    await h.engine.onInbound({ character: 'Quinn', mes: 'wanna get pizza tonight?', source: 'telegram' });

    const state = stateOf(h.store, 'Quinn');
    assert.ok(state.chatFile, 'chat created');
    const msgs = h.chatStore.readMessages('Quinn', state.chatFile);
    // greeting + user msg + char reply
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].is_user, false);
    assert.equal(msgs[1].mes, 'wanna get pizza tonight?');
    assert.equal(msgs[1].is_user, true);
    assert.equal(msgs[2].mes, 'totally, what time?');
    assert.equal(msgs[2].extra.autolife_kind, 'reply');
    assert.ok(msgs[2].send_date);
    assert.deepEqual(h.delivered, [{ character: 'Quinn', text: 'totally, what time?' }]);
    assert.ok(h.composing.includes('Quinn'));
    // relationship went up (+1 message, +2 not applicable)
    assert.equal(state.relationship, 21);
});

test('inbound while busy: delayed reply fires on a later tick', async () => {
    const card = characterCard('Delia');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0)); // Thu 10:00 UTC — free per card
    const rngValues = [0.99, 0.99]; // no ignore, no quick -> delayed
    const h = buildHarness({ card, now: start, rngValues });

    await h.engine.onInbound({ character: 'Delia', mes: 'you there?', source: 'telegram' });
    let state = stateOf(h.store, 'Delia');
    assert.ok(state.pendingReply, 'reply scheduled');
    assert.equal(h.delivered.length, 0);

    // a second inbound while pending must not re-roll
    await h.engine.onInbound({ character: 'Delia', mes: 'hello??', source: 'telegram' });
    state = stateOf(h.store, 'Delia');
    assert.ok(state.pendingReply);

    // advance clock 5 hours and tick — pending reply fires
    h.clock.now = new Date(start.getTime() + 5 * 3600_000);
    await h.engine.tick(h.clock.now);
    state = stateOf(h.store, 'Delia');
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 1);
    const msgs = h.chatStore.readMessages('Delia', state.chatFile);
    assert.equal(msgs.filter((m) => !m.is_user).length, 2); // greeting + reply
});

test('inbound ignored at low-probability roll: no reply, catch-up later', async () => {
    const card = characterCard('Ivy');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0));
    const h = buildHarness({ card, now: start, rngValues: [0.0] }); // ignore roll passes
    await h.engine.onInbound({ character: 'Ivy', mes: 'ping', source: 'telegram' });

    let state = stateOf(h.store, 'Ivy');
    assert.ok(state.ignoredAt);
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 0);

    // ticks soon after: no catch-up yet (<45 min), journal/initiative disabled by default rng
    await h.engine.tick(new Date(start.getTime() + 30 * 60_000));
    assert.equal(h.delivered.length, 0);

    // after 90 minutes (free): catch-up fires
    await h.engine.tick(new Date(start.getTime() + 90 * 60_000));
    state = stateOf(h.store, 'Ivy');
    assert.equal(state.ignoredAt, null);
    assert.equal(h.delivered.length, 1);
});

test('initiative: fires when enabled, respects max_per_day and sleep', async () => {
    const card = characterCard('Rico', { initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 1, followup_on_unread_hours: 0 } });
    const start = new Date(Date.UTC(2026, 0, 15, 12, 0)); // free time
    const h = buildHarness({ card, now: start, rngValues: [0.0] }); // initiative roll passes
    // she has material: a fresh journal thought (the gate demands something to say)
    const st0 = stateOf(h.store, 'Rico');
    st0.lastJournalAt = new Date(start.getTime() - 60_000).toISOString();
    h.store.saveState(st0);

    await h.engine.tick(start);
    let state = stateOf(h.store, 'Rico');
    assert.equal(h.delivered.length, 1, 'initiative message sent');
    assert.ok(state.lastInitiativeAt);
    assert.equal(state.initiativeDay.count, 1);

    // another tick same day: max_per_day = 1 blocks further initiative
    const rng2 = makeRng([0.0]);
    h.engine.rng = rng2;
    await h.engine.tick(new Date(start.getTime() + 3 * 3600_000));
    state = stateOf(h.store, 'Rico');
    assert.equal(state.initiativeDay.count, 1);
    assert.equal(h.delivered.length, 1);

    // at 04:00 UTC the character is asleep — no initiative even with a passing roll
    h.engine.rng = makeRng([0.0]);
    const nextDay = new Date(Date.UTC(2026, 0, 16, 4, 0));
    await h.engine.tick(nextDay);
    state = stateOf(h.store, 'Rico');
    assert.equal(state.initiativeDay.count, 1, 'still blocked by daily cap');
});

test('memory RAG: old texts get recalled into reply prompts', async () => {
    const card = characterCard('Remmy');
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'on it' });

    // an "old" message from weeks ago, already in the memory index
    const oldText = 'we finally booked the italy flights for the spring trip';
    const oldTs = '2026-07-01T12:00:00.000Z';
    h.memory.append('Remmy', {
        ts: oldTs,
        role: 'user',
        text: oldText,
        vec: await Promise.resolve(fakeVec('italy italy italy')),
        chatFile: 'old.jsonl',
        key: messageKey(oldTs, 'user', oldText),
    }, 'nomic-embed-text');

    // the fake ollama embeds with italy/pizza/work dims; the harness ollama
    // uses the same scheme, so a new message about italy retrieves the old one
    function fakeVec(text) {
        const t = String(text).toLowerCase();
        const v = [(t.match(/italy/g) ?? []).length, (t.match(/pizza/g) ?? []).length, (t.match(/work/g) ?? []).length];
        const n = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
        return v.map((x) => x / n);
    }

    await h.engine.onInbound({ character: 'Remmy', mes: 'hey did we ever finish the italy itinerary?', source: 'telegram' });

    // reply generated; the last chat call should contain a system message with the old text
    assert.ok(h.chatCalls.length >= 1);
    const lastCall = h.chatCalls[h.chatCalls.length - 1];
    const memMsg = lastCall.find((m) => m.role === 'system' && m.content.includes('your own memories'));
    assert.ok(memMsg, 'memory context block present in prompt');
    assert.ok(memMsg.content.includes('italy flights'));
    // and the recall was audited
    assert.ok(h.store.readAudit('Remmy', 50).some((a) => a.kind === 'memory' && /recalled 1 older text/.test(a.text)));
    // both the old user message and the new exchange got indexed
    assert.ok(h.memory.count('Remmy', 'nomic-embed-text') >= 3);
});

test('applyBootPolicy stops everyone on server start (unless disabled)', async () => {
    const card = characterCard('Boota');
    const h = buildHarness({ card });
    let state = stateOf(h.store, 'Boota');
    state.enabled = true;
    h.store.saveState(state);

    const stopped = h.engine.applyBootPolicy();
    assert.equal(stopped, 1);
    state = stateOf(h.store, 'Boota');
    assert.equal(state.enabled, false);

    // policy off -> characters keep running across restarts
    h.engine.settings.engine.start_stopped = false;
    state.enabled = true;
    h.store.saveState(state);
    assert.equal(h.engine.applyBootPolicy(), 0);
    assert.equal(stateOf(h.store, 'Boota').enabled, true);
});

test('persona name resolves from ST default persona setting', async () => {
    const card = characterCard('Perseus');
    const h = buildHarness({ card });
    // no chats, but settings.json declares the default persona
    fs.writeFileSync(
        path.join(h.root, 'settings.json'),
        JSON.stringify({ power_user: { default_persona: 'Sean.png' } }),
    );
    assert.equal(h.chatStore.resolveUserName(), 'Sean');
    h.engine.refreshSettings();
    assert.equal(h.chatStore.userName, 'Sean');
});

test('single persona file resolves even without settings or chats', async () => {
    const card = characterCard('Loner');
    const h = buildHarness({ card });
    fs.mkdirSync(path.join(h.root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'personas', 'Sean.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Sean' } }));
    assert.equal(h.chatStore.resolveUserName(), 'Sean');
});

test('persona name resolves from SillyTavern chat headers, not the placeholder', async () => {
    const card = characterCard('Namer');
    const h = buildHarness({ card });
    // engine-created chats carry the default 'User' — resolution must skip those
    await h.engine.onInbound({ character: 'Namer', mes: 'hello', source: 'telegram' });

    // a web-style chat written by ST itself with the real persona name
    const chatDir = h.chatStore.chatDir('Namer');
    const webChat = `${chatDir}${path.sep}web.jsonl`.split(path.sep).join(path.sep);
    h.chatStore.appendMessage('Namer', 'web.jsonl', h.chatStore.userMessage('hi', new Date()));
    // rewrite that file's header to look like an ST-authored chat with persona 'Sean'
    const full = path.join(chatDir, 'web.jsonl');
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines[0] = JSON.stringify({ chat_metadata: {}, user_name: 'Sean', character_name: 'Namer' });
    fs.writeFileSync(full, lines.join('\n'), 'utf8');

    assert.equal(h.chatStore.resolveUserName(), 'Sean');
    h.engine.refreshSettings();
    assert.equal(h.chatStore.userName, 'Sean');
});

test('web inbound messages mirror to telegram with You: prefix; telegram does not', async () => {
    const card = characterCard('Mirra');
    const h = buildHarness({ card, rngValues: [0.99, 0.99] }); // -> delayed, no reply yet
    await h.engine.onInbound({ character: 'Mirra', mes: 'see you friday', source: 'web' });
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].text, 'You: see you friday');
    assert.equal(h.delivered[0].character, 'Mirra');

    const before = h.delivered.length;
    await h.engine.onInbound({ character: 'Mirra', mes: 'from telegram', source: 'telegram' });
    assert.equal(h.delivered.length, before, 'telegram-source inbound is not mirrored back');
});

test('bindings are scoped per bot with legacy flat migration', async () => {
    const card = characterCard('Bindy');
    const h = buildHarness({ card });
    // legacy flat bindings file -> treated as the default bot
    fs.writeFileSync(path.join(h.root, 'autolife', 'bindings.json'), JSON.stringify({ '111': { character: 'Bindy', chatFile: 'a.jsonl' } }));
    assert.deepEqual(h.store.loadBindings('default'), { '111': { character: 'Bindy', chatFile: 'a.jsonl' } });
    assert.deepEqual(h.store.loadBindings('maya'), {});

    // per-bot saves don't leak into each other
    h.store.saveBindings('maya', { '222': { character: 'Bindy', chatFile: 'b.jsonl' } });
    assert.ok(h.store.loadBindings('default')['111']);
    assert.ok(h.store.loadBindings('maya')['222']);
    const all = h.store.allBindings();
    assert.ok(all['default:111'] && all['maya:222']);
    assert.equal(all['maya:222'].bot, 'maya');
});

test('AUTOLIFE_START_STOPPED env overrides the boot policy', async () => {
    const card = characterCard('Envira');
    const h = buildHarness({ card });
    let state = stateOf(h.store, 'Envira');
    state.enabled = true;
    h.store.saveState(state);

    process.env.AUTOLIFE_START_STOPPED = 'false';
    try {
        assert.equal(h.engine.applyBootPolicy(), 0, 'env false keeps characters running');
        assert.equal(stateOf(h.store, 'Envira').enabled, true);

        process.env.AUTOLIFE_START_STOPPED = 'true';
        h.engine.settings.engine.start_stopped = false; // even with the setting off
        assert.equal(h.engine.applyBootPolicy(), 1, 'env true forces stop');
        assert.equal(stateOf(h.store, 'Envira').enabled, false);
    } finally {
        delete process.env.AUTOLIFE_START_STOPPED;
    }
});

test('bursts: {follow-up} marker produces multiple texts and chat messages (opt-in)', async () => {
    const card = characterCard('Bursty');
    const replies = ['hey, guess what {follow-up}', 'i got the job!!'];
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: replies });
    const s0 = h.store.loadSettings();
    s0.engine = { ...s0.engine, followup_bursts: true };
    h.store.saveSettings(s0);
    h.engine.refreshSettings();
    await h.engine.onInbound({ character: 'Bursty', mes: '??', source: 'telegram' });

    const state = stateOf(h.store, 'Bursty');
    const msgs = h.chatStore.readMessages('Bursty', state.chatFile);
    const charMsgs = msgs.filter((m) => !m.is_user);
    // greeting + two burst texts as separate messages
    assert.equal(charMsgs.length, 3);
    assert.equal(charMsgs[1].mes, 'hey, guess what');
    assert.equal(charMsgs[2].mes, 'i got the job!!');
    // delivered as two paced texts
    assert.deepEqual(h.delivered.map((d) => d.text.replace(/^You: /, '')), ['hey, guess what', 'i got the job!!']);
    // audit notes the burst
    assert.ok(h.store.readAudit('Bursty', 50).some((a) => a.kind === 'sent' && /2 texts/.test(a.text)));
});

test('echoed user words are rejected and retried, not delivered', async () => {
    const card = characterCard('Echoe');
    const replies = ['>hey did we ever finish the italy itinerary?', 'sounds amazing, booked for june!'];
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: replies });
    await h.engine.onInbound({ character: 'Echoe', mes: 'hey did we ever finish the italy itinerary?', source: 'telegram' });

    // the echo was retried away: only the real reply delivered
    assert.equal(h.delivered.filter((d) => !d.text.startsWith('You:')).length, 1);
    assert.ok(!h.delivered.some((d) => d.text.includes('italy itinerary')));
    const state = stateOf(h.store, 'Echoe');
    const msgs = h.chatStore.readMessages('Echoe', state.chatFile).filter((m) => !m.is_user);
    assert.ok(!msgs.some((m) => m.mes.includes('italy itinerary')));
});

test('parroted prompt scaffolding is stripped before delivery', async () => {
    const card = characterCard('Leaky');
    // a fine reply with the memory-block header rambling after it (observed
    // Hannah failure: [SYSTEM_PROMPT] + verbatim memory header + fabricated
    // entries, truncated mid-ramble by the token cap)
    const reply = 'omg i had the best day [SYSTEM_PROMPT]Texts from earlier in your history with Sean (your own memories of past exchanges — respond to them if relevant; NEVER quote, repeat, or recite them back): [Aug 22] Hannah: can i do that?[Aug 22';
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply });
    await h.engine.onInbound({ character: 'Leaky', mes: 'how was your day?', source: 'telegram' });

    // the clean prefix is delivered; none of the scaffolding escapes
    const sent = h.delivered.filter((d) => !d.text.startsWith('You:'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'omg i had the best day');
    assert.ok(!sent.some((d) => d.text.includes('SYSTEM_PROMPT') || d.text.includes('Texts from earlier')));
    const state = stateOf(h.store, 'Leaky');
    const msgs = h.chatStore.readMessages('Leaky', state.chatFile).filter((m) => !m.is_user);
    assert.ok(!msgs.some((m) => m.mes.includes('SYSTEM_PROMPT') || m.mes.includes('Texts from earlier')));
    // and the cut is visible in the audit log
    assert.ok(h.store.readAudit('Leaky', 50).some((a) => a.kind === 'leak_blocked' && /stripped/.test(a.text)));
});

test('verbatim self-recitation is rejected and regenerated, not delivered twice', async () => {
    const card = characterCard('Repeaty');
    const first = 'just got home from the studio, what are you up to tonight?';
    // second inbound: the model resends the earlier text word-for-word, then
    // produces something new on the retry
    // rng order per inbound: ignore-roll, quick-roll (bursts are off by
    // default now, so no probe roll) — the second inbound starts at value 3
    const h = buildHarness({ card, rngValues: [0.99, 0.0, 0.99, 0.0], reply: [first, first, 'wait, movie night instead? i am picking the film'] });
    await h.engine.onInbound({ character: 'Repeaty', mes: 'hey you', source: 'telegram' });
    await h.engine.onInbound({ character: 'Repeaty', mes: 'still there?', source: 'telegram' });

    const sent = h.delivered.filter((d) => !d.text.startsWith('You:'));
    assert.equal(sent.filter((d) => d.text === first).length, 1, 'the original text is delivered exactly once');
    assert.ok(sent.some((d) => d.text === 'wait, movie night instead? i am picking the film'), 'the regenerated reply is delivered');
    const state = stateOf(h.store, 'Repeaty');
    const msgs = h.chatStore.readMessages('Repeaty', state.chatFile).filter((m) => !m.is_user);
    assert.equal(msgs.filter((m) => m.mes === first).length, 1, 'the recitation never lands in the chat');
    assert.ok(h.store.readAudit('Repeaty', 50).some((a) => a.kind === 'repeat_blocked' && /recited/.test(a.text)));
});

test('evolve: reflection lands pending, approval injects into prompts', async () => {
    const card = characterCard('Grower', { evolve: { enabled: true } });
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'I have gotten far more sarcastic with you.' });
    await h.engine.reflectNow('Grower');

    let notes = h.engine.evolveNotes('Grower');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].status, 'pending', 'default requires approval');

    // pending notes do NOT shape prompts
    await h.engine.onInbound({ character: 'Grower', mes: 'hey', source: 'telegram' });
    const sysMsg = h.chatCalls[h.chatCalls.length - 1].find((m) => m.role === 'system');
    assert.ok(!sysMsg.content.includes('more sarcastic'), 'pending note not injected');

    h.engine.decideNote('Grower', notes[0].ts, 'approve');
    notes = h.engine.evolveNotes('Grower');
    assert.equal(notes[0].status, 'approved');
    assert.ok(h.store.readAudit('Grower', 50).some((a) => a.kind === 'evolve' && /approved/.test(a.text)));
});

test('evolve: auto_apply approves immediately and shapes the next prompt', async () => {
    const card = characterCard('Auto', { evolve: { enabled: true, auto_apply: true } });
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'I trust you more than I used to.' });
    await h.engine.reflectNow('Auto');
    assert.equal(h.engine.evolveNotes('Auto')[0].status, 'approved');

    await h.engine.onInbound({ character: 'Auto', mes: 'hello again', source: 'telegram' });
    const sysMsg = h.chatCalls[h.chatCalls.length - 1].find((m) => m.role === 'system');
    assert.ok(sysMsg.content.includes("How you've changed"), 'approved note injected');
    assert.ok(sysMsg.content.includes('trust you more'));
});

test('purge resets state to card seed and clears the memory index', async () => {
    const card = characterCard('Purgy', { relationship: { initial: 55 }, initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 1, followup_on_unread_hours: 0 } });
    const h = buildHarness({ card, rngValues: [0.99, 0.0] });

    // build up state: messages, memory entries, relationship growth, journal
    await h.engine.onInbound({ character: 'Purgy', mes: 'hello there old friend', source: 'telegram' });
    let st = stateOf(h.store, 'Purgy');
    assert.ok(st.relationship > 55, 'relationship grew');
    assert.ok(h.memory.count('Purgy', 'nomic-embed-text') >= 2, 'memory index populated');
    st.journal = [{ ts: new Date().toISOString(), text: 'secret note' }];
    st.lastUserMessageAt = new Date().toISOString();
    h.store.saveState(st);

    await h.engine.purgeCharacter('Purgy');

    // read through the engine's seeding path (card initial 55, not the helper's 20)
    st = h.store.loadState('Purgy', { initialRelationship: 55 });
    assert.equal(st.relationship, 55, 'relationship reset to card seed');
    assert.equal(st.enabled, true, 're-created live');
    assert.equal(st.journal.length, 0, 'journal wiped');
    assert.equal(st.lastUserMessageAt, null, 'timestamps wiped');
    assert.equal(h.memory.count('Purgy', 'nomic-embed-text'), 0, 'memory index wiped');
    assert.ok(h.store.readAudit('Purgy', 50).some((a) => a.kind === 'purged'));
});

test('full reset archives chats: post-purge prompts contain no old conversation', async () => {
    const card = characterCard('Fresher');
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'totally, what time?' });
    await h.engine.onInbound({ character: 'Fresher', mes: 'the codeword is pineapple', source: 'telegram' });
    let st = h.store.loadState('Fresher', { initialRelationship: 20 });
    const oldChat = st.chatFile;
    assert.ok(oldChat);

    await h.engine.purgeCharacter('Fresher', { freshChat: true });

    // chat files archived out of sight
    assert.equal(h.chatStore.listChats('Fresher').length, 0, 'no active chats remain');
    const archivedDir = h.chatStore.chatDir('Fresher') + '/archive';
    assert.ok(fs.existsSync(archivedDir) && fs.readdirSync(archivedDir).includes(oldChat), 'old chat preserved in archive/');

    // next conversation is fresh: greeting only, no codeword anywhere in the prompt
    h.engine.rng = makeRng([0.99, 0.0]); // quick reply on the fresh conversation
    await h.engine.onInbound({ character: 'Fresher', mes: 'hi again', source: 'telegram' });
    st = h.store.loadState('Fresher', { initialRelationship: 20 });
    // NOTE: the fresh chat may reuse the same *name* (the original was moved to
    // archive/); what matters is its CONTENT starts from the greeting.
    const msgs = h.chatStore.readMessages('Fresher', st.chatFile);
    assert.equal(msgs[0].is_user, false, 'fresh chat starts with greeting');
    const sysMsg = h.chatCalls[h.chatCalls.length - 1].find((m) => m.role === 'system');
    const lastCall = h.chatCalls[h.chatCalls.length - 1];
    const anyCodeword = lastCall.some((m) => (m.content ?? '').includes('pineapple'));
    assert.ok(!anyCodeword, 'old conversation absent from the new prompt');
});

test('audit granularity levels filter kinds', async () => {
    const { auditLevelAllows, auditGroup } = await import('../plugin/src/telegram.js');
    assert.equal(auditGroup('sent'), 'messages');
    assert.equal(auditGroup('deferred'), 'decisions');
    assert.equal(auditGroup('journal'), 'detail');
    assert.equal(auditGroup('model_fallback'), 'errors');

    assert.ok(auditLevelAllows('full', 'journal'));
    assert.ok(!auditLevelAllows('normal', 'journal'), 'normal hides journal notes');
    assert.ok(auditLevelAllows('normal', 'deferred'));
    assert.ok(auditLevelAllows('min', 'sent'));
    assert.ok(!auditLevelAllows('min', 'deferred'), 'min hides decisions');
    assert.ok(auditLevelAllows('min', 'gen_failed'), 'min keeps errors');
});

test('status() summarizes life state', async () => {
    const card = characterCard('Sasha');
    const h = buildHarness({ card });
    const s = h.engine.status();
    assert.equal(s.running, false); // never started
    assert.equal(s.characters.length, 1);
    const c = s.characters[0];
    assert.equal(c.name, 'Sasha');
    assert.ok(c.availability > 0); // free time
    assert.ok(c.localTime.includes('UTC'));
});

test('failed delayed reply retries with backoff and audits each step', async () => {
    const card = characterCard('Flint');
    const start = new Date(Date.UTC(2026, 0, 15, 10, 0));
    const h = buildHarness({ card, now: start, rngValues: [0.99, 0.99] }); // -> delayed

    await h.engine.onInbound({ character: 'Flint', mes: 'you up?', source: 'telegram' });
    let state = stateOf(h.store, 'Flint');
    assert.ok(state.pendingReply);
    assert.equal(state.pendingReply.attempts, 0);

    // make generation fail
    h.engine.ollama.chat = async () => { throw new Error('model exploded'); };
    h.clock.now = new Date(start.getTime() + 5 * 3600_000); // past due
    await h.engine.tick(h.clock.now);

    state = stateOf(h.store, 'Flint');
    assert.ok(state.pendingReply, 'reply re-pended after failure');
    assert.equal(state.pendingReply.attempts, 1);
    const audit = h.store.readAudit('Flint', 50).map((a) => a.kind);
    assert.ok(audit.includes('deferred'));
    assert.ok(audit.includes('pending_fired'));
    assert.ok(audit.includes('gen_failed'));
    assert.ok(audit.includes('gen_retry'));
    assert.equal(h.delivered.length, 0);

    // recovery: generation works again, second attempt fires and delivers
    h.engine.ollama.chat = async () => 'back online, sorry!';
    h.clock.now = new Date(state.pendingReply.dueAt.getTime ? state.pendingReply.dueAt : new Date(state.pendingReply.dueAt));
    h.clock.now = new Date(new Date(state.pendingReply.dueAt).getTime() + 1000);
    await h.engine.tick(h.clock.now);
    state = stateOf(h.store, 'Flint');
    assert.equal(state.pendingReply, null);
    assert.equal(h.delivered.length, 1);
    assert.ok(h.store.readAudit('Flint', 50).some((a) => a.kind === 'sent'));
});

test('initiative blocks are visible in status', async () => {
    const card = characterCard('Nora', { initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 1, followup_on_unread_hours: 0 } });
    const h = buildHarness({ card });
    let s = h.engine.status();
    let n = s.characters[0];
    assert.equal(n.initiative.blockedReason, null); // eligible

    // send a message that gets a quick reply -> then "just messaged" blocks initiative
    h.engine.rng = makeRng([0.99, 0.0]);
    await h.engine.onInbound({ character: 'Nora', mes: 'hi', source: 'telegram' });
    s = h.engine.status();
    n = s.characters[0];
    assert.match(n.initiative.blockedReason, /less than 20 min/);
});

test('journal generation carries her identity (personality, scenario, relationship) and not old journal notes', async () => {
    const card = characterCard('Diary', {
        journal: { enabled: true },
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '23:00', activity: 'hanging out at home', availability: 0.7 }],
    });
    const h = buildHarness({ card, rngValues: [], reply: 'I keep wondering whether I should tell Sean about the test results. I am nervous but hopeful.' });
    // seed a contaminated old note — it must NOT leak into the new generation
    const state = stateOf(h.store, 'Diary');
    state.journal = [{ ts: '2026-01-01T00:00:00Z', text: 'the mailman came early, it came, just got my package' }];
    h.store.saveState(state);

    const note = await h.engine.journalNow('Diary');
    assert.ok(note, 'a journal note was produced');

    const req = h.chatReqs.at(-1);
    const system = req.messages[0].content;
    assert.ok(req.messages[0].role === 'system');
    assert.ok(/Personality:/.test(system), 'personality present');
    assert.ok(/Situation between you two:/.test(system), 'scenario present');
    assert.ok(/Your relationship with/.test(system), 'relationship present');
    assert.ok(/Your life right now:/.test(system), 'life context present');
    assert.ok(!/mailman/.test(system), 'old journal notes do not feed back');
    assert.ok(!/How you text:/.test(system), 'texting style rules stay out of diary mode');
    assert.ok(/PRIVATE DIARY THOUGHTS/.test(system), 'directive rides along');
});

test('journal grounding sees only the user side — her own texts never feed back', async () => {
    const card = characterCard('Loopless', {
        journal: { enabled: true },
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '23:00', activity: 'hanging out at home', availability: 0.7 }],
    });
    // she texts a litany of repeats, then the user replies once
    const h = buildHarness({
        card,
        rngValues: [0.99, 0.0, 0.99, 0.0],
        reply: ['the mailman came early', 'totally different fresh words in reply'],
    });
    await h.engine.onInbound({ character: 'Loopless', mes: 'the mailman came early i was waiting by the window', source: 'telegram' });
    const state = stateOf(h.store, 'Loopless');
    for (const t of ['the mailman came early', 'it came', 'just got my package']) {
        h.chatStore.appendMessage('Loopless', state.chatFile, { name: 'Loopless', is_user: false, mes: t, send_date: '2026-01-15T15:00:00Z' });
    }

    await h.engine.journalNow('Loopless');
    const req = h.chatReqs.at(-1);
    // no assistant messages at all in journal generation
    assert.ok(!req.messages.some((m) => m.role === 'assistant'), 'her own texts are excluded');
    const system = req.messages[0].content;
    assert.ok(/actually said to you recently/.test(system), 'user-side grounding list present');
    assert.ok(system.includes('the mailman came early i was waiting by the window'), 'the user message is listed');
    assert.ok(!/it came\n|just got my package/.test(req.messages.map((m) => m.content).join('\n')), 'her litany is not shown');
});

test('journal with no recent user messages says so instead of showing nothing', async () => {
    const card = characterCard('Quiet', {
        journal: { enabled: true },
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '23:00', activity: 'reading', availability: 0.7 }],
    });
    const h = buildHarness({ card, rngValues: [], reply: 'i wonder what Sean is doing today. it is strange to miss someone this much.' });
    await h.engine.journalNow('Quiet');
    const system = h.chatReqs.at(-1).messages[0].content;
    assert.ok(/No messages from .* lately/.test(system), 'explicit no-messages fallback');
    assert.ok(!h.chatReqs.at(-1).messages.some((m) => m.role === 'assistant'));
});

test('custom directives ride on generations; burst uses the kind-aware directive', async () => {
    const card = characterCard('Direct');
    const h = buildHarness({
        card,
        rngValues: [0.99, 0.0, 0.99],
        reply: ['custom directive initiative text, all fresh words {follow-up}', 'burst two, brand new content'],
    });
    const s = h.store.loadSettings();
    s.engine = { ...s.engine, followup_bursts: true };
    s.directives = { ...s.directives, initiative: 'CUSTOM-INITIATIVE for {{user}}' };
    h.store.saveSettings(s);
    h.engine.refreshSettings();

    await h.engine.force('Direct', 'initiative');
    const first = h.chatReqs[0];
    assert.ok(first.messages.some((m) => m.content.includes('CUSTOM-INITIATIVE for ')), 'override reached the request with {{user}} substituted');

    // burst continuation after this initiative text carries the kind-aware directive
    const burstReq = h.chatReqs.find((r) => r.logMeta?.attempt === 'burst-1');
    assert.ok(burstReq, 'burst attempt logged');
    assert.ok(burstReq.messages.some((m) => m.content.includes('just sent that text moments ago') && m.content.includes('never repeat anything from your previous texts')), 'burst directive carries anti-repeat wording');
});

test('follow-up bursts are OFF by default: markers ignored, no burst generations', async () => {
    const card = characterCard('NoBurst');
    const h = buildHarness({ card, rngValues: [0.99, 0.0, 0.0], reply: 'one fresh main text {follow-up}' });
    await h.engine.onInbound({ character: 'NoBurst', mes: 'you around?', source: 'telegram' });
    const attempts = h.chatReqs.map((r) => r.logMeta?.attempt).filter(Boolean);
    assert.deepEqual(attempts.filter((a) => a?.startsWith('burst')), [], 'no burst generations by default');
    const state = stateOf(h.store, 'NoBurst');
    const msgs = h.chatStore.readMessages('NoBurst', state.chatFile).filter((m) => !m.is_user);
    assert.ok(!msgs.some((m) => /\{follow-?up\}/i.test(m.mes)), 'marker stripped from the stored text');
});

test('initiative is blocked when she has nothing to say (material gate)', async () => {
    const card = characterCard('Idle', { initiative: { enabled: true, min_gap_minutes: 60, max_per_day: 5, followup_on_unread_hours: 0 } });
    const start = new Date(Date.UTC(2026, 0, 15, 12, 0));
    const h = buildHarness({ card, now: start, rngValues: [0.5, 0.5, 0.0, 0.5, 0.5] }); // initiative roll fires on tick 2; journal/happening skip
    await h.engine.tick(start);

    const state = stateOf(h.store, 'Idle');
    assert.equal(h.delivered.length, 0, 'no initiative without material');
    assert.ok(h.store.readAudit('Idle', 20).some((a) => /nothing new to say/.test(a.text)),
        'the block reason names the missing material');

    // a fresh journal thought unlocks it
    state.lastJournalAt = new Date(start.getTime() - 30_000).toISOString();
    h.store.saveState(state);
    await h.engine.tick(start);
    assert.equal(h.delivered.length, 1, 'initiative fires once she has a fresh thought');
});

test('greeting spiral: two bare pings into silence back initiative off', async () => {
    const card = characterCard('Spiral', { initiative: { enabled: true, min_gap_minutes: 1, max_per_day: 10, followup_on_unread_hours: 0 } });
    let t = new Date(Date.UTC(2026, 0, 15, 12, 0));
    // per tick: [initiative roll, journal skip, happening skip]
    const h = buildHarness({ card, now: t, rngValues: [0.0, 0.5, 0.5, 0.0, 0.5, 0.5, 0.5, 0.5], reply: 'hey you' });
    // material: a fresh journal before each initiative
    let st = stateOf(h.store, 'Spiral');
    st.lastJournalAt = new Date(t.getTime() - 30_000).toISOString();
    h.store.saveState(st);
    await h.engine.tick(t);
    console.log('DEBUG audits:', h.store.readAudit('Spiral', 20).map((a) => a.kind).join(','));
    console.log('DEBUG delivered:', JSON.stringify(h.delivered));
    assert.equal(h.delivered.length, 1, 'first bare initiative fires');
    st = stateOf(h.store, 'Spiral');
    assert.equal(st.greetingRun, 1);

    // two hours later, another fresh journal, another bare ping
    t = new Date(t.getTime() + 2 * 3600_000);
    h.clock.now = t;
    st.lastJournalAt = new Date(t.getTime() - 30_000).toISOString();
    h.store.saveState(st);
    h.engine.rng = makeRng([0.0]);
    await h.engine.tick(t);
    st = stateOf(h.store, 'Spiral');
    assert.equal(st.greetingRun, 2);
    assert.ok(st.greetingBackoffUntil, 'backoff armed after two bare greetings');
    assert.ok(h.store.readAudit('Spiral', 30).some((a) => a.kind === 'initiative_blocked' && /bare greetings/.test(a.text)));

    // a third initiative with material is now held by the backoff
    t = new Date(t.getTime() + 2 * 3600_000);
    h.clock.now = t;
    st.lastJournalAt = new Date(t.getTime() - 30_000).toISOString();
    h.store.saveState(st);
    h.engine.rng = makeRng([0.0]);
    await h.engine.tick(t);
    assert.equal(h.delivered.length, 2, 'backoff holds the third initiative');
    assert.ok(h.store.readAudit('Spiral', 30).some((a) => /backing off after bare/.test(a.text)));
});

test('happenings: invented everyday events supply initiative material and get consumed', async () => {
    const card = characterCard('Lived', { initiative: { enabled: true, min_gap_minutes: 1, max_per_day: 10, followup_on_unread_hours: 0 } });
    const h = buildHarness({ card, rngValues: [0.0, 0.5, 0.5], reply: 'you will not BELIEVE what the vending machine just did to me' });
    const text = await h.engine.happeningNow('Lived');
    assert.ok(text && text.length > 5, 'a happening was generated');
    assert.ok(h.chatReqs.at(-1).messages.some((m) => m.content.includes('small, mundane thing')), 'happening prompt requests an everyday event');
    assert.ok(h.chatReqs.at(-1).messages.some((m) => m.content.includes('must NOT involve')), 'happenings never involve the user');
    assert.ok(h.chatReqs.at(-1).messages.some((m) => m.content.includes('Never use pronouns for people')), 'happening notes carry the pronoun rule');

    let st = stateOf(h.store, 'Lived');
    assert.equal(st.happenings.filter((x) => !x.used).length, 1, 'stored unused');

    // the next initiative carries it in the instruction and consumes it
    const start = new Date(Date.UTC(2026, 0, 15, 12, 0));
    h.clock.now = start;
    st.lastJournalAt = new Date(start.getTime() - 30_000).toISOString();
    h.store.saveState(st);
    await h.engine.tick(start);
    const initReq = h.chatReqs.find((r) => r.logMeta?.kind === 'initiative');
    assert.ok(initReq.messages.some((m) => m.content.includes('something small happened to you recently')), 'happening offered as material');
    st = stateOf(h.store, 'Lived');
    assert.equal(st.happenings.filter((x) => !x.used).length, 0, 'consumed after a content initiative');
});

test('schedule enhancement: lazy per-block activity, cached, used in lieu of schedule text', async () => {
    const card = characterCard('Cafe', {
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '23:00', activity: 'at work', availability: 0.7 }],
    });
    // first call = enhancement, second = the main reply
    const h = buildHarness({
        card,
        rngValues: [0.99, 0.0, 0.0],
        reply: ['reconciling the invoices with half a latte going cold', 'main reply with fresh words'],
    });
    await h.engine.onInbound({ character: 'Cafe', mes: 'you around?', source: 'telegram' });

    // the enhancement generation ran once, asked about the block with its timeframe
    const enhanceReqs = h.chatReqs.filter((r) => r.logMeta?.kind === 'schedule_enhance');
    assert.equal(enhanceReqs.length, 1, 'enhancement generated once per block');
    assert.ok(enhanceReqs[0].messages.some((m) => m.content.includes('"at work"')));
    assert.ok(enhanceReqs[0].messages.some((m) => m.content.includes('9:00am to 11:00pm')));

    // the main prompt used the enhanced activity instead of the raw schedule text
    const main = h.chatReqs.find((r) => r.logMeta?.kind === 'reply');
    assert.ok(main.messages.some((m) => m.content.includes('reconciling the invoices')), 'enhanced activity replaces schedule text');
    assert.ok(!main.messages.some((m) => m.content.includes('Your life right now: it is') && m.content.includes('at work')), 'raw schedule text gone');

    // a second generation in the same block uses the cache — no new enhancement call
    await h.engine.onInbound({ character: 'Cafe', mes: 'still there?', source: 'telegram' });
    assert.equal(h.chatReqs.filter((r) => r.logMeta?.kind === 'schedule_enhance').length, 1, 'cache holds for the block');
    const state = stateOf(h.store, 'Cafe');
    assert.ok(Object.values(state.enhanced ?? {}).some((e) => /invoices/.test(e.text)), 'cached in state');
});

test('schedule enhancement can be disabled', async () => {
    const card = characterCard('Plain', {
        schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '23:00', activity: 'at work', availability: 0.7 }],
    });
    const h = buildHarness({ card, rngValues: [0.99, 0.0], reply: 'an ordinary reply with fresh words' });
    const s = h.store.loadSettings();
    s.features = { ...s.features, schedule_enhance: false };
    h.store.saveSettings(s);
    h.engine.refreshSettings();
    await h.engine.onInbound({ character: 'Plain', mes: 'hi', source: 'telegram' });
    assert.equal(h.chatReqs.filter((r) => r.logMeta?.kind === 'schedule_enhance').length, 0, 'no enhancement when disabled');
});

test('evolution generation sees only card + journals + reflections (no chat)', async () => {
    const card = characterCard('Grower2', { evolve: { enabled: true } });
    const h = buildHarness({ card, rngValues: [], reply: 'I have grown more patient with Sean over these months.' });
    const st = stateOf(h.store, 'Grower2');
    st.journal = [{ ts: '2026-01-01T00:00:00Z', text: 'JOURNAL-MARKER thought one' }];
    st.evolve = { lastReflectAt: null, notes: [{ ts: '2026-01-02T00:00:00Z', text: 'EVOLUTION-MARKER earlier reflection', status: 'approved' }] };
    h.store.saveState(st);

    // a chat history exists — it must not appear in the evolution prompt
    h.chatStore.appendMessage('Grower2', st.chatFile ?? (st.chatFile = h.chatStore.createChat('Grower2', 'hello')), { name: 'Grower2', is_user: false, mes: 'CHAT-MARKER message body', send_date: '2026-01-03T00:00:00Z' });

    await h.engine.reflectNow('Grower2');
    const req = h.chatReqs.at(-1);
    const system = req.messages.find((m) => m.role === 'system').content;
    assert.ok(system.includes('JOURNAL-MARKER'), 'all journal entries included');
    assert.ok(system.includes('EVOLUTION-MARKER'), 'all past reflections included');
    assert.ok(system.includes('personality: cooperative'), 'card included');
    assert.ok(!req.messages.some((m) => m.role === 'assistant' || m.role === 'user' && m.content.includes('CHAT-MARKER')), 'no chat entries in evolution');
    assert.ok(system.includes('Never use pronouns for people'));
});
