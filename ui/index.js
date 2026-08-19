// Autolife UI extension: card builder panel + life monitor + Telegram/model setup.
// Pairs with the `autolife` server plugin (same origin, /api/plugins/autolife/*).

const PLUGIN = '/api/plugins/autolife';
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

let ST; // SillyTavern context, filled on APP_READY
const state = {
    enabled: new Set(), // character names the engine handles (autolife present + enabled)
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

// ---------------------------------------------------------------- helpers

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

// ---------------------------------------------------------------- panel HTML

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

                <div class="autolife-section" id="autolife_editor_section">
                    <h4>This character</h4>
                    <label><input type="checkbox" id="autolife_enable"> Enable Autolife for <span id="autolife_char_name">—</span></label>
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

                <div class="autolife-section">
                    <h4>Life monitor</h4>
                    <div style="overflow-x:auto;"><table class="autolife-monitor-table" id="autolife_monitor"></table></div>
                </div>

                <div class="autolife-section">
                    <h4>Audit log
                        <select id="autolife_audit_filter" style="font-size:0.85em; margin-left:8px;"></select>
                        <a class="autolife-btn" id="autolife_audit_refresh" title="reload"><i class="fa-solid fa-rotate"></i></a>
                    </h4>
                    <div class="autolife-muted">Every engine decision — replies (instant/delayed/ignored), initiative rolls and blocks, retries, journal notes. Also live in Telegram via /audit on.</div>
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

// ---------------------------------------------------------------- panel logic

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
        renderMonitor(s.engine.characters);
        populateAuditFilter(s.engine.characters);
    } catch (err) {
        $('#autolife_badge').text('plugin unreachable');
        $('#autolife_status').text(`Could not reach the Autolife plugin — is it enabled in config.yaml? (${err.message})`);
    }
}

function renderMonitor(characters) {
    const $t = $('#autolife_monitor');
    if (!characters.length) {
        $t.html('<tr><td class="autolife-muted">No Autolife characters yet — open a character and configure it above.</td></tr>');
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

async function loadCharacterEditor() {
    const name = currentCharacterName();
    $('#autolife_char_name').text(name ?? '—');
    if (!name) {
        $('#autolife_editor').hide();
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

// ---------------------------------------------------------------- toasts / typing

function toast(text, ms = 3500) {
    const $t = $(`<div class="autolife-toast">${text}</div>`).appendTo('body');
    setTimeout(() => $t.fadeOut(300, () => $t.remove()), ms);
}

function showTyping(character) {
    const $last = $('#chat .mes.last_mes');
    if ($last.length && !$last.find('.autolife-typing').length) {
        $last.find('.mes_block').append(`<div class="autolife-typing">${character} is typing… (or busy, or asleep — they'll get back to you)</div>`);
    }
    clearTimeout(state.typingTimers.get(character));
    state.typingTimers.set(character, setTimeout(() => $('.autolife-typing').remove(), 10 * 60 * 1000));
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
                if ($feed.find('.autolife-muted-only').length || $feed.children().length === 0) $feed.empty();
                $feed.prepend(auditRow(data));
                $feed.children().slice(120).remove();
                applyAuditFilter();
                break;
            }
            case 'character_message': {
                $('.autolife-typing').remove();
                refreshStatus();
                const open = currentCharacterName();
                if (open === data.character) {
                    const generating = $('#mes_stop').is(':visible');
                    if (!generating && !$('#send_textarea').is(':focus')) {
                        ST.reloadCurrentChat();
                    } else {
                        toast(`<b>${data.character}</b> texted you — reload the chat when ready.`);
                    }
                } else {
                    toast(`<b>${data.character}</b> texted you.`);
                }
                break;
            }
            case 'deferred':
                showTyping(data.character);
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
            case 'model_pull':
                updatePullWidget(data);
                if (data.status === 'success' || /^failed/.test(data.status ?? '')) {
                    loadModelSection();
                    refreshStatus();
                }
                break;
            case 'memory':
                loadMemorySection();
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
    $('#autolife_add_block').on('click', () => $('#autolife_sched_rows').append(schedRowHtml()));
    $(document).on('click', '.autolife-del-block', (ev) => $(ev.currentTarget).closest('.autolife-sched-row').remove());

    $('#autolife_enable').on('change', (ev) => {
        const on = ev.target.checked;
        $('#autolife_editor').toggle(on);
        if (!on) {
            const name = ST.name2;
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

    $('#autolife_audit_filter').on('change', applyAuditFilter);
    $('#autolife_audit_refresh').on('click', loadAudit);

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

    $('#autolife_think').on('change', async (ev) => {
        const think = ev.target.value;
        try {
            await api('/settings', 'POST', { model: { think } });
            toast(`Thinking set to ${think}`);
        } catch (e) { toast(e.message); }
    });

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
}

// user messages from the web UI -> engine (decides delay/ignore/…)
function onUserMessage() {
    const name = currentCharacterName();
    if (!name || !state.enabled.has(name)) return;
    const chat = ST.chat ?? [];
    const last = chat[chat.length - 1];
    if (!last?.is_user) return;
    showTyping(name);
    api('/inbound', 'POST', { character: name, mes: String(last.mes ?? '') }).catch(() => {});
}

// ---------------------------------------------------------------- bootstrap

jQuery(() => {
    const init = async () => {
        ST = (window.SillyTavern?.getContext) ? window.SillyTavern.getContext() : null;
        if (!ST) return setTimeout(init, 500);

        $('#extensions_settings2').append(panelHtml());
        $('#autolife_sched_head').html(schedHeadHtml());
        wireEvents();

        ST.eventSource.on(ST.event_types.APP_READY, () => {
            connectEvents();
            refreshStatus();
            loadTelegramSection();
            loadModelSection();
            loadAudit();
            loadMemorySection();
            setInterval(refreshStatus, 30_000);
            setInterval(loadAudit, 120_000);
        });
        ST.eventSource.on(ST.event_types.CHAT_CHANGED, () => {
            loadCharacterEditor();
            refreshStatus();
        });
        ST.eventSource.on(ST.event_types.MESSAGE_SENT, onUserMessage);
        ST.eventSource.on(ST.event_types.MESSAGE_RECEIVED, () => $('.autolife-typing').remove());

        loadCharacterEditor();
    };
    init();
});
