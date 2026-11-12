/**
 * Admin AI Responder Engine & Live Simulator Lab Component
 * Supports configuring Master Admin or any Tenant's AI Responder settings, persona presets, and interactive WhatsApp chat simulation.
 */

import { showToast } from './admin-sidebar.js';
import { getAuthHeaders, escapeHtml } from '../shared/auth-guard.js';

export function getAIConfigHTML() {
    return `
        <div class="space-y-6 pb-8">
            <!-- Top Banner & Target Store Selector -->
            <div class="bg-gradient-to-r from-slate-900 via-purple-950/60 to-slate-900 p-6 rounded-3xl border border-purple-500/20 shadow-xl flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <div>
                    <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[11px] font-black uppercase tracking-widest mb-2">
                        <i class="fa-solid fa-brain"></i> Multi-Tenant Neural AI Engine
                    </div>
                    <h2 class="text-2xl md:text-3xl font-black text-white tracking-tight">AI Responder & Simulator Lab</h2>
                    <p class="text-slate-400 text-xs md:text-sm mt-1">Configure LLM models, system prompts, store policies, and automated lead capture for Master Admin or any tenant store.</p>
                </div>

                <div class="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
                    <div class="flex items-center gap-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3.5 py-2 flex-1 sm:flex-initial">
                        <i class="fa-solid fa-store text-purple-400 text-xs"></i>
                        <span class="text-[11px] font-bold text-slate-400 uppercase">Target Store:</span>
                        <select id="admin-ai-target-user" onchange="window.loadAdminTargetAISettings(this.value)" class="bg-transparent text-white text-xs font-bold outline-none pr-2 min-h-9 cursor-pointer">
                            <option value="admin" class="bg-slate-900 text-white">Master Admin (@admin)</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- Quick Persona Presets Bar -->
            <div class="bg-slate-900/90 p-4 rounded-2xl border border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-xs font-bold text-slate-300">
                    <i class="fa-solid fa-wand-magic-sparkles text-purple-400"></i>
                    <span>Quick Industry Persona Templates:</span>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button type="button" onclick="window.applyAdminAIPreset('kirana')" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-purple-600/20 text-slate-300 hover:text-purple-300 border border-slate-800 hover:border-purple-500/40 text-xs font-bold transition cursor-pointer">
                        🛒 Kirana & Grocery Store
                    </button>
                    <button type="button" onclick="window.applyAdminAIPreset('restaurant')" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-purple-600/20 text-slate-300 hover:text-purple-300 border border-slate-800 hover:border-purple-500/40 text-xs font-bold transition cursor-pointer">
                        🍔 Restaurant & Cloud Kitchen
                    </button>
                    <button type="button" onclick="window.applyAdminAIPreset('fashion')" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-purple-600/20 text-slate-300 hover:text-purple-300 border border-slate-800 hover:border-purple-500/40 text-xs font-bold transition cursor-pointer">
                        👗 Fashion & D2C Boutique
                    </button>
                    <button type="button" onclick="window.applyAdminAIPreset('saas')" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-purple-600/20 text-slate-300 hover:text-purple-300 border border-slate-800 hover:border-purple-500/40 text-xs font-bold transition cursor-pointer">
                        🚀 WaMart SaaS Sales Agent
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <!-- Left Column: Configuration Form (7 cols) -->
                <div class="lg:col-span-7 bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                    <div class="flex items-center justify-between mb-5 pb-4 border-b border-slate-800">
                        <div>
                            <h3 class="text-lg font-black text-white flex items-center gap-2">
                                <i class="fa-solid fa-sliders text-purple-400"></i> LLM Engine & Persona Settings
                            </h3>
                            <p class="text-xs text-slate-400 mt-0.5">Editing configuration for <span id="ai-editing-target-badge" class="text-purple-400 font-mono font-bold">@admin</span></p>
                        </div>
                        <label class="inline-flex items-center gap-2 cursor-pointer bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-xl">
                            <input type="checkbox" id="ai-auto-reply-toggle" checked class="w-4 h-4 accent-emerald-500 rounded">
                            <span class="text-[11px] font-black text-emerald-400 uppercase">24/7 Auto-Reply</span>
                        </label>
                    </div>

                    <form onsubmit="window.saveAISettings(event)" class="space-y-4">
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">AI Provider</label>
                                <select id="ai-provider" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white text-sm outline-none">
                                    <option value="Groq">Groq Cloud (Ultra-Fast Llama 3.3)</option>
                                    <option value="OpenAI">OpenAI (GPT-4o / Mini)</option>
                                    <option value="Gemini">Google Gemini (Flash / Pro)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Model Name</label>
                                <input type="text" id="ai-model" placeholder="llama-3.3-70b-versatile" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white text-sm font-mono outline-none">
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Provider API Key <span class="text-slate-500 font-normal">(Optional if server key configured)</span></label>
                            <input type="password" id="ai-key" placeholder="gsk_... or sk-..." class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white font-mono text-sm outline-none">
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Temperature (0.1 - 1.0)</label>
                                <input type="number" step="0.1" min="0" max="1" id="ai-temp" value="0.7" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white text-sm outline-none">
                            </div>
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Reply Language</label>
                                <input type="text" id="ai-lang" placeholder="Hinglish / English" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white text-sm outline-none">
                            </div>
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Lead Alert WhatsApp</label>
                                <input type="text" id="ai-alert-phone" placeholder="919876543210" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-purple-500 p-3 rounded-xl text-white font-mono text-sm outline-none">
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">System Persona & Sales Instructions</label>
                            <textarea id="ai-prompt" rows="4" placeholder="You are a polite, persuasive store assistant..." class="w-full bg-slate-950 border border-slate-800 focus:border-purple-500 p-3.5 rounded-xl text-white text-sm outline-none leading-relaxed"></textarea>
                        </div>

                        <div>
                            <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Store Knowledge Base, Delivery & Return Policies</label>
                            <textarea id="ai-knowledge" rows="3" placeholder="Free home delivery within 5km on orders above ₹299. Instant UPI & COD accepted..." class="w-full bg-slate-950 border border-slate-800 focus:border-purple-500 p-3.5 rounded-xl text-white text-sm outline-none leading-relaxed"></textarea>
                        </div>

                        <button type="submit" id="ai-save-btn" class="w-full min-h-11 bg-purple-600 hover:bg-purple-500 text-white font-black py-3.5 rounded-xl shadow-lg shadow-purple-600/20 transition flex items-center justify-center gap-2 text-sm cursor-pointer">
                            <i class="fa-solid fa-floppy-disk"></i> Save AI Configuration
                        </button>
                    </form>
                </div>

                <!-- Right Column: Live Interactive WhatsApp Chat Simulator (5 cols) -->
                <div class="lg:col-span-5 bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl flex flex-col justify-between">
                    <div>
                        <div class="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
                            <div class="flex items-center gap-2.5">
                                <div class="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                                    <i class="fa-brands fa-whatsapp text-xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base font-black text-white">Live WhatsApp AI Simulator</h3>
                                    <p class="text-[11px] text-slate-400">Test real-time responses with live inventory context</p>
                                </div>
                            </div>
                            <button type="button" onclick="window.clearAdminSimChat()" class="min-h-9 px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-white text-xs font-bold border border-slate-800 transition cursor-pointer">
                                Clear Chat
                            </button>
                        </div>

                        <!-- Sample Quick Prompts -->
                        <div class="mb-3">
                            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">Try a sample catalog inquiry:</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button type="button" onclick="window.sendQuickSimPrompt('Aapke store me kya kya products available hain aur price kya hai?')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] border border-slate-800 transition cursor-pointer">📦 Available Products?</button>
                                <button type="button" onclick="window.sendQuickSimPrompt('Home delivery kitne der me hogi aur payment kaise karna hai?')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] border border-slate-800 transition cursor-pointer">🚚 Delivery & UPI?</button>
                                <button type="button" onclick="window.sendQuickSimPrompt('Mujhe bulk order dena hai, mera number 9876543210 hai call back karo')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] border border-slate-800 transition cursor-pointer">🔥 Order Lead Trigger</button>
                            </div>
                        </div>

                        <!-- Chat Conversation Stream -->
                        <div id="ai-sim-chat-stream" class="bg-slate-950/90 border border-slate-800/90 rounded-2xl p-4 h-[340px] overflow-y-auto space-y-3 custom-scrollbar">
                            <div class="flex items-start gap-2.5">
                                <div class="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300 text-xs shrink-0 mt-0.5">
                                    <i class="fa-solid fa-robot"></i>
                                </div>
                                <div class="bg-slate-900 border border-slate-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-xs text-slate-300 max-w-[85%] leading-relaxed">
                                    👋 Namaste! Send a test message below to preview how the AI Responder replies to WhatsApp shoppers using your store prompt and live inventory catalog.
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Chat Input Box -->
                    <div class="mt-4 pt-3 border-t border-slate-800">
                        <div class="flex items-center gap-2">
                            <input type="text" id="ai-test-input" onkeydown="if(event.key==='Enter'){event.preventDefault();window.testAI();}" placeholder="Type a shopper inquiry or product search..." class="flex-1 min-h-11 bg-slate-950 border border-slate-800 focus:border-emerald-500 px-3.5 py-2.5 rounded-xl text-white text-sm outline-none">
                            <button type="button" onclick="window.testAI()" id="ai-test-btn" class="min-h-11 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-black rounded-xl shadow-lg shadow-emerald-600/20 transition flex items-center gap-1.5 text-xs shrink-0 cursor-pointer">
                                <i class="fa-solid fa-paper-plane"></i> Send
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function initAIConfig() {
    let activeAIUser = 'admin';

    const PRESETS = {
        kirana: {
            lang: 'Hinglish',
            prompt: 'You are a helpful and polite neighborhood Kirana & Supermarket WhatsApp assistant. Help customers check product availability, daily grocery prices, and guide them to order via our online storefront or WhatsApp.',
            knowledge: 'Free home delivery within 3 KM on orders above ₹199. Delivery within 30-45 minutes. Both Instant UPI QR and Cash on Delivery (COD) are accepted.'
        },
        restaurant: {
            lang: 'Hinglish',
            prompt: 'You are an energetic Restaurant & Cloud Kitchen order assistant on WhatsApp. Recommend best-selling dishes, confirm spice preferences, and help customers place quick food orders.',
            knowledge: 'Hot & fresh delivery within 35 minutes. Hygiene certified kitchen. Instant UPI payment gets priority dispatch.'
        },
        fashion: {
            lang: 'English / Hinglish',
            prompt: 'You are a premium Fashion & Retail stylist assistant. Help shoppers with sizes, fabric quality, latest arrivals, and order links.',
            knowledge: 'Easy 5-day size exchange policy. Free shipping on prepaid UPI orders. COD available across serviceable pin codes.'
        },
        saas: {
            lang: 'Hinglish / English',
            prompt: 'You are the official WaMart SaaS Enterprise Onboarding Consultant. Explain how businesses get their own Online Storefront + WhatsApp AI Bot + Automated Catalog & UPI Checkout.',
            knowledge: 'WaMart includes Multi-Tenant Storefront, AI WhatsApp Auto-Responder, Bulk Broadcasts, and Instant Zero-Commission UPI QR payments.'
        }
    };

    async function loadTenantsForDropdown() {
        try {
            const res = await fetch('/api/admin/users', { headers: getAuthHeaders() });
            const raw = await res.json();
            const users = Array.isArray(raw) ? raw : (raw.users || []);
            window._allTenants = users;
            const sel = document.getElementById('admin-ai-target-user');
            if (sel) {
                sel.innerHTML = `<option value="admin" class="bg-slate-900 text-white">Master Admin (@admin)</option>` +
                    users.map(u => `<option value="${escapeHtml(u.username)}" class="bg-slate-900 text-white">${escapeHtml(u.business_name || u.account_name || u.username)} (@${escapeHtml(u.username)})</option>`).join('');
                sel.value = activeAIUser;
            }
        } catch (err) {
            console.error('Failed to load tenant list for AI selector:', err);
        }
    }

    async function loadAISettings(username = 'admin') {
        activeAIUser = username || 'admin';
        const badge = document.getElementById('ai-editing-target-badge');
        if (badge) badge.innerText = `@${activeAIUser}`;
        const sel = document.getElementById('admin-ai-target-user');
        if (sel && sel.value !== activeAIUser) sel.value = activeAIUser;

        try {
            const res = await fetch(`/api/ai/settings?username=${encodeURIComponent(activeAIUser)}`, { headers: getAuthHeaders() });
            const data = await res.json();
            if (document.getElementById('ai-provider')) {
                const prov = data.ai_provider || data.platform || data.provider || 'Groq';
                const provSelect = document.getElementById('ai-provider');
                if (prov.toLowerCase() === 'openai') provSelect.value = 'OpenAI';
                else if (prov.toLowerCase() === 'gemini') provSelect.value = 'Gemini';
                else provSelect.value = 'Groq';

                document.getElementById('ai-model').value = data.ai_model || data.model || data.model_name || 'llama-3.3-70b-versatile';
                document.getElementById('ai-key').value = data.api_key || '';
                document.getElementById('ai-temp').value = data.ai_temperature ?? data.temperature ?? 0.7;
                document.getElementById('ai-lang').value = data.response_language || data.language || data.reply_language || 'Hinglish';
                document.getElementById('ai-alert-phone').value = data.notification_phone || data.alert_phone || '';
                document.getElementById('ai-prompt').value = data.system_prompt || '';
                document.getElementById('ai-knowledge').value = data.store_policies || data.knowledge_base || '';
                const autoToggle = document.getElementById('ai-auto-reply-toggle');
                if (autoToggle) autoToggle.checked = data.auto_reply !== false;
            }
        } catch (e) {
            console.error("Failed to load AI settings", e);
        }
    }

    window.loadAdminTargetAISettings = function(username) {
        loadAISettings(username);
        showToast(`Loaded AI configuration for @${username}`, true);
    };

    window.applyAdminAIPreset = function(presetKey) {
        const preset = PRESETS[presetKey];
        if (!preset) return;
        document.getElementById('ai-lang').value = preset.lang;
        document.getElementById('ai-prompt').value = preset.prompt;
        document.getElementById('ai-knowledge').value = preset.knowledge;
        showToast('Applied industry persona template! Click Save to persist.', true);
    };

    window.saveAISettings = async function(e) {
        e.preventDefault();
        const btn = document.getElementById('ai-save-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
        }
        const providerVal = document.getElementById('ai-provider').value;
        const modelVal = document.getElementById('ai-model').value.trim() || 'llama-3.3-70b-versatile';
        const tempVal = parseFloat(document.getElementById('ai-temp').value) || 0.7;
        const langVal = document.getElementById('ai-lang').value.trim() || 'Hinglish';
        const phoneVal = document.getElementById('ai-alert-phone').value.trim();
        const promptVal = document.getElementById('ai-prompt').value.trim();
        const knowledgeVal = document.getElementById('ai-knowledge').value.trim();
        const autoReplyVal = document.getElementById('ai-auto-reply-toggle')?.checked ?? true;

        const payload = {
            username: activeAIUser,
            platform: providerVal,
            ai_provider: providerVal,
            provider: providerVal.toLowerCase(),
            model: modelVal,
            ai_model: modelVal,
            model_name: modelVal,
            api_key: document.getElementById('ai-key').value.trim(),
            temperature: tempVal,
            ai_temperature: tempVal,
            response_language: langVal,
            language: langVal,
            reply_language: langVal,
            notification_phone: phoneVal,
            alert_phone: phoneVal,
            system_prompt: promptVal,
            store_policies: knowledgeVal,
            knowledge_base: knowledgeVal,
            auto_reply: autoReplyVal
        };

        try {
            const res = await fetch('/api/ai/settings', {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && (data.status === 'success' || data.success !== false)) {
                showToast(`AI settings saved & synced for @${activeAIUser}!`, true);
            } else {
                showToast(data.message || data.error || "Failed to save AI settings", false);
            }
        } catch (err) {
            showToast("Server error saving settings", false);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save AI Configuration`;
            }
        }
    };

    window.clearAdminSimChat = function() {
        const stream = document.getElementById('ai-sim-chat-stream');
        if (stream) {
            stream.innerHTML = `
                <div class="flex items-start gap-2.5">
                    <div class="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300 text-xs shrink-0 mt-0.5">
                        <i class="fa-solid fa-robot"></i>
                    </div>
                    <div class="bg-slate-900 border border-slate-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-xs text-slate-300 max-w-[85%] leading-relaxed">
                        Chat cleared. Send a message below to test <span class="text-purple-400 font-mono font-bold">@${escapeHtml(activeAIUser)}</span>'s AI Responder.
                    </div>
                </div>
            `;
        }
    };

    window.sendQuickSimPrompt = function(text) {
        const input = document.getElementById('ai-test-input');
        if (input) {
            input.value = text;
            window.testAI();
        }
    };

    window.testAI = async function() {
        const inputEl = document.getElementById('ai-test-input');
        const msg = inputEl ? inputEl.value.trim() : '';
        if (!msg) return showToast("Enter a message to test", false);

        const stream = document.getElementById('ai-sim-chat-stream');
        const btn = document.getElementById('ai-test-btn');
        if (inputEl) inputEl.value = '';

        if (stream) {
            stream.insertAdjacentHTML('beforeend', `
                <div class="flex justify-end">
                    <div class="bg-emerald-600 text-white rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-xs max-w-[85%] shadow">
                        ${escapeHtml(msg)}
                    </div>
                </div>
            `);
            stream.scrollTop = stream.scrollHeight;
        }

        if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
            btn.disabled = true;
        }

        try {
            const payload = {
                username: activeAIUser,
                query: msg,
                message: msg,
                provider: document.getElementById('ai-provider')?.value || 'Groq',
                model: document.getElementById('ai-model')?.value || 'llama-3.3-70b-versatile',
                api_key: document.getElementById('ai-key')?.value || '',
                temperature: parseFloat(document.getElementById('ai-temp')?.value) || 0.7,
                system_prompt: document.getElementById('ai-prompt')?.value || '',
                response_language: document.getElementById('ai-lang')?.value || 'Hinglish'
            };

            const res = await fetch('/api/ai/test', {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            const replyText = data.reply || data.error || "No response received.";
            if (stream) {
                stream.insertAdjacentHTML('beforeend', `
                    <div class="flex items-start gap-2.5">
                        <div class="w-7 h-7 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-300 text-xs shrink-0 mt-0.5">
                            <i class="fa-solid fa-robot"></i>
                        </div>
                        <div class="bg-slate-900 border border-slate-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-xs text-emerald-300 max-w-[85%] leading-relaxed whitespace-pre-line">
                            ${escapeHtml(replyText)}
                        </div>
                    </div>
                `);
                stream.scrollTop = stream.scrollHeight;
            }
        } catch (err) {
            showToast("Failed to reach AI test endpoint", false);
        } finally {
            if (btn) {
                btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Send`;
                btn.disabled = false;
            }
        }
    };

    loadTenantsForDropdown();
    loadAISettings('admin');
}
