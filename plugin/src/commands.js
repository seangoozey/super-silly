// Telegram command registry. Each command is one entry; adding commands later
// is a one-object edit. Unimplemented future commands reply honestly.

import { importCardBuffer } from './card-import.js';
import { relationshipDescriptor } from './schedule.js';

const NOT_YET = (name) => `/${name} is planned but not implemented yet. Coming in a future version.`;

const fmtBytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);
const progressBar = (pct) => {
    const filled = Math.round(Math.max(0, Math.min(100, pct)) / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

export function createCommandRegistry(ctx) {
    const { engine, cards, store, chatStore, log } = ctx;
    const charactersDir = cards.dir;

    // The transport is created after this registry (they reference each other);
    // proxy through ctx so every call sees the live instance.
    const transport = new Proxy({}, {
        get(_target, prop) {
            const real = ctx.transport;
            if (!real) throw new Error('Telegram transport not started');
            const value = real[prop];
            return typeof value === 'function' ? value.bind(real) : value;
        },
    });

    const commands = new Map();

    function register(cmd) {
        commands.set(cmd.name, cmd);
    }

    const bindingFor = (chatId) => store.loadBindings()[String(chatId)] ?? null;

    const characterSummary = (entry) => {
        const status = engine.status().characters.find((c) => c.name === entry.name);
        if (!status) return `${entry.name}: no engine state yet.`;
        const mins = (iso) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
        const pending = status.pendingReply
            ? `Replying in ~${mins(status.pendingReply.dueAt)} min${status.pendingReply.attempts ? ` (retry ${status.pendingReply.attempts}/5)` : ''}`
            : 'No pending reply';
        const init = status.initiative ?? {};
        const initLine = !init.enabled
            ? 'Initiative: off'
            : init.blockedReason
                ? `Initiative: on hold — ${init.blockedReason}`
                : `Initiative: eligible${init.nextEligibleAt ? ` in ~${mins(init.nextEligibleAt)} min` : ''} (${init.todayCount ?? 0}/${init.max_per_day} used today)`;
        const lines = [
            `*${entry.name}*`,
            `Right now: ${status.activity} (${Math.round(status.availability * 100)}% available${status.mood ? `, feeling ${status.mood}` : ''})`,
            `Their local time: ${status.localTime}`,
            `Relationship: ${Math.round(status.relationship)}/100 (${relationshipDescriptor(status.relationship)})`,
            pending,
            initLine,
            status.paused ? '⚠️ paused' : '',
        ].filter(Boolean);
        return lines.join('\n');
    };

    register({
        name: 'start',
        help: 'show what this bot can do',
        run: async (chatId) => {
            await transport.send(chatId,
                'Hey! This is an Autolife character bot — the people here text you on their own schedule.\n\n' +
                'Commands:\n' +
                '/chars — list characters\n' +
                '/switch <name> — talk to a character\n' +
                '/status — what your character is up to\n' +
                '/start, /stop — full stop/start (they begin stopped after server restarts)\n' +
                '/pause, /resume — soft pause of the character\'s life\n' +
                '/audit [on|off] — see every engine decision as it happens\n' +
                '/memory — long-term memory status\n' +
                '/model — model control (list/use/pull)\n' +
                '/upload — attach a character card (.png/.json) to import it\n\n' +
                'Then just text them like a real person. They might reply instantly… or a while later. Or be asleep.');
        },
    });

    register({
        name: 'help',
        help: 'alias of /start',
        run: async (chatId) => commands.get('start').run(chatId),
    });

    register({
        name: 'chars',
        help: 'list characters',
        run: async (chatId) => {
            const list = cards.autolifeCharacters();
            if (!list.length) {
                await transport.send(chatId, 'No Autolife characters installed yet. Import one with /upload or via SillyTavern.');
                return;
            }
            const binding = bindingFor(chatId);
            const body = list.map((c) => `${c.name === binding?.character ? '→ ' : ''}${c.name}`).join('\n');
            await transport.send(chatId, `Characters:\n${body}\n\nUse /switch <name>.`);
        },
    });

    register({
        name: 'switch',
        help: 'switch this chat to a character',
        run: async (chatId, args) => {
            const query = args.join(' ');
            if (!query) {
                await transport.send(chatId, 'Usage: /switch <name>');
                return;
            }
            const entry = cards.find(query);
            if (!entry || !entry.autolife) {
                await transport.send(chatId, `No Autolife character matching "${query}". Try /chars.`);
                return;
            }
            const file = await transport.bind(chatId, entry);
            log(`telegram chat ${chatId} bound to "${entry.name}" (${file})`);
            const state = store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial });
            const stoppedNote = state.enabled === false ? '\n⚠️ They are currently STOPPED (characters start stopped after server restarts) — /start to let them text you.' : '';
            await transport.send(chatId, `You're now texting ${entry.name}.\n\n${characterSummary(entry)}${stoppedNote}`);
            const greeting = entry.card?.data?.first_mes;
            if (greeting) {
                await transport.send(chatId, chatStore.substituteMacros(greeting, entry.name));
            }
        },
    });

    register({
        name: 'status',
        help: 'what your character is doing',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) {
                await transport.send(chatId, 'No character bound — /switch <name> first.');
                return;
            }
            const entry = cards.find(binding.character);
            if (!entry) {
                await transport.send(chatId, `Bound character "${binding.character}" no longer exists. /chars to pick another.`);
                return;
            }
            await transport.send(chatId, characterSummary(entry));
        },
    });

    register({
        name: 'start',
        help: 'start the bound character (after server restarts they begin stopped)',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const state = store.loadState(binding.character, { initialRelationship: 20 });
            state.enabled = true;
            state.paused = false;
            store.saveState(state);
            await transport.send(chatId, `${binding.character} is live — schedule, replies and initiative are running.`);
        },
    });

    register({
        name: 'stop',
        help: 'stop the bound character entirely (no replies, no initiative)',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const state = store.loadState(binding.character, { initialRelationship: 20 });
            state.enabled = false;
            store.saveState(state);
            await transport.send(chatId, `${binding.character} is stopped — completely hands-off until /start.`);
        },
    });

    register({
        name: 'pause',
        help: 'pause the bound character',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const state = store.loadState(binding.character, { initialRelationship: 20 });
            state.paused = true;
            store.saveState(state);
            await transport.send(chatId, `${binding.character} is paused — they won't message you and won't reply. /resume to wake them back up.`);
        },
    });

    register({
        name: 'resume',
        help: 'resume the bound character',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const state = store.loadState(binding.character, { initialRelationship: 20 });
            state.paused = false;
            store.saveState(state);
            await transport.send(chatId, `${binding.character} is back — messages and replies flow again.`);
        },
    });

    /**
     * Pull a model with one chat message that gets edited at milestones
     * (~every 10% or 2 min): progress bar, bytes, speed, ETA. Per-event spam
     * floods the chat; silence hides multi-GB pulls entirely.
     */
    async function pullWithChatUpdates(chatId, name) {
        const first = await transport.send(chatId, `Pulling ${name}…\n${progressBar(0)} 0%`);
        const messageId = first?.message_id;
        const edit = (text) => transport.api('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => {});
        let lastPct = -100;
        let lastSent = Date.now();
        try {
            const ok = await engine.ollama.ensureModel(name, (p) => {
                if (p.percent === undefined) return;
                const pct = Math.floor(p.percent);
                if (!(pct - lastPct >= 10 || Date.now() - lastSent > 120_000)) return;
                lastPct = pct;
                lastSent = Date.now();
                const speed = p.speedBps > 0 ? ` · ${fmtBytes(p.speedBps)}/s` : '';
                const eta = p.speedBps > 0 && p.total > p.completed
                    ? ` · ETA ~${Math.max(1, Math.round((p.total - p.completed) / p.speedBps / 60))} min`
                    : '';
                edit(`Pulling ${name}\n${progressBar(pct)} ${pct}%\n${fmtBytes(p.completed)} / ${fmtBytes(p.total)}${speed}${eta}`);
            });
            if (ok) {
                await (messageId ? edit(`Done — ${name} is ready ✓`) : transport.send(chatId, `Done — ${name} is ready ✓`));
            } else {
                await transport.send(chatId, `Pulling ${name} failed — check the server logs.`);
            }
        } catch (err) {
            await transport.send(chatId, `Pull failed: ${err.message}`);
        }
    }

    register({
        name: 'model',
        help: 'model control: /model [list | use <name> | pull <name>]',
        run: async (chatId, args) => {
            const sub = (args[0] ?? '').toLowerCase();
            const settings = store.loadSettings();
            const presets = [settings.model.primary, settings.model.fallback].filter(Boolean);

            if (!sub || sub === 'list') {
                let local = [];
                try {
                    local = (await engine.ollama.tags()).map((m) => m.name);
                } catch {
                    local = [];
                }
                const mark = (n) => (n === settings.model.current ? `${n}  ← in use` : n);
                await transport.send(chatId,
                    `In use: ${settings.model.current}\n\n` +
                    `Presets:\n${presets.map(mark).map((s) => `- ${s}`).join('\n')}\n\n` +
                    (local.length ? `Installed locally:\n${local.map((n) => `- ${mark(n)}`).join('\n')}` : '(could not list local models — is Ollama up?)') +
                    `\n\n/model use <name> to switch, /model pull <name> to download.`);
                return;
            }

            if (sub === 'use') {
                const name = args.slice(1).join(' ').trim();
                if (!name) return transport.send(chatId, 'Usage: /model use <name>');
                const installed = await engine.ollama.hasModel(name).catch(() => false);
                settings.model.current = name;
                store.saveSettings(settings);
                engine.refreshSettings();
                await transport.send(chatId,
                    `Switched to ${name}.${installed ? '' : '\nIt is not installed yet — starting the download now.'}`);
                if (!installed) pullWithChatUpdates(chatId, name).catch(() => {});
                return;
            }

            if (sub === 'think') {
                const mode = (args[1] ?? '').toLowerCase();
                if (!['on', 'off', 'auto'].includes(mode)) {
                    return transport.send(chatId,
                        `Thinking is currently: ${settings.model.think ?? 'off'}\n` +
                        'Usage: /model think <on|off|auto>\n' +
                        '- off: no reasoning — fast, short texts (recommended default)\n' +
                        '- on: model reasons before texting (needs a thinking model, e.g. Dark-Scarlett)\n' +
                        '- auto: whatever the model\'s own template defaults to');
                }
                settings.model.think = mode;
                store.saveSettings(settings);
                engine.refreshSettings();
                return transport.send(chatId, `Thinking set to ${mode}.`);
            }

            if (sub === 'pull') {
                const name = args.slice(1).join(' ').trim();
                if (!name) return transport.send(chatId, 'Usage: /model pull <name>');
                if (await engine.ollama.hasModel(name).catch(() => false)) {
                    return transport.send(chatId, `${name} is already installed — /model use ${name} to switch to it.`);
                }
                await pullWithChatUpdates(chatId, name);
                return;
            }

            await transport.send(chatId, 'Usage: /model [list | use <name> | pull <name>]');
        },
    });

    register({
        name: 'audit',
        help: 'engine decision notifications: /audit [on|off]',
        run: async (chatId, args) => {
            const bindings = store.loadBindings();
            const key = String(chatId);
            const binding = bindings[key];
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const sub = (args[0] ?? '').toLowerCase();
            if (sub === 'on' || sub === 'off') {
                binding.audit = sub === 'on';
                bindings[key] = binding;
                store.saveBindings(bindings);
                return transport.send(chatId,
                    `Audit notifications ${binding.audit ? 'ON' : 'OFF'} for ${binding.character}. `
                    + (binding.audit
                        ? "You'll get a message here for every engine decision: instant replies, delays (with the wait), ignored messages, catch-ups, initiative rolls and blocks, retries after failed generations."
                        : 'Back to silence.'));
            }
            return transport.send(chatId,
                `Audit notifications are currently ${binding.audit ? 'ON' : 'OFF'} for ${binding.character}.\n`
                + '/audit on — every planned action/non-action gets messaged here\n'
                + '/audit off — silence');
        },
    });

    register({
        name: 'memory',
        help: 'long-term memory (RAG) stats',
        run: async (chatId) => {
            const binding = bindingFor(chatId);
            if (!binding?.character) return transport.send(chatId, 'No character bound — /switch <name> first.');
            const status = engine.status().characters.find((c) => c.name === binding.character);
            const settings = store.loadSettings();
            await transport.send(chatId,
                `${binding.character}'s memory:\n` +
                `- ${status?.memoryEntries ?? 0} texts indexed${status?.memoryEntries ? ' (older conversations are searchable)' : ''}\n` +
                `- Embedding model: ${settings.memory?.embed_model ?? 'nomic-embed-text'}\n` +
                '- Recalled automatically when your message relates to older chats — watch for 🔎 "recalled N older texts" audit lines.');
        },
    });

    register({ name: 'schedule', help: 'view the schedule (planned)', run: async (chatId) => transport.send(chatId, NOT_YET('schedule')) });
    register({ name: 'journal', help: 'read the journal (planned)', run: async (chatId) => transport.send(chatId, NOT_YET('journal')) });
    register({ name: 'newchat', help: 'start a fresh chat (planned)', run: async (chatId) => transport.send(chatId, NOT_YET('newchat')) });
    register({ name: 'persona', help: 'set your persona (planned)', run: async (chatId) => transport.send(chatId, NOT_YET('persona')) });

    return {
        /** Parse and run "/cmd@bot args…" text. */
        async handle(chatId, text) {
            const [head, ...args] = text.trim().split(/\s+/);
            const name = head.replace(/@.*$/, '').slice(1).toLowerCase();
            const cmd = commands.get(name);
            if (!cmd) {
                await transport.send(chatId, `Unknown command /${name} — try /help.`);
                return;
            }
            log(`telegram command /${name} ${args.join(' ')}`.trimEnd());
            await cmd.run(chatId, args);
        },

        /** Document upload (cards). */
        async handleUpload(chatId, document) {
            const name = document.file_name ?? '';
            const sizeMb = (document.file_size ?? 0) / 1024 / 1024;
            if (!/\.(png|json)$/i.test(name)) {
                await transport.send(chatId, `I can only import .png or .json character cards (got "${name}").`);
                return;
            }
            if (sizeMb > 20) {
                await transport.send(chatId, 'That file is too large (>20MB).');
                return;
            }
            await transport.send(chatId, `Importing "${name}"…`);
            try {
                const buffer = await transport.api('getFile', { file_id: document.file_id }).then(async (info) => {
                    const res = await (ctx.fetchImpl ?? fetch)(`https://api.telegram.org/file/bot${transport.token}/${info.file_path}`);
                    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
                    return Buffer.from(await res.arrayBuffer());
                });
                const result = importCardBuffer({ buffer, filename: name, charactersDir });
                if (!result.ok) {
                    await transport.send(chatId, `Card rejected:\n- ${result.errors.join('\n- ')}`);
                    return;
                }
                cards.invalidate(result.file);
                const warns = result.warnings.length ? `\nWarnings:\n- ${result.warnings.join('\n- ')}` : '';
                const autolifeNote = result.hasAutolife
                    ? ''
                    : '\nNote: this card has no autolife block — set up its schedule in the SillyTavern Autolife panel.';
                await transport.send(chatId, `Imported "${result.name}"${autolifeNote}${warns}\n\n/switch ${result.name} to start texting them.`);
            } catch (err) {
                log(`upload failed: ${err?.stack ?? err}`);
                await transport.send(chatId, `Import failed: ${err.message}`);
            }
        },
    };
}
