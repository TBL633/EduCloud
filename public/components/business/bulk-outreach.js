import { getActiveUsername, escapeHtml, checkBusinessAuth, checkNeonStatus } from "../shared/auth-guard.js";
import { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync } from "../shared/media-cropper.js";

// ==============================================================
// BUSINESS PORTAL: EXECUTIVE BULK WHATSAPP OUTREACH STUDIO
// (Pure Broadcast & Audience Outreach — Zero Channel Forwarding Clutter)
// ==============================================================

const BULK_MESSAGE_TEMPLATES = {
    festival: "Namaste {{name}}! Special festive offer at our store today — enjoy up to 25% OFF on fresh arrivals and priority home delivery. Reply *ORDER* to view our latest catalog!",
    new_stock: "Hello {{name}}, fresh stock has just arrived! Check out our updated digital catalog and place your order directly on WhatsApp for express delivery today.",
    followup: "Hi {{name}}, thank you for visiting us recently! Let us know if you need help reordering your favorite items—reply to this message anytime.",
    vip_deal: "Exclusive Customer Deal for {{name}}: Flat ₹100 OFF on orders above ₹499 today. Reply *DEAL* to claim your instant discount!"
};

function showBulkToast(message, type = 'success') {
    const existing = document.getElementById('bulk-studio-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'bulk-studio-toast';
    const isErr = type === 'error';
    toast.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl border shadow-2xl flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-200 ${
        isErr
            ? 'bg-rose-950/95 border-rose-500/40 text-rose-200'
            : 'bg-slate-900/95 border-emerald-500/40 text-emerald-200'
    }`;
    toast.innerHTML = `<i class="fa-solid ${isErr ? 'fa-circle-exclamation text-rose-400' : 'fa-circle-check text-emerald-400'}"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        if (toast && toast.parentNode) toast.remove();
    }, 3200);
}

function parseValidPhoneList(rawText = '') {
    return String(rawText || '')
        .split(/[\r\n,;]+/)
        .map(p => p.trim().replace(/\D/g, ''))
        .filter(p => p.length >= 8 && p.length <= 15 && !p.startsWith('120363'));
}

