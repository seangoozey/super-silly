// Telegram Bot API transport: long-polling inbound, rate-limited outbound,
// typing indicator, file downloads for /upload.

const API_BASE = 'https://api.telegram.org';

export class TelegramTransport {
    /**
     * @param {{ token: string, allowedChatIds: number[], store: object, engine: object,
     *           cards: object, chatStore: object, commands: object, log?: (m:string)=>void,
     *           emit?: (t:string,d:object)=>void, fetchImpl?: typeof fetch,
     *           maxDocumentMb?: number }} deps
     */
    constructor(deps) {
        this.name = 'telegram';
        this.token = deps.token;
        this.allowedChatIds = deps.allowedChatIds ?? [];
        this.store = deps.store;
        this.engine = deps.engine;
        this.cards = deps.cards;
        this.chatStore = deps.chatStore;
        this.commands = deps.commands;
        this.log = deps.log ?? ((m) => console.log(`[Autolife:tg] ${m}`));
        this.emit = deps.emit ?? (() => {});
        this.fetchImpl = deps.fetchImpl ?? fetch;
        this.maxDocumentMb = deps.maxDocumentMb ?? 20;
        this.running = false;
        this.queues = new Map(); // chatId -> Promise chain for outbound pacing
    }

    get enabled() {
        return Boolean(this.token);
    }

    start() {
        if (!this.enabled) {
            this.log('no bot token configured — Telegram transport disabled (set it in the Autolife panel or TELEGRAM_BOT_TOKEN)');
            return;
        }
        this.running = true;
        this.#pollLoop();
    }

    stop() {
        this.running = false;
    }

    // ------------------------------------------------------------ bot api

    async api(method, params = {}) {
        const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false) {
            const desc = json.description ?? `HTTP ${res.status}`;
            const err = new Error(`Telegram ${method}: ${desc}`);
            err.code = res.status;
            err.description = String(desc);
            throw err;
        }
        return json.result;
    }

    async #downloadFile(fileId) {
        const info = await this.api('getFile', { file_id: fileId });
        const res = await this.fetchImpl(`${API_BASE}/file/bot${this.token}/${info.file_path}`);
        if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    // ------------------------------------------------------------ polling

    async #pollLoop() {
        this.log('started long-polling getUpdates');
        let offset = this.store.loadTelegramOffset();
        while (this.running) {
            try {
                const updates = await this.api('getUpdates', {
                    offset,
                    timeout: 25,
                    allowed_updates: ['message'],
                });
                for (const update of updates) {
                    offset = update.update_id + 1;
                    this.store.saveTelegramOffset(offset);
                    try {
                        await this.handleUpdate(update);
                    } catch (err) {
                        this.log(`update handler error: ${err?.stack ?? err}`);
                    }
                }
            } catch (err) {
                const conflict = err.code === 409 || /Conflict/i.test(err.description ?? '');
                const wait = conflict ? 15_000 : 5_000;
                if (conflict) this.log('another getUpdates poller is running (409) — retrying in 15s');
                else this.log(`poll error: ${err.message} — retrying in 5s`);
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    }

    async handleUpdate(update) {
        const msg = update.message;
        if (!msg) return;

        const chatId = msg.chat?.id;
        const fromId = msg.from?.id;
        if (!this.#isAllowed(chatId, fromId)) {
            this.log(`ignoring message from unauthorized chat ${chatId} (from ${fromId})`);
            return;
        }

        // commands first
        const text = msg.text ?? msg.caption ?? '';
        if (text.startsWith('/')) {
            await this.commands.handle(chatId, text);
            return;
        }

        // card upload as document
        if (msg.document) {
            await this.commands.handleUpload(chatId, msg.document);
            return;
        }

        if (!text) return; // stickers/photos/etc: v1 ignores

        const bindings = this.store.loadBindings();
        const binding = bindings[String(chatId)];
        if (!binding?.character) {
            await this.send(chatId, 'No character bound to this chat yet — send /chars and then /switch <name>.');
            return;
        }
        this.emit('telegram_inbound', { chatId, character: binding.character, text: text.slice(0, 80) });
        await this.engine.onInbound({ character: binding.character, mes: text, source: 'telegram' });
    }

    #isAllowed(chatId, fromId) {
        if (!this.allowedChatIds.length) return false; // empty allowlist = nobody (fail closed)
        return this.allowedChatIds.includes(Number(chatId)) || this.allowedChatIds.includes(Number(fromId));
    }

    // ------------------------------------------------------------ outbound

    /** Enqueue a text message, pacing to ~1 msg/sec per chat (Telegram limit). */
    send(chatId, text, extra = {}) {
        const queue = this.queues.get(chatId) ?? Promise.resolve();
        const job = queue
            .catch(() => {})
            .then(async () => {
                await new Promise((r) => setTimeout(r, 1100));
                return this.api('sendMessage', {
                    chat_id: chatId,
                    text: String(text).slice(0, 4000),
                    link_preview_options: { is_disabled: true },
                    ...extra,
                });
            });
        this.queues.set(chatId, job);
        return job;
    }

    /** Engine hook: character started composing — show typing in bound chats. */
    async onComposing(character) {
        if (!this.enabled) return;
        const bindings = this.store.loadBindings();
        for (const [chatId, b] of Object.entries(bindings)) {
            if (b?.character === character) {
                this.api('sendChatAction', { chat_id: Number(chatId), action: 'typing' }).catch(() => {});
            }
        }
    }

    /** Engine hook: deliver a generated message to every chat bound to the character. */
    async deliver(character, text) {
        const bindings = this.store.loadBindings();
        const targets = Object.entries(bindings).filter(([, b]) => b?.character === character).map(([chatId]) => Number(chatId));
        await Promise.all(targets.map((chatId) => this.send(chatId, text)));
    }

    /** Bind a telegram chat to a character (latest chat or a fresh one). */
    async bind(chatId, entry) {
        const bindings = this.store.loadBindings();
        const { file } = this.chatStore.getOrCreateChat(entry.name, entry.card?.data?.first_mes ?? null);
        bindings[String(chatId)] = { character: entry.name, chatFile: file };
        this.store.saveBindings(bindings);
        // point the character's active chat at this conversation
        const state = this.store.loadState(entry.name, { initialRelationship: entry.autolife?.relationship?.initial });
        state.chatFile = file;
        this.store.saveState(state);
        return file;
    }
}
