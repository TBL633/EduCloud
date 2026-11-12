import { getActiveUsername, escapeHtml } from "../shared/auth-guard.js";

// ============================================================================
// BUSINESS PORTAL: AI LEAD RESPONDER STUDIO & LIVE WHATSAPP SIMULATOR
// ============================================================================

window._savedApiKeys = window._savedApiKeys || [];
window._aiRevealedKeys = window._aiRevealedKeys || {};
window._aiSimHistory = window._aiSimHistory || [];
window._aiSyncedStoreContext = window._aiSyncedStoreContext || {
    business_name: '',
    business_type: 'Kirana / General Store',
    product_count: 0,
    category_count: 0,
    allow_cod: true,
    paytm_vpa: ''
};

const MODEL_PRESETS_BY_PROVIDER = {
    Groq: [
        { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Recommended)' },
        { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (Ultra Fast)' },
        { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' }
    ],
    Gemini: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Recommended)' },
        { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
        { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }
    ],
    ChatGPT: [
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Economic)' },
        { id: 'gpt-4o', label: 'GPT-4o Omni' },
        { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
    ],
    DeepSeek: [
        { id: 'deepseek-chat', label: 'DeepSeek V3 Chat' },
        { id: 'deepseek-reasoner', label: 'DeepSeek R1 Reasoner' }
    ],
    OpenRouter: [
        { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B Instruct' },
        { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
        { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku' }
    ]
};

function showAIToast(message, type = 'success') {
    const banner = document.getElementById('ai-toast-banner');
    const icon = document.getElementById('ai-toast-icon');
    const text = document.getElementById('ai-toast-text');
    if (!banner || !text) return;

    text.textContent = message;
    banner.classList.remove('hidden', 'border-emerald-500/40', 'bg-emerald-950/90', 'text-emerald-200', 'border-rose-500/40', 'bg-rose-950/90', 'text-rose-200', 'border-purple-500/40', 'bg-purple-950/90', 'text-purple-200');

    if (type === 'error') {
        banner.classList.add('border-rose-500/40', 'bg-rose-950/90', 'text-rose-200');
        if (icon) icon.className = 'fa-solid fa-triangle-exclamation text-rose-400 text-sm shrink-0';
    } else if (type === 'info') {
        banner.classList.add('border-purple-500/40', 'bg-purple-950/90', 'text-purple-200');
        if (icon) icon.className = 'fa-solid fa-wand-magic-sparkles text-purple-400 text-sm shrink-0';
    } else {
        banner.classList.add('border-emerald-500/40', 'bg-emerald-950/90', 'text-emerald-200');
        if (icon) icon.className = 'fa-solid fa-circle-check text-emerald-400 text-sm shrink-0';
    }

    if (window._aiToastTimer) clearTimeout(window._aiToastTimer);
    window._aiToastTimer = setTimeout(() => {
        banner.classList.add('hidden');
    }, 4200);
}

// ============================================================================
// 1. MULTI-KEY ROTATION VAULT MANAGER
// ============================================================================
function renderAPIKeysList() {
    const container = document.getElementById('api-keys-list-container');
    const hiddenTextarea = document.getElementById('ai-api-key');
    const countBadge = document.getElementById('ai-keys-count-badge');
    const kpiKeyCount = document.getElementById('kpi-ai-keys-count');
    if (!container) return;

    const keys = window._savedApiKeys || [];
    if (countBadge) countBadge.textContent = `${keys.length} Active ${keys.length === 1 ? 'Key' : 'Keys'}`;
    if (kpiKeyCount) kpiKeyCount.textContent = keys.length > 0 ? `${keys.length} Key${keys.length > 1 ? 's' : ''} in Pool` : 'Default / Server Key';

    if (keys.length === 0) {
        container.innerHTML = `
            <div class="p-3.5 rounded-xl bg-slate-950/80 border border-dashed border-slate-800 text-slate-400 text-xs flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                    <i class="fa-solid fa-key text-slate-600"></i>
                    <span>No custom API keys added yet. Paste a key above to enable dedicated Round-Robin rotation.</span>
                </div>
                <span class="text-[10px] font-mono text-slate-500 shrink-0">0 Keys</span>
            </div>
        `;
        if (hiddenTextarea) hiddenTextarea.value = '';
        return;
    }

    container.innerHTML = keys.map((key, idx) => {
        const isRevealed = Boolean(window._aiRevealedKeys[idx]);
        const displayKey = isRevealed
            ? key
            : (key.length > 12 ? `${key.slice(0, 7)}••••••••••••${key.slice(-4)}` : '••••••••••••');
        return `
            <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 flex items-center justify-between gap-3 text-xs font-mono transition">
                <div class="flex items-center gap-2.5 min-w-0">
                    <span class="w-6 h-6 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 flex items-center justify-center text-[10px] font-bold shrink-0">
                        #${idx + 1}
                    </span>
                    <span class="text-slate-200 truncate font-semibold select-all">${escapeHtml(displayKey)}</span>
                    <span class="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-sans font-bold uppercase shrink-0">Slot ${idx + 1}</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" onclick="toggleRevealAPIKey(${idx})" class="w-7 h-7 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer transition" title="${isRevealed ? 'Hide Key' : 'Reveal Key'}">
                        <i class="fa-solid ${isRevealed ? 'fa-eye-slash' : 'fa-eye'} text-[11px]"></i>
                    </button>
                    <button type="button" onclick="copyIndividualAPIKey(${idx})" class="w-7 h-7 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300 flex items-center justify-center cursor-pointer transition" title="Copy Key">
                        <i class="fa-regular fa-copy text-[11px]"></i>
                    </button>
                    <button type="button" onclick="deleteIndividualAPIKey(${idx})" class="w-7 h-7 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 flex items-center justify-center cursor-pointer transition" title="Remove Key">
                        <i class="fa-solid fa-trash-can text-[11px]"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    if (hiddenTextarea) {
        hiddenTextarea.value = keys.join('\n');
    }
}

function toggleRevealAPIKey(idx) {
    window._aiRevealedKeys[idx] = !window._aiRevealedKeys[idx];
    renderAPIKeysList();
}

function copyIndividualAPIKey(idx) {
    const key = window._savedApiKeys?.[idx];
    if (!key) return;
    navigator.clipboard.writeText(key).then(() => {
        showAIToast(`API Key #${idx + 1} copied to clipboard.`, 'info');
    });
}

function addIndividualAPIKey() {
    const input = document.getElementById('new-api-key-input');
    const val = input ? input.value.trim() : '';
    if (!val) {
        showAIToast('Please paste a valid API Key first.', 'error');
        input?.focus();
        return;
    }
    if (!window._savedApiKeys) window._savedApiKeys = [];
    if (!window._savedApiKeys.includes(val)) {
        window._savedApiKeys.push(val);
        showAIToast(`API Key #${window._savedApiKeys.length} added to rotation pool! Click Save to persist.`, 'success');
    } else {
        showAIToast('This API Key is already in your rotation pool.', 'info');
    }
    if (input) input.value = '';
    renderAPIKeysList();
}

function deleteIndividualAPIKey(index) {
    if (!window._savedApiKeys) return;
    window._savedApiKeys.splice(index, 1);
    delete window._aiRevealedKeys[index];
    renderAPIKeysList();
    showAIToast('API key removed from rotation pool.', 'info');
}

// ============================================================================
// 2. MODEL PRESETS, TEMPERATURE & PERSONA TEMPLATES
// ============================================================================
function handleAIProviderChange(provider) {
    renderModelPresetChips(provider);
    const modelInput = document.getElementById('ai-model');
    const presets = MODEL_PRESETS_BY_PROVIDER[provider] || MODEL_PRESETS_BY_PROVIDER.Groq;
    if (modelInput && (!modelInput.value.trim() || Object.values(MODEL_PRESETS_BY_PROVIDER).flat().some(m => m.id === modelInput.value.trim()))) {
        modelInput.value = presets[0]?.id || '';
    }
    updateAIKPIStrip();
}

function renderModelPresetChips(provider) {
    const container = document.getElementById('ai-model-presets-container');
    if (!container) return;
    const presets = MODEL_PRESETS_BY_PROVIDER[provider] || MODEL_PRESETS_BY_PROVIDER.Groq;
    const currentModel = document.getElementById('ai-model')?.value.trim() || '';

    container.innerHTML = presets.map(m => {
        const isSelected = currentModel === m.id;
        return `
            <button type="button" onclick="selectAIModelPreset('${m.id}')" class="px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition cursor-pointer ${isSelected ? 'bg-purple-500 text-white shadow-sm' : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800'}">
                ${escapeHtml(m.label)}
            </button>
        `;
    }).join('');
}

function selectAIModelPreset(modelId) {
    const input = document.getElementById('ai-model');
    if (input) input.value = modelId;
    const provider = document.getElementById('ai-platform')?.value || 'Groq';
    renderModelPresetChips(provider);
    updateAIKPIStrip();
}

function updateTemperatureDisplay(val) {
    const num = parseFloat(val) || 0.7;
    const disp = document.getElementById('temp-display-val');
    const modeLabel = document.getElementById('temp-mode-label');
    if (disp) disp.textContent = num.toFixed(1);
    if (modeLabel) {
        if (num <= 0.3) {
            modeLabel.textContent = 'Strict Catalog & Factual Precision';
            modeLabel.className = 'text-[10px] font-mono text-cyan-400';
        } else if (num <= 0.8) {
            modeLabel.textContent = 'Balanced Sales & Natural Politeness';
            modeLabel.className = 'text-[10px] font-mono text-emerald-400';
        } else {
            modeLabel.textContent = 'Creative & Expressive Outreach';
            modeLabel.className = 'text-[10px] font-mono text-amber-400';
        }
    }
}

function applyAIPersonaPreset(presetKey) {
    const textarea = document.getElementById('ai-store-policies');
    if (!textarea) return;
    const bName = window._aiSyncedStoreContext?.business_name || getActiveUsername() || 'our store';

    const templates = {
        kirana: `You are the polite WhatsApp ordering assistant for ${bName}. Greet customers warmly with Namaste 🙏. Always quote exact product prices and variants from the live catalog. Remind customers about fast doorstep delivery and ask them to share their delivery address or live location pin to confirm their order.`,
        restaurant: `You are the fast-food & cloud kitchen order desk for ${bName}. Suggest popular combos and fresh items from the menu, confirm spice/customization preferences, mention hot doorstep delivery within 35-45 minutes, and guide the customer to complete UPI or COD checkout.`,
        boutique: `You are the personal shopping stylist for ${bName}. Help customers pick sizes, colors, and trending styles from our catalog. Share product images when requested using <IMG_ID>, highlight fabric quality, and assist with instant order booking.`,
        strict: `Strictly answer only using products and prices available in the ${bName} catalog. Never invent unlisted items or discounts. If an item is out of stock or not listed, politely inform the customer and offer to connect them with the store manager.`
    };

    if (templates[presetKey]) {
        textarea.value = templates[presetKey];
        showAIToast('AI Sales Persona instructions applied! Click Save AI Settings to activate.', 'info');
    }
}

function updateAIKPIStrip() {
    const platform = document.getElementById('ai-platform')?.value || 'Groq';
    const model = document.getElementById('ai-model')?.value.trim() || 'Default Model';
    const autoReply = document.getElementById('ai-autoreply-check')?.checked ?? true;
    const importCat = document.getElementById('ai-import-catalog-check')?.checked ?? true;
    const notifPhone = document.getElementById('ai-notif-phone')?.value.trim() || '';

    const kpiEngine = document.getElementById('kpi-ai-engine-label');
    const kpiModel = document.getElementById('kpi-ai-model-label');
    if (kpiEngine) kpiEngine.textContent = platform;
    if (kpiModel) kpiModel.textContent = model;

    const statusBadge = document.getElementById('ai-autopilot-status-badge');
    const heroToggle = document.getElementById('hero-ai-autoreply-toggle');
    if (heroToggle && heroToggle.checked !== autoReply) heroToggle.checked = autoReply;

    if (statusBadge) {
        statusBadge.innerHTML = autoReply
            ? '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>24/7 Autopilot Active'
            : '<span class="w-2 h-2 rounded-full bg-rose-400 inline-block mr-1.5"></span>Auto-Reply Paused';
        statusBadge.className = autoReply
            ? 'text-xs font-black text-emerald-400 flex items-center'
            : 'text-xs font-black text-rose-400 flex items-center';
    }

    const kpiCatalog = document.getElementById('kpi-ai-catalog-status');
    const kpiCatalogSub = document.getElementById('kpi-ai-catalog-sub');
    const prodCount = window._aiSyncedStoreContext?.product_count || 0;
    const catCount = window._aiSyncedStoreContext?.category_count || 0;
    if (kpiCatalog) {
        kpiCatalog.textContent = importCat ? `${prodCount} Products Indexed` : 'Catalog RAG Disabled';
        kpiCatalog.className = importCat ? 'text-xs font-bold text-emerald-400 font-mono mt-0.5' : 'text-xs font-bold text-slate-400 font-mono mt-0.5';
    }
    if (kpiCatalogSub) {
        kpiCatalogSub.textContent = importCat ? `${catCount} Categories in prompt` : ' Enable below to feed prices';
    }

    const kpiAlert = document.getElementById('kpi-ai-alert-phone');
    if (kpiAlert) {
        kpiAlert.textContent = notifPhone ? `+${notifPhone.replace(/^\+/, '')}` : 'Not Configured';
        kpiAlert.className = notifPhone ? 'text-xs font-bold text-white font-mono mt-0.5' : 'text-xs font-bold text-amber-400 font-mono mt-0.5';
    }

    const simBadge = document.getElementById('test-sandbox-model-badge');
    if (simBadge) {
        simBadge.innerHTML = `<i class="fa-solid fa-microchip text-xs"></i> ${escapeHtml(platform)} · ${escapeHtml(model.slice(0, 22))}`;
    }
}

async function quickToggleAIAutoReply(enabled) {
    const checkEl = document.getElementById('ai-autoreply-check');
    if (checkEl) checkEl.checked = Boolean(enabled);
    updateAIKPIStrip();
    await saveAISettings(true);
}

// ============================================================================
// 3. SAVE & LOAD AI SETTINGS (SYNCED WITH STORE MANAGEMENT)
// ============================================================================
async function saveAISettings(isSilentToggle = false) {
    const platform = document.getElementById('ai-platform')?.value || 'Groq';
    const modelInput = document.getElementById('ai-model');
    const model = modelInput ? modelInput.value.trim() : 'llama-3.3-70b-versatile';
    const temperature = parseFloat(document.getElementById('ai-temperature')?.value) || 0.7;
    const notifPhone = document.getElementById('ai-notif-phone')?.value.trim() || '';
    const responseLanguage = document.getElementById('ai-response-language')?.value || 'Hinglish';
    const autoReply = document.getElementById('ai-autoreply-check')?.checked ?? true;
    const importCatalog = document.getElementById('ai-import-catalog-check')?.checked ?? true;
    const storePolicies = document.getElementById('ai-store-policies')?.value.trim() || '';

    // Preserve store context fields without duplicating their inputs
    const businessName = document.getElementById('ai-business-name')?.value.trim()
        || window._aiSyncedStoreContext?.business_name
        || '';
    const businessType = document.getElementById('ai-business-type')?.value
        || window._aiSyncedStoreContext?.business_type
        || '';

    // Automatically capture any typed API key from input box if user didn't click Add
    const newKeyInput = document.getElementById('new-api-key-input');
    if (newKeyInput && newKeyInput.value.trim()) {
        const typedKey = newKeyInput.value.trim();
        if (!window._savedApiKeys) window._savedApiKeys = [];
        if (!window._savedApiKeys.includes(typedKey)) {
            window._savedApiKeys.push(typedKey);
        }
        newKeyInput.value = '';
        renderAPIKeysList();
    }

    const apiKey = (window._savedApiKeys && window._savedApiKeys.length > 0)
        ? window._savedApiKeys.join('\n')
        : (document.getElementById('ai-api-key')?.value.trim() || '');
    const username = getActiveUsername();

    const saveBtn = document.getElementById('btn-save-ai-settings');
    const originalHtml = saveBtn ? saveBtn.innerHTML : '<i class="fa-solid fa-floppy-disk"></i><span>Save AI Configuration</span>';
    if (saveBtn && !isSilentToggle) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Syncing AI Engine...</span>';
    }

    try {
        const payload = {
            username,
            platform,
            ai_provider: platform,
            model,
            ai_model: model,
            temperature,
            ai_temperature: temperature,
            notification_phone: notifPhone,
            api_key: apiKey,
            response_language: responseLanguage,
            language: responseLanguage,
            auto_reply: autoReply,
            import_catalog_details: importCatalog,
            store_policies: storePolicies
        };
        if (businessName) payload.business_name = businessName;
        if (businessType) payload.business_type = businessType;

        const res = await fetch('/api/ai/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            updateAIKPIStrip();
            if (isSilentToggle) {
                showAIToast(autoReply ? '🟢 24/7 AI Inbound Auto-Reply enabled!' : '🔴 AI Inbound Auto-Reply paused.', autoReply ? 'success' : 'info');
            } else {
                showAIToast('AI Lead Responder configuration saved & synced to cloud DB!', 'success');
            }
            if (typeof window.loadUserProfile === 'function') {
                try { window.loadUserProfile(); } catch {}
            }
        } else {
            showAIToast(data.message || data.error || 'Failed to save AI settings.', 'error');
        }
    } catch (err) {
        showAIToast('Network error saving AI settings. Please try again.', 'error');
    } finally {
        if (saveBtn && !isSilentToggle) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = originalHtml;
        }
    }
}

async function testLeadAlertDispatch() {
    const notifPhone = document.getElementById('ai-notif-phone')?.value.trim();
    const btn = document.getElementById('btn-test-lead-alert');
    if (!notifPhone) {
        showAIToast('Please enter a Lead Alert Notification WhatsApp Number first.', 'error');
        document.getElementById('ai-notif-phone')?.focus();
        return;
    }

    const username = getActiveUsername();
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Dispatching...</span>';
    }

    try {
        const res = await fetch('/api/ai/test-lead-alert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, notification_phone: notifPhone })
        });
        const data = await res.json();
        if (res.ok && data.status !== 'error') {
            showAIToast(data.message || `Test lead alert dispatched to +${notifPhone}!`, 'success');
        } else {
            showAIToast(data.message || 'Could not dispatch test lead alert.', 'error');
        }
    } catch (err) {
        showAIToast('Network error sending test lead alert.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}

async function loadAISettings() {
    const username = getActiveUsername();
    if (!username) return;

    try {
        const [aiRes, prodRes, catRes] = await Promise.all([
            fetch(`/api/ai/settings?username=${encodeURIComponent(username)}`),
            fetch(`/api/products?username=${encodeURIComponent(username)}`),
            fetch(`/api/categories?username=${encodeURIComponent(username)}`)
        ]);

        let prodCount = 0;
        let catCount = 0;
        if (prodRes.ok) {
            const pList = await prodRes.json();
            if (Array.isArray(pList)) prodCount = pList.length;
        }
        if (catRes.ok) {
            const cList = await catRes.json();
            if (Array.isArray(cList)) catCount = cList.length;
        }

        if (!aiRes.ok) return;
        const data = await aiRes.json();

        window._aiSyncedStoreContext = {
            business_name: data.business_name || username,
            business_type: data.business_type || 'Kirana / General Store',
            product_count: prodCount,
            category_count: catCount,
            allow_cod: data.allow_cod !== false,
            paytm_vpa: data.paytm_vpa || ''
        };

        const platformEl = document.getElementById('ai-platform');
        const modelEl = document.getElementById('ai-model');
        const tempEl = document.getElementById('ai-temperature');
        const notifEl = document.getElementById('ai-notif-phone');
        const bNameEl = document.getElementById('ai-business-name');
        const bTypeEl = document.getElementById('ai-business-type');
        const langEl = document.getElementById('ai-response-language');
        const autoReplyEl = document.getElementById('ai-autoreply-check');
        const importCatalogEl = document.getElementById('ai-import-catalog-check');
        const storePoliciesEl = document.getElementById('ai-store-policies');

        // Normalize provider casing to match select options
        const rawProv = String(data.ai_provider || data.platform || 'Groq').toLowerCase();
        let matchedProv = 'Groq';
        if (rawProv.includes('gemini')) matchedProv = 'Gemini';
        else if (rawProv.includes('gpt') || rawProv.includes('openai')) matchedProv = 'ChatGPT';
        else if (rawProv.includes('deepseek')) matchedProv = 'DeepSeek';
        else if (rawProv.includes('openrouter')) matchedProv = 'OpenRouter';

        if (platformEl) platformEl.value = matchedProv;
        if (modelEl) modelEl.value = data.ai_model || data.model || 'llama-3.3-70b-versatile';
        renderModelPresetChips(matchedProv);

        const t = data.ai_temperature ?? data.temperature ?? 0.7;
        if (tempEl) tempEl.value = t;
        updateTemperatureDisplay(t);

        if (notifEl) notifEl.value = data.notification_phone || '';
        if (bNameEl) bNameEl.value = data.business_name || data.account_name || username;
        if (bTypeEl) bTypeEl.value = data.business_type || 'Kirana / General Store';
        if (langEl) langEl.value = data.response_language || data.language || 'Hinglish';
        if (autoReplyEl) autoReplyEl.checked = data.auto_reply !== false;
        if (importCatalogEl) importCatalogEl.checked = data.import_catalog_details !== false;
        if (storePoliciesEl) storePoliciesEl.value = data.store_policies || '';

        // Update linked store context summary bar
        const ctxStoreName = document.getElementById('ai-linked-store-name');
        const ctxStoreType = document.getElementById('ai-linked-store-type');
        const ctxPaymentBadge = document.getElementById('ai-linked-payment-badge');
        if (ctxStoreName) ctxStoreName.textContent = data.business_name || username;
        if (ctxStoreType) ctxStoreType.textContent = data.business_type || 'Kirana / General Store';
        if (ctxPaymentBadge) {
            const pMethods = [];
            if (data.paytm_vpa) pMethods.push(`UPI (${data.paytm_vpa})`);
            if (data.allow_cod !== false) pMethods.push('COD');
            ctxPaymentBadge.textContent = pMethods.length > 0 ? pMethods.join(' + ') : 'Prepaid Only';
        }

        if (data.api_key !== undefined) {
            const raw = String(data.api_key || '').trim();
            if (raw) {
                window._savedApiKeys = raw.split(/[\n,\s]+/).map(k => k.trim()).filter(Boolean);
            } else {
                window._savedApiKeys = [];
            }
            renderAPIKeysList();
        }

        updateAIKPIStrip();
    } catch (err) {
        console.warn('AI settings load error:', err);
    }
}

// ============================================================================
// 4. INTERACTIVE MULTI-TURN WHATSAPP AI SIMULATOR
// ============================================================================
function setQuickTestQuery(text) {
    const input = document.getElementById('ai-test-query');
    if (input) {
        input.value = text;
        runAITestSimulation();
    }
}

function clearAISimulatorChat() {
    window._aiSimHistory = [];
    const thread = document.getElementById('ai-sim-chat-thread');
    if (thread) {
        thread.innerHTML = `
            <div class="text-center py-6 space-y-2">
                <div class="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto text-sm">
                    <i class="fa-brands fa-whatsapp"></i>
                </div>
                <p class="text-xs font-bold text-slate-300">Live WhatsApp AI Sandbox Ready</p>
                <p class="text-[11px] text-slate-500 max-w-xs mx-auto">Click any quick test chip below or type a customer message to test your AI sales agent in real time.</p>
            </div>
        `;
    }
    const resultBox = document.getElementById('ai-test-result-box');
    if (resultBox) resultBox.classList.add('hidden');
}

async function runAITestSimulation() {
    const queryInput = document.getElementById('ai-test-query');
    const query = queryInput ? queryInput.value.trim() : '';
    if (!query) {
        showAIToast('Please type or select a sample customer message first.', 'error');
        queryInput?.focus();
        return;
    }

    const platform = document.getElementById('ai-platform')?.value || 'Groq';
    const model = document.getElementById('ai-model')?.value.trim() || 'llama-3.3-70b-versatile';
    const temperature = parseFloat(document.getElementById('ai-temperature')?.value) || 0.7;
    const apiKey = (window._savedApiKeys && window._savedApiKeys.length > 0)
        ? window._savedApiKeys.join('\n')
        : (document.getElementById('ai-api-key')?.value.trim() || '');
    const businessName = document.getElementById('ai-business-name')?.value.trim()
        || window._aiSyncedStoreContext?.business_name
        || getActiveUsername();
    const businessType = document.getElementById('ai-business-type')?.value
        || window._aiSyncedStoreContext?.business_type
        || 'Kirana / General Store';
    const responseLanguage = document.getElementById('ai-response-language')?.value || 'Hinglish';
    const username = getActiveUsername();

    const btn = document.getElementById('btn-test-ai');
    const btnText = document.getElementById('btn-test-ai-text');
    const resultBox = document.getElementById('ai-test-result-box');
    const replyEl = document.getElementById('ai-test-reply-content');
    const errorBox = document.getElementById('ai-test-error-box');
    const errorText = document.getElementById('ai-test-error-text');
    const latencyEl = document.getElementById('ai-test-latency');
    const metaBadge = document.getElementById('ai-test-meta-badge');
    const modelInfo = document.getElementById('ai-test-model-info');
    const tsEl = document.getElementById('ai-test-timestamp');
    const thread = document.getElementById('ai-sim-chat-thread');

    if (errorBox) errorBox.classList.add('hidden');
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i> Thinking...';

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Append incoming customer bubble into thread
    if (thread) {
        if (window._aiSimHistory.length === 0) thread.innerHTML = '';
        window._aiSimHistory.push({ role: 'user', text: query, time: nowStr });
        thread.insertAdjacentHTML('beforeend', `
            <div class="flex justify-start">
                <div class="max-w-[82%] bg-slate-800 border border-slate-700 text-slate-100 px-3.5 py-2.5 rounded-2xl rounded-tl-sm text-xs leading-relaxed shadow">
                    <div class="text-[9px] font-mono text-cyan-400 font-bold mb-0.5">Customer</div>
                    <div>${escapeHtml(query)}</div>
                    <div class="text-[9px] font-mono text-slate-400 text-right mt-1">${nowStr}</div>
                </div>
            </div>
        `);
        thread.scrollTop = thread.scrollHeight;
    }
    if (queryInput) queryInput.value = '';

    const startTime = performance.now();

    try {
        const res = await fetch('/api/ai/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                query,
                prompt: query,
                platform,
                ai_provider: platform,
                model,
                temperature,
                api_key: apiKey,
                business_name: businessName,
                business_type: businessType,
                response_language: responseLanguage,
                language: responseLanguage
            })
        });

        const data = await res.json();
        const latency = Math.round(performance.now() - startTime);

        if (!res.ok || data.error) {
            if (errorBox && errorText) {
                errorText.innerText = data.error || `Server responded with status ${res.status}`;
                errorBox.classList.remove('hidden');
            }
            return;
        }

        const rawReply = data.reply || data.response || 'No response generated.';
        const replyTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (resultBox) resultBox.classList.remove('hidden');
        if (latencyEl) latencyEl.innerText = `${latency}ms`;
        if (metaBadge) metaBadge.innerText = `· ${data.provider || platform}`;
        if (modelInfo) modelInfo.innerText = `Model: ${data.model_used || model || 'Default'} (${temperature} temp)`;
        if (tsEl) tsEl.innerText = replyTime;
        if (replyEl) replyEl.innerText = rawReply;

        if (thread) {
            window._aiSimHistory.push({ role: 'assistant', text: rawReply, time: replyTime, latency });
            thread.insertAdjacentHTML('beforeend', `
                <div class="flex justify-end">
                    <div class="max-w-[86%] bg-[#005c4b] text-white px-3.5 py-2.5 rounded-2xl rounded-tr-sm text-xs leading-relaxed shadow-md space-y-1.5">
                        <div class="flex items-center justify-between gap-2 text-[9px] font-mono text-emerald-200/90 border-b border-emerald-400/20 pb-1">
                            <span><i class="fa-solid fa-robot mr-1"></i>AI Agent (${escapeHtml(data.provider || platform)})</span>
                            <span>${latency}ms</span>
                        </div>
                        <div class="whitespace-pre-wrap">${escapeHtml(rawReply)}</div>
                        <div class="text-[9px] font-mono text-emerald-200/80 text-right flex items-center justify-end gap-1">
                            <span>${replyTime}</span>
                            <i class="fa-solid fa-check-double text-sky-300"></i>
                        </div>
                    </div>
                </div>
            `);
            thread.scrollTop = thread.scrollHeight;
        }
    } catch (err) {
        if (errorBox && errorText) {
            errorText.innerText = 'Network error contacting AI simulation engine. Please check connection.';
            errorBox.classList.remove('hidden');
        }
    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.innerHTML = '<i class="fa-solid fa-paper-plane text-xs"></i> Send';
    }
}