function updateBulkLivePreviewAndMetrics() {
    const rawPhones = document.getElementById('bulk-phones')?.value || '';
    const message = document.getElementById('bulk-message')?.value || '';
    const antiBan = document.getElementById('bulk-antiban-check')?.checked ?? true;
    const dataUrl = document.getElementById('bulk-ephemeral-data-url')?.value || '';

    const validList = parseValidPhoneList(rawPhones);
    const uniqueList = Array.from(new Set(validList));

    // Update KPI Cards & Counters
    const kpiRecipients = document.getElementById('bulk-kpi-recipients');
    const badgeRecipients = document.getElementById('bulk-audience-count-badge');
    const kpiEstTime = document.getElementById('bulk-kpi-est-time');
    const kpiCadence = document.getElementById('bulk-kpi-cadence');
    const charCounter = document.getElementById('bulk-char-counter');

    if (kpiRecipients) kpiRecipients.innerText = `${uniqueList.length}`;
    if (badgeRecipients) badgeRecipients.innerText = `${uniqueList.length} valid numbers`;

    const avgSecPerMsg = antiBan ? 3.5 : 1;
    const totalSec = Math.ceil(uniqueList.length * avgSecPerMsg);
    if (kpiEstTime) {
        if (uniqueList.length === 0) kpiEstTime.innerText = '0s';
        else if (totalSec < 60) kpiEstTime.innerText = `~${totalSec}s`;
        else kpiEstTime.innerText = `~${Math.ceil(totalSec / 60)} min`;
    }

    if (kpiCadence) {
        kpiCadence.innerText = antiBan ? 'Humanized Jitter' : 'Rapid Direct';
        kpiCadence.className = antiBan
            ? 'text-sm font-bold text-emerald-400 font-mono tabular-nums'
            : 'text-sm font-bold text-amber-400 font-mono tabular-nums';
    }

    if (charCounter) {
        charCounter.innerText = `${message.length} chars`;
    }

    // Update Live WhatsApp Phone Preview
    const previewTextEl = document.getElementById('bulk-live-preview-text');
    const previewImgWrap = document.getElementById('bulk-live-preview-img-wrap');
    const previewImgEl = document.getElementById('bulk-live-preview-img');
    const previewTimeEl = document.getElementById('bulk-live-preview-time');

    if (previewTimeEl) {
        previewTimeEl.innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    if (previewImgWrap && previewImgEl) {
        if (dataUrl) {
            previewImgEl.src = dataUrl;
            previewImgWrap.classList.remove('hidden');
        } else {
            previewImgEl.src = '';
            previewImgWrap.classList.add('hidden');
        }
    }

    if (previewTextEl) {
        if (!message.trim()) {
            previewTextEl.innerHTML = `<span class="text-slate-400 italic">Type your broadcast message on the left to preview how it appears on customer phones...</span>`;
        } else {
            let formatted = escapeHtml(message)
                .replace(/\{\{\s*name\s*\}\}/gi, '<span class="text-emerald-300 font-semibold">Rahul Sharma</span>')
                .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
                .replace(/_([^_]+)_/g, '<em>$1</em>')
                .replace(/~([^~]+)~/g, '<del>$1</del>')
                .replace(/\n/g, '<br>');
            previewTextEl.innerHTML = formatted;
        }
    }
}

function cleanAndDeduplicateBulkPhones() {
    const phonesEl = document.getElementById('bulk-phones');
    if (!phonesEl) return;

    const rawList = parseValidPhoneList(phonesEl.value);
    const normalized = rawList.map(p => {
        if (p.length === 10 && ['6', '7', '8', '9'].includes(p[0])) {
            return '91' + p;
        }
        return p;
    });
    const unique = Array.from(new Set(normalized));
    phonesEl.value = unique.join('\n');
    updateBulkLivePreviewAndMetrics();
    showBulkToast(`Cleaned & deduplicated: ${unique.length} valid recipient numbers ready.`);
}

async function importRecipientsFromLeads() {
    const username = getActiveUsername();
    const phonesEl = document.getElementById('bulk-phones');
    if (!phonesEl) return;

    try {
        const [leadsRes, chatsRes] = await Promise.all([
            fetch(`/api/leads?username=${encodeURIComponent(username)}`).catch(() => null),
            fetch(`/api/chats?username=${encodeURIComponent(username)}`).catch(() => null)
        ]);

        const collected = new Set(parseValidPhoneList(phonesEl.value));
        let addedCount = 0;

        if (leadsRes && leadsRes.ok) {
            const leadsData = await leadsRes.json();
            const leads = leadsData.leads || [];
            leads.forEach(l => {
                const ph = String(l.customer_phone || l.phone || '').replace(/\D/g, '');
                if (ph.length >= 10 && !ph.startsWith('120363')) {
                    const norm = ph.length === 10 ? '91' + ph : ph;
                    if (!collected.has(norm)) {
                        collected.add(norm);
                        addedCount++;
                    }
                }
            });
        }

        if (chatsRes && chatsRes.ok) {
            const chatsData = await chatsRes.json();
            const convos = chatsData.conversations || [];
            convos.forEach(c => {
                const ph = String(c.customer_phone || '').replace(/\D/g, '');
                if (ph.length >= 10 && !ph.startsWith('120363')) {
                    const norm = ph.length === 10 ? '91' + ph : ph;
                    if (!collected.has(norm)) {
                        collected.add(norm);
                        addedCount++;
                    }
                }
            });
        }

        phonesEl.value = Array.from(collected).join('\n');
        updateBulkLivePreviewAndMetrics();
        if (addedCount > 0) {
            showBulkToast(`Imported ${addedCount} customer numbers from your CRM & Inbox!`);
        } else {
            showBulkToast('All available CRM & Inbox contacts are already in the list.');
        }
    } catch (e) {
        showBulkToast('Could not import contacts right now.', 'error');
    }
}

function applyBulkTemplate(templateKey) {
    const msgEl = document.getElementById('bulk-message');
    if (!msgEl || !BULK_MESSAGE_TEMPLATES[templateKey]) return;
    msgEl.value = BULK_MESSAGE_TEMPLATES[templateKey];
    msgEl.focus();
    updateBulkLivePreviewAndMetrics();
}

function insertBulkTextToken(token) {
    const msgEl = document.getElementById('bulk-message');
    if (!msgEl) return;
    const start = msgEl.selectionStart || msgEl.value.length;
    const end = msgEl.selectionEnd || msgEl.value.length;
    const current = msgEl.value;
    msgEl.value = current.slice(0, start) + token + current.slice(end);
    msgEl.focus();
    updateBulkLivePreviewAndMetrics();
}

// 6. LAUNCH BULK CAMPAIGN (WITH EPHEMERAL IMAGE THAT AUTO-DELETES ON SEND & MULTI-SEPARATOR PHONE PARSING)
async function launchBulkCampaign() {
    const rawPhones = document.getElementById('bulk-phones')?.value.trim() || '';
    const message = document.getElementById('bulk-message')?.value.trim() || '';
    const antiBan = document.getElementById('bulk-antiban-check')?.checked ?? true;
    const dataUrl = document.getElementById('bulk-ephemeral-data-url')?.value || '';

    if (!rawPhones || (!message && !dataUrl)) {
        showBulkToast('Please enter target phone numbers and a message or image.', 'error');
        return;
    }

    const phoneList = Array.from(new Set(parseValidPhoneList(rawPhones)));

    if (phoneList.length === 0) {
        showBulkToast('No valid target phone numbers found. Please check phone numbers (e.g. 919876543202).', 'error');
        return;
    }

    const username = getActiveUsername();
    let tempUrl = '';
    let tempPath = '';

    const launchBtn = document.getElementById('btn-launch-bulk-campaign');
    const origHtml = launchBtn ? launchBtn.innerHTML : '';
    if (launchBtn) {
        launchBtn.disabled = true;
        launchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Dispatching to ${phoneList.length} Recipients...</span>`;
    }

    if (dataUrl) {
        try {
            const upRes = await fetch('/api/bulk/upload-temp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    data_url: dataUrl,
                    filename: document.getElementById('bulk-image-preview-name')?.innerText || 'broadcast.jpg'
                })
            });
            const upData = await upRes.json();
            if (upData.file_url) {
                tempUrl = upData.file_url;
                tempPath = upData.file_path || '';
            }
        } catch (e) {
            console.warn('Temporary image upload error:', e);
        }
    }

    try {
        const res = await fetch('/api/bulk/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phones: phoneList,
                message,
                image_url: tempUrl,
                temp_file_path: tempPath,
                anti_ban: antiBan,
                username
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            clearBulkImageAttachment();
            showBulkToast(`Broadcast launched for ${phoneList.length} recipients!`);
            fetchCampaignLogs();
        } else {
            showBulkToast(data.message || data.error || 'Campaign launch failed', 'error');
        }
    } catch (err) {
        showBulkToast('Server error launching campaign', 'error');
    } finally {
        if (launchBtn) {
            launchBtn.disabled = false;
            launchBtn.innerHTML = origHtml;
        }
    }
}

// 6B. HANDLE BULK IMAGE SELECTION (EPHEMERAL)
function handleBulkImageSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        const hiddenInput = document.getElementById('bulk-ephemeral-data-url');
        const previewCard = document.getElementById('bulk-image-preview-card');
        const thumb = document.getElementById('bulk-image-preview-thumb');
        const nameEl = document.getElementById('bulk-image-preview-name');
        const sizeEl = document.getElementById('bulk-image-preview-size');
        const labelText = document.getElementById('bulk-file-label-text');

        if (hiddenInput) hiddenInput.value = dataUrl;
        if (thumb) thumb.src = dataUrl;
        if (nameEl) nameEl.innerText = file.name;
        if (sizeEl) sizeEl.innerText = `${(file.size / 1024).toFixed(1)} KB · Auto-expires after send`;
        if (previewCard) previewCard.classList.remove('hidden');
        if (labelText) labelText.innerText = 'Change Broadcast Image';
        updateBulkLivePreviewAndMetrics();
    };
    reader.readAsDataURL(file);
}

// 6C. CLEAR BULK IMAGE ATTACHMENT
function clearBulkImageAttachment() {
    const fileInput = document.getElementById('bulk-image-file');
    const hiddenInput = document.getElementById('bulk-ephemeral-data-url');
    const previewCard = document.getElementById('bulk-image-preview-card');
    const thumb = document.getElementById('bulk-image-preview-thumb');
    const labelText = document.getElementById('bulk-file-label-text');

    if (fileInput) fileInput.value = '';
    if (hiddenInput) hiddenInput.value = '';
    if (thumb) thumb.src = '';
    if (previewCard) previewCard.classList.add('hidden');
    if (labelText) labelText.innerText = 'Attach Promotional Image';
    updateBulkLivePreviewAndMetrics();
}

// 7. FETCH CAMPAIGN LOGS
async function fetchCampaignLogs() {
    const tbody = document.getElementById('bulk-logs-body');
    const kpiDelivered = document.getElementById('bulk-kpi-delivered');
    if (!tbody) return;
    const username = getActiveUsername();
    try {
        const res = await fetch(`/api/bulk/status?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        const logs = data.campaign?.logs || data.recent_logs || [];

        if (kpiDelivered) {
            const deliveredCount = logs.filter(l => l.status === 'sent' || l.status === 'Delivered').length;
            kpiDelivered.innerText = `${deliveredCount} / ${logs.length}`;
        }

        if (logs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" class="p-8 text-center text-slate-500 text-xs">
                        No broadcast delivery logs recorded yet. Compose a campaign above and click <strong class="text-slate-300">Launch Bulk Campaign</strong> to begin.
                    </td>
                </tr>
            `;
            return;
        }
        tbody.innerHTML = logs.map((l, idx) => {
            const isOk = l.status === 'sent' || l.status === 'Delivered';
            return `
                <tr class="hover:bg-slate-900/50 transition">
                    <td class="p-3 text-slate-500 font-mono text-[11px] tabular-nums">#${idx + 1}</td>
                    <td class="p-3 font-mono font-bold text-white tabular-nums">+${escapeHtml(String(l.phone || '').replace(/^\+/, ''))}</td>
                    <td class="p-3">
                        <span class="text-xs font-semibold ${isOk ? 'text-emerald-400' : 'text-rose-400'}">
                            <i class="fa-solid ${isOk ? 'fa-check-double' : 'fa-circle-exclamation'} mr-1"></i>
                            ${escapeHtml(l.status === 'sent' ? 'Delivered' : (l.status || 'Pending'))}
                        </span>
                    </td>
                    <td class="p-3 text-right text-slate-400 font-mono text-[11px] tabular-nums">${escapeHtml(l.timestamp || l.time || 'Just now')}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.warn('Logs error:', err);
    }
}

export function getBulkOutreachHTML() {
    return `                <div id="view-bulk" class="biz-tab-content max-w-6xl mx-auto space-y-6">

                    <!-- TOP CAMPAIGN TELEMETRY & ANTI-BAN OVERVIEW STRIP -->
                    <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div class="space-y-1">
                            <div class="text-xs font-medium text-slate-400 flex items-center gap-2">
                                <span>Outbound Campaign Studio</span>
                                <span aria-hidden="true">·</span>
                                <span class="font-mono text-emerald-400">Humanized Anti-Ban Dispatch</span>
                            </div>
                            <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">Bulk WhatsApp Broadcast & Customer Outreach</h2>
                        </div>

                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-800">
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Target Audience</span>
                                <span id="bulk-kpi-recipients" class="text-sm font-bold text-white font-mono tabular-nums">0</span>
                            </div>
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Est. Dispatch Time</span>
                                <span id="bulk-kpi-est-time" class="text-sm font-bold text-cyan-400 font-mono tabular-nums">0s</span>
                            </div>
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Protection Mode</span>
                                <span id="bulk-kpi-cadence" class="text-sm font-bold text-emerald-400 font-mono tabular-nums">Humanized Jitter</span>
                            </div>
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Recent Delivered</span>
                                <span id="bulk-kpi-delivered" class="text-sm font-bold text-white font-mono tabular-nums">0 / 0</span>
                            </div>
                        </div>
                    </div>

                    <!-- 2-COLUMN BROADCAST COMPOSER & LIVE WHATSAPP PREVIEW -->
                    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">

                        <!-- LEFT COLUMN (7 COLS): CAMPAIGN COMPOSER -->
                        <div class="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-5 flex flex-col justify-between">
                            <div class="space-y-5">
                                <!-- Step 1: Audience & Phone Numbers -->
                                <div class="space-y-2">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <label for="bulk-phones" class="text-xs font-bold text-white">01. Recipient Phone Numbers</label>
                                            <span class="text-[11px] text-slate-400 ml-2" id="bulk-audience-count-badge">0 valid numbers</span>
                                        </div>
                                        <div class="flex items-center gap-1.5">
                                            <button type="button" onclick="importRecipientsFromLeads()" class="px-2.5 py-1 bg-slate-950 hover:bg-slate-800 text-emerald-400 border border-slate-800 rounded-lg text-[11px] font-semibold transition cursor-pointer flex items-center gap-1 whitespace-nowrap" title="Import numbers from Leads & Customer Chats">
                                                <i class="fa-solid fa-user-plus text-[10px]"></i>
                                                <span>Import CRM Contacts</span>
                                            </button>
                                            <button type="button" onclick="cleanAndDeduplicateBulkPhones()" class="px-2.5 py-1 bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-[11px] font-semibold transition cursor-pointer flex items-center gap-1 whitespace-nowrap" title="Normalize +91 prefix and remove duplicates">
                                                <i class="fa-solid fa-wand-magic-sparkles text-[10px] text-amber-400"></i>
                                                <span>Clean & Deduplicate</span>
                                            </button>
                                        </div>
                                    </div>
                                    <textarea id="bulk-phones" rows="4" oninput="updateBulkLivePreviewAndMetrics()" placeholder="Enter WhatsApp numbers with country code (one per line or comma-separated)&#10;919876543210&#10;917706070633" class="w-full p-3.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white outline-none focus:border-emerald-500 placeholder-slate-600 tabular-nums leading-relaxed"></textarea>
                                </div>

                                <!-- Step 2: Message Composer & Quick Templates -->
                                <div class="space-y-2.5">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <label for="bulk-message" class="text-xs font-bold text-white">02. Broadcast Message Payload</label>
                                        <span id="bulk-char-counter" class="text-[11px] font-mono text-slate-400 tabular-nums">0 chars</span>
                                    </div>

                                    <!-- Quick Preset Templates & Formatting Bar -->
                                    <div class="flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-950 border border-slate-800 rounded-xl">
                                        <div class="flex flex-wrap items-center gap-1">
                                            <span class="text-[10px] text-slate-500 px-1.5 font-semibold">Templates:</span>
                                            <button type="button" onclick="applyBulkTemplate('festival')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] font-medium transition cursor-pointer whitespace-nowrap">Festive Offer</button>
                                            <button type="button" onclick="applyBulkTemplate('new_stock')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] font-medium transition cursor-pointer whitespace-nowrap">Fresh Stock</button>
                                            <button type="button" onclick="applyBulkTemplate('vip_deal')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] font-medium transition cursor-pointer whitespace-nowrap">VIP Discount</button>
                                            <button type="button" onclick="applyBulkTemplate('followup')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] font-medium transition cursor-pointer whitespace-nowrap">Follow-Up</button>
                                        </div>
                                        <div class="flex items-center gap-1 border-l border-slate-800 pl-2">
                                            <button type="button" onclick="insertBulkTextToken('{{name}}')" class="px-2 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono font-bold transition cursor-pointer whitespace-nowrap" title="Insert Customer Name Variable">{{name}}</button>
                                            <button type="button" onclick="insertBulkTextToken('*bold*')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] font-bold transition cursor-pointer" title="Bold">B</button>
                                            <button type="button" onclick="insertBulkTextToken('_italic_')" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-[11px] italic transition cursor-pointer" title="Italic">I</button>
                                        </div>
                                    </div>

                                    <textarea id="bulk-message" rows="4" oninput="updateBulkLivePreviewAndMetrics()" placeholder="Write your promotional or informational WhatsApp message here... Supports {{name}} personalization and *bold* formatting." class="w-full p-3.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-emerald-500 placeholder-slate-600 leading-relaxed"></textarea>
                                </div>

                                <!-- Step 3: Ephemeral Broadcast Media Attachment -->
                                <div class="space-y-2.5">
                                    <div class="flex items-center justify-between">
                                        <label class="text-xs font-bold text-white">03. Ephemeral Media Attachment <span class="text-slate-400 font-normal">(Optional)</span></label>
                                        <span class="text-[11px] font-mono text-slate-400">Auto-purges from server after dispatch</span>
                                    </div>

                                    <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 p-3.5 rounded-xl bg-slate-950 border border-slate-800">
                                        <label class="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold border border-slate-700 hover:border-emerald-500/50 cursor-pointer flex items-center justify-center gap-2 transition shrink-0 whitespace-nowrap">
                                            <i class="fa-solid fa-cloud-arrow-up text-emerald-400"></i>
                                            <span id="bulk-file-label-text">Attach Promotional Image</span>
                                            <input type="file" id="bulk-image-file" class="hidden" accept="image/*" onchange="handleBulkImageSelect(event)">
                                        </label>
                                        <span class="text-[11px] text-slate-400 leading-relaxed">Attach a product flyer, banner, or festival creative. Media is streamed directly and deleted immediately upon campaign completion.</span>
                                    </div>

                                    <!-- Image Preview Card -->
                                    <div id="bulk-image-preview-card" class="hidden p-3 rounded-xl bg-slate-950 border border-emerald-500/30 flex items-center justify-between gap-3">
                                        <div class="flex items-center gap-3 overflow-hidden">
                                            <img id="bulk-image-preview-thumb" src="" alt="Broadcast Preview" class="w-12 h-12 object-cover rounded-lg border border-slate-700 shrink-0">
                                            <div class="truncate">
                                                <p id="bulk-image-preview-name" class="text-xs font-bold text-white truncate">image.jpg</p>
                                                <p id="bulk-image-preview-size" class="text-[10px] font-mono text-emerald-400">0 KB · Ephemeral</p>
                                            </div>
                                        </div>
                                        <button type="button" onclick="clearBulkImageAttachment()" class="px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold transition flex items-center gap-1 shrink-0 cursor-pointer whitespace-nowrap">
                                            <i class="fa-solid fa-xmark"></i>
                                            <span>Remove</span>
                                        </button>
                                    </div>
                                    <input type="hidden" id="bulk-ephemeral-data-url">
                                </div>
                            </div>

                            <!-- Step 4: Anti-Ban Toggle & Launch Button -->
                            <div class="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                <label for="bulk-antiban-check" class="flex items-center gap-3 cursor-pointer select-none">
                                    <input type="checkbox" id="bulk-antiban-check" checked onchange="updateBulkLivePreviewAndMetrics()" class="w-4 h-4 rounded accent-emerald-500 cursor-pointer">
                                    <div>
                                        <span class="text-xs font-bold text-white block">Humanized Anti-Ban Randomized Delay</span>
                                        <span class="text-[11px] text-slate-400 block">Inserts natural 2s–5s variable intervals between messages</span>
                                    </div>
                                </label>

                                <button type="button" id="btn-launch-bulk-campaign" onclick="launchBulkCampaign()" class="w-full sm:w-auto px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-md whitespace-nowrap">
                                    <i class="fa-solid fa-paper-plane"></i>
                                    <span>Launch Bulk Campaign</span>
                                </button>
                            </div>
                        </div>

                        <!-- RIGHT COLUMN (5 COLS): LIVE WHATSAPP PHONE PREVIEW & SAFETY GUARDRAILS -->
                        <div class="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-6">
                            <div class="space-y-4">
                                <div class="flex items-center justify-between pb-3 border-b border-slate-800">
                                    <div>
                                        <h3 class="text-base font-bold text-white">Live Customer Handset Preview</h3>
                                        <p class="text-xs text-slate-400 mt-0.5">Real-time simulation of recipient WhatsApp screen</p>
                                    </div>
                                    <span class="text-[11px] font-mono text-emerald-400">WhatsApp Preview</span>
                                </div>

                                <!-- Simulated WhatsApp Chat Viewport -->
                                <div class="rounded-2xl overflow-hidden border border-slate-800 bg-[#0b141a] shadow-inner">
                                    <!-- Phone Top Bar -->
                                    <div class="px-4 py-3 bg-[#202c33] border-b border-[#2a3942] flex items-center justify-between">
                                        <div class="flex items-center gap-2.5">
                                            <div class="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 text-xs">
                                                <i class="fa-solid fa-store"></i>
                                            </div>
                                            <div>
                                                <div class="text-xs font-bold text-white leading-tight">Your Verified Business</div>
                                                <div class="text-[10px] text-emerald-400">Official Business Account</div>
                                            </div>
                                        </div>
                                        <i class="fa-solid fa-ellipsis-vertical text-slate-400 text-xs"></i>
                                    </div>

                                    <!-- Message Canvas -->
                                    <div class="p-4 min-h-[210px] flex flex-col justify-end" style="background-image: radial-gradient(rgba(32, 44, 51, 0.45) 1px, transparent 1px); background-size: 18px 18px;">
                                        <div class="max-w-[90%] bg-[#005c4b] text-[#e9edef] p-3 rounded-xl rounded-tr-none border border-[#00755f]/60 shadow-md space-y-2">
                                            <div id="bulk-live-preview-img-wrap" class="hidden rounded-lg overflow-hidden border border-black/20">
                                                <img id="bulk-live-preview-img" src="" alt="Preview" class="w-full max-h-40 object-cover">
                                            </div>
                                            <div id="bulk-live-preview-text" class="text-xs leading-relaxed break-words">
                                                <span class="text-slate-300/70 italic">Type your broadcast message on the left to preview how it appears on customer phones...</span>
                                            </div>
                                            <div class="flex items-center justify-end gap-1 text-[10px] font-mono text-emerald-200/80 tabular-nums">
                                                <span id="bulk-live-preview-time">12:00</span>
                                                <i class="fa-solid fa-check-double text-[#53bdeb]"></i>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Anti-Ban Best Practices Box -->
                            <div class="p-4 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2.5">
                                <div class="text-xs font-bold text-white flex items-center justify-between">
                                    <span>Account Safety Guardrails</span>
                                    <span class="text-[11px] font-mono text-emerald-400">Active</span>
                                </div>
                                <ul class="text-[11px] text-slate-400 space-y-1.5 leading-relaxed">
                                    <li>1. Personalize messages with <span class="font-mono text-slate-200">{{name}}</span> so each payload hash is unique.</li>
                                    <li>2. Keep <strong class="text-slate-200">Humanized Anti-Ban Delay</strong> enabled when sending to more than 20 recipients.</li>
                                    <li>3. Broadcast images are automatically purged from cloud disk immediately after delivery.</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <!-- CAMPAIGN DELIVERY LOGS TABLE -->
                    <div class="bg-slate-900/90 p-6 rounded-2xl border border-slate-800 space-y-4">
                        <div class="flex items-center justify-between pb-3 border-b border-slate-800">
                            <div>
                                <h3 class="text-base font-bold text-white">Campaign Delivery Telemetry</h3>
                                <p class="text-xs text-slate-400 mt-0.5">Real-time per-recipient dispatch log from your active broadcast queue</p>
                            </div>
                            <button type="button" onclick="fetchCampaignLogs()" class="px-3.5 py-2 bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl text-xs font-semibold cursor-pointer transition flex items-center gap-1.5 whitespace-nowrap">
                                <i class="fa-solid fa-rotate text-emerald-400"></i>
                                <span>Refresh Logs</span>
                            </button>
                        </div>

                        <div class="overflow-x-auto w-full rounded-xl border border-slate-800 bg-slate-950/60">
                            <table class="w-full text-left text-xs min-w-[520px]">
                                <thead>
                                    <tr class="text-[11px] text-slate-400 border-b border-slate-800 font-mono bg-slate-900/60">
                                        <th class="p-3 w-16">#</th>
                                        <th class="p-3">Recipient Phone</th>
                                        <th class="p-3">Delivery State</th>
                                        <th class="p-3 text-right">Timestamp</th>
                                    </tr>
                                </thead>
                                <tbody id="bulk-logs-body" class="divide-y divide-slate-800/60 font-mono text-slate-300"></tbody>
                            </table>
                        </div>
                    </div>
                </div>`;
}

const exportedBulkFunctions = {
    launchBulkCampaign,
    handleBulkImageSelect,
    clearBulkImageAttachment,
    fetchCampaignLogs,
    updateBulkLivePreviewAndMetrics,
    cleanAndDeduplicateBulkPhones,
    importRecipientsFromLeads,
    applyBulkTemplate,
    insertBulkTextToken
};

export function initBulkOutreach(apiBaseUrl = "") {
    Object.assign(window, exportedBulkFunctions);
    updateBulkLivePreviewAndMetrics();
    fetchCampaignLogs();
}

export {
    launchBulkCampaign,
    handleBulkImageSelect,
    clearBulkImageAttachment,
    fetchCampaignLogs,
    updateBulkLivePreviewAndMetrics,
    cleanAndDeduplicateBulkPhones,
    importRecipientsFromLeads,
    applyBulkTemplate,
    insertBulkTextToken
};

Object.assign(window, exportedBulkFunctions);
