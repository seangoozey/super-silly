// Autolife UI extension.
// P1 chat-native: live incoming messages, typing bubble, life-status strip,
//    message provenance tags.
// P2 character integration: config lives inside SillyTavern's character
//    editor; character tiles get live status chips.
// P3 dashboard: monitor/audit/memory/telegram/model stay in the extensions
//    drawer panel (future: full overlay).
// Pairs with the `autolife` server plugin at /api/plugins/autolife/*.

const PLUGIN = '/api/plugins/autolife';
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

let ST; // SillyTavern context, filled at boot
const state = {
    enabled: new Set(),      // engine-managed character names
    installed: new Set(),    // locally installed ollama models
    charStatus: new Map(),   // name -> status entry from /status
    typingTimers: new Map(),
};

// ---------------------------------------------------------------- plugin API

async function api(path, method = 'GET', body = null) {
    const res = await fetch(PLUGIN + path, {
        method,
        headers: {
            ...(await ST.getRequestHeaders()),
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
}

function currentCharacterName() {
    if (ST?.characterId >= 0 && ST.characters?.[ST.characterId]?.name) {
        return ST.characters[ST.characterId].name;
    }
    return ST?.name2 ?? null;
}

// ---------------------------------------------------------------- generation interceptor
// For Autolife characters the engine owns ALL character output (delays,
// initiative…). SillyTavern's instant generation would break the sim, so we
// abort it here. Types we let through: quiet prompts and impersonation.

globalThis.autolifeGenerateInterceptor = async function (chat, contextSize, abort, type) {
    if (!ST) return;
    if (type === 'quiet' || type === 'impersonate') return;
    const characterName = currentCharacterName();
    if (!characterName) return; // no character / group chat: hands off
    if (!state.enabled.has(characterName)) return;
    abort(true);
};

// ---------------------------------------------------------------- dashboard panel (extensions drawer)

function panelHtml() {
    return `
    <div class="autolife-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Autolife</b>
                <span id="autolife_badge" class="autolife-muted">checking…</span>
            </div>
            <div class="inline-drawer-content">
                <div id="autolife_status" class="autolife-status-line">…</div>

                <div class="autolife-section">
                    <h4>Life monitor</h4>
                    <div style="overflow-x:auto;"><table class="autolife-monitor-table" id="autolife_monitor"></table></div>
                </div>

                <div class="autolife-section">
                    <h4>Audit log
                        <select id="autolife_audit_filter" style="font-size:0.85em; margin-left:8px;"></select>
                        <a class="autolife-btn" id="autolife_audit_refresh" title="reload"><i class="fa-solid fa-rotate"></i></a>
                    </h4>
                    <div class="autolife-muted">Every engine decision — replies (instant/delayed/ignored), initiative rolls and blocks, retries, memory recalls, journal notes. Also live in Telegram via /audit on.</div>
                    <div id="autolife_audit_feed" class="autolife-audit-feed"></div>
                </div>

                <div class="autolife-section">
                    <h4>Memory <span class="autolife-muted">(RAG over chat history)</span></h4>
                    <div class="autolife-form-grid">
                        <label>Embedding model (Ollama)</label>
                        <input type="text" id="autolife_embed_model" placeholder="nomic-embed-text">
                    </div>
                    <div style="margin-top:6px;">
                        <button class="menu_button autolife-btn" id="autolife_embed_save">Save model</button>
                        <span id="autolife_embed_msg" class="autolife-muted"></span>
                    </div>
                    <div class="autolife-muted" style="margin-top:4px;">Pulled automatically on first use (~274 MB for nomic-embed-text). Changing the model rebuilds all indexes.</div>
                    <div style="overflow-x:auto;"><table class="autolife-monitor-table" id="autolife_memory_table"></table></div>
                </div>

                <div class="autolife-section">
                    <h4>Telegram</h4>
                    <div class="autolife-form-grid">
                        <label>Bot token</label>
                        <input type="password" id="autolife_tg_token" placeholder="123456:ABC… (from @BotFather)">
                        <label>Allowed chat IDs</label>
                        <input type="text" id="autolife_tg_ids" placeholder="comma separated, e.g. 12345678">
                    </div>
                    <div style="margin-top:6px;">
                        <button class="menu_button autolife-btn" id="autolife_tg_save">Save & restart bridge</button>
                        <span id="autolife_tg_msg" class="autolife-muted"></span>
                    </div>
                    <div id="autolife_bindings" class="autolife-status-line"></div>
                    <div class="autolife-muted">In Telegram: /chars, /switch &lt;name&gt;, /status, /model, /upload a card file. Get your chat ID by messaging the bot once and checking the server log.</div>
                </div>

                <div class="autolife-section">
                    <h4>Model</h4>
                    <div class="autolife-form-grid">
                        <label>Current model</label>
                        <select id="autolife_model_select"></select>
                        <label>or enter any model</label>
                        <input type="text" id="autolife_model_free" placeholder="hf.co/user/repo:Q4_K_M">
                        <label>Thinking (engine replies)</label>
                        <select id="autolife_think">
                            <option value="off">off — fast short texts (default)</option>
                            <option value="on">on — model reasons first (thinking models)</option>
                            <option value="auto">auto — model template default</option>
                        </select>
                    </div>
                    <div style="margin-top:6px;">
                        <button class="menu_button autolife-btn" id="autolife_model_use">Use</button>
                        <button class="menu_button autolife-btn" id="autolife_model_pull">Pull</button>
                        <span id="autolife_model_msg" class="autolife-muted"></span>
                    </div>
                    <div id="autolife_pull_progress" style="display:none; margin-top:8px;">
                        <div class="autolife-status-line" id="autolife_pull_label"></div>
                        <div class="autolife-pull-bar"><div id="autolife_pull_fill"></div></div>
                        <div class="autolife-muted" id="autolife_pull_detail"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- character editor section (P2)
// Injected into SillyTavern's character editing panel so Autolife config sits
// next to description/personality instead of in a drawer.

function editorHtml() {
    return `
    <div class="autolife-editor-section">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Autolife — <span id="autolife_char_name">—</span></b>
            </div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="autolife_enable"> Enable Autolife for this character</label>
                <div id="autolife_editor" style="display:none; margin-top:8px;">
                    <div class="autolife-form-grid">
                        <label for="autolife_tz">Timezone (IANA)</label>
                        <input type="text" id="autolife_tz" placeholder="America/New_York" value="UTC">

                        <label>Quick reply chance</label>
                        <input type="number" id="autolife_quick" min="0" max="1" step="0.05" value="0.5">
                        <label>Delay minutes (min–max)</label>
                        <span><input type="number" id="autolife_dmin" min="0" max="1440" value="5" style="width:45%"> – <input type="number" id="autolife_dmax" min="0" max="1440" value="90" style="width:45%"></span>
                        <label>Busy delay multiplier</label>
                        <input type="number" id="autolife_busyx" min="0.1" max="100" step="0.1" value="3">
                        <label>Ignore chance</label>
                        <input type="number" id="autolife_ignore" min="0" max="1" step="0.01" value="0.05">
                        <label>Message length</label>
                        <select id="autolife_len"><option value="short">short</option><option value="medium">medium</option><option value="long">long</option></select>
                        <label>Catch-up after missed message</label>
                        <input type="checkbox" id="autolife_catchup" checked>
                    </div>

                    <div style="margin-top:8px;">
                        <b style="font-size:0.85em;">Weekly schedule</b>
                        <span class="autolife-muted"> (first match wins; unlisted times = free)</span>
                        <div class="autolife-sched-row autolife-sched-head" id="autolife_sched_head"></div>
                        <div id="autolife_sched_rows"></div>
                        <button class="menu_button autolife-btn" id="autolife_add_block">+ add block</button>
                    </div>

                    <div class="autolife-form-grid" style="margin-top:10px;">
                        <label>Initiative (texts you first)</label>
                        <input type="checkbox" id="autolife_init_on">
                        <label>Initiative min gap (min)</label>
                        <input type="number" id="autolife_init_gap" min="1" max="10080" value="120">
                        <label>Initiative max / day</label>
                        <input type="number" id="autolife_init_max" min="0" max="100" value="4">
                        <label>Double-text after (h, 0=off)</label>
                        <input type="number" id="autolife_followup" min="0" max="168" value="6">
                        <label>Relationship start (0–100)</label>
                        <input type="number" id="autolife_rel" min="0" max="100" value="20">
                        <label>Keep a private journal</label>
                        <input type="checkbox" id="autolife_journal" checked>
                        <label>Long-term memory (RAG)</label>
                        <input type="checkbox" id="autolife_mem_on" checked>
                        <label>Recalled texts per reply (0–10)</label>
                        <input type="number" id="autolife_mem_k" min="0" max="10" value="3">
                        <label>Memory index size (max entries)</label>
                        <input type="number" id="autolife_mem_max" min="100" max="100000" step="100" value="4000">
                    </div>

                    <div style="margin-top:10px;">
                        <button class="menu_button autolife-btn" id="autolife_save"><i class="fa-solid fa-floppy-disk"></i> Save card</button>
                        <button class="menu_button autolife-btn" id="autolife_force"><i class="fa-solid fa-bolt"></i> Force message now</button>
                        <span id="autolife_save_msg" class="autolife-muted"></span>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- schedule editor

function schedHeadHtml() {
    return DAY_LABELS.map((d) => `<span>${d}</span>`).join('')
        + '<span>start</span><span>end</span><span>activity</span><span>avail %</span><span></span>';
}

function schedRowHtml(block = {}) {
    const days = block.days ?? [0, 1, 2, 3, 4, 5, 6];
    const dayBoxes = DAY_LABELS.map((_, i) =>
        `<span style="text-align:center;"><input type="checkbox" data-day="${i}" ${days.includes(i) ? 'checked' : ''}></span>`).join('');
    return `
    <div class="autolife-sched-row">
        ${dayBoxes}
        <input type="text" class="autolife-start" value="${block.start ?? '09:00'}" maxlength="5">
        <input type="text" class="autolife-end" value="${block.end ?? '17:00'}" maxlength="5">
        <input type="text" class="autolife-activity" value="${block.activity ?? 'busy'}">
        <span><input type="number" class="autolife-avail" min="0" max="100" value="${Math.round((block.availability ?? 0.5) * 100)}" style="width:60px">%</span>
        <span><a class="autolife-btn autolife-del-block" title="remove"><i class="fa-solid fa-xmark"></i></a></span>
    </div>`;
}

function readSchedRows() {
    return $('#autolife_sched_rows .autolife-sched-row').toArray().map((row) => {
        const $r = $(row);
        return {
            days: $r.find('input[data-day]').toArray().filter((c) => c.checked).map((c) => Number(c.dataset.day)),
            start: $r.find('.autolife-start').val().trim(),
            end: $r.find('.autolife-end').val().trim(),
            activity: $r.find('.autolife-activity').val().trim() || 'busy',
            availability: Math.min(1, Math.max(0, Number($r.find('.autolife-avail').val()) / 100 || 0.5)),
            mood: null,
        };
    }).filter((b) => b.days.length > 0);
}

// ---------------------------------------------------------------- dashboard: status/monitor/audit/memory/model

async function refreshStatus() {
    try {
        const s = await api('/status');
        const tg = s.telegram?.enabled ? 'telegram on' : 'telegram off';
        const model = s.model?.current ?? '?';
        $('#autolife_badge').text(`running · ${tg}`);
        $('#autolife_status').text(
            `Engine ${s.engine.running ? 'running' : 'stopped'} · tick ${s.engine.tickSeconds}s · model ${model} · Ollama ${s.ollama?.version ?? 'unreachable'}`,
        );
        state.enabled = new Set(s.engine.characters.filter((c) => c.enabled && !c.paused).map((c) => c.name));
        state.charStatus = new Map(s.engine.characters.map((c) => [c.name, c]));
        renderMonitor(s.engine.characters);
        populateAuditFilter(s.engine.characters);
        updateChatStrip();
        applyCharacterChips();
        updateTypingBubble();
    } catch (err) {
        $('#autolife_badge').text('plugin unreachable');
        $('#autolife_status').text(`Could not reach the Autolife plugin — is it enabled in config.yaml? (${err.message})`);
    }
}

function renderMonitor(characters) {
    const $t = $('#autolife_monitor');
    if (!characters.length) {
        $t.html('<tr><td class="autolife-muted">No Autolife characters yet — open a character and configure it in the editor.</td></tr>');
        return;
    }
    const mins = (iso) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    const rows = characters.map((c) => {
        const avail = Math.round(c.availability * 100);
        const pending = c.pendingReply
            ? `reply in ${mins(c.pendingReply.dueAt)} min${c.pendingReply.attempts ? ` (retry ${c.pendingReply.attempts}/5)` : ''}`
            : '—';
        const init = c.initiative ?? {};
        const nextTxt = !init.enabled
            ? 'off'
            : init.blockedReason
                ? init.blockedReason.replace(/^(asleep\/unreachable|a reply to you is pending|generating right now).*$/, (m) => m.split(' (')[0].split(' — ')[0])
                : (init.nextEligibleAt ? `in ${mins(init.nextEligibleAt)} min` : 'eligible now');
        const buttons = `
            <a class="autolife-btn" data-force="${c.name}" title="force a message now"><i class="fa-solid fa-bolt"></i></a>
            <a class="autolife-btn" data-pause="${c.name}" data-paused="${c.paused ? 1 : 0}" title="${c.paused ? 'resume' : 'pause'}"><i class="fa-solid fa-${c.paused ? 'play' : 'pause'}"></i></a>`;
        return `<tr>
            <td><b>${c.name}</b>${c.paused ? ' <span class="autolife-muted">(paused)</span>' : ''}</td>
            <td>${c.activity}<div class="autolife-avail-bar"><div style="width:${avail}%"></div></div></td>
            <td>${c.localTime}</td>
            <td>rel ${Math.round(c.relationship)}</td>
            <td>${pending}</td>
            <td title="${init.blockedReason ?? 'initiative eligible'}">${nextTxt}</td>
            <td>${c.onTelegram ? 'tg ✓' : ''}</td>
            <td>${buttons}</td>
        </tr>`;
    });
    $t.html('<tr><th>character</th><th>doing</th><th>their time</th><th>rel</th><th>pending</th><th>next text</th><th></th><th></th></tr>' + rows.join(''));
}

// ---------------------------------------------------------------- audit log

function auditRow(entry) {
    const time = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour12: false }) : '';
    const who = entry.character ?? 'engine';
    return `<div class="autolife-audit-row" data-character="${who}">
        <span class="autolife-muted">${time}</span> <b>${who}</b> — ${entry.text ?? entry.kind}
    </div>`;
}

async function loadAudit() {
    try {
        const { entries } = await api('/audit?limit=80');
        $('#autolife_audit_feed').html(entries.map(auditRow).reverse().join('') || '<div class="autolife-muted">Nothing yet — engine decisions will appear here.</div>');
        applyAuditFilter();
    } catch { /* plugin offline */ }
}

function applyAuditFilter() {
    const filter = $('#autolife_audit_filter').val() || 'all';
    $('#autolife_audit_feed .autolife-audit-row').each((_, el) => {
        const show = filter === 'all' || el.dataset.character === filter;
        $(el).toggle(show);
    });
}

function populateAuditFilter(characters) {
    const current = $('#autolife_audit_filter').val() || 'all';
    const options = ['all', ...characters.map((c) => c.name)];
    $('#autolife_audit_filter').html(options.map((o) => `<option value="${o}" ${o === current ? 'selected' : ''}>${o === 'all' ? 'all' : o}</option>`).join(''));
}

// ---------------------------------------------------------------- memory section

async function loadMemorySection() {
    try {
        const m = await api('/memory');
        $('#autolife_embed_model').val(m.embedModel);
        const rows = m.characters.map((c) => {
            const pct = c.chatMessages ? Math.min(100, Math.round((c.entries / c.chatMessages) * 100)) : 0;
            return `<tr>
                <td><b>${c.name}</b>${c.enabled ? '' : ' <span class="autolife-muted">(off)</span>'}</td>
                <td>${c.entries} indexed</td>
                <td>${c.chatMessages} in chat${pct > 0 && pct < 100 ? ` · backfilling ${pct}%` : ''}</td>
                <td>${c.model ?? '—'}</td>
                <td><a class="autolife-btn" data-memrebuild="${c.name}" title="rebuild index from chat history"><i class="fa-solid fa-rotate-left"></i></a></td>
            </tr>`;
        });
        $('#autolife_memory_table').html(rows.length
            ? '<tr><th>character</th><th>memory</th><th>source</th><th>embed model</th><th></th></tr>' + rows.join('')
            : '<tr><td class="autolife-muted">No Autolife characters.</td></tr>');
    } catch { /* plugin offline */ }
}

// ---------------------------------------------------------------- character editor (P2)

async function loadCharacterEditor() {
    const name = currentCharacterName();
    $('#autolife_char_name').text(name ?? '—');
    if (!name) {
        $('#autolife_editor').hide();
        $('#autolife_enable').prop('checked', false);
        return;
    }
    try {
        const card = await api(`/card?name=${encodeURIComponent(name)}`);
        const a = card.autolife;
        $('#autolife_enable').prop('checked', !!a);
        $('#autolife_editor').toggle(!!a);
        if (!a) return;
        $('#autolife_tz').val(a.timezone ?? 'UTC');
        $('#autolife_quick').val(a.behavior.quick_reply_chance);
        $('#autolife_dmin').val(a.behavior.delay_minutes_min);
        $('#autolife_dmax').val(a.behavior.delay_minutes_max);
        $('#autolife_busyx').val(a.behavior.busy_delay_multiplier);
        $('#autolife_ignore').val(a.behavior.ignore_chance);
        $('#autolife_len').val(a.behavior.avg_message_length);
        $('#autolife_catchup').prop('checked', !!a.behavior.catch_up);
        $('#autolife_init_on').prop('checked', !!a.initiative.enabled);
        $('#autolife_init_gap').val(a.initiative.min_gap_minutes);
        $('#autolife_init_max').val(a.initiative.max_per_day);
        $('#autolife_followup').val(a.initiative.followup_on_unread_hours);
        $('#autolife_rel').val(a.relationship.initial);
        $('#autolife_journal').prop('checked', !!a.journal.enabled);
        $('#autolife_mem_on').prop('checked', a.memory?.enabled ?? true);
        $('#autolife_mem_k').val(a.memory?.retrieve_count ?? 3);
        $('#autolife_mem_max').val(a.memory?.max_entries ?? 4000);
        $('#autolife_sched_rows').html((a.schedule.length ? a.schedule : []).map(schedRowHtml).join(''));
    } catch {
        $('#autolife_enable').prop('checked', false);
        $('#autolife_editor').hide();
    }
}

function buildAutolifeFromForm() {
    return {
        version: '1.1',
        timezone: $('#autolife_tz').val().trim() || 'UTC',
        schedule: readSchedRows(),
        behavior: {
            quick_reply_chance: Number($('#autolife_quick').val()),
            delay_minutes_min: Number($('#autolife_dmin').val()),
            delay_minutes_max: Number($('#autolife_dmax').val()),
            busy_delay_multiplier: Number($('#autolife_busyx').val()),
            ignore_chance: Number($('#autolife_ignore').val()),
            catch_up: $('#autolife_catchup').prop('checked'),
            avg_message_length: $('#autolife_len').val(),
        },
        initiative: {
            enabled: $('#autolife_init_on').prop('checked'),
            min_gap_minutes: Number($('#autolife_init_gap').val()),
            max_per_day: Number($('#autolife_init_max').val()),
            followup_on_unread_hours: Number($('#autolife_followup').val()),
        },
        relationship: { initial: Number($('#autolife_rel').val()) },
        journal: { enabled: $('#autolife_journal').prop('checked') },
        memory: {
            enabled: $('#autolife_mem_on').prop('checked'),
            retrieve_count: Number($('#autolife_mem_k').val()),
            max_entries: Number($('#autolife_mem_max').val()),
        },
    };
}

async function saveCard() {
    const name = currentCharacterName();
    if (!name) return;
    const msg = $('#autolife_save_msg').text('saving…');
    try {
        const res = await api('/card', 'POST', { name, autolife: buildAutolifeFromForm() });
        msg.text(`saved ✓${res.warnings?.length ? ` (${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''})` : ''}`);
        refreshStatus();
    } catch (err) {
        msg.text(`error: ${err.message}`);
    }
    setTimeout(() => msg.text(''), 4000);
}

// ---------------------------------------------------------------- chat-native layer (P1)

function chatStripHtml() {
    return `
    <div id="autolife_chat_strip" class="autolife-chat-strip" style="display:none;">
        <span class="autolife-strip-name"></span>
        <span class="autolife-strip-activity"></span>
        <span class="autolife-avail-bar autolife-strip-bar"><div></div></span>
        <span class="autolife-strip-time autolife-muted"></span>
        <span class="autolife-strip-init autolife-muted"></span>
    </div>`;
}

function updateChatStrip() {
    const $strip = $('#autolife_chat_strip');
    if (!$strip.length) return;
    const name = currentCharacterName();
    const status = name ? state.charStatus.get(name) : null;
    if (!status || !state.enabled.has(name)) {
        $strip.hide();
        return;
    }
    $strip.show();
    $strip.find('.autolife-strip-name').text(`${name} · ${status.paused ? 'paused' : 'alive'}`);
    $strip.find('.autolife-strip-activity').text(status.activity + (status.mood ? ` (${status.mood})` : ''));
    $strip.find('.autolife-strip-bar > div').css('width', `${Math.round(status.availability * 100)}%`);
    $strip.find('.autolife-strip-time').text(status.localTime);
    const init = status.initiative ?? {};
    $strip.find('.autolife-strip-init').text(!init.enabled ? 'initiative off' : (init.blockedReason ? `next text: ${init.blockedReason}` : 'may text you any moment'));
}

function ensureTypingBubble() {
    let $b = $('#autolife_typing_bubble');
    if (!$b.length) {
        $b = $(`<div id="autolife_typing_bubble" class="mes autolife-typing-bubble" style="display:none;">
            <div class="mes_block"><div class="ch_name autolife-typing-name"></div>
            <div class="mes_text autolife-typing-text"><span class="autolife-dots"><i></i><i></i><i></i></span> <span class="autolife-typing-status"></span></div></div>
        </div>`);
        $('#chat').append($b);
    }
    return $b;
}

function updateTypingBubble() {
    const $b = ensureTypingBubble();
    const name = currentCharacterName();
    const status = name ? state.charStatus.get(name) : null;
    const open = name && state.enabled.has(name);
    if (!open || !status || status.paused) return $b.hide();

    if (status.pendingReply) {
        const due = new Date(status.pendingReply.dueAt);
        const mins = Math.max(0, Math.round((due.getTime() - Date.now()) / 60000));
        const label = mins > 0 ? `typing… (or busy — reply around ${due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${mins > 90 ? `, ~${Math.round(mins / 60)}h` : `, ~${mins}m`})` : 'typing…';
        $b.find('.autolife-typing-name').text(name);
        $b.find('.autolife-typing-status').text(label);
        return $b.show();
    }
    $b.hide();
}

function removeTypingBubble() {
    $('#autolife_typing_bubble').hide();
}

/**
 * Insert an engine-generated message into the OPEN chat live (no reload).
 * Falls back to a reload if the context API shape surprises us.
 */
async function insertLiveMessage(data) {
    const name = currentCharacterName();
    if (name !== data.character) {
        toast(`<b>${data.character}</b> texted you.`);
        return;
    }
    const generating = $('#mes_stop').is(':visible');
    if (generating) {
        toast(`<b>${data.character}</b> texted you — reload the chat when your generation finishes.`);
        return;
    }
    try {
        const chatId = (typeof ST.getCurrentChatId === 'function' ? ST.getCurrentChatId() : ST.chatId) ?? null;
        if (chatId && data.chatFile && !String(data.chatFile).replace(/\.jsonl$/, '').endsWith(String(chatId))) {
            toast(`<b>${data.character}</b> texted you in another chat.`);
            return;
        }
        const message = {
            name: data.character,
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: String(data.mes ?? ''),
            extra: { autolife_kind: data.kind ?? 'reply' },
            swipes: [String(data.mes ?? '')],
        };
        ST.chat.push(message);
        ST.addOneMessage(message, { type: 'normal', scroll: true });
        ST.saveChat();
    } catch (err) {
        // never lose the message — fall back to a reload
        try { ST.reloadCurrentChat(); } catch { toast(`<b>${data.character}</b> texted you.`); }
    }
}

/** Tag engine messages (⚡ initiative etc.) once rendered. */
const KIND_TAG = { initiative: '⚡', catchup: '↩', followup: '➤', reply: '' };

function annotateMessage(index) {
    try {
        const m = ST.chat?.[index];
        const kind = m?.extra?.autolife_kind;
        if (!kind || !KIND_TAG[kind]) return;
        $(`.mes[mesid="${index}"] .mes_text`).each((_, el) => {
            const $el = $(el);
            if (!$el.find('.autolife-msg-tag').length) {
                $el.prepend(`<span class="autolife-msg-tag" title="engine ${kind}">⚡</span>`);
            }
        });
    } catch { /* rendering shapes vary across ST versions */ }
}

function annotateVisibleMessages() {
    (ST.chat ?? []).forEach((m, i) => {
        if (m?.extra?.autolife_kind) annotateMessage(i);
    });
}

// ---------------------------------------------------------------- character tile chips (P2)

const chipFor = (status) => {
    if (!status) return null;
    if (status.paused) return { icon: '⏸', label: 'paused', cls: 'paused' };
    if (status.availability < 0.05) return { icon: '💤', label: status.activity, cls: 'asleep' };
    if (status.availability < 0.35) return { icon: '🏢', label: status.activity, cls: 'busy' };
    return { icon: '✨', label: 'free', cls: 'free' };
};

function applyCharacterChips() {
    if (!ST?.characters) return;
    $('#rm_print_characters_block .character_select').each((_, el) => {
        const $el = $(el);
        const chid = Number($el.attr('chid'));
        const character = ST.characters[chid];
        if (!character?.name) return;
        $el.find('.autolife-chip').remove();
        const status = state.charStatus.get(character.name);
        if (!status) return; // not an autolife character
        const chip = chipFor(status);
        const $name = $el.find('.ch_name');
        if ($name.length && chip) {
            $name.append(` <span class="autolife-chip autolife-chip-${chip.cls}" title="${status.activity} · ${status.localTime}">${chip.icon}</span>`);
        }
    });
}

function watchCharacterList() {
    const target = document.getElementById('rm_print_characters_block');
    if (!target) return;
    let timer = null;
    const reapply = () => {
        clearTimeout(timer);
        timer = setTimeout(applyCharacterChips, 200);
    };
    new MutationObserver(reapply).observe(target, { childList: true, subtree: true });
}

// ---------------------------------------------------------------- toasts

function toast(text, ms = 3500) {
    const $t = $(`<div class="autolife-toast">${text}</div>`).appendTo('body');
    setTimeout(() => $t.fadeOut(300, () => $t.remove()), ms);
}

// ---------------------------------------------------------------- pull progress widget

function fmtBytes(b) {
    if (!Number.isFinite(b) || b <= 0) return '';
    if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
    if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
    return `${Math.round(b / 1024)} KB`;
}

let pullDoneTimer = null;

function updatePullWidget(d) {
    const $w = $('#autolife_pull_progress');
    const $label = $('#autolife_pull_label');
    const $fill = $('#autolife_pull_fill');
    const $detail = $('#autolife_pull_detail');
    clearTimeout(pullDoneTimer);
    $w.show();
    $fill.removeClass('autolife-pull-error');

    if (d.status === 'success') {
        $label.text(`${d.model} ready ✓`);
        $fill.css('width', '100%');
        $detail.text('');
        pullDoneTimer = setTimeout(() => $w.fadeOut(500), 10_000);
        return;
    }
    if (/^failed/.test(d.status ?? '')) {
        $label.text(`${d.model} — pull failed`);
        $fill.addClass('autolife-pull-error');
        $detail.text(d.status);
        pullDoneTimer = setTimeout(() => $w.fadeOut(500), 20_000);
        return;
    }
    $label.text(`${d.model} — ${d.status}${d.layerCount ? ` (layer ${d.layerCount})` : ''}`);
    if (d.percent !== undefined) {
        $fill.css('width', `${Math.min(100, d.percent).toFixed(1)}%`);
        const parts = [`${fmtBytes(d.completed)} / ${fmtBytes(d.total)}`];
        if (d.speedBps > 0) {
            parts.push(`${fmtBytes(d.speedBps)}/s`);
            if (d.total > d.completed) {
                const secs = Math.round((d.total - d.completed) / d.speedBps);
                parts.push(`ETA ${secs > 5400 ? `${Math.round(secs / 3600)} h` : `${Math.max(1, Math.round(secs / 60))} min`}`);
            }
        }
        $detail.text(parts.join(' · '));
    } else {
        $fill.css('width', '0%');
        $detail.text('contacting registry…');
    }
}

// ---------------------------------------------------------------- telegram / model sections

async function loadTelegramSection() {
    try {
        const { settings } = await api('/settings');
        $('#autolife_tg_token').attr('placeholder', settings.telegram?.hasToken ? settings.telegram.token : '123456:ABC… (from @BotFather)');
        $('#autolife_tg_ids').val((settings.telegram?.allowed_chat_ids ?? []).join(', '));
        const { bindings } = await api('/bindings');
        const rows = Object.entries(bindings).map(([chatId, b]) =>
            `<tr><td>${chatId}</td><td>${b?.character ?? '?'}</td><td><a class="autolife-btn" data-unbind="${chatId}" title="unbind"><i class="fa-solid fa-link-slash"></i></a></td></tr>`);
        $('#autolife_bindings').html(rows.length ? `Bindings: <table>${rows.join('')}</table>` : 'No Telegram chats bound yet.');
    } catch { /* plugin offline; status line already shows it */ }
}

async function loadModelSection() {
    try {
        const m = await api('/model/list');
        const installed = new Set(m.local.map((l) => l.name));
        state.installedModels = installed;
        const options = [
            ...m.presets.map((p) => ({
                value: p,
                label: `${p}${p === m.current ? ' · in use' : installed.has(p) ? ' · installed' : ' · NOT downloaded'}`,
            })),
            ...m.local.filter((l) => !m.presets.includes(l.name)).map((l) => ({
                value: l.name,
                label: `${l.name}${l.name === m.current ? ' · in use' : ''}`,
            })),
        ];
        $('#autolife_model_select').html(options.map((o) => `<option value="${o.value}" ${o.value === m.current ? 'selected' : ''}>${o.label}</option>`).join(''));
        $('#autolife_think').val(m.think ?? 'off');
        refreshModelButtons();
    } catch { /* ignore */ }
}

/** Pull button reflects the chosen model's install state. */
function refreshModelButtons() {
    const chosen = $('#autolife_model_free').val().trim() || $('#autolife_model_select').val();
    const $pull = $('#autolife_model_pull');
    if (chosen && state.installedModels?.has(chosen)) {
        $pull.prop('disabled', true).text('Ready ✓');
    } else {
        $pull.prop('disabled', false).text('Pull');
    }
}

// ---------------------------------------------------------------- SSE

function connectEvents() {
    const es = new EventSource(PLUGIN + '/events');
    es.onmessage = (ev) => {
        let data;
        try {
            data = JSON.parse(ev.data);
        } catch {
            return;
        }
        switch (data.type) {
            case 'audit': {
                const $feed = $('#autolife_audit_feed');
                if ($feed.children().length === 0 || $feed.find('.autolife-muted').length === $feed.children().length) $feed.empty();
                $feed.prepend(auditRow(data));
                $feed.children().slice(120).remove();
                applyAuditFilter();
                break;
            }
            case 'character_message': {
                removeTypingBubble();
                refreshStatus();
                insertLiveMessage(data);
                break;
            }
            case 'deferred':
                refreshStatus();
                break;
            case 'ignored':
            case 'state_changed':
            case 'bindings_changed':
            case 'card_updated':
                refreshStatus();
                if (data.type === 'bindings_changed') loadTelegramSection();
                if (data.type === 'card_updated' && currentCharacterName() === data.character) loadCharacterEditor();
                break;
            case 'memory':
                loadMemorySection();
                break;
            case 'model_pull':
                updatePullWidget(data);
                if (data.status === 'success' || /^failed/.test(data.status ?? '')) {
                    loadModelSection();
                    refreshStatus();
                }
                break;
            case 'model_changed':
                loadModelSection();
                refreshStatus();
                break;
            default:
                break;
        }
    };
}

// ---------------------------------------------------------------- wiring

function wireEvents() {
    // --- editor ---
    $('#autolife_add_block').on('click', () => $('#autolife_sched_rows').append(schedRowHtml()));
    $(document).on('click', '.autolife-del-block', (ev) => $(ev.currentTarget).closest('.autolife-sched-row').remove());

    $('#autolife_enable').on('change', (ev) => {
        const on = ev.target.checked;
        $('#autolife_editor').toggle(on);
        if (!on) {
            const name = currentCharacterName();
            api('/enable', 'POST', { name, enabled: false }).then(refreshStatus).catch((e) => toast(`disable failed: ${e.message}`));
        }
    });

    $('#autolife_save').on('click', saveCard);

    $('#autolife_force').on('click', async () => {
        const name = currentCharacterName();
        if (!name) return;
        toast(`Asking ${name} to text you now…`);
        try {
            await api('/trigger', 'POST', { name, kind: 'initiative' });
        } catch (e) {
            toast(`failed: ${e.message}`);
        }
    });

    // --- monitor buttons ---
    $(document).on('click', '[data-force]', async (ev) => {
        const name = $(ev.currentTarget).data('force');
        toast(`Asking ${name} to text you now…`);
        api('/trigger', 'POST', { name, kind: 'initiative' }).catch((e) => toast(`failed: ${e.message}`));
    });

    $(document).on('click', '[data-pause]', (ev) => {
        const $el = $(ev.currentTarget);
        const paused = $el.data('paused') ? false : true; // toggle
        api('/pause', 'POST', { name: $el.data('pause'), paused }).then(refreshStatus).catch((e) => toast(e.message));
    });

    $(document).on('click', '[data-unbind]', (ev) => {
        api('/bindings/delete', 'POST', { chatId: String($(ev.currentTarget).data('unbind')) })
            .then(loadTelegramSection).catch((e) => toast(e.message));
    });

    // --- audit ---
    $('#autolife_audit_filter').on('change', applyAuditFilter);
    $('#autolife_audit_refresh').on('click', loadAudit);

    // --- memory ---
    $('#autolife_embed_save').on('click', async () => {
        const model = $('#autolife_embed_model').val().trim();
        const msg = $('#autolife_embed_msg').text('saving…');
        try {
            await api('/settings', 'POST', { memory: { embed_model: model } });
            msg.text('saved ✓ — indexes rebuild automatically');
            loadMemorySection();
        } catch (e) { msg.text(`error: ${e.message}`); }
        setTimeout(() => msg.text(''), 5000);
    });

    $(document).on('click', '[data-memrebuild]', (ev) => {
        const name = $(ev.currentTarget).data('memrebuild');
        api('/memory/rebuild', 'POST', { name }).then(loadMemorySection).catch((e) => toast(e.message));
    });

    // --- telegram ---
    $('#autolife_tg_save').on('click', async () => {
        const token = $('#autolife_tg_token').val().trim();
        const ids = $('#autolife_tg_ids').val().split(/[,\s]+/).map((s) => Number(s.trim())).filter(Number.isFinite);
        const msg = $('#autolife_tg_msg').text('saving…');
        try {
            await api('/settings', 'POST', { telegram: { token: token || undefined, allowed_chat_ids: ids, restart: true } });
            msg.text('saved ✓ — bridge restarting');
            $('#autolife_tg_token').val('');
            loadTelegramSection();
            refreshStatus();
        } catch (e) {
            msg.text(`error: ${e.message}`);
        }
        setTimeout(() => msg.text(''), 4000);
    });

    // --- model ---
    const chosenModel = () => $('#autolife_model_free').val().trim() || $('#autolife_model_select').val();
    $('#autolife_model_select').on('change', refreshModelButtons);
    $('#autolife_model_free').on('input', refreshModelButtons);
    $('#autolife_model_use').on('click', async () => {
        try {
            await api('/model/use', 'POST', { model: chosenModel() });
            toast(`Switched model to ${chosenModel()}`);
            loadModelSection();
        } catch (e) { toast(e.message); }
    });
    $('#autolife_model_pull').on('click', async () => {
        try {
            const model = chosenModel();
            await api('/model/pull', 'POST', { model });
            updatePullWidget({ model, status: 'starting' });
        } catch (e) { toast(e.message); }
    });
    $('#autolife_think').on('change', async (ev) => {
        const think = ev.target.value;
        try {
            await api('/settings', 'POST', { model: { think } });
            toast(`Thinking set to ${think}`);
        } catch (e) { toast(e.message); }
    });
}

// user messages from the web UI -> engine (decides delay/ignore/…)
function onUserMessage() {
    const name = currentCharacterName();
    if (!name || !state.enabled.has(name)) return;
    const chat = ST.chat ?? [];
    const last = chat[chat.length - 1];
    if (!last?.is_user) return;
    updateTypingBubble();
    api('/inbound', 'POST', { character: name, mes: String(last.mes ?? '') }).then(() => refreshStatus()).catch(() => {});
}

// ---------------------------------------------------------------- bootstrap

jQuery(() => {
    const init = async () => {
        ST = (window.SillyTavern?.getContext) ? window.SillyTavern.getContext() : null;
        if (!ST) return setTimeout(init, 500);

        // dashboard panel in the extensions drawer
        $('#extensions_settings2').append(panelHtml());
        $('#autolife_sched_head').html(schedHeadHtml());

        // character config inside ST's character editor (falls back to the drawer)
        const $editor = $('#character_editing');
        if ($editor.length) {
            $editor.append(editorHtml());
        } else {
            // no editor panel found (unexpected ST layout) — keep it reachable
            $('#extensions_settings2').find('.autolife-panel').prepend(editorHtml());
        }

        // chat strip above the chat
        $('#chat').before(chatStripHtml());

        wireEvents();

        ST.eventSource.on(ST.event_types.APP_READY, () => {
            connectEvents();
            refreshStatus();
            loadTelegramSection();
            loadModelSection();
            loadAudit();
            loadMemorySection();
            loadCharacterEditor();
            watchCharacterList();
            setInterval(refreshStatus, 30_000);
            setInterval(loadAudit, 120_000);
            setInterval(() => { updateChatStrip(); updateTypingBubble(); }, 15_000);
        });
        ST.eventSource.on(ST.event_types.CHAT_CHANGED, () => {
            loadCharacterEditor();
            refreshStatus();
            removeTypingBubble();
            annotateVisibleMessages();
        });
        ST.eventSource.on(ST.event_types.MESSAGE_SENT, onUserMessage);
        ST.eventSource.on(ST.event_types.MESSAGE_RECEIVED, () => removeTypingBubble());
        ST.eventSource.on(ST.event_types.CHARACTER_MESSAGE_RENDERED, (idx) => {
            try { annotateMessage(typeof idx === 'number' ? idx : Number(idx?.messageId ?? idx)); } catch { /* noop */ }
        });

        loadCharacterEditor();
    };
    init();
});