export function getAIResponderHTML() {
    return `                <!-- VIEW: AI LEAD RESPONDER STUDIO & LIVE WHATSAPP SIMULATOR -->
                <div id="view-ai" class="biz-tab-content max-w-6xl mx-auto space-y-6 pb-12">

                    <!-- Non-Blocking Toast Banner -->
                    <div id="ai-toast-banner" class="hidden fixed bottom-6 right-6 z-50 max-w-md px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-md flex items-center gap-3 transition-all duration-200">
                        <i id="ai-toast-icon" class="fa-solid fa-circle-check text-emerald-400 text-sm shrink-0"></i>
                        <span id="ai-toast-text" class="text-xs font-bold leading-snug">AI settings saved!</span>
                        <button type="button" onclick="document.getElementById('ai-toast-banner').classList.add('hidden')" class="ml-2 text-slate-400 hover:text-white text-xs cursor-pointer">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>

                    <!-- Hidden inputs preserving store context sync -->
                    <input type="hidden" id="ai-business-name" value="">
                    <input type="hidden" id="ai-business-type" value="Kirana / General Store">

                    <!-- ============================================================== -->
                    <!-- TOP EXECUTIVE COMMAND HEADER & 4 LIVE TELEMETRY KPIS -->
                    <!-- ============================================================== -->
                    <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-5">
                        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/90 pb-5">
                            <div class="flex items-start sm:items-center gap-3.5">
                                <div class="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center text-xl shrink-0 shadow-inner">
                                    <i class="fa-solid fa-robot"></i>
                                </div>
                                <div>
                                    <div class="flex flex-wrap items-center gap-2.5">
                                        <h2 class="text-lg font-black text-white tracking-tight">AI Sales Responder & RAG Studio</h2>
                                        <span class="px-2.5 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-300 text-[10px] font-mono font-bold uppercase tracking-wider">
                                            Multi-LLM Engine
                                        </span>
                                    </div>
                                    <p class="text-xs text-slate-400 mt-0.5">Configure autonomous WhatsApp lead qualification, round-robin API key rotation, catalog RAG & live chat testing.</p>
                                </div>
                            </div>

                            <!-- Master 24/7 Autopilot Switch + Save Button -->
                            <div class="flex flex-wrap items-center gap-3">
                                <div class="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800">
                                    <div class="text-right">
                                        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Inbound Bot</div>
                                        <div id="ai-autopilot-status-badge" class="text-xs font-black text-emerald-400 flex items-center">
                                            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>24/7 Autopilot Active
                                        </div>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer shrink-0" title="Enable / Pause 24/7 AI Inbound Auto-Replies">
                                        <input type="checkbox" id="hero-ai-autoreply-toggle" checked onchange="quickToggleAIAutoReply(this.checked)" class="sr-only peer">
                                        <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500"></div>
                                    </label>
                                </div>

                                <button type="button" id="btn-save-ai-settings" onclick="saveAISettings()" class="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-2 shadow-lg shadow-purple-600/25">
                                    <i class="fa-solid fa-floppy-disk"></i>
                                    <span>Save AI Configuration</span>
                                </button>
                            </div>
                        </div>

                        <!-- 4 Live Telemetry KPI Cards -->
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-microchip"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Active LLM Provider</div>
                                    <div id="kpi-ai-engine-label" class="text-xs font-bold text-white font-mono mt-0.5">Groq</div>
                                    <div id="kpi-ai-model-label" class="text-[10px] text-purple-400 font-mono truncate">llama-3.3-70b-versatile</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-key"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">API Key Rotation</div>
                                    <div id="kpi-ai-keys-count" class="text-xs font-bold text-white font-mono mt-0.5">Default / Server Key</div>
                                    <div class="text-[10px] text-cyan-400 font-medium">Round-robin load balancer</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-boxes-stacked"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Catalog RAG Context</div>
                                    <div id="kpi-ai-catalog-status" class="text-xs font-bold text-emerald-400 font-mono mt-0.5">0 Products Indexed</div>
                                    <div id="kpi-ai-catalog-sub" class="text-[10px] text-slate-400 font-medium truncate">Live inventory synced</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-bell"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Lead Alert Target</div>
                                    <div id="kpi-ai-alert-phone" class="text-xs font-bold text-white font-mono mt-0.5 truncate">Not Configured</div>
                                    <div class="text-[10px] text-amber-400 font-medium">Instant WhatsApp forward</div>
                                </div>
                            </div>
                        </div>

                        <!-- Non-Duplicate Linked Storefront & Checkout Context Strip -->
                        <div class="px-4 py-3 rounded-xl bg-slate-950/90 border border-slate-800/90 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                            <div class="flex flex-wrap items-center gap-2.5 text-xs">
                                <span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono font-bold">
                                    <i class="fa-solid fa-link mr-1"></i>Synced Store Context
                                </span>
                                <span class="text-slate-300 font-bold" id="ai-linked-store-name">My Store</span>
                                <span class="text-slate-600">•</span>
                                <span class="text-slate-400 text-[11px]" id="ai-linked-store-type">Kirana / General Store</span>
                                <span class="text-slate-600">•</span>
                                <span class="text-cyan-400 text-[11px] font-mono" id="ai-linked-payment-badge">COD Active</span>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <button type="button" onclick="if(typeof switchTab==='function') switchTab('catalog')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[11px] font-bold transition cursor-pointer">
                                    <i class="fa-solid fa-boxes-stacked text-amber-400 mr-1"></i>Manage Catalog
                                </button>
                                <button type="button" onclick="if(typeof switchTab==='function') switchTab('store')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 text-[11px] font-bold transition cursor-pointer">
                                    <i class="fa-solid fa-store mr-1"></i>Store & UPI Settings
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- ============================================================== -->
                    <!-- MAIN 2-COLUMN WORKSPACE: CONFIGURATOR (LEFT) + SIMULATOR (RIGHT) -->
                    <!-- ============================================================== -->
                    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

                        <!-- LEFT COLUMN (7 COLS): AI ENGINE, API KEYS, PERSONA & LEAD ALERTS -->
                        <div class="lg:col-span-7 space-y-6">

                            <!-- CARD 1: LLM ENGINE, MODEL & TEMPERATURE -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5 shadow-xl">
                                <div class="flex items-center justify-between border-b border-slate-800 pb-3.5">
                                    <div class="flex items-center gap-2.5">
                                        <div class="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center text-sm">
                                            <i class="fa-solid fa-sliders"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">1. LLM Provider, Model & Creativity</h3>
                                            <p class="text-[11px] text-slate-400">Select your inference provider and pick a recommended model or type any custom model ID.</p>
                                        </div>
                                    </div>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="block text-xs font-bold text-slate-300">AI Provider Platform</label>
                                        <select id="ai-platform" onchange="handleAIProviderChange(this.value)" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-purple-500 cursor-pointer">
                                            <option value="Groq">⚡ Groq (Ultra-Low Latency LPU)</option>
                                            <option value="Gemini">✨ Google Gemini</option>
                                            <option value="ChatGPT">🧠 OpenAI ChatGPT</option>
                                            <option value="DeepSeek">🔮 DeepSeek AI</option>
                                            <option value="OpenRouter">🌐 OpenRouter (Universal)</option>
                                        </select>
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="block text-xs font-bold text-slate-300">Model ID (Editable)</label>
                                        <input type="text" id="ai-model" oninput="updateAIKPIStrip()" placeholder="e.g. llama-3.3-70b-versatile" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-purple-300 outline-none focus:border-purple-500 placeholder-slate-600">
                                    </div>
                                </div>

                                <!-- Dynamic Recommended Model Chips -->
                                <div class="space-y-1.5">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Recommended Models for Selected Provider:</div>
                                    <div id="ai-model-presets-container" class="flex flex-wrap gap-1.5"></div>
                                </div>

                                <!-- Temperature Slider -->
                                <div class="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                                    <div class="flex items-center justify-between">
                                        <div>
                                            <span class="text-xs font-bold text-slate-200">Response Temperature (Creativity vs. Precision)</span>
                                            <div id="temp-mode-label" class="text-[10px] font-mono text-emerald-400">Balanced Sales & Natural Politeness</div>
                                        </div>
                                        <span id="temp-display-val" class="px-2.5 py-1 rounded-lg bg-purple-500/15 border border-purple-500/30 text-xs font-mono font-bold text-purple-300">0.7</span>
                                    </div>
                                    <input type="range" id="ai-temperature" min="0.0" max="2.0" step="0.1" value="0.7" oninput="updateTemperatureDisplay(this.value)" class="w-full accent-purple-500 cursor-pointer">
                                    <div class="flex justify-between text-[10px] font-mono text-slate-500">
                                        <span>0.0 (Strict Catalog Facts)</span>
                                        <span>0.7 (Recommended Sales)</span>
                                        <span>2.0 (High Creativity)</span>
                                    </div>
                                </div>
                            </div>

                            <!-- CARD 2: MULTI-KEY ROTATION VAULT -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4 shadow-xl">
                                <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3.5">
                                    <div class="flex items-center gap-2.5">
                                        <div class="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center text-sm">
                                            <i class="fa-solid fa-key"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">2. Round-Robin API Key Vault</h3>
                                            <p class="text-[11px] text-slate-400">Add multiple API keys to automatically distribute traffic and eliminate rate limits.</p>
                                        </div>
                                    </div>
                                    <span id="ai-keys-count-badge" class="px-2.5 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-[10px] font-mono font-bold">
                                        0 Active Keys
                                    </span>
                                </div>

                                <div class="flex flex-col sm:flex-row gap-2">
                                    <input type="password" id="new-api-key-input" placeholder="Paste API Key (e.g. gsk_... or AIzaSy... or sk-...)" class="flex-1 px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white outline-none focus:border-cyan-500 placeholder-slate-600" onkeydown="if(event.key==='Enter'){event.preventDefault();addIndividualAPIKey();}">
                                    <button type="button" onclick="addIndividualAPIKey()" class="px-4 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0 shadow-md">
                                        <i class="fa-solid fa-plus text-xs"></i>
                                        <span>Add Key to Pool</span>
                                    </button>
                                </div>

                                <div id="api-keys-list-container" class="space-y-2"></div>
                                <textarea id="ai-api-key" class="hidden"></textarea>
                            </div>

                            <!-- CARD 3: CONVERSATIONAL PERSONA, RAG & GUARDRAILS -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5 shadow-xl">
                                <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3.5">
                                    <div class="flex items-center gap-2.5">
                                        <div class="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center text-sm">
                                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">3. Conversational Persona, Language & Catalog RAG</h3>
                                            <p class="text-[11px] text-slate-400">Control reply language, live inventory grounding, and custom business instructions.</p>
                                        </div>
                                    </div>
                                    <span class="px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono font-bold">
                                        Token-Optimized RAG
                                    </span>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch">
                                    <div class="space-y-1.5">
                                        <label class="block text-xs font-bold text-slate-300">Default Reply Language</label>
                                        <select id="ai-response-language" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-emerald-500 cursor-pointer">
                                            <option value="Hinglish">🇮🇳 Hinglish (Natural Hindi + English Mix)</option>
                                            <option value="English">🌐 English (Professional)</option>
                                            <option value="Hindi">🇮🇳 Hindi (हिंदी देवनागरी)</option>
                                            <option value="Marathi">🇮🇳 Marathi (मराठी)</option>
                                            <option value="Gujarati">🇮🇳 Gujarati (ગુજરાતી)</option>
                                            <option value="Tamil">🇮🇳 Tamil (தமிழ்)</option>
                                            <option value="Telugu">🇮🇳 Telugu (తెలుగు)</option>
                                            <option value="Bengali">🇮🇳 Bengali (বাংলা)</option>
                                        </select>
                                    </div>

                                    <!-- Live Catalog RAG Toggle -->
                                    <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
                                        <div>
                                            <div class="text-xs font-bold text-white flex items-center gap-1.5">
                                                <i class="fa-solid fa-boxes-stacked text-amber-400"></i>
                                                <span>Feed Live Catalog into AI</span>
                                            </div>
                                            <p class="text-[10px] text-slate-400 mt-0.5">Auto-injects prices, variants & stock into prompt</p>
                                        </div>
                                        <label class="relative inline-flex items-center cursor-pointer shrink-0">
                                            <input type="checkbox" id="ai-import-catalog-check" checked onchange="updateAIKPIStrip()" class="sr-only peer">
                                            <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                        </label>
                                    </div>
                                </div>

                                <!-- 1-Click Persona Presets + Custom Instructions Textarea -->
                                <div class="space-y-2">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <label class="text-xs font-bold text-slate-300">Custom Sales Instructions & Guardrails</label>
                                        <span class="text-[10px] font-mono text-slate-500">1-Click Persona Templates:</span>
                                    </div>
                                    <div class="flex flex-wrap gap-1.5 pb-1">
                                        <button type="button" onclick="applyAIPersonaPreset('kirana')" class="px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold transition cursor-pointer">
                                            🛒 Kirana & Grocery Closer
                                        </button>
                                        <button type="button" onclick="applyAIPersonaPreset('restaurant')" class="px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold transition cursor-pointer">
                                            🍔 Cloud Kitchen & Food Desk
                                        </button>
                                        <button type="button" onclick="applyAIPersonaPreset('boutique')" class="px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold transition cursor-pointer">
                                            👗 Fashion & Boutique Stylist
                                        </button>
                                        <button type="button" onclick="applyAIPersonaPreset('strict')" class="px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[10px] font-bold transition cursor-pointer">
                                            🛡️ Strict Catalog-Only Mode
                                        </button>
                                    </div>
                                    <textarea id="ai-store-policies" rows="3" placeholder="e.g. Greet with Namaste. Highlight free delivery above ₹499. Never invent unlisted products. Ask customers for their delivery location pin to confirm orders." class="w-full p-3.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-purple-500 placeholder-slate-600 leading-relaxed resize-y"></textarea>
                                </div>
                            </div>

                            <!-- CARD 4: AUTOMATED WHATSAPP LEAD ALERT DISPATCH -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4 shadow-xl">
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3.5">
                                    <div class="flex items-center gap-2.5">
                                        <div class="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center text-sm">
                                            <i class="fa-solid fa-bell"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">4. Instant WhatsApp Lead Alert Forwarding</h3>
                                            <p class="text-[11px] text-slate-400">Receive real-time WhatsApp alerts whenever the AI qualifies a buyer or captures an order.</p>
                                        </div>
                                    </div>
                                    <button type="button" id="btn-test-lead-alert" onclick="testLeadAlertDispatch()" class="px-3.5 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shrink-0">
                                        <i class="fa-solid fa-paper-plane"></i>
                                        <span>Send Test Alert</span>
                                    </button>
                                </div>

                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-slate-300">Merchant Alert WhatsApp Number (With Country Code)</label>
                                    <input type="text" id="ai-notif-phone" oninput="updateAIKPIStrip()" placeholder="e.g. 919876543210" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-amber-300 outline-none focus:border-amber-500 placeholder-slate-600">
                                </div>

                                <div class="pt-2 border-t border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                                    <label class="flex items-center gap-2.5 cursor-pointer">
                                        <input type="checkbox" id="ai-autoreply-check" checked onchange="updateAIKPIStrip()" class="w-4 h-4 rounded accent-purple-500 cursor-pointer">
                                        <span class="text-xs font-bold text-slate-200">Enable 24/7 AI Inbound WhatsApp Auto-Replies</span>
                                    </label>
                                    <button type="button" onclick="saveAISettings()" class="w-full sm:w-auto px-6 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-lg">
                                        <i class="fa-solid fa-floppy-disk"></i>
                                        <span>Save AI Settings</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- RIGHT COLUMN (5 COLS): STICKY INTERACTIVE WHATSAPP AI SIMULATOR -->
                        <div class="lg:col-span-5 lg:sticky lg:top-6 space-y-4">
                            <div class="bg-slate-900/95 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
                                <!-- WhatsApp Handset Top Bar -->
                                <div class="px-4 py-3.5 bg-[#1f2c34] border-b border-slate-800 flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-2.5 min-w-0">
                                        <div class="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center text-sm shrink-0">
                                            <i class="fa-brands fa-whatsapp"></i>
                                        </div>
                                        <div class="min-w-0">
                                            <div class="text-xs font-bold text-white truncate flex items-center gap-1.5">
                                                <span>AI Agent Live Simulator</span>
                                                <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>
                                            </div>
                                            <div id="test-sandbox-model-badge" class="text-[10px] font-mono text-emerald-300 truncate">
                                                <i class="fa-solid fa-microchip text-[9px]"></i> Live Engine
                                            </div>
                                        </div>
                                    </div>
                                    <button type="button" onclick="clearAISimulatorChat()" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold transition cursor-pointer shrink-0" title="Clear Simulator Conversation">
                                        <i class="fa-solid fa-broom mr-1"></i>Clear
                                    </button>
                                </div>

                                <!-- Scrollable Multi-Turn WhatsApp Chat Thread -->
                                <div id="ai-sim-chat-thread" class="p-4 bg-[#0b141a] min-h-[290px] max-h-[380px] overflow-y-auto space-y-3">
                                    <div class="text-center py-8 space-y-2">
                                        <div class="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto text-base">
                                            <i class="fa-brands fa-whatsapp"></i>
                                        </div>
                                        <p class="text-xs font-bold text-slate-300">Live WhatsApp AI Sandbox Ready</p>
                                        <p class="text-[11px] text-slate-500 max-w-xs mx-auto">Click any quick test scenario below or type a customer question to test your live catalog & prompt response.</p>
                                    </div>
                                </div>

                                <!-- Latest Reply Telemetry Strip (Preserves legacy IDs) -->
                                <div id="ai-test-result-box" class="hidden px-4 py-2 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
                                    <div class="flex items-center gap-1.5 truncate">
                                        <span class="text-emerald-400 font-bold"><i class="fa-solid fa-bolt mr-1"></i>Reply</span>
                                        <span id="ai-test-meta-badge" class="text-purple-300"></span>
                                        <span id="ai-test-model-info" class="truncate"></span>
                                    </div>
                                    <div class="flex items-center gap-2 shrink-0">
                                        <span id="ai-test-latency" class="text-cyan-400 font-bold"></span>
                                        <span id="ai-test-timestamp" class="hidden"></span>
                                    </div>
                                    <div id="ai-test-reply-content" class="hidden"></div>
                                    <div id="ai-test-img-preview" class="hidden">
                                        <img id="ai-test-img-thumb" src="" alt="">
                                        <div id="ai-test-img-tag"></div>
                                    </div>
                                </div>

                                <!-- Error Banner -->
                                <div id="ai-test-error-box" class="hidden m-3 p-3 rounded-xl bg-rose-950/90 border border-rose-500/40 text-xs text-rose-200 flex items-start gap-2">
                                    <i class="fa-solid fa-circle-exclamation text-rose-400 mt-0.5 shrink-0"></i>
                                    <div id="ai-test-error-text" class="leading-relaxed"></div>
                                </div>

                                <!-- Quick Test Scenario Chips -->
                                <div class="px-3.5 py-2.5 bg-slate-950/90 border-t border-slate-800/80 space-y-1.5">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Quick Customer Test Scenarios:</div>
                                    <div class="flex flex-wrap gap-1.5">
                                        <button type="button" onclick="setQuickTestQuery('Namaste! What products do you have available today and what are their prices?')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-purple-500/40 text-[10px] font-medium transition cursor-pointer">
                                            💰 Products & Prices
                                        </button>
                                        <button type="button" onclick="setQuickTestQuery('Can you send me a product photo from your catalog?')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-purple-500/40 text-[10px] font-medium transition cursor-pointer">
                                            🖼️ Request Photo
                                        </button>
                                        <button type="button" onclick="setQuickTestQuery('I want to place an order right now. Can I pay via UPI or Cash on Delivery?')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-purple-500/40 text-[10px] font-medium transition cursor-pointer">
                                            🛒 Order & Payment
                                        </button>
                                        <button type="button" onclick="setQuickTestQuery('How fast do you deliver to my home and what is the delivery charge?')" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-purple-500/40 text-[10px] font-medium transition cursor-pointer">
                                            🚚 Delivery & Fees
                                        </button>
                                    </div>
                                </div>

                                <!-- Message Input Composer -->
                                <div class="p-3 bg-[#1f2c34] border-t border-slate-800 flex items-center gap-2">
                                    <input type="text" id="ai-test-query" placeholder="Type a customer WhatsApp message..." class="flex-1 px-3.5 py-2.5 bg-[#2a3942] border border-slate-700/80 rounded-xl text-xs text-white outline-none focus:border-emerald-500 placeholder-slate-400" onkeydown="if(event.key==='Enter'){event.preventDefault();runAITestSimulation();}">
                                    <button type="button" id="btn-test-ai" onclick="runAITestSimulation()" class="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0 shadow-md">
                                        <span id="btn-test-ai-text"><i class="fa-solid fa-paper-plane text-xs"></i> Send</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>`;
}

