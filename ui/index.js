// Autolife UI extension.
// P1 chat-native: live incoming messages, typing bubble, life-status strip,
//    message provenance tags.
// P2 character integration: config lives inside SillyTavern's character
//    editor; character tiles get live status chips.
// P3 dashboard: monitor/audit/memory/telegram/model stay in the extensions
//    drawer panel (future: full overlay).
// Pairs with the `autolife` server plugin at /api/plugins/autolife/*.

const PLUGIN = '/api/plugins/autolife';
const EXT_VERSION = '0.6.19';
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
    let res;
    try {
        res = await fetch(PLUGIN + path, {
            method,
            headers: {
                ...(await ST.getRequestHeaders()),
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        showReloadBanner();
        throw new Error(`server unreachable — was the container rebuilt? Reload the page. (${err.message})`);
    }
    if (res.status === 403) {
        // CSRF/session invalidated server-side: the classic case is the page
        // surviving a container rebuild. Nothing will work until reload.
        showReloadBanner();
        throw new Error('session expired — the server was restarted (rebuilt?). Reload the page (Ctrl-Shift-R).');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
}

function showReloadBanner() {
    if ($('#autolife_reload_banner').length) return;
    $('<div id="autolife_reload_banner" class="autolife-toast autolife-reload-banner">⚠️ Autolife: the server was restarted (container rebuilt?) and this page\'s session is stale. <b>Reload the page (Ctrl-Shift-R)</b> — ST saves will keep failing until you do.</div>').appendTo('body');
}

function currentCharacterName() {
    // When the editor (or its Advanced Definitions popup) is open, the name
    // pole holds the character being edited — in those states ST's context
    // vars can point at the hidden "SillyTavern System" character instead.
    const poleVisible = $('#character_popup').is(':visible') || $('#rm_ch_create_block').is(':visible');
    const pole = String($('#character_name_pole').val() ?? '').trim();
    if (poleVisible && pole) return pole;
    // Otherwise resolve from chat context. Try the name directly against our
    // status map first (works in chat view regardless of cards-array quirks),
    // then accept any name that maps to a real character card.
    const n2 = String(ST?.name2 ?? '').trim();
    if (n2 && state.charStatus.has(n2)) return n2;
    const isCard = (n) => Boolean(n) && Boolean(ST?.characters?.some((c) => c?.name === n));
    if (isCard(n2)) return n2;
    const byId = ST?.characterId >= 0 ? ST.characters?.[ST.characterId]?.name : null;
    if (isCard(byId)) return byId;
    return null;
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

// ---------------------------------------------------------------- dashboard: drawer entry (launcher) + full overlay

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
                <div id="autolife_connect_hint" class="autolife-status-line" style="display:none; color:#e0b060;"></div>
                <div style="margin-top:6px;">
                    <button type="button" class="menu_button autolife-btn" id="autolife_open_dashboard"><i class="fa-solid fa-expand"></i> Open Autolife dashboard</button>
                    <div class="autolife-muted" style="margin-top:4px;">Also on the top bar: <i class="fa-solid fa-heart-pulse"></i></div>
                </div>
            </div>
        </div>
    </div>`;
}

function dashboardHtml() {
    return `
    <div id="autolife_dashboard" class="autolife-dashboard" style="display:none;">
        <div class="autolife-dashboard-head">
            <b><i class="fa-solid fa-heart-pulse"></i> Autolife</b>
            <span id="autolife_dash_status" class="autolife-muted"></span>
            <a class="autolife-btn" id="autolife_dashboard_close" title="close (Esc)"><i class="fa-solid fa-xmark"></i></a>
        </div>
        <div class="autolife-dashboard-body">
            <div class="autolife-dash-col">

                <div class="autolife-section" style="border-top:none;">
                    <h4>Engine</h4>
                    <div class="autolife-form-grid">
                        <label>Your name (as characters see you)</label>
                        <span><input type="text" id="autolife_persona_name" placeholder="auto — your default ST persona">
                        <button type="button" class="menu_button autolife-btn" id="autolife_persona_save">Save</button></span>
                        <label>Samplers — temp / top_p / top_k / rep_pen</label>
                        <span>
                            <input type="text" id="autolife_samplers_temp" style="width:52px" placeholder="0.7"> /
                            <input type="text" id="autolife_samplers_top_p" style="width:52px" placeholder="1"> /
                            <input type="text" id="autolife_samplers_top_k" style="width:52px" placeholder="0"> /
                            <input type="text" id="autolife_samplers_rep_pen" style="width:52px" placeholder="1">
                            <button type="button" class="menu_button autolife-btn" id="autolife_samplers_save">Save</button>
                            <span id="autolife_samplers_msg" class="autolife-muted"></span>
                        </span>
                        <label>llama.cpp samplers — top_n_sigma / xtc_prob / xtc_thresh</label>
                        <span>
                            <input type="text" id="autolife_samplers_nsigma" style="width:52px" placeholder="1.2"> /
                            <input type="text" id="autolife_samplers_xtc_p" style="width:52px" placeholder="0.33"> /
                            <input type="text" id="autolife_samplers_xtc_t" style="width:52px" placeholder="0.05">
                            <span class="autolife-muted">ReadyArt's full recipe (0 = off); Ollama ignores these</span>
                        </span>
                        <label>Availability shapes tone</label>
                        <input type="checkbox" id="autolife_availability_tone" checked>
                        <label>Relationship speeds replies</label>
                        <input type="checkbox" id="autolife_relationship_speed" checked>
                        <label>Follow-up bursts ({follow-up} double-texts)</label>
                        <input type="checkbox" id="autolife_engine_bursts">
                        <label>Memory RAG (global)</label>
                        <input type="checkbox" id="autolife_feature_memory" checked>
                        <label>Journal (global)</label>
                        <input type="checkbox" id="autolife_feature_journal" checked>
                        <label>Evolve (global)</label>
                        <input type="checkbox" id="autolife_feature_evolve" checked>
                        <label>Invent concrete schedule activities</label>
                        <input type="checkbox" id="autolife_feature_enhance" checked>
                        <label>Journal entries in prompts</label>
                        <input type="number" id="autolife_reflect_journal" min="1" max="20" value="3">
                        <label>Evolution notes in prompts</label>
                        <input type="number" id="autolife_reflect_evolve" min="1" max="20" value="6">
                        <label>Quiet hours (your sleep)</label>
                        <span><input type="checkbox" id="autolife_quiet_enabled">
                        <input type="text" id="autolife_quiet_start" style="width:52px" placeholder="23:00"> –
                        <input type="text" id="autolife_quiet_end" style="width:52px" placeholder="07:00">
                        <input type="text" id="autolife_quiet_tz" style="width:110px" placeholder="America/New_York"></span>
                    </div>
                    <div style="margin-top:6px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_engine_save">Save engine settings</button>
                        <span id="autolife_engine_msg" class="autolife-muted"></span>
                    </div>
                    <div class="autolife-muted">Tone: busy characters text short/distracted, relaxed evenings may ramble. Speed: close relationships reply up to 3x faster. Quiet hours: no engine texts inside the window; due replies hold until it ends.</div>
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
                    <div class="autolife-muted">Every engine decision — replies (instant/delayed/ignored), initiative rolls and blocks, retries, model fallbacks, memory recalls, journal notes. Also live in Telegram via /audit on.</div>
                    <div id="autolife_audit_feed" class="autolife-audit-feed"></div>
                </div>

                <div class="autolife-section" id="autolife_plog_section">
                    <h4>Prompt log <span class="autolife-muted">(debug repeats — full text)</span>
                        <select id="autolife_plog_filter" style="font-size:0.85em; margin-left:8px;"></select>
                        <a class="autolife-btn" id="autolife_plog_refresh" title="reload"><i class="fa-solid fa-rotate"></i></a>
                        <a class="autolife-btn" id="autolife_plog_purge" title="delete all entries"><i class="fa-solid fa-trash-can"></i></a>
                    </h4>
                    <div class="autolife-form-grid">
                        <label>Capture every prompt sent to the model</label>
                        <span><input type="checkbox" id="autolife_plog_enabled">
                        keep newest <input type="number" id="autolife_plog_keep" min="10" max="5000" step="50" style="width:64px" value="500">
                        <button type="button" class="menu_button autolife-btn" id="autolife_plog_save">Save</button>
                        <span id="autolife_plog_msg" class="autolife-muted"></span></span>
                    </div>
                    <div class="autolife-muted">One full-text file per generation (replies, retries, bursts, journal, evolve, web chats) — click an entry to inspect the exact messages, samplers, and raw response.</div>
                    <div id="autolife_plog_feed" class="autolife-audit-feed"></div>
                </div>
                <div id="autolife_plog_viewer" style="display:none; position:fixed; inset:0; z-index:4000; background:rgba(0,0,0,0.6); overflow:auto; padding:24px;">
                    <div style="max-width:900px; margin:0 auto; background:var(--SmartThemeBlurTintColor, #1b1b1e); color:var(--SmartThemeBodyColor, #ddd); border:1px solid var(--SmartThemeBorderColor, #555); border-radius:8px; padding:16px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <b id="autolife_plog_viewer_title"></b>
                            <a class="autolife-btn" id="autolife_plog_viewer_close"><i class="fa-solid fa-xmark"></i> close</a>
                        </div>
                        <div id="autolife_plog_viewer_body"></div>
                    </div>
                </div>

                <div class="autolife-section">
                    <h4>Internal directives <span class="autolife-muted">(the engine's per-turn instructions)</span></h4>
                    <div class="autolife-form-grid">
                        <label>Initiative <span class="autolife-muted">(she texts first)</span></label>
                        <textarea id="autolife_dir_initiative" rows="3" style="width:100%" placeholder="(built-in default — leave empty to use it)"></textarea>
                        <label>Follow-up <span class="autolife-muted">(nudge after no reply)</span></label>
                        <textarea id="autolife_dir_followup" rows="3" style="width:100%" placeholder="(built-in default)"></textarea>
                        <label>Catch-up <span class="autolife-muted">(answering a missed message)</span></label>
                        <textarea id="autolife_dir_catchup" rows="3" style="width:100%" placeholder="(built-in default)"></textarea>
                        <label>Burst <span class="autolife-muted">(double-texts / {follow-up} chains)</span></label>
                        <textarea id="autolife_dir_burst" rows="3" style="width:100%" placeholder="(built-in default)"></textarea>
                    </div>
                    <div style="margin-top:6px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_dir_save">Save directives</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_dir_restore">Restore defaults</button>
                        <span id="autolife_dir_msg" class="autolife-muted"></span>
                    </div>
                    <div class="autolife-muted">The boxes always show what is currently sent. Saving the built-in wording unchanged keeps you linked to it (future default improvements apply); custom text supports {{user}} and {{char}}. Everything is visible verbatim in the prompt log.</div>
                </div>

                <div class="autolife-section">
                    <h4>Prompt template <span class="autolife-muted">(global default)</span></h4>
                    <div class="autolife-muted">Applies to every character; a character's own template (Autolife panel → Prompt) overrides it. The box shows the current effective template; saving the built-in assembly unchanged keeps you linked to it. Placeholders: {{card_system}} {{identity}} {{description}} {{personality}} {{scenario}} {{about_user}} {{evolve}} {{life}} {{relationship}} {{journal}} {{style}} {{post_history}} {{time}} {{weekday}} {{activity}} {{char}} {{user}}.</div>
                    <textarea id="autolife_prompt_global" rows="6" style="width:100%; margin-top:4px;" placeholder="built-in assembly"></textarea>
                    <div style="margin-top:4px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_prompt_global_save">Save template</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_prompt_global_restore">Restore defaults</button>
                        <span id="autolife_prompt_global_msg" class="autolife-muted"></span>
                    </div>
                </div>
            </div>

            <div class="autolife-dash-col">
                <div class="autolife-section" style="border-top:none;">
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
                        <label>Context window (num_ctx, 0=default)</label>
                        <input type="number" id="autolife_num_ctx" min="0" max="131072" step="1024" value="0">
                        <label>Sampler presets (per model)</label>
                        <span>
                            <select id="autolife_preset_model" style="max-width:210px"></select>
                            <select id="autolife_preset_select"></select>
                            <button type="button" class="menu_button autolife-btn" id="autolife_preset_assign">Assign</button>
                            <button type="button" class="menu_button autolife-btn" id="autolife_preset_clear">Clear</button>
                            <span id="autolife_preset_msg" class="autolife-muted"></span>
                        </span>
                        <span id="autolife_preset_summary" class="autolife-muted" style="grid-column:1 / -1;"></span>
                    </div>
                    <div class="autolife-muted">Presets come from SillyTavern's Text Completion preset manager (AI → Text Completion → presets drawer) — edit or import them there; an assignment overrides the engine sampler settings for that model's generations.</div>
                    <div style="margin-top:6px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_model_use">Use</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_model_pull">Pull</button>
                        <span id="autolife_model_msg" class="autolife-muted"></span>
                    </div>
                    <div id="autolife_pull_progress" style="display:none; margin-top:8px;">
                        <div class="autolife-status-line" id="autolife_pull_label"></div>
                        <div class="autolife-pull-bar"><div id="autolife_pull_fill"></div></div>
                        <div class="autolife-muted" id="autolife_pull_detail"></div>
                    </div>
                </div>

                <div class="autolife-section">
                    <h4>Memory <span class="autolife-muted">(RAG over chat history)</span></h4>
                    <div class="autolife-form-grid">
                        <label>Embedding model (Ollama)</label>
                        <input type="text" id="autolife_embed_model" placeholder="nomic-embed-text">
                    </div>
                    <div style="margin-top:6px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_embed_save">Save model</button>
                        <span id="autolife_embed_msg" class="autolife-muted"></span>
                    </div>
                    <div class="autolife-muted" style="margin-top:4px;">Pulled automatically on first use (~274 MB for nomic-embed-text). Changing the model rebuilds all indexes.</div>
                    <div style="overflow-x:auto;"><table class="autolife-monitor-table" id="autolife_memory_table"></table></div>
                </div>

                <div class="autolife-section">
                    <h4>Telegram</h4>
                    <div class="autolife-form-grid">
                        <label>Bot token (shared/default)</label>
                        <input type="password" id="autolife_tg_token" placeholder="123456:ABC… (from @BotFather)">
                        <label>Allowed chat IDs</label>
                        <input type="text" id="autolife_tg_ids" placeholder="comma separated, e.g. 12345678">
                        <label>Extra bots (one per line)</label>
                        <textarea id="autolife_tg_bots" rows="2" placeholder="maya | 123:token | 12345678" style="width:100%;"></textarea>
                    </div>
                    <div style="margin-top:6px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_tg_save">Save & restart bridge</button>
                        <span id="autolife_tg_msg" class="autolife-muted"></span>
                    </div>
                    <div id="autolife_bindings" class="autolife-status-line"></div>
                    <div class="autolife-muted">One bot = one chat with one character at a time (/switch changes it). For full separation give a character its own bot: add it above, message it in Telegram, /switch there — bindings are per-bot, so characters never share chats. Commands: /chars, /switch, /status, /start, /stop, /model, /upload.</div>
                </div>
            </div>
        </div>
    </div>`;
}

function openDashboard(opts = {}) {
    $('#autolife_dashboard').show();
    if (opts.promptLogFor) {
        // coming from a character's panel — show only her exchanges
        state.plogFilter = opts.promptLogFor;
        loadPromptLogSection().then(() => {
            $('#autolife_plog_section')[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function closeDashboard() {
    $('#autolife_dashboard').hide();
}

// ---------------------------------------------------------------- character editor section (compact launcher)
// Lives at the bottom of ST's editor form / inside Advanced Definitions when
// open. Full configuration happens in the dedicated Autolife panel (our own
// modal — immune to ST DOM changes), opened from here or a character chip.

function editorHtml() {
    return `
    <div class="autolife-editor-section">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Autolife — <span id="autolife_char_name">—</span></b>
                <span id="autolife_char_status" class="autolife-muted"></span>
            </div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="autolife_enable"> Autolife enabled (character carries an autolife block)</label>
                <div style="margin-top:8px;">
                    <button type="button" class="menu_button autolife-btn" id="autolife_open_panel"><i class="fa-solid fa-id-card"></i> Open Autolife panel</button>
                    <span class="autolife-muted">schedule · journal · relationship · pause/stop/purge</span>
                </div>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- dedicated per-character panel (modal)

function panelModalHtml() {
    return `
    <div id="autolife_panel_overlay" class="autolife-modal-overlay" style="display:none;">
        <div class="autolife-modal">
            <div class="autolife-modal-head">
                <b>Autolife — <span id="autolife_panel_name">—</span></b>
                <span id="autolife_panel_life" class="autolife-muted"></span>
                <a class="autolife-btn" id="autolife_panel_close" title="close"><i class="fa-solid fa-xmark"></i></a>
            </div>
            <div class="autolife-modal-body">

                <div class="autolife-section">
                    <h4>Status &amp; lifecycle</h4>
                    <div id="autolife_panel_statusline" class="autolife-status-line"></div>
                    <div>
                        <button type="button" class="menu_button autolife-btn" id="autolife_panel_add" style="display:none;"><i class="fa-solid fa-plus"></i> Add Autolife to this card</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_panel_force"><i class="fa-solid fa-bolt"></i> Text me now</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_panel_pause">Pause</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_panel_stop">Stop</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_panel_plog"><i class="fa-solid fa-file-lines"></i> View prompts</button>
                        <button type="button" class="menu_button autolife-btn autolife-danger" id="autolife_panel_purge"><i class="fa-solid fa-trash-can"></i> Purge state</button>
                    </div>
                    <div class="autolife-muted">Pause: no replies, no initiative, resumes where it left off. Stop: Autolife off until re-enabled (ST instant replies return). Purge: wipes relationship, journal, pending replies and the memory index — chats and card are kept.</div>
                </div>

                <div class="autolife-section">
                    <h4>Relationship</h4>
                    <div class="autolife-form-grid">
                        <label>Score (0–100)</label>
                        <span><input type="number" id="autolife_panel_rel_now" min="0" max="100" style="width:70px">
                        <span id="autolife_panel_rel_desc" class="autolife-muted"></span></span>
                    </div>
                    <div style="margin-top:4px;"><button type="button" class="menu_button autolife-btn" id="autolife_panel_rel_save">Set relationship</button></div>
                </div>

                <div class="autolife-section">
                    <h4>Active chat</h4>
                    <div class="autolife-form-grid">
                        <label>Chat she's living in</label>
                        <span>
                            <select id="autolife_chat_select" style="max-width:230px"></select>
                            <button type="button" class="menu_button autolife-btn" id="autolife_chat_switch">Switch</button>
                            <button type="button" class="menu_button autolife-btn" id="autolife_chat_new">New</button>
                            <span id="autolife_chat_msg" class="autolife-muted"></span>
                        </span>
                    </div>
                    <div class="autolife-muted">The engine follows whichever chat you open for her in the web UI — this dropdown overrides that. Every file is its own conversation; switching preserves all of them.</div>
                </div>

                <div class="autolife-section">
                    <h4>Journal <a class="autolife-btn" id="autolife_panel_journal_new" title="write one entry now"><i class="fa-solid fa-pen-to-square"></i></a> <a class="autolife-btn" id="autolife_panel_journal_refresh" title="reload"><i class="fa-solid fa-rotate"></i></a></h4>
                    <div id="autolife_panel_journal" class="autolife-audit-feed"></div>
                </div>

                <div class="autolife-section">
                    <h4>Schedule &amp; behavior <span class="autolife-muted">(saved into the card)</span></h4>
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

                        <label>Initiative (texts you first)</label>
                        <input type="checkbox" id="autolife_init_on">
                        <label>Initiative min gap (min)</label>
                        <input type="number" id="autolife_init_gap" min="1" max="10080" value="120">
                        <label>Initiative max / day</label>
                        <input type="number" id="autolife_init_max" min="0" max="100" value="4">
                        <label>Double-text after (h, 0=off)</label>
                        <input type="number" id="autolife_followup" min="0" max="168" value="6">

                        <label>Long-term memory (RAG)</label>
                        <input type="checkbox" id="autolife_mem_on" checked>
                        <label>Recalled texts per reply (0–10)</label>
                        <input type="number" id="autolife_mem_k" min="0" max="10" value="3">
                        <label>Memory index size (max entries)</label>
                        <input type="number" id="autolife_mem_max" min="100" max="100000" step="100" value="4000">
                        <label>Keep a private journal</label>
                        <input type="checkbox" id="autolife_journal" checked>
                    </div>

                    <div style="margin-top:8px;">
                        <b style="font-size:0.85em;">Weekly schedule</b>
                        <span class="autolife-muted"> (first match wins; unlisted times = free)</span>
                        <div class="autolife-sched-row autolife-sched-head" id="autolife_sched_head"></div>
                        <div id="autolife_sched_rows"></div>
                        <button type="button" class="menu_button autolife-btn" id="autolife_add_block">+ add block</button>
                    </div>

                    <div style="margin-top:10px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_save"><i class="fa-solid fa-floppy-disk"></i> Save card</button>
                        <span id="autolife_save_msg" class="autolife-muted"></span>
                    </div>
                </div>

                <div class="autolife-section">
                    <h4>Prompt template <span class="autolife-muted">(this character; empty = global/built-in)</span></h4>
                    <div class="autolife-muted">Same placeholders as the global template. Sections you omit are simply absent from the prompt.</div>
                    <textarea id="autolife_prompt_card" rows="6" style="width:100%; margin-top:4px;" placeholder="empty — global template or built-in assembly"></textarea>
                    <div style="margin-top:4px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_prompt_card_save">Save with card</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_prompt_preview_btn"><i class="fa-solid fa-eye"></i> Preview rendered prompt</button>
                        <span id="autolife_prompt_msg" class="autolife-muted"></span>
                    </div>
                    <pre id="autolife_prompt_preview" class="autolife-audit-feed" style="display:none; white-space:pre-wrap;"></pre>
                </div>

                <div class="autolife-section">
                    <h4>About {{user}} <span class="autolife-muted">(what this character knows about you — saved to the card)</span></h4>
                    <div class="autolife-muted">Relationship history, facts about you, shared references. Injected as its own prompt section ({{about_user}} in templates). Keep scenario for the present encounter; put what they *know about you* here.</div>
                    <textarea id="autolife_about_user" rows="4" style="width:100%; margin-top:4px;" placeholder="we met at Maria's wedding in 2023; you work nights as a nurse; you owe me tacos from the bet"></textarea>
                    <div style="margin-top:4px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_about_user_save">Save with card</button>
                    </div>
                </div>

                <div class="autolife-section">
                    <h4>How I've changed <span class="autolife-muted">(self-reflections)</span></h4>
                    <div class="autolife-form-grid">
                        <label>Enable evolve reflections</label>
                        <input type="checkbox" id="autolife_evolve_on">
                        <label>Auto-apply (skip approval)</label>
                        <input type="checkbox" id="autolife_evolve_auto">
                        <label>Reflection interval (hours)</label>
                        <input type="number" id="autolife_evolve_interval" min="1" max="2160" value="72">
                    </div>
                    <div style="margin-top:4px;">
                        <button type="button" class="menu_button autolife-btn" id="autolife_evolve_save">Save evolve settings</button>
                        <button type="button" class="menu_button autolife-btn" id="autolife_evolve_now"><i class="fa-solid fa-seedling"></i> Reflect now</button>
                        <span id="autolife_evolve_msg" class="autolife-muted"></span>
                    </div>
                    <div class="autolife-muted">Every few days the character reflects on how she's durably changed; reflections are suggestions you approve here or via /evolve in Telegram. Approved notes shape her prompts — the card itself never changes (purge resets her to the seed).</div>
                    <div id="autolife_evolve_list" class="autolife-audit-feed"></div>
                </div>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- panel logic

let panelChar = null;

async function openCharacterPanel(name) {
    if (!name) {
        toast('No character selected — open a character first, or click a status chip on a tile.');
        return;
    }
    panelChar = name;
    $('#autolife_panel_overlay').show();
    await refreshPanel();
}

function closeCharacterPanel() {
    panelChar = null;
    $('#autolife_panel_overlay').hide();
}

const relDescriptor = (score) => (score < 20 ? 'distant' : score < 40 ? 'friendly' : score < 60 ? 'close' : score < 80 ? 'very close' : 'deeply bonded');

// stash the card's relationship.initial so panel saves don't clobber it
let panelInitialRelationship = 20;

async function refreshPanel() {
    if (!panelChar) return;
    try {
        const [status, card] = await Promise.all([
            api('/status'),
            api(`/card?name=${encodeURIComponent(panelChar)}`),
        ]);
        panelInitialRelationship = card.autolife?.relationship?.initial ?? 20;
        $('#autolife_panel_add').toggle(!card.autolife);
        const c = status.engine.characters.find((x) => x.name === panelChar);
        if (!c) {
            $('#autolife_panel_name').text(panelChar);
            $('#autolife_panel_statusline').text(card.autolife
                ? 'Autolife is stopped for this character.'
                : 'No autolife block on this card yet — add one to give them a life (enabled by default).');
            $('#autolife_panel_life').text('');
            return;
        }
        $('#autolife_panel_name').text(c.name);
        $('#autolife_panel_life').text(`${c.activity} · ${Math.round(c.availability * 100)}% available · ${c.localTime}`);
        const pending = c.pendingReply
            ? ` · replies in ~${Math.max(0, Math.round((new Date(c.pendingReply.dueAt) - Date.now()) / 60000))} min`
            : '';
        $('#autolife_panel_statusline').text(
            `${c.paused ? '⏸ paused' : c.enabled ? '● enabled' : '■ stopped'} · relationship ${Math.round(c.relationship)}/100 (${relDescriptor(c.relationship)}) · memory ${c.memoryEntries} texts${pending}`,
        );

        $('#autolife_panel_pause').text(c.paused ? 'Resume' : 'Pause');
        $('#autolife_panel_stop').text(c.enabled ? 'Stop' : 'Start');
        $('#autolife_panel_rel_now').val(Math.round(c.relationship));
        $('#autolife_panel_rel_desc').text(relDescriptor(c.relationship));

        const journal = (c.journal ?? []).slice().reverse();
        $('#autolife_panel_journal').html(journal.length
            ? journal.map((j) => `<div class="autolife-audit-row" data-jts="${escHtml(j.ts)}" data-raw="${escHtml(j.text)}">
                <span class="autolife-muted">${new Date(j.ts).toLocaleString()}${j.edited ? ' · edited' : ''}</span> — ${escHtml(j.text)}
                <a class="autolife-btn" data-journal-edit="${escHtml(j.ts)}" title="edit this entry"><i class="fa-solid fa-pen"></i></a>
                <a class="autolife-btn" data-journal-del="${escHtml(j.ts)}" title="delete this entry"><i class="fa-solid fa-trash-can"></i></a>
            </div>`).join('')
            : '<div class="autolife-muted">No journal entries yet — they accumulate every few waking hours.</div>');

        const a = card.autolife;
        if (a) {
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
            $('#autolife_journal').prop('checked', !!a.journal?.enabled);
            $('#autolife_mem_on').prop('checked', a.memory?.enabled ?? true);
            $('#autolife_mem_k').val(a.memory?.retrieve_count ?? 3);
            $('#autolife_mem_max').val(a.memory?.max_entries ?? 4000);
            $('#autolife_prompt_card').val(a.prompt?.template ?? '');
            $('#autolife_about_user').val(a.about_user ?? '');
            $('#autolife_evolve_on').prop('checked', !!a.evolve?.enabled);
            $('#autolife_evolve_auto').prop('checked', !!a.evolve?.auto_apply);
            $('#autolife_evolve_interval').val(a.evolve?.interval_hours ?? 72);
            $('#autolife_sched_rows').html((a.schedule.length ? a.schedule : []).map(schedRowHtml).join(''));
        }
        loadEvolveSection();
        loadChatOptions();
    } catch (err) {
        $('#autolife_panel_statusline').text(`error: ${err.message}`);
    }
}

/** Active-chat dropdown: her chat files with message counts, active flagged. */
async function loadChatOptions() {
    if (!panelChar) return;
    try {
        const r = await api(`/chats?name=${encodeURIComponent(panelChar)}`);
        const opts = (r.chats ?? []).map((c) =>
            `<option value="${c.file}" ${c.active ? 'selected' : ''}>${c.file.replace(/\.jsonl$/, '')} · ${c.messages} msgs${c.active ? ' · ACTIVE' : ''}</option>`);
        $('#autolife_chat_select').html(opts.join('') || '<option value="">(no chats yet)</option>');
    } catch { /* panel may be closed */ }
}

/** Evolve section: reflection notes, newest first, pending ones reviewable. */async function loadEvolveSection() {
    if (!panelChar) return;
    try {
        const r = await api(`/evolve?name=${encodeURIComponent(panelChar)}`);
        const notes = [...(r.notes ?? [])].reverse();
        const row = (n) => {
            const when = `<span class="autolife-muted">${new Date(n.ts).toLocaleString()}</span>`;
            if (n.status === 'pending') {
                return `<div class="autolife-audit-row">${when} — <b>${n.text}</b> ` +
                    `<a class="autolife-btn" data-evolve-ok="${n.ts}" title="let it shape her prompts"><i class="fa-solid fa-check"></i> keep</a> ` +
                    `<a class="autolife-btn" data-evolve-no="${n.ts}" title="throw it away"><i class="fa-solid fa-xmark"></i> discard</a></div>`;
            }
            const label = n.status === 'approved' ? '✓ kept' : `(${n.status})`;
            return `<div class="autolife-audit-row">${when} — <span class="autolife-muted">${label}</span> ${n.text}</div>`;
        };
        $('#autolife_evolve_list').html(notes.length
            ? notes.map(row).join('')
            : `<div class="autolife-muted">No reflections yet${r.enabled ? '' : ' — enable evolve in the settings above first'}.</div>`);
    } catch (e) {
        $('#autolife_evolve_list').html(`<div class="autolife-muted">${e.message}</div>`);
    }
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
        const statusLine = `Autolife ${EXT_VERSION} · engine ${s.engine.running ? 'running' : 'stopped'} · tick ${s.engine.tickSeconds}s · model ${model} · Ollama ${s.ollama?.version ?? 'unreachable'}`;
        $('#autolife_status').text(statusLine);
        $('#autolife_dash_status').text(statusLine);
        state.enabled = new Set(s.engine.characters.filter((c) => c.enabled && !c.paused).map((c) => c.name));
        state.charStatus = new Map(s.engine.characters.map((c) => [c.name, c]));

        // detect an unconnected web UI (fresh ST defaults to AI Horde) and hint the fix
        const mainApi = String($('#main_api').val() ?? '');
        const tgType = String($('#textgen_type').val() ?? '');
        const webUiUnconnected = mainApi === 'koboldhorde' || (mainApi === 'textgenerationwebui' && tgType && tgType !== 'ollama');
        $('#autolife_connect_hint').toggle(webUiUnconnected);
        if (webUiUnconnected) {
            $('#autolife_connect_hint').html('⚠️ Web-UI chatting is not connected to Ollama'
                + (mainApi === 'koboldhorde' ? ' (still on the default AI Horde)' : '')
                + '. Fix: <b>API Connections (🔌) → API: Text Completion → API Type: Ollama → URL http://127.0.0.1:11434 → Connect</b>.'
                + ' Engine/Telegram texting works regardless.');
        }

        renderMonitor(s.engine.characters);
        populateAuditFilter(s.engine.characters);
        updateChatStrip();
        applyCharacterChips();
        updateTypingBubble();
    } catch (err) {
        $('#autolife_badge').text('plugin unreachable');
        $('#autolife_status').text(`Autolife ${EXT_VERSION} — could not reach the plugin (${err.message}). Is it enabled in config.yaml?`);
        // NEVER keep painting stale status: a page that survived a container
        // rebuild would otherwise keep showing old badges (e.g. "asleep" for
        // characters the boot policy stopped). Clear everything.
        state.charStatus = new Map();
        state.enabled = new Set();
        $('.autolife-chip').remove();
        updateChatStrip();
        updateTypingBubble();
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
            <td data-panelname="${c.name}" class="autolife-panel-launch" title="open the Autolife panel"><b>${c.name}</b>${c.paused ? ' <span class="autolife-muted">(paused)</span>' : (!c.enabled ? ' <span class="autolife-muted">(stopped)</span>' : '')}</td>
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

/** Prompt editors always show the EFFECTIVE text — custom or built-in. */
async function loadPromptEditors() {
    try {
        const r = await api('/prompt-defaults');
        state.promptDefaults = r.defaults ?? {};
        state.defaultTemplate = r.defaultTemplate ?? '';
        const cur = r.current ?? {};
        $('#autolife_dir_initiative').val(cur.initiative || r.defaults.initiative || '');
        $('#autolife_dir_followup').val(cur.followup || r.defaults.followup || '');
        $('#autolife_dir_catchup').val(cur.catchup || r.defaults.catchup || '');
        $('#autolife_dir_burst').val(cur.burst || r.defaults.burst || '');
        $('#autolife_prompt_global').val(r.currentTemplate || r.defaultTemplate || '');
    } catch { /* plugin offline */ }
}

// ---------------------------------------------------------------- prompt log

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function loadPromptLogSection() {
    try {
        const r = await api('/promptlog?limit=200');
        $('#autolife_plog_enabled').prop('checked', !!r.enabled);
        $('#autolife_plog_keep').val(r.keep ?? 500);
        const all = r.entries ?? [];
        // character filter (kept across reloads; set from a character's panel)
        const chars = [...new Set(all.map((e) => e.character ?? '(engine)'))];
        const current = state.plogFilter ?? '';
        $('#autolife_plog_filter').html(['<option value="">(all characters)</option>']
            .concat(chars.map((c) => `<option value="${escHtml(c)}" ${c === current ? 'selected' : ''}>${escHtml(c)}</option>`))
            .join(''));
        if (current && !chars.includes(current)) state.plogFilter = '';
        const entries = all.filter((e) => !state.plogFilter || (e.character ?? '(engine)') === state.plogFilter);
        const rows = entries.map((e) => {
            const when = new Date(e.ts).toLocaleTimeString();
            const tag = [e.character, e.kind, e.attempt].filter(Boolean).join(' · ');
            return `<div class="autolife-audit-row" data-plog-id="${escHtml(e.id)}" style="cursor:pointer;">
                <span class="autolife-muted">${when}</span> — <b>${escHtml(tag)}</b>
                <span class="autolife-muted"> · ${e.messages} msgs · ${(e.promptChars / 1000).toFixed(1)}k chars</span><br>
                <span class="autolife-muted">${escHtml(e.responsePreview) || '(empty response)'}</span>
            </div>`;
        });
        $('#autolife_plog_feed').html(rows.join('') || `<div class="autolife-muted">Nothing logged${state.plogFilter ? ` for ${escHtml(state.plogFilter)}` : ' yet'} — enable capture, then generate.</div>`);
    } catch { /* plugin offline */ }
}

async function openPromptLogEntry(id) {
    try {
        const e = await api(`/promptlog/file?id=${encodeURIComponent(id)}`);
        $('#autolife_plog_viewer_title').text(`${e.character ?? '(engine)'} · ${e.kind ?? 'chat'}${e.attempt ? ` · ${e.attempt}` : ''} · ${new Date(e.ts).toLocaleString()}`);
        const opts = { ...e.request };
        delete opts.messages;
        const msgHtml = (e.request?.messages ?? []).map((m) =>
            `<div style="margin-top:10px;"><b>${escHtml(m.role)}</b>
             <pre style="white-space:pre-wrap; margin:4px 0 0; font-size:0.9em;">${escHtml(m.content)}</pre></div>`).join('');
        $('#autolife_plog_viewer_body').html(
            `<div class="autolife-muted">model: ${escHtml(e.model)} · options: ${escHtml(JSON.stringify(opts))}</div>` +
            msgHtml +
            `<div style="margin-top:14px;"><b>response</b>
             <pre style="white-space:pre-wrap; margin:4px 0 0; font-size:0.9em;">${escHtml(e.response) || '(empty)'}</pre></div>`,
        );
        $('#autolife_plog_viewer').show();
    } catch (err2) { toast(err2.message); }
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

// ---------------------------------------------------------------- character editor section

async function loadCharacterEditor() {
    const name = currentCharacterName();
    lastEditorLoad = { name, ts: Date.now() };
    $('#autolife_char_name').text(name ?? '—');
    if (!name) {
        $('#autolife_enable').prop('checked', false);
        $('#autolife_char_status').text('');
        return;
    }
    try {
        const card = await api(`/card?name=${encodeURIComponent(name)}`);
        const has = !!card.autolife;
        $('#autolife_enable').prop('checked', has);
        const status = state.charStatus.get(name);
        $('#autolife_char_status').text(has
            ? (status ? `${status.activity} · ${Math.round(status.availability * 100)}%` : 'enabled')
            : 'no autolife block');
    } catch {
        $('#autolife_enable').prop('checked', false);
        $('#autolife_char_status').text('');
    }
}

function buildAutolifeFromForm() {
    return {
        version: '1.2',
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
        // runtime relationship is edited live in the panel; preserve the card's
        // initial for future purges rather than clobbering it from the form
        relationship: { initial: panelInitialRelationship },
        journal: { enabled: $('#autolife_journal').prop('checked') },
        memory: {
            enabled: $('#autolife_mem_on').prop('checked'),
            retrieve_count: Number($('#autolife_mem_k').val()),
            max_entries: Number($('#autolife_mem_max').val()),
        },
        prompt: { template: $('#autolife_prompt_card').val() },
        about_user: $('#autolife_about_user').val().slice(0, 2000),
        evolve: {
            enabled: $('#autolife_evolve_on').prop('checked'),
            auto_apply: $('#autolife_evolve_auto').prop('checked'),
            interval_hours: Number($('#autolife_evolve_interval').val()) || 72,
            max_notes: 10,
        },
    };
}

async function saveCard() {
    if (!panelChar) return;
    const msg = $('#autolife_save_msg').text('saving…');
    try {
        const res = await api('/card', 'POST', { name: panelChar, autolife: buildAutolifeFromForm() });
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
        <span class="autolife-strip-chat autolife-muted"></span>
    </div>`;
}

function updateChatStrip() {
    let $strip = $('#autolife_chat_strip');
    if (!$strip.length && $('#chat').length) {
        // self-heal: ST DOM churn should never lose the strip
        $('#chat').before(chatStripHtml());
        $strip = $('#autolife_chat_strip');
    }
    if (!$strip.length) return;
    const name = currentCharacterName();
    const status = name ? state.charStatus.get(name) : null;
    if (!status) {
        $strip.hide();
        return;
    }
    $strip.show();
    const life = status.enabled
        ? (status.paused ? 'paused' : 'alive')
        : 'STOPPED — start them from the Autolife panel';
    $strip.find('.autolife-strip-name').text(`${name} · ${life}`);
    $strip.find('.autolife-strip-activity').text(status.activity + (status.mood ? ` (${status.mood})` : ''));
    $strip.find('.autolife-strip-bar > div').css('width', `${Math.round(status.availability * 100)}%`);
    $strip.find('.autolife-strip-time').text(status.localTime);
    const init = status.initiative ?? {};
    $strip.find('.autolife-strip-init').text(!status.enabled ? '' : (!init.enabled ? 'initiative off' : (init.blockedReason ? `next text: ${init.blockedReason}` : 'may text you any moment')));
    $strip.find('.autolife-strip-chat').text(status.chatFile ? `chat: ${String(status.chatFile).replace(/\.jsonl$/, '')}` : '');
}

/**
 * Mark the engine's ACTIVE chat in SillyTavern's past-chats popup so the
 * right conversation is identifiable among the recents.
 */
function markActiveChats() {
    const $div = $('#select_chat_div');
    if (!$div.length) return;
    const name = currentCharacterName();
    const status = name ? state.charStatus.get(name) : null;
    const activeFile = status?.chatFile ? String(status.chatFile).replace(/\.jsonl$/, '') : null;
    $div.find('.select_chat_block').each((_, el) => {
        const $el = $(el);
        $el.find('.autolife-active-chat').remove();
        const file = String($el.attr('file_name') ?? '').replace(/\.jsonl$/, '');
        if (activeFile && file === activeFile) {
            $el.find('.chat_date').last().append(' <span class="autolife-active-chat" title="Autolife active chat — engine messages land in this conversation">● Autolife</span>');
        }
    });
}

function watchPastChatsPopup() {
    const target = document.getElementById('select_chat_div');
    if (!target) return;
    let timer = null;
    const reapply = () => {
        clearTimeout(timer);
        timer = setTimeout(markActiveChats, 200);
    };
    new MutationObserver(reapply).observe(target, { childList: true, subtree: true });
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
    if (!status.enabled) return { icon: '⏹', label: 'stopped', cls: 'paused' };
    if (status.paused) return { icon: '⏸', label: 'paused', cls: 'paused' };
    if (status.availability < 0.05) return { icon: '💤', label: status.activity, cls: 'asleep' };
    if (status.availability < 0.35) return { icon: '🏢', label: status.activity, cls: 'busy' };
    return { icon: '✨', label: 'free', cls: 'free' };
};

function applyCharacterChips() {
    if (!ST?.characters) return;
    $('#rm_print_characters_block .character_select').each((_, el) => {
        const $el = $(el);
        $el.find('.autolife-chip, .autolife-tile-ctrls').remove();

        // Per-tile identity: the tile's OWN displayed name (text nodes only, so
        // our injected spans don't pollute the match). The chid->characters[]
        // indirection proved unreliable (tiles were picking up another tile's
        // data); the displayed name cannot cross-wire. chid stays as fallback.
        const tileName = String($el.find('.ch_name').contents().filter((_, n) => n.nodeType === 3).text() ?? '').trim();
        const chid = Number($el.attr('chid'));
        const byId = Number.isInteger(chid) && chid >= 0 ? ST.characters[chid]?.name : null;
        const name = tileName && state.charStatus.has(tileName) ? tileName : byId;
        const status = name ? state.charStatus.get(name) : null;
        if (!status) return; // not an autolife character

        const chip = chipFor(status);
        const $name = $el.find('.ch_name');
        if (!$name.length) return;
        if (chip) {
            $name.append(` <span class="autolife-chip autolife-chip-${chip.cls}" data-name="${name}" title="${name}: ${status.activity} · ${status.localTime} — click for the Autolife panel">${chip.icon}</span>`);
        }
        // Play/Stop | Pause controls, right on the tile
        const lifecycle = status.enabled
            ? `<a class="autolife-tile-btn" data-name="${name}" data-action="lifecycle" title="Stop ${name} (hands-off until started again)">⏹</a>`
            : `<a class="autolife-tile-btn" data-name="${name}" data-action="lifecycle" title="Start ${name} (schedule, replies, initiative)">▶</a>`;
        const pause = status.enabled
            ? `<a class="autolife-tile-btn" data-name="${name}" data-action="pause" title="${status.paused ? 'Resume' : 'Pause'} ${name}">${status.paused ? '⏯' : '⏸'}</a>`
            : '';
        $name.append(`<span class="autolife-tile-ctrls">${lifecycle}${pause}</span>`);
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
        $('#autolife_persona_name').val(settings.persona?.name ?? '');
        $('#autolife_samplers_temp').val(settings.model?.temperature ?? 0.7);
        $('#autolife_samplers_top_p').val(settings.model?.top_p ?? 1);
        $('#autolife_samplers_top_k').val(settings.model?.top_k ?? 0);
        $('#autolife_samplers_rep_pen').val(settings.model?.repeat_penalty ?? 1);
        $('#autolife_samplers_nsigma').val(settings.model?.top_n_sigma ?? 1.2);
        $('#autolife_samplers_xtc_p').val(settings.model?.xtc_probability ?? 0.33);
        $('#autolife_samplers_xtc_t').val(settings.model?.xtc_threshold ?? 0.05);
        loadPromptEditors();
        $('#autolife_availability_tone').prop('checked', settings.engine?.availability_tone !== false);
        $('#autolife_relationship_speed').prop('checked', settings.engine?.relationship_speed !== false);
        $('#autolife_engine_bursts').prop('checked', settings.engine?.followup_bursts === true);
        $('#autolife_feature_memory').prop('checked', settings.features?.memory !== false);
        $('#autolife_feature_journal').prop('checked', settings.features?.journal !== false);
        $('#autolife_feature_evolve').prop('checked', settings.features?.evolve !== false);
        $('#autolife_feature_enhance').prop('checked', settings.features?.schedule_enhance !== false);
        $('#autolife_reflect_journal').val(settings.reflections?.journal ?? 3);
        $('#autolife_reflect_evolve').val(settings.reflections?.evolve ?? 6);
        $('#autolife_quiet_enabled').prop('checked', !!settings.quiet_hours?.enabled);
        $('#autolife_quiet_start').val(settings.quiet_hours?.start ?? '23:00');
        $('#autolife_quiet_end').val(settings.quiet_hours?.end ?? '07:00');
        $('#autolife_quiet_tz').val(settings.quiet_hours?.timezone ?? 'UTC');
        $('#autolife_num_ctx').val(settings.model?.num_ctx ?? 0);
        $('#autolife_tg_token').attr('placeholder', settings.telegram?.hasToken ? settings.telegram.token : '123456:ABC… (from @BotFather)');
        $('#autolife_tg_ids').val((settings.telegram?.allowed_chat_ids ?? []).join(', '));
        $('#autolife_tg_bots').val((settings.telegram?.bots ?? [])
            .map((b) => `${b.name} | ${b.token} | ${(b.allowed_chat_ids ?? []).join(',')}`)
            .join('\n'));
        const { bindings } = await api('/bindings');
        const rows = Object.entries(bindings).map(([, b]) =>
            `<tr><td>${b.bot ?? 'default'}</td><td>${b.chatId ?? ''}</td><td>${b?.character ?? '?'}</td><td><a class="autolife-btn" data-unbind="${b.chatId}" data-unbind-bot="${b.bot ?? 'default'}" title="unbind"><i class="fa-solid fa-link-slash"></i></a></td></tr>`);
        $('#autolife_bindings').html(rows.length
            ? `Bindings: <table>${rows.join('')}</table>`
            : 'No Telegram chats bound yet — message a bot, then /switch <name> in that chat.');
    } catch { /* plugin offline; status line already shows it */ }
}

async function loadModelSection() {
    let m = { presets: [], local: [], current: '' };
    try {
        m = await api('/model/list');
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
        state.modelOptions = options.map((o) => o.value);
        state.presetAssignments = m.presetAssignments ?? {};
        refreshModelButtons();
    } catch { /* ignore */ }
    loadPresetOptions(m.current);
}

/** Sampler-preset manager: per-model dropdown + preset dropdown + summary. */
async function loadPresetOptions(currentModel) {
        try {
            const p = await api('/presets');
            state.presetList = p.presets ?? [];
            state.presetAssignments = p.assignments ?? {};
        // model choices: the same list the model picker shows
        const models = state.modelOptions?.length ? state.modelOptions : (currentModel ? [currentModel] : []);
        const sel = $('#autolife_preset_model');
        if (sel.find('option').length !== models.length || models.some((m, i) => sel.find('option').eq(i).val() !== m)) {
            sel.html(models.map((m) => `<option value="${escHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escHtml(m)}</option>`).join('') || '<option value="">(no models)</option>');
        }
        renderPresetAssignment();
    } catch { /* ignore */ }
}

function renderPresetAssignment() {
    const model = $('#autolife_preset_model').val() ?? '';
    const assigned = state.presetAssignments?.[model] ?? '';
    const p = state.presetList ?? [];
    $('#autolife_preset_select').html(
        ['<option value="">none — engine sampler settings</option>']
            .concat(p.map((n) => `<option value="${escHtml(n)}" ${n === assigned ? 'selected' : ''}>${escHtml(n)}</option>`))
            .join(''),
    );
    const rows = Object.entries(state.presetAssignments ?? {})
        .map(([m, preset]) => `${escHtml(shortModelName(m))} → ${escHtml(preset)}`);
    $('#autolife_preset_summary').text(rows.length ? rows.join('   ·   ') : 'no assignments yet');
}

function shortModelName(m) {
    const s = String(m);
    return s.startsWith('hf.co/') ? s.slice(6) : s;
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
    let sseFailures = 0;
    es.onopen = () => { sseFailures = 0; };
    es.onerror = () => {
        // EventSource auto-reconnects; repeated failures mean the live feed is
        // gone (most commonly a stale page after a container rebuild) — the
        // data this page holds can no longer be trusted.
        sseFailures += 1;
        if (sseFailures >= 5) showReloadBanner();
    };
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
            case 'telegram_inbound': {
                // a message you sent on Telegram landed in the active chat file —
                // refresh the open web chat so both surfaces stay in sync
                refreshStatus();
                const open = currentCharacterName();
                if (open === data.character && !$('#mes_stop').is(':visible')) {
                    try { ST.reloadCurrentChat(); } catch { /* ignore */ }
                }
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
                if (panelChar) refreshPanel();
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
            case 'evolve':
                if (panelChar && data.character === panelChar) loadEvolveSection();
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

    // editor-section controls are DELEGATED: the section is created by the
    // watchdog, possibly after these bindings run — direct binding would miss it
    $(document).on('change', '#autolife_enable', (ev) => {
        const on = ev.target.checked;
        const name = currentCharacterName() ?? lastEditorLoad.name;
        if (!name) return;
        api('/enable', 'POST', { name, enabled: on })
            .then(() => { refreshStatus(); loadCharacterEditor(); })
            .catch((e) => toast(`${on ? 'enable' : 'disable'} failed: ${e.message}`));
    });

    $(document).on('click', '#autolife_open_panel', (ev) => {
        ev.preventDefault(); // the section lives inside ST's #form_create — never submit it
        openCharacterPanel(currentCharacterName() ?? lastEditorLoad.name);
    });

    $('#autolife_save').on('click', saveCard);

    // --- dedicated panel ---
    $('#autolife_open_panel').on('click', () => openCharacterPanel(currentCharacterName()));
    $('#autolife_panel_close').on('click', closeCharacterPanel);
    $('#autolife_panel_overlay').on('click', (ev) => {
        if (ev.target.id === 'autolife_panel_overlay') closeCharacterPanel();
    });
    $('#autolife_panel_add').on('click', async () => {
        if (!panelChar) return;
        await api('/card', 'POST', { name: panelChar, autolife: { version: '1.1' } })
            .then(() => { toast(`Autolife added to ${panelChar} — enabled with defaults`); refreshPanel(); refreshStatus(); loadCharacterEditor(); })
            .catch((e) => toast(e.message));
    });
    $('#autolife_panel_force').on('click', () => {
        if (!panelChar) return;
        toast(`Asking ${panelChar} to text you now…`);
        api('/trigger', 'POST', { name: panelChar, kind: 'initiative' })
            .then(() => setTimeout(refreshPanel, 1500))
            .catch((e) => toast(e.message));
    });
    $('#autolife_panel_pause').on('click', async () => {
        const c = state.charStatus.get(panelChar);
        const paused = c ? !c.paused : true;
        await api('/pause', 'POST', { name: panelChar, paused }).catch((e) => toast(e.message));
        refreshStatus();
        refreshPanel();
    });
    $('#autolife_panel_stop').on('click', async () => {
        const c = state.charStatus.get(panelChar);
        const enabled = c ? !c.enabled : true;
        await api('/enable', 'POST', { name: panelChar, enabled }).catch((e) => toast(e.message));
        refreshStatus();
        refreshPanel();
        loadCharacterEditor();
    });
    $('#autolife_panel_purge').on('click', async () => {
        if (!panelChar) return;
        if (!window.confirm(`Purge ${panelChar}'s runtime state?\n\nThis wipes the relationship score, journal, pending replies and the entire memory index. Chats and the character card are kept. This cannot be undone.`)) return;
        if (!window.confirm(`Really purge ${panelChar}? They start over from the card defaults.`)) return;
        await api('/purge', 'POST', { name: panelChar })
            .then(() => { toast(`${panelChar} purged — starting fresh`); refreshPanel(); refreshStatus(); })
            .catch((e) => toast(e.message));
    });
    $('#autolife_panel_rel_save').on('click', async () => {
        const score = Number($('#autolife_panel_rel_now').val());
        await api('/relationship', 'POST', { name: panelChar, score })
            .then(() => { toast('Relationship updated'); refreshPanel(); refreshStatus(); })
            .catch((e) => toast(e.message));
    });
    $('#autolife_panel_journal_refresh').on('click', refreshPanel);

    $('#autolife_panel_journal_new').on('click', async () => {
        if (!panelChar) return;
        toast('writing a journal entry…');
        try {
            const r = await api('/journal/new', 'POST', { name: panelChar });
            toast(r.text ? `Journaled: "${String(r.text).slice(0, 80)}…"` : 'nothing came of it');
            refreshPanel();
        } catch (e) { toast(e.message); }
    });

    $(document).on('click', '[data-journal-del]', (ev) => {
        const ts = String($(ev.currentTarget).data('journal-del'));
        if (!panelChar || !confirm('Delete this journal entry?')) return;
        api('/journal/delete', 'POST', { name: panelChar, ts })
            .then(() => refreshPanel())
            .catch((e) => toast(e.message));
    });

    $(document).on('click', '[data-journal-edit]', (ev) => {
        const ts = String($(ev.currentTarget).data('journal-edit'));
        const row = $(`[data-jts="${CSS.escape(ts)}"]`).first();
        if (!row.length || !panelChar) return;
        row.html(`
            <textarea class="autolife-journal-edit" rows="3" style="width:100%">${escHtml(row.attr('data-raw'))}</textarea>
            <div class="autolife-inline-actions">
                <button type="button" class="menu_button autolife-btn" data-journal-save="${escHtml(ts)}">Save</button>
                <button type="button" class="menu_button autolife-btn" data-journal-cancel="1">Cancel</button>
            </div>`);
    });

    $(document).on('click', '[data-journal-save]', async (ev) => {
        const ts = String($(ev.currentTarget).data('journal-save'));
        const text = $(ev.currentTarget).closest('[data-jts]').find('textarea').val();
        try {
            await api('/journal/edit', 'POST', { name: panelChar, ts, text });
            refreshPanel();
        } catch (e) { toast(e.message); }
    });

    $(document).on('click', '[data-journal-cancel]', () => refreshPanel());

    $(document).on('click', '#autolife_chat_switch', async () => {
        if (!panelChar) return;
        try {
            await api('/chat-file', 'POST', { name: panelChar, chatFile: $('#autolife_chat_select').val() });
            toast('Switched — her next texts continue that conversation');
            refreshPanel();
        } catch (e) { toast(e.message); }
    });

    $(document).on('click', '#autolife_chat_new', async () => {
        if (!panelChar) return;
        try {
            const r = await api('/chat/new', 'POST', { name: panelChar });
            toast(`Fresh chat started: ${r.chatFile}`);
            refreshPanel();
        } catch (e) { toast(e.message); }
    });

    // --- chips open the dedicated panel without selecting the character ---
    // CAPTURE phase: runs before ST's tile handlers, so the click never
    // selects the character and never re-renders (which used to destroy the
    // chip mid-click — hence single clicks not working).
    document.addEventListener('click', (ev) => {
        const chip = ev.target?.closest?.('.autolife-chip');
        if (!chip) return;
        ev.stopPropagation();
        ev.preventDefault();
        const name = chip.getAttribute('data-name');
        if (name) openCharacterPanel(name);
    }, true);

    // Play/Stop | Pause buttons on the tiles (capture phase, same as chips)
    document.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('.autolife-tile-btn');
        if (!btn) return;
        ev.stopPropagation();
        ev.preventDefault();
        const name = btn.getAttribute('data-name');
        const action = btn.getAttribute('data-action');
        const status = name ? state.charStatus.get(name) : null;
        if (!name) return;
        if (action === 'lifecycle') {
            api('/enable', 'POST', { name, enabled: status ? !status.enabled : true })
                .then(() => refreshStatus())
                .catch((e) => toast(e.message));
        } else if (action === 'pause') {
            api('/pause', 'POST', { name, paused: status ? !status.paused : true })
                .then(() => refreshStatus())
                .catch((e) => toast(e.message));
        }
    }, true);

    // monitor table names open the panel too
    $(document).on('click', '.autolife-panel-launch', (ev) => {
        const name = $(ev.currentTarget).data('panelname');
        if (name) openCharacterPanel(name);
    });

    // --- dashboard ---
    $(document).on('click', '#autolife_open_dashboard, #autolife_top_button', () => openDashboard());
    $(document).on('click', '#autolife_dashboard_close', () => closeDashboard());

    // --- prompt templates ---
    $(document).on('click', '#autolife_prompt_global_save', async () => {
        try {
            const v = String($('#autolife_prompt_global').val() ?? '').trim();
            const template = state.defaultTemplate && v === state.defaultTemplate.trim() ? '' : $('#autolife_prompt_global').val();
            await api('/settings', 'POST', { prompt: { template } });
            $('#autolife_prompt_global_msg').text('saved ✓');
            loadPromptEditors();
        } catch (e) { $('#autolife_prompt_global_msg').text(e.message); }
        setTimeout(() => $('#autolife_prompt_global_msg').text(''), 4000);
    });

    $(document).on('click', '#autolife_prompt_global_restore', async () => {
        try {
            await api('/settings', 'POST', { prompt: { template: '' } });
            $('#autolife_prompt_global_msg').text('restored to built-in assembly ✓');
            loadPromptEditors();
        } catch (e) { $('#autolife_prompt_global_msg').text(e.message); }
        setTimeout(() => $('#autolife_prompt_global_msg').text(''), 4000);
    });

    $(document).on('click', '#autolife_dir_save', async () => {
        try {
            const d = state.promptDefaults ?? {};
            // saving the built-in wording unchanged stays linked to it
            const val = (sel, key) => {
                const v = String($(sel).val() ?? '').trim();
                return v && d[key] && v === String(d[key]).trim() ? '' : $(sel).val();
            };
            await api('/settings', 'POST', {
                directives: {
                    initiative: val('#autolife_dir_initiative', 'initiative'),
                    followup: val('#autolife_dir_followup', 'followup'),
                    catchup: val('#autolife_dir_catchup', 'catchup'),
                    burst: val('#autolife_dir_burst', 'burst'),
                },
            });
            $('#autolife_dir_msg').text('saved ✓');
            loadPromptEditors();
        } catch (e) { $('#autolife_dir_msg').text(e.message); }
        setTimeout(() => $('#autolife_dir_msg').text(''), 4000);
    });

    $(document).on('click', '#autolife_dir_restore', async () => {
        try {
            await api('/settings', 'POST', { directives: { initiative: '', followup: '', catchup: '', burst: '' } });
            $('#autolife_dir_msg').text('restored to built-in wording ✓');
            loadPromptEditors();
        } catch (e) { $('#autolife_dir_msg').text(e.message); }
        setTimeout(() => $('#autolife_dir_msg').text(''), 4000);
    });

    $(document).on('click', '#autolife_prompt_card_save', () => saveCard());
    $(document).on('click', '#autolife_about_user_save', () => saveCard());

    $(document).on('click', '#autolife_evolve_save', () => saveCard());

    $(document).on('click', '#autolife_evolve_now', async () => {
        if (!panelChar) return;
        $('#autolife_evolve_msg').text('reflecting…');
        try {
            const r = await api('/evolve/reflect', 'POST', { name: panelChar });
            $('#autolife_evolve_msg').text(r.text ? 'reflected ✓' : 'nothing came of it');
            loadEvolveSection();
        } catch (e) { $('#autolife_evolve_msg').text(e.message); }
        setTimeout(() => $('#autolife_evolve_msg').text(''), 4000);
    });

    $(document).on('click', '[data-evolve-ok]', (ev) => {
        api('/evolve/decide', 'POST', { name: panelChar, ts: String($(ev.currentTarget).data('evolve-ok')), action: 'approve' })
            .then(loadEvolveSection).catch((e) => toast(e.message));
    });

    $(document).on('click', '[data-evolve-no]', (ev) => {
        api('/evolve/decide', 'POST', { name: panelChar, ts: String($(ev.currentTarget).data('evolve-no')), action: 'discard' })
            .then(loadEvolveSection).catch((e) => toast(e.message));
    });

    $(document).on('click', '#autolife_prompt_preview_btn', async () => {
        if (!panelChar) return;
        try {
            const p = await api(`/prompt/preview?name=${encodeURIComponent(panelChar)}`);
            $('#autolife_prompt_preview').show().text(p.system + `\n\n— rendered from: ${p.source} template, ${p.system.length} chars —`);
        } catch (e) { toast(e.message); }
    });

    // ESC closes the topmost surface (dashboard, then character panel)
    $(document).on('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if ($('#autolife_dashboard').is(':visible')) return closeDashboard();
        if (panelChar) closeCharacterPanel();
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
        const $el = $(ev.currentTarget);
        api('/bindings/delete', 'POST', { chatId: String($el.data('unbind')), bot: String($el.data('unbind-bot') ?? 'default') })
            .then(loadTelegramSection).catch((e) => toast(e.message));
    });

    // --- audit ---
    $('#autolife_audit_filter').on('change', applyAuditFilter);
    $('#autolife_audit_refresh').on('click', loadAudit);

    $('#autolife_plog_refresh').on('click', loadPromptLogSection);
    $('#autolife_plog_filter').on('change', (ev) => {
        state.plogFilter = ev.target.value;
        loadPromptLogSection();
    });

    // per-character panel: jump straight into her captured exchanges
    $(document).on('click', '#autolife_panel_plog', () => {
        if (!panelChar) return;
        openDashboard({ promptLogFor: panelChar });
    });
    $('#autolife_plog_save').on('click', async () => {
        try {
            await api('/settings', 'POST', {
                prompt_log: {
                    enabled: $('#autolife_plog_enabled').prop('checked'),
                    keep: Number($('#autolife_plog_keep').val()) || 500,
                },
            });
            $('#autolife_plog_msg').text('saved ✓');
            setTimeout(() => $('#autolife_plog_msg').text(''), 4000);
        } catch (e) { $('#autolife_plog_msg').text(e.message); }
    });
    $('#autolife_plog_purge').on('click', async () => {
        if (!confirm('Delete ALL captured prompts?')) return;
        try {
            const r = await api('/promptlog/purge', 'POST');
            toast(`Purged ${r.removed} entries`);
            loadPromptLogSection();
        } catch (e) { toast(e.message); }
    });
    $(document).on('click', '[data-plog-id]', (ev) => {
        openPromptLogEntry(String($(ev.currentTarget).data('plog-id')));
    });
    $('#autolife_plog_viewer_close').on('click', () => $('#autolife_plog_viewer').hide());
    $('#autolife_plog_viewer').on('click', (ev) => {
        if (ev.target === ev.currentTarget) $('#autolife_plog_viewer').hide();
    });

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
    $('#autolife_engine_save').on('click', async () => {
        try {
            await api('/settings', 'POST', {
                engine: {
                    availability_tone: $('#autolife_availability_tone').prop('checked'),
                    relationship_speed: $('#autolife_relationship_speed').prop('checked'),
                    followup_bursts: $('#autolife_engine_bursts').prop('checked'),
                },
                features: {
                    memory: $('#autolife_feature_memory').prop('checked'),
                    journal: $('#autolife_feature_journal').prop('checked'),
                    evolve: $('#autolife_feature_evolve').prop('checked'),
                    schedule_enhance: $('#autolife_feature_enhance').prop('checked'),
                },
                reflections: {
                    journal: Number($('#autolife_reflect_journal').val()) || 3,
                    evolve: Number($('#autolife_reflect_evolve').val()) || 6,
                },
                quiet_hours: {
                    enabled: $('#autolife_quiet_enabled').prop('checked'),
                    start: $('#autolife_quiet_start').val().trim() || '23:00',
                    end: $('#autolife_quiet_end').val().trim() || '07:00',
                    timezone: $('#autolife_quiet_tz').val().trim() || 'UTC',
                },
            });
            $('#autolife_engine_msg').text('saved ✓');
            refreshStatus();
        } catch (e) { $('#autolife_engine_msg').text(e.message); }
        setTimeout(() => $('#autolife_engine_msg').text(''), 4000);
    });

    $('#autolife_persona_save').on('click', async () => {
        try {
            await api('/settings', 'POST', { persona: { name: $('#autolife_persona_name').val() } });
            toast('Name saved — characters will use it from their next message');
            refreshStatus();
        } catch (e) { toast(e.message); }
    });

    $('#autolife_samplers_save').on('click', async () => {
        const num = (sel, fallback) => {
            const v = Number($(sel).val());
            return Number.isFinite(v) ? v : fallback;
        };
        try {
            await api('/settings', 'POST', {
                model: {
                    temperature: num('#autolife_samplers_temp', 0.7),
                    top_p: num('#autolife_samplers_top_p', 1),
                    top_k: num('#autolife_samplers_top_k', 0),
                    repeat_penalty: num('#autolife_samplers_rep_pen', 1),
                    top_n_sigma: num('#autolife_samplers_nsigma', 1.2),
                    xtc_probability: num('#autolife_samplers_xtc_p', 0.33),
                    xtc_threshold: num('#autolife_samplers_xtc_t', 0.05),
                },
            });
            $('#autolife_samplers_msg').text('saved ✓');
            refreshStatus();
        } catch (e) { $('#autolife_samplers_msg').text(e.message); }
        setTimeout(() => $('#autolife_samplers_msg').text(''), 4000);
    });

    $('#autolife_tg_save').on('click', async () => {
        const token = $('#autolife_tg_token').val().trim();
        const ids = $('#autolife_tg_ids').val().split(/[,\s]+/).map((s) => Number(s.trim())).filter(Number.isFinite);
        const bots = $('#autolife_tg_bots').val().split('\n').map((line) => line.trim()).filter(Boolean)
            .map((line) => {
                const [name, botToken, botIds] = line.split('|').map((p) => (p ?? '').trim());
                return { name, token: botToken, allowed_chat_ids: botIds.split(/[,\s]+/).map(Number).filter(Number.isFinite) };
            })
            .filter((b) => b.token);
        const msg = $('#autolife_tg_msg').text('saving…');
        try {
            await api('/settings', 'POST', { telegram: { token: token || undefined, allowed_chat_ids: ids, bots, restart: true } });
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
            api('/settings', 'POST', { model: { num_ctx: Number($('#autolife_num_ctx').val()) || 0 } }).catch(() => {});
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
    $('#autolife_preset_model').on('change', renderPresetAssignment);
    $('#autolife_preset_assign').on('click', async () => {
        try {
            const model = $('#autolife_preset_model').val();
            const preset = $('#autolife_preset_select').val() || '';
            await api('/preset/assign', 'POST', { model, preset });
            $('#autolife_preset_msg').text('saved ✓');
            setTimeout(() => $('#autolife_preset_msg').text(''), 4000);
            await loadPresetOptions(model);
        } catch (e) { $('#autolife_preset_msg').text(e.message); }
    });
    $('#autolife_preset_clear').on('click', async () => {
        try {
            const model = $('#autolife_preset_model').val();
            await api('/preset/assign', 'POST', { model, preset: '' });
            $('#autolife_preset_msg').text('cleared ✓');
            setTimeout(() => $('#autolife_preset_msg').text(''), 4000);
            await loadPresetOptions(model);
        } catch (e) { $('#autolife_preset_msg').text(e.message); }
    });
}

// user messages from the web UI -> engine (decides delay/ignore/…)
function onUserMessage(messageId) {
    const name = currentCharacterName();
    // post for ANY autolife character (stopped/paused too) — the engine
    // audits and mirrors those instead of dropping them silently
    if (!name || !state.charStatus.has(name)) return;
    const chat = ST.chat ?? [];
    const message = Number.isInteger(messageId) ? chat[messageId] : chat[chat.length - 1];
    if (!message?.is_user) return;
    updateTypingBubble();
    api('/inbound', 'POST', { character: name, mes: String(message.mes ?? '') }).then(() => refreshStatus()).catch(() => {});
}

// ---------------------------------------------------------------- bootstrap

/**
 * The per-character config lives in ONE instance that moves between surfaces:
 * inside the "Advanced Definitions" popup (#character_popup) when it's open —
 * that's where people look for character settings — and at the bottom of the
 * main editor form (#form_create) otherwise. A watchdog re-creates the
 * section if SillyTavern rebuilds the editor HTML and wipes it, and reloads
 * values when the popup opens for a character.
 */
let lastEditorLoad = { name: null, ts: 0 };

function editorSectionHome() {
    const $popup = $('#character_popup');
    if ($popup.length && $popup.is(':visible')) return $popup;
    if ($('#form_create').length) return $('#form_create');
    if ($('#character_editing').length) return $('#character_editing'); // older ST
    return null;
}

function startEditorWatchdog() {
    let wasPopupOpen = false;
    const tick = () => {
        const $home = editorSectionHome();
        if (!$home) return;
        let $sec = $('.autolife-editor-section');
        if (!$sec.length) {
            $home.append(editorHtml()); // wiped by an ST re-render — recreate
        } else if (!$sec.parent().is($home)) {
            $home.append($sec); // moves the single instance to the open surface
        }
        const popupOpen = $home.is('#character_popup');
        if (popupOpen !== wasPopupOpen) {
            wasPopupOpen = popupOpen;
            const name = currentCharacterName();
            // reload only when a DIFFERENT character is being edited — never
            // clobber unsaved form state for the same character
            if (name && lastEditorLoad.name !== name) {
                loadCharacterEditor();
            }
        }
    };
    tick(); // inject immediately if the editor form is already in the DOM
    setInterval(tick, 1000);
}

jQuery(() => {
    const init = async (attempt = 0) => {
        try {
            ST = (typeof window.SillyTavern?.getContext === 'function') ? window.SillyTavern.getContext() : null;
        } catch {
            ST = null; // called before ST finished init — retry
        }
        if (!ST) {
            if (attempt < 90) return setTimeout(() => init(attempt + 1), 500);
            return; // ST never became available; nothing we can do
        }

        // dashboard: slim launcher in the extensions drawer + full-screen overlay
        $('#extensions_settings2').append(panelHtml());
        $('body').append(dashboardHtml());

        // top-bar button (self-healing alongside the dashboard)
        // Top bar button: lives in the RIGHT drawer-toggle cluster next to the
        // native icons. #top-bar itself sits UNDER #top-settings-holder
        // (z-index 3005) — icons appended there look right but can't be clicked.
        const injectTopButton = () => {
            if ($('#autolife_top_button').length) return;
            const host = $('#unimportantYes').length ? $('#unimportantYes') : ($('#rightNavDrawerIcon').parent().length ? $('#rightNavDrawerIcon').parent() : $('#top-bar'));
            if (!host.length) return;
            host.append('<div id="autolife_top_button" class="drawer-icon fa-solid fa-heart-pulse fa-fw closedIcon" title="Autolife dashboard"></div>');
        };
        injectTopButton();
        setInterval(injectTopButton, 5000); // re-inject if ST rebuilds the top bar

        // dedicated per-character panel modal (our own DOM — immune to ST changes)
        $('body').append(panelModalHtml());
        $('#autolife_sched_head').html(schedHeadHtml());

        // character config: editor form + Advanced Definitions popup (self-healing)
        startEditorWatchdog();

        // chat strip above the chat
        $('#chat').before(chatStripHtml());

        wireEvents();

        ST.eventSource.on(ST.event_types.APP_READY, () => {
            connectEvents();
            refreshStatus();
            loadTelegramSection();
            loadModelSection();
            loadAudit();
            loadPromptLogSection();
            loadMemorySection();
            loadCharacterEditor();
            watchCharacterList();
            watchPastChatsPopup();
            setInterval(refreshStatus, 30_000);
            setInterval(loadAudit, 120_000);
            setInterval(() => { updateChatStrip(); updateTypingBubble(); }, 15_000);
        });
        ST.eventSource.on(ST.event_types.CHAT_CHANGED, () => {
            loadCharacterEditor();
            refreshStatus();
            removeTypingBubble();
            annotateVisibleMessages();
            // tell the engine which chat we have open, so its messages land
            // in THIS conversation instead of diverging into its own file
            const name = currentCharacterName();
            const chatId = ST.chatId ?? (typeof ST.getCurrentChatId === 'function' ? ST.getCurrentChatId() : null);
            if (name && chatId && state.charStatus.has(name)) {
                api('/chat-file', 'POST', { name, chatFile: String(chatId), source: 'web' }).catch(() => {});
            }
        });
        ST.eventSource.on(ST.event_types.MESSAGE_SENT, (messageId) => onUserMessage(Number.isInteger(messageId) ? messageId : undefined));
        ST.eventSource.on(ST.event_types.MESSAGE_RECEIVED, () => removeTypingBubble());
        ST.eventSource.on(ST.event_types.CHARACTER_MESSAGE_RENDERED, (idx) => {
            try { annotateMessage(typeof idx === 'number' ? idx : Number(idx?.messageId ?? idx)); } catch { /* noop */ }
        });

        loadCharacterEditor();
    };
    init();
});
