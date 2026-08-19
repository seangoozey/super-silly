// Reads and writes SillyTavern chat files (JSONL) in the exact format ST uses:
//   data/<user>/chats/<character>/<file>.jsonl
//   line 1: header { chat_metadata, user_name, character_name }
//   lines:  messages { name, is_user, is_system?, mes, send_date, extra, swipes }
// SillyTavern tolerates extra/missing optional fields on load; we keep to the
// minimal shape its own importers produce.

import fs from 'node:fs';
import path from 'node:path';
import { safeName } from './card-io.js';

export class ChatStore {
    /**
     * @param {{ dataRoot: string, userHandle?: string, userName?: string }} opts
     */
    constructor(opts) {
        this.dataRoot = opts.dataRoot;
        this.userHandle = opts.userHandle ?? 'default-user';
        this.userName = opts.userName ?? 'User';
    }

    get userDir() {
        return path.join(this.dataRoot, this.userHandle);
    }

    chatDir(character) {
        return path.join(this.userDir, 'chats', safeName(character));
    }

    static stamp(date = new Date()) {
        const p = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}@${p(date.getHours())}h${p(date.getMinutes())}m${p(date.getSeconds())}s`;
    }

    chatFileName(character, date = new Date()) {
        return `${safeName(character)} - ${ChatStore.stamp(date)}.jsonl`;
    }

    listChats(character) {
        const dir = this.chatDir(character);
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .map((x) => x.file);
    }

    /**
     * Latest existing chat, or null.
     * @returns {string|null} file name
     */
    latestChat(character) {
        return this.listChats(character)[0] ?? null;
    }

    /**
     * Create a new chat file seeded with the character greeting.
     * @returns {string} file name
     */
    createChat(character, greeting = null) {
        const dir = this.chatDir(character);
        fs.mkdirSync(dir, { recursive: true });
        const file = this.chatFileName(character);
        const header = {
            chat_metadata: {},
            user_name: this.userName,
            character_name: character,
        };
        const lines = [JSON.stringify(header)];
        if (greeting) {
            lines.push(JSON.stringify(ChatStore.characterMessage(character, this.substituteMacros(greeting, character))));
        }
        fs.writeFileSync(path.join(dir, file), lines.join('\n'), 'utf8');
        return file;
    }

    /**
     * Pick the latest chat or create one with the given greeting.
     * @returns {{ file: string, created: boolean }}
     */
    getOrCreateChat(character, greeting = null) {
        const existing = this.latestChat(character);
        if (existing) return { file: existing, created: false };
        return { file: this.createChat(character, greeting), created: true };
    }

    /**
     * Read all messages (excluding the header line) of a chat, newest last.
     * @returns {Array<object>}
     */
    readMessages(character, file, limit = Infinity) {
        const full = path.join(this.chatDir(character), file);
        if (!fs.existsSync(full)) return [];
        const content = fs.readFileSync(full, 'utf8');
        const messages = [];
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let obj;
            try {
                obj = JSON.parse(line);
            } catch {
                continue;
            }
            if (obj && typeof obj === 'object' && obj.chat_metadata !== undefined) continue; // header
            messages.push(obj);
        }
        return Number.isFinite(limit) && messages.length > limit ? messages.slice(-limit) : messages;
    }

    /**
     * Append one message object to a chat (creating the file with a header if missing).
     * @param {string} character
     * @param {string} file
     * @param {object} message
     */
    appendMessage(character, file, message) {
        const dir = this.chatDir(character);
        fs.mkdirSync(dir, { recursive: true });
        const full = path.join(dir, file);
        const line = JSON.stringify(message);
        if (fs.existsSync(full)) {
            let content = fs.readFileSync(full, 'utf8');
            if (content.length && !content.endsWith('\n')) content += '\n';
            fs.writeFileSync(full, content + line + '\n', 'utf8');
        } else {
            const header = { chat_metadata: {}, user_name: this.userName, character_name: character };
            fs.writeFileSync(full, `${JSON.stringify(header)}\n${line}\n`, 'utf8');
        }
    }

    substituteMacros(text, character) {
        return String(text ?? '')
            .replaceAll('{{char}}', character)
            .replaceAll('{{user}}', this.userName);
    }

    /**
     * Recover the user's real persona name from existing SillyTavern chat
     * headers (ST stores user_name on the header line). Returns null when no
     * real name has ever been used — callers fall back to the configured or
     * default name.
     */
    resolveUserName() {
        if (this._resolvedUserName) return this._resolvedUserName;
        try {
            const chatsRoot = path.join(this.userDir, 'chats');
            if (!fs.existsSync(chatsRoot)) return null;
            for (const dir of fs.readdirSync(chatsRoot)) {
                const dirPath = path.join(chatsRoot, dir);
                if (!fs.statSync(dirPath).isDirectory()) continue;
                const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')).sort().reverse();
                for (const file of files) {
                    try {
                        const header = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8').split('\n')[0]);
                        const name = header?.user_name?.trim();
                        if (name && name !== 'User' && name !== 'unused') {
                            this._resolvedUserName = name;
                            return name;
                        }
                    } catch { /* skip unreadable chat */ }
                }
            }
        } catch { /* no chats at all */ }
        return null;
    }

    // ---- message factories (ST-compatible minimal shape) ----

    static userMessage(userName, mes, date = new Date()) {
        return {
            name: userName,
            is_user: true,
            is_system: false,
            send_date: date.toISOString(),
            mes: String(mes),
            extra: {},
            swipes: [String(mes)],
        };
    }

    static characterMessage(character, mes, date = new Date(), extra = {}) {
        return {
            name: character,
            is_user: false,
            is_system: false,
            send_date: date.toISOString(),
            mes: String(mes),
            extra,
            swipes: [String(mes)],
        };
    }

    userMessage(mes, date = new Date(), extra = {}) {
        return ChatStore.userMessage(this.userName, mes, date, extra);
    }

    characterMessage(character, mes, date = new Date(), extra = {}) {
        return ChatStore.characterMessage(character, mes, date, extra);
    }
}