export function initAIResponder(apiBaseUrl = "") {
    Object.assign(window, {
        showAIToast,
        renderAPIKeysList,
        toggleRevealAPIKey,
        copyIndividualAPIKey,
        addIndividualAPIKey,
        deleteIndividualAPIKey,
        handleAIProviderChange,
        renderModelPresetChips,
        selectAIModelPreset,
        updateTemperatureDisplay,
        applyAIPersonaPreset,
        updateAIKPIStrip,
        quickToggleAIAutoReply,
        saveAISettings,
        testLeadAlertDispatch,
        loadAISettings,
        setQuickTestQuery,
        clearAISimulatorChat,
        runAITestSimulation
    });
    loadAISettings();
}

export {
    showAIToast,
    renderAPIKeysList,
    toggleRevealAPIKey,
    copyIndividualAPIKey,
    addIndividualAPIKey,
    deleteIndividualAPIKey,
    handleAIProviderChange,
    renderModelPresetChips,
    selectAIModelPreset,
    updateTemperatureDisplay,
    applyAIPersonaPreset,
    updateAIKPIStrip,
    quickToggleAIAutoReply,
    saveAISettings,
    testLeadAlertDispatch,
    loadAISettings,
    setQuickTestQuery,
    clearAISimulatorChat,
    runAITestSimulation
};

Object.assign(window, {
    showAIToast,
    renderAPIKeysList,
    toggleRevealAPIKey,
    copyIndividualAPIKey,
    addIndividualAPIKey,
    deleteIndividualAPIKey,
    handleAIProviderChange,
    renderModelPresetChips,
    selectAIModelPreset,
    updateTemperatureDisplay,
    applyAIPersonaPreset,
    updateAIKPIStrip,
    quickToggleAIAutoReply,
    saveAISettings,
    testLeadAlertDispatch,
    loadAISettings,
    setQuickTestQuery,
    clearAISimulatorChat,
    runAITestSimulation
});
