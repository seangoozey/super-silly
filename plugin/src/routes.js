// Plugin HTTP routes, mounted by SillyTavern at /api/plugins/autolife/*.
// Express-free body handling (tiny JSON reader) so the module has zero deps.

import { validateAutolife, normalizeAutolife } from './autolife-schema.js';
import { saveAutolifeToCharacter } from './card-import.js';

function readBody(req) {
    // SillyTavern's global express.json middleware may already have consumed
    // and parsed the body — in that case the stream is ended and reading it
    // again would hang forever. Prefer the parsed body when present.
    if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
        return Promise.resolve(req.body);
    }
    if (req.readableEnded || req.complete) {
        return Promise.resolve({});
    }
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 2_000_000) reject(new Error('body too large'));
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(`[Autolife] route ${req.method} ${req.url} failed: ${err?.stack ?? err}`);
    if (!res.headersSent) res.status(500).json({ error: String(err?.message ?? err) });
});

/**
 * @param {{ engine: object, store: object, cards: object, chatStore: object, ollama: object,
 *           transport: object, charactersDir: string, broadcast: (t:string,d:object)=>void,
 *           addSseClient: (res:object)=>void, restartTransport: ()=>void, log: (m:string)=>void }} deps
 */
export function registerRoutes(router, deps) {
    const { engine, store, cards, chatStore, ollama, memory, transport, charactersDir, broadcast, addSseClient, restartTransport, log } = deps;

    /** Persist + broadcast an audit entry from a route action. */
    const audit = (character, kind, text) => {
        const entry = { ts: new Date().toISOString(), character: character ?? null, kind, text };
        store.appendAudit(character, entry);
        broadcast('audit', entry);
    };

    // ---- audit log ----
    router.get('/audit', wrap(async (req, res) => {
        const name = req.query?.name ? String(req.query.name) : null;
        const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
        res.json({ entries: store.readAudit(name, limit) });
    }));

    // ---- SSE live events ----
    router.get('/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write('data: {"type":"hello"}\n\n');
        addSseClient(res);
        const beat = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch {
                clearInterval(beat);
            }
        }, 25_000);
        req.on('close', () => clearInterval(beat));
    });

    // ---- status ----
    router.get('/status', wrap(async (req, res) => {
        const settings = store.loadSettings();
        const ollamaVersion = await ollama.version().catch(() => null);
        res.json({
            engine: engine.status(),
            ollama: { url: ollama.baseUrl, version: ollamaVersion },
            telegram: { enabled: transport.enabled, allowedChats: (settings.telegram?.allowed_chat_ids ?? []).length },
            model: settings.model,
        });
    }));

    // ---- characters & cards ----
    router.get('/characters', wrap(async (req, res) => {
        const all = cards.scan().map((c) => ({
            name: c.name,
            file: c.file,
            hasAutolife: !!c.autolife,
            tags: c.card?.data?.tags ?? [],
            greeting: (c.card?.data?.first_mes ?? '').slice(0, 200),
        }));
        res.json({ characters: all });
    }));

    router.get('/card', wrap(async (req, res) => {
        const name = String(req.query?.name ?? '');
        const entry = cards.find(name);
        if (!entry) return res.status(404).json({ error: `No character "${name}".` });
        res.json({
            name: entry.name,
            file: entry.file,
            autolifeRaw: entry.autolifeRaw ?? null,
            autolife: entry.autolife ?? null,
            description: entry.card?.data?.description ?? '',
            first_mes: entry.card?.data?.first_mes ?? '',
        });
    }));

    router.post('/card', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry) return res.status(404).json({ error: `No character "${body.name}".` });
        const check = validateAutolife(body.autolife);
        if (!check.valid) return res.status(400).json({ error: 'Invalid autolife block', errors: check.errors, warnings: check.warnings });
        saveAutolifeToCharacter(charactersDir, entry, body.autolife);
        cards.invalidate(entry.file);
        cards.scan();
        log(`updated autolife block for "${entry.name}"`);
        broadcast('card_updated', { character: entry.name });
        audit(entry.name, 'card_updated', 'autolife configuration updated from the SillyTavern panel');
        res.json({ ok: true, name: entry.name, warnings: check.warnings });
    }));

    // ---- enable / pause ----
    router.post('/enable', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry) return res.status(404).json({ error: `No character "${body.name}".` });
        if (body.enabled && !entry.autolife) {
            return res.status(400).json({ error: 'Character has no autolife block — configure it first.' });
        }
        const state = store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial ?? 20 });
        state.enabled = !!body.enabled;
        store.saveState(state);
        broadcast('state_changed', { character: entry.name });
        audit(entry.name, 'state_changed', `autolife ${body.enabled ? 'enabled' : 'disabled'} for this character`);
        res.json({ ok: true });
    }));

    router.post('/pause', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry) return res.status(404).json({ error: `No character "${body.name}".` });
        const state = store.loadState(entry.name, { initialRelationship: 20 });
        state.paused = !!body.paused;
        store.saveState(state);
        broadcast('state_changed', { character: entry.name });
        audit(entry.name, 'state_changed', body.paused ? 'paused — no replies, no initiative' : 'resumed');
        res.json({ ok: true });
    }));

    // ---- web inbound (the UI extension reports user messages) ----
    router.post('/inbound', wrap(async (req, res) => {
        const body = await readBody(req);
        if (!body.character || typeof body.mes !== 'string') {
            return res.status(400).json({ error: 'character and mes required' });
        }
        await engine.onInbound({ character: body.character, mes: body.mes, source: 'web' });
        res.json({ ok: true });
    }));

    // ---- force action ----
    router.post('/trigger', wrap(async (req, res) => {
        const body = await readBody(req);
        try {
            await engine.force(String(body.name ?? ''), String(body.kind ?? 'initiative'));
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    }));

    // ---- settings ----
    router.get('/settings', wrap(async (req, res) => {
        const settings = store.loadSettings();
        const token = settings.telegram?.token ?? '';
        res.json({
            settings: {
                ...settings,
                telegram: {
                    ...settings.telegram,
                    token: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : '',
                    hasToken: !!token,
                },
            },
        });
    }));

    router.post('/settings', wrap(async (req, res) => {
        const body = await readBody(req);
        const settings = store.loadSettings();
        if (body.model) settings.model = { ...settings.model, ...body.model };
        if (body.engine) {
            settings.engine = { ...settings.engine, ...body.engine };
            ['availability_tone', 'relationship_speed', 'start_stopped'].forEach((k) => {
                if (typeof body.engine[k] === 'boolean') {
                    audit(null, 'engine', `${k} set to ${body.engine[k]}`);
                }
            });
        }
        if (body.quiet_hours) {
            settings.quiet_hours = { ...settings.quiet_hours, ...body.quiet_hours };
            audit(null, 'engine', `quiet hours ${settings.quiet_hours.enabled ? `enabled (${settings.quiet_hours.start}–${settings.quiet_hours.end} ${settings.quiet_hours.timezone})` : 'disabled'}`);
        }
        if (body.memory) {
            const before = settings.memory?.embed_model;
            settings.memory = { ...settings.memory, ...body.memory };
            if (body.memory.embed_model && body.memory.embed_model !== before) {
                audit(null, 'memory', `embedding model changed: ${before ?? '(none)'} -> ${body.memory.embed_model} — existing indexes will rebuild`);
            }
        }
        if (body.persona) {
            const before = settings.persona?.name ?? '(auto)';
            settings.persona = { ...settings.persona, ...body.persona };
            if (typeof body.persona.name === 'string') {
                settings.persona.name = body.persona.name.trim();
                if (settings.persona.name !== before) {
                    audit(null, 'persona', `user name characters see changed: ${before} -> ${settings.persona.name || '(auto-resolve)'}`);
                }
            }
        }
        if (body.prompt) {
            settings.prompt = { ...settings.prompt, ...body.prompt };
            if (typeof body.prompt.template === 'string') {
                audit(null, 'prompt', `global prompt template ${body.prompt.template.trim() ? 'updated' : 'cleared'} (${body.prompt.template.length} chars)`);
            }
        }
        if (body.telegram) {
            // empty token string means "keep existing"; explicit null clears it
            if (typeof body.telegram.token === 'string' && body.telegram.token.trim()) settings.telegram.token = body.telegram.token.trim();
            if (body.telegram.token === null) settings.telegram.token = '';
            if (Array.isArray(body.telegram.allowed_chat_ids)) {
                settings.telegram.allowed_chat_ids = body.telegram.allowed_chat_ids.map(Number).filter(Number.isFinite);
            }
            // extra per-character bots: [{ name, token, allowed_chat_ids }]
            if (Array.isArray(body.telegram.bots)) {
                settings.telegram.bots = body.telegram.bots
                    .filter((b) => b && typeof b.token === 'string' && b.token.trim())
                    .map((b) => ({
                        name: String(b.name ?? 'bot').replace(/[^a-z0-9_-]/gi, '_').slice(0, 24) || 'bot',
                        token: b.token.trim(),
                        allowed_chat_ids: Array.isArray(b.allowed_chat_ids) ? b.allowed_chat_ids.map(Number).filter(Number.isFinite) : [],
                    }));
                audit(null, 'model', `telegram bots configured: ${settings.telegram.bots.length + 1} (incl. default)`);
            }
        }
        store.saveSettings(settings);
        engine.refreshSettings();
        let telegramRestarted = false;
        if (body.telegram?.restart) {
            restartTransport();
            telegramRestarted = true;
        }
        res.json({ ok: true, telegramRestarted });
    }));

    // ---- bindings ----
    router.get('/bindings', wrap(async (req, res) => {
        // merged across bots: "<bot>:<chatId>" -> { character, chatFile, bot, chatId }
        res.json({ bindings: store.allBindings() });
    }));

    router.post('/bindings/delete', wrap(async (req, res) => {
        const body = await readBody(req);
        const bot = String(body.bot ?? 'default');
        const key = String(body.chatId ?? '');
        const bindings = store.loadBindings(bot);
        if (!(key in bindings)) return res.status(404).json({ error: `No ${bot} binding for ${key}.` });
        delete bindings[key];
        store.saveBindings(bot, bindings);
        audit(bindings[key]?.character ?? null, 'state_changed', `telegram binding removed (${bot}:${key})`);
        broadcast('bindings_changed', {});
        res.json({ ok: true });
    }));

    // ---- prompt template ----
    router.get('/prompt/preview', wrap(async (req, res) => {
        const name = String(req.query?.name ?? '');
        const entry = cards.find(name);
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${name}".` });
        const { evaluate } = await import('./schedule.js');
        const { buildSystemPrompt } = await import('./llm.js');
        const settings = store.loadSettings();
        const state = store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial ?? 20 });
        const template = entry.autolife.prompt?.template?.trim() || settings.prompt?.template?.trim() || null;
        const system = buildSystemPrompt({
            card: entry.card,
            autolife: entry.autolife,
            life: evaluate(entry.autolife, new Date()),
            relationshipScore: state.relationship,
            journal: state.journal ?? [],
            userName: chatStore.userName,
            template,
        });
        res.json({ system, template: template ?? '', source: entry.autolife.prompt?.template?.trim() ? 'card' : (settings.prompt?.template?.trim() ? 'global' : 'builtin') });
    }));

    // ---- models ----
    router.get('/model/list', wrap(async (req, res) => {
        const settings = store.loadSettings();
        let local = [];
        try {
            local = (await ollama.tags()).map((m) => ({ name: m.name, size: m.size ?? null }));
        } catch { /* ollama down — still return presets */ }
        res.json({
            current: settings.model.current,
            think: settings.model.think ?? 'off',
            presets: [settings.model.primary, settings.model.fallback].filter(Boolean),
            local,
        });
    }));

    router.post('/model/use', wrap(async (req, res) => {
        const body = await readBody(req);
        if (!body.model) return res.status(400).json({ error: 'model required' });
        const settings = store.loadSettings();
        settings.model.current = String(body.model);
        store.saveSettings(settings);
        engine.refreshSettings();
        broadcast('model_changed', { model: settings.model.current });
        audit(null, 'model', `current model switched to ${settings.model.current}`);
        res.json({ ok: true, current: settings.model.current });
    }));

    router.post('/model/pull', wrap(async (req, res) => {
        const body = await readBody(req);
        if (!body.model) return res.status(400).json({ error: 'model required' });
        const model = String(body.model);
        res.json({ started: true });
        audit(null, 'model', `model pull started: ${model}`);
        ollama.ensureModel(model, (p) => broadcast('model_pull', { model, ...p }))
            .then((ok) => {
                broadcast('model_pull', { model, status: ok ? 'success' : 'failed' });
                audit(null, 'model', `model pull ${ok ? 'succeeded' : 'FAILED'}: ${model}`);
            })
            .catch((err) => {
                broadcast('model_pull', { model, status: `failed: ${err.message}` });
                audit(null, 'model', `model pull FAILED: ${model} (${err.message})`);
            });
    }));

    // ---- memory (RAG) ----
    router.get('/memory', wrap(async (req, res) => {
        const settings = store.loadSettings();
        const name = req.query?.name ? String(req.query.name) : null;
        const chars = engine.cards.autolifeCharacters();
        const characters = chars.map((c) => {
            const stats = memory.stats(c.name, settings.memory?.embed_model);
            const state = store.loadState(c.name, { initialRelationship: c.autolife?.relationship?.initial ?? 20 });
            const chatCount = state.chatFile ? chatStore.readMessages(c.name, state.chatFile).length : 0;
            return { name: c.name, enabled: !!c.autolife.memory?.enabled, ...stats, chatMessages: chatCount, chatFile: state.chatFile };
        }).filter((c) => !name || c.name === name);
        res.json({ embedModel: settings.memory?.embed_model ?? 'nomic-embed-text', characters });
    }));

    router.post('/memory/rebuild', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${body.name}".` });
        memory.rebuild(entry.name);
        audit(entry.name, 'memory', 'memory index cleared — rebuilding from chat history');
        broadcast('memory', { character: entry.name, indexed: 0 });
        res.json({ ok: true });
    }));

    // ---- active chat sync (web UI tells the engine which chat is open) ----
    router.post('/chat-file', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${body.name}".` });
        let file = String(body.chatFile ?? '');
        if (!file.endsWith('.jsonl')) file += '.jsonl';
        if (!chatStore.listChats(entry.name).includes(file)) {
            return res.status(404).json({ error: `Chat file "${file}" not found for ${entry.name}.` });
        }
        const state = store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial ?? 20 });
        if (state.chatFile !== file) {
            state.chatFile = file;
            store.saveState(state);
            audit(entry.name, 'state_changed', `active chat switched to "${file}" (following the open web-UI chat)`);
            broadcast('state_changed', { character: entry.name });
        }
        res.json({ ok: true, chatFile: file });
    }));

    // ---- evolve (self-reflection notes) ----
    router.get('/evolve', wrap(async (req, res) => {
        const name = String(req.query?.name ?? '');
        const entry = cards.find(name);
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${name}".` });
        res.json({
            enabled: !!entry.autolife.evolve?.enabled,
            autoApply: !!entry.autolife.evolve?.auto_apply,
            notes: engine.evolveNotes(entry.name),
        });
    }));

    router.post('/evolve/reflect', wrap(async (req, res) => {
        const body = await readBody(req);
        try {
            const text = await engine.reflectNow(String(body.name ?? ''));
            res.json({ ok: true, text });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    }));

    router.post('/evolve/decide', wrap(async (req, res) => {
        const body = await readBody(req);
        try {
            const note = engine.decideNote(String(body.name ?? ''), String(body.ts ?? ''), String(body.action ?? ''));
            res.json({ ok: true, status: note.status });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    }));

    // ---- per-character panel: relationship + purge ----
    router.post('/relationship', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${body.name}".` });
        const score = Number(body.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) {
            return res.status(400).json({ error: 'score must be a number between 0 and 100.' });
        }
        const state = store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial ?? 20 });
        const before = Math.round(state.relationship);
        state.relationship = score;
        store.saveState(state);
        audit(entry.name, 'state_changed', `relationship set manually: ${before} -> ${Math.round(score)}`);
        broadcast('state_changed', { character: entry.name });
        res.json({ ok: true, relationship: Math.round(score) });
    }));

    router.post('/purge', wrap(async (req, res) => {
        const body = await readBody(req);
        const entry = cards.find(String(body.name ?? ''));
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${body.name}".` });
        memory.rebuild(entry.name);
        store.purgeState(entry.name);
        audit(entry.name, 'purged', 'runtime state purged — relationship, journal, pending replies and the memory index were wiped (chats and card kept); state recreated with card defaults');
        broadcast('state_changed', { character: entry.name });
        log(`purged runtime state for "${entry.name}"`);
        res.json({ ok: true });
    }));

    // ---- schedule preview (used by the panel's grid editor) ----
    router.get('/schedule/preview', wrap(async (req, res) => {
        const name = String(req.query?.name ?? '');
        const entry = cards.find(name);
        if (!entry?.autolife) return res.status(404).json({ error: `No autolife character "${name}".` });
        const normalized = normalizeAutolife(entry.autolifeRaw);
        const { evaluate } = await import('./schedule.js');
        const now = new Date();
        const timeline = [];
        for (let h = 0; h < 24; h++) {
            const probe = new Date(now);
            probe.setUTCHours(h, 0, 0, 0);
            const life = evaluate(normalized, probe);
            timeline.push({ hour: `${String(h).padStart(2, '0')}:00`, activity: life.activity, availability: life.availability, mood: life.mood });
        }
        res.json({ timezone: normalized.timezone, schedule: normalized.schedule, timeline });
    }));
}
