// Telegram command registry. Each command is one entry; adding commands later
// is a one-object edit. Unimplemented future commands reply honestly.

import { importCardBuffer } from './card-import.js';
import { relationshipDescriptor } from './schedule.js';

const NOT_YET = (name) => `/${name} is planned but not implemented yet. Coming in a future version.`;

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
        const lines = [
            `*${entry.name}*`,
            `Right now: ${status?.activity ?? 'unknown'} (${Math.round((status?.availability ?? 0) * 100)}% available${status?.mood ? `, feeling ${status.mood}` : ''})`,
            status ? `Their local time: ${status.localTime}` : '',
            `Relationship: ${Math.round(status?.relationship ?? 0)}/100 (${relationshipDescriptor(status?.relationship ?? 0)})`,
            status?.pendingReply ? `Replying to you in: ~${Math.max(0, Math.round((new Date(status.pendingReply.dueAt).getTime() - Date.now()) / 60000))} min` : 'No pending reply',
            status?.paused ? '⚠️ paused' : '',
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
                '/model — model control (list/use/pull)\n' +
                '/pause, /resume — pause the character\'s life\n' +
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
            await transport.send(chatId, `You're now texting ${entry.name}.\n\n${characterSummary(entry)}`);
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
                    `Switched to ${name}.${installed ? '' : '\nIt is not installed yet — pulling now (this can take a while); I will confirm when done.'}`);
                if (!installed) {
                    engine.ollama.ensureModel(name, () => {})
                        .then((ok) => transport.send(chatId, ok ? `Done — ${name} is ready.` : `Pulling ${name} failed. Check the logs.`))
                        .catch((e) => transport.send(chatId, `Pull failed: ${e.message}`));
                }
                return;
            }

            if (sub === 'pull') {
                const name = args.slice(1).join(' ').trim();
                if (!name) return transport.send(chatId, 'Usage: /model pull <name>');
                await transport.send(chatId, `Pulling ${name}…`);
                try {
                    let last = '';
                    await engine.ollama.pull(name, (s) => {
                        if (s !== last && /pulling|downloading|verifying|success/i.test(s)) last = s; // progress spam guard
                    });
                    await transport.send(chatId, `Done — ${name} is ready.`);
                } catch (err) {
                    await transport.send(chatId, `Pull failed: ${err.message}`);
                }
                return;
            }

            await transport.send(chatId, 'Usage: /model [list | use <name> | pull <name>]');
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
