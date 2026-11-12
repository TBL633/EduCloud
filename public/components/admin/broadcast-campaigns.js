/**
 * Admin Bulk WhatsApp Broadcast Studio Component
 * Supports one-click lead import from PostgreSQL, campaign message presets, sender node selection,
 * Pause/Resume/Abort controls, and live progress + log telemetry.
 */

import { showToast } from './admin-sidebar.js';
import { getAuthHeaders, escapeHtml } from '../shared/auth-guard.js';

export function getBroadcastCampaignsHTML() {
    return `
        <div class="space-y-6 pb-8">
            <!-- Header Banner -->
            <div class="bg-gradient-to-r from-slate-900 via-amber-950/60 to-slate-900 p-6 rounded-3xl border border-amber-500/20 shadow-xl flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <div>
                    <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-black uppercase tracking-widest mb-2">
                        <i class="fa-solid fa-bullhorn"></i> Merchant Broadcast & Dispatcher
                    </div>
                    <h2 class="text-2xl md:text-3xl font-black text-white tracking-tight">Merchant & Business Broadcast Studio</h2>
                    <p class="text-slate-400 text-xs md:text-sm mt-1">Broadcast platform announcements, system updates, and merchant policy notices directly to verified business store owners.</p>
                </div>
                <div class="flex flex-wrap items-center gap-2.5">
                    <button type="button" onclick="window.importBusinessOwnersFromDB()" id="import-db-leads-btn" class="min-h-11 px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-black transition flex items-center gap-2 cursor-pointer">
                        <i class="fa-solid fa-building-columns"></i> Import Business Owners from DB
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <!-- Left: Campaign Composer (7 cols) -->
                <div class="lg:col-span-7 bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                    <div class="flex flex-wrap items-center justify-between gap-2 mb-5 pb-4 border-b border-slate-800">
                        <h3 class="text-lg font-black text-white flex items-center gap-2">
                            <i class="fa-solid fa-paper-plane text-amber-400"></i> Merchant Broadcast Composer
                        </h3>
                        <!-- Quick Templates -->
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span class="text-[10px] font-bold text-slate-500 uppercase mr-1">Templates:</span>
                            <button type="button" onclick="window.applyBroadcastTemplate('upgrade')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] font-bold border border-slate-800 transition cursor-pointer">🚀 Platform Upgrade</button>
                            <button type="button" onclick="window.applyBroadcastTemplate('maint')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] font-bold border border-slate-800 transition cursor-pointer">⚡ Maintenance Notice</button>
                            <button type="button" onclick="window.applyBroadcastTemplate('upi')" class="px-2.5 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-300 text-[11px] font-bold border border-slate-800 transition cursor-pointer">💳 Zero-Fee UPI Tip</button>
                        </div>
                    </div>

                    <form onsubmit="window.startBulkCampaign(event)" class="space-y-4">
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Sender WhatsApp Node</label>
                                <select id="bulk-sender-node" onchange="window.pollBulkStatusNow()" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-amber-500 p-3 rounded-xl text-white text-sm font-bold outline-none">
                                    <option value="admin">Master Admin (@admin)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Anti-Ban Human Delay Interval</label>
                                <select id="bulk-delay" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-amber-500 p-3 rounded-xl text-white text-sm outline-none">
                                    <option value="1200">Fast (1.2 - 2.5 sec between messages)</option>
                                    <option value="3000" selected>Safe Recommended (3 - 5 sec)</option>
                                    <option value="6000">Ultra Safe Anti-Ban (6 - 10 sec)</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <div class="flex items-center justify-between mb-1.5">
                                <label class="block text-xs text-slate-400 font-bold uppercase">Target Phone Numbers (With Country Code)</label>
                                <span id="bulk-recipient-count" class="text-[11px] font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 rounded-full">0 Valid Recipients</span>
                            </div>
                            <textarea id="bulk-numbers" oninput="window.updateBulkRecipientCount()" rows="4" required placeholder="919876543210, 919876543211 (comma or newline separated)" class="w-full bg-slate-950 border border-slate-800 focus:border-amber-500 p-3.5 rounded-xl text-white font-mono text-sm outline-none"></textarea>
                        </div>

                        <div>
                            <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Broadcast Message / Caption</label>
                            <textarea id="bulk-message" rows="4" required placeholder="Write your promotional offer, store link, or announcement here..." class="w-full bg-slate-950 border border-slate-800 focus:border-amber-500 p-3.5 rounded-xl text-white text-sm outline-none leading-relaxed"></textarea>
                        </div>

                        <div>
                            <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Optional Image Banner URL</label>
                            <input type="url" id="bulk-image-url" placeholder="https://example.com/promo-banner.jpg (optional)" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-amber-500 p-3 rounded-xl text-white text-sm font-mono outline-none">
                        </div>

                        <button type="submit" id="bulk-btn" class="w-full min-h-11 bg-amber-600 hover:bg-amber-500 text-white font-black py-3.5 rounded-xl shadow-lg shadow-amber-600/20 transition flex items-center justify-center gap-2 text-sm cursor-pointer">
                            <i class="fa-solid fa-paper-plane"></i> Launch WhatsApp Broadcast Campaign
                        </button>
                    </form>
                </div>

                <!-- Right: Live Campaign Telemetry & Queue Controls (5 cols) -->
                <div class="lg:col-span-5 space-y-6">
                    <!-- Live Campaign Status Card -->
                    <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                        <div class="flex items-center justify-between mb-4">
                            <h3 class="text-base font-black text-white flex items-center gap-2">
                                <i class="fa-solid fa-satellite-dish text-emerald-400"></i> Live Dispatcher Status
                            </h3>
                            <span id="bulk-live-status-pill" class="px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-slate-800 text-slate-400">Idle</span>
                        </div>

                        <div class="space-y-4">
                            <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800">
                                <div class="flex justify-between text-xs font-bold text-slate-400 mb-2">
                                    <span>Delivery Progress</span>
                                    <span id="bulk-progress-text" class="text-white font-mono">0 / 0 (0%)</span>
                                </div>
                                <div class="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                                    <div id="bulk-progress-bar" class="h-full bg-gradient-to-r from-amber-500 to-emerald-500 rounded-full transition-all duration-500 w-0"></div>
                                </div>
                            </div>

                            <div class="grid grid-cols-3 gap-2.5">
                                <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 text-center">
                                    <div class="text-[10px] font-bold text-slate-500 uppercase">Sent</div>
                                    <div id="bulk-sent-count" class="text-lg font-black text-emerald-400 mt-0.5 font-mono">0</div>
                                </div>
                                <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 text-center">
                                    <div class="text-[10px] font-bold text-slate-500 uppercase">Remaining</div>
                                    <div id="bulk-remaining-count" class="text-lg font-black text-amber-400 mt-0.5 font-mono">0</div>
                                </div>
                                <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 text-center">
                                    <div class="text-[10px] font-bold text-slate-500 uppercase">Failed</div>
                                    <div id="bulk-failed-count" class="text-lg font-black text-rose-400 mt-0.5 font-mono">0</div>
                                </div>
                            </div>

                            <!-- Queue Control Buttons (Pause / Resume / Abort) -->
                            <div class="grid grid-cols-3 gap-2 pt-1">
                                <button type="button" onclick="window.controlBulkCampaign('pause')" class="min-h-10 px-3 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer">
                                    <i class="fa-solid fa-pause"></i> Pause
                                </button>
                                <button type="button" onclick="window.controlBulkCampaign('resume')" class="min-h-10 px-3 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer">
                                    <i class="fa-solid fa-play"></i> Resume
                                </button>
                                <button type="button" onclick="window.controlBulkCampaign('revoke')" class="min-h-10 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer">
                                    <i class="fa-solid fa-stop"></i> Abort
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Live Dispatch Activity Log -->
                    <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                        <h4 class="text-sm font-black text-white flex items-center gap-2 mb-3">
                            <i class="fa-solid fa-list-check text-amber-400"></i> Live Dispatch Activity Feed
                        </h4>
                        <div id="bulk-live-logs-box" class="bg-slate-950 border border-slate-800 rounded-2xl p-3 h-44 overflow-y-auto space-y-1.5 font-mono text-[11px] text-slate-400">
                            <div class="text-slate-500 text-center py-12">No active broadcast logs yet.</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function initBroadcastCampaigns() {
    let statusInterval = null;

    const TEMPLATES = {
        upgrade: `🚀 *WaMart Merchant Platform Upgrade Announcement!*\n\nNamaste Business Partner! We have released new features to your digital storefront and WhatsApp AI bot.\n\n✨ Updates include:\n- Instant Paytm Zero-Fee UPI QR checkout\n- Enhanced order fulfillment lifecycle tracking\n- Instant WhatsApp customer dispatch alerts\n\nOpen your Business Portal now to check the latest features!`,
        maint: `⚡ *Scheduled System Maintenance Notice*\n\nDear Store Owner, our cloud servers will undergo brief scheduled maintenance tonight from 2:00 AM to 2:30 AM IST.\n\nYour store catalogs and WhatsApp bot will resume normal operations immediately afterwards. Thank you for partnering with WaMart!`,
        upi: `💳 *Tip: Maximize Sales with Zero-Fee Paytm UPI QR!*\n\nHello Merchant! Did you know you can accept instant UPI payments directly to your bank account with 0% gateway commission?\n\nEnsure your Paytm Merchant VPA is configured in your Business Portal settings to activate instant QR payments today.`
    };

    async function populateSenderNodes() {
        try {
            const res = await fetch('/api/admin/users', { headers: getAuthHeaders() });
            const raw = await res.json();
            const users = Array.isArray(raw) ? raw : (raw.users || []);
            const sel = document.getElementById('bulk-sender-node');
            if (sel) {
                sel.innerHTML = `<option value="admin">Master Admin (@admin)</option>` +
                    users.map(u => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.business_name || u.account_name || u.username)} (@${escapeHtml(u.username)}) ${u.wa_connected ? '🟢' : '⚪'}</option>`).join('');
            }
        } catch (err) {
            console.error('Error loading sender nodes:', err);
        }
    }

    function parseValidPhoneNumbers() {
        const el = document.getElementById('bulk-numbers');
        if (!el) return [];
        const nums = el.value
            .split(/[\n,]+/)
            .map(n => n.replace(/\D/g, '').trim())
            .filter(n => n.length >= 10)
            .map(n => n.length === 10 ? `91${n}` : n);
        return [...new Set(nums)];
    }

    window.updateBulkRecipientCount = function() {
        const badge = document.getElementById('bulk-recipient-count');
        if (!badge) return;
        const uniqueNums = parseValidPhoneNumbers();
        badge.innerText = `${uniqueNums.length} Valid Recipient${uniqueNums.length === 1 ? '' : 's'}`;
    };

    window.applyBroadcastTemplate = function(key) {
        const msgEl = document.getElementById('bulk-message');
        if (msgEl && TEMPLATES[key]) {
            msgEl.value = TEMPLATES[key];
            showToast('Loaded merchant broadcast template!', true);
        }
    };

    window.importBusinessOwnersFromDB = async function() {
        const btn = document.getElementById('import-db-leads-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Importing...`;
        }
        try {
            const res = await fetch('/api/admin/users', { headers: getAuthHeaders() });
            const raw = await res.json();
            const users = Array.isArray(raw) ? raw : (raw.users || []);
            const phones = new Set();

            users.forEach(u => {
                const phoneStr = String(u.phone || u.wa_jid || '').replace(/\D/g, '');
                if (phoneStr.length >= 10) {
                    phones.add(phoneStr.length === 10 ? `91${phoneStr}` : phoneStr);
                }
            });

            const numBox = document.getElementById('bulk-numbers');
            if (phones.size === 0) {
                showToast('No registered business store owner phone numbers found.', false);
            } else if (numBox) {
                const existing = parseValidPhoneNumbers();
                const merged = [...new Set([...existing, ...phones])];
                numBox.value = merged.join(', ');
                window.updateBulkRecipientCount();
                showToast(`Imported ${phones.size} verified business store owners from DB!`, true);
            }
        } catch (err) {
            showToast('Failed to import business owners', false);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-building-columns"></i> Import Business Owners from DB`;
            }
        }
    };
    window.importBroadcastLeadsFromDB = window.importBusinessOwnersFromDB;

    async function pollBulkStatus() {
        const pill = document.getElementById('bulk-live-status-pill');
        if (!pill) {
            if (statusInterval) clearInterval(statusInterval);
            return;
        }
        const senderNode = document.getElementById('bulk-sender-node')?.value || 'admin';
        try {
            const res = await fetch(`/api/bulk/status?username=${encodeURIComponent(senderNode)}`, { headers: getAuthHeaders() });
            const data = await res.json();
            const c = data.campaign || data;
            const total = Number(c?.totalCount ?? c?.total ?? 0);
            const sent = Number(c?.sentCount ?? c?.sent ?? 0);
            const failed = Number(c?.failedCount ?? c?.failed ?? 0);
            const remaining = Number(c?.remainingCount ?? Math.max(0, total - sent - failed));
            const statusStr = String(c?.status || 'idle').toLowerCase();

            const sentEl = document.getElementById('bulk-sent-count');
            const remEl = document.getElementById('bulk-remaining-count');
            const failedEl = document.getElementById('bulk-failed-count');
            const progText = document.getElementById('bulk-progress-text');
            const progBar = document.getElementById('bulk-progress-bar');
            const logsBox = document.getElementById('bulk-live-logs-box');

            if (sentEl) sentEl.innerText = String(sent);
            if (remEl) remEl.innerText = String(remaining);
            if (failedEl) failedEl.innerText = String(failed);

            const pct = total > 0 ? Math.min(100, Math.round(((sent + failed) / total) * 100)) : 0;
            if (progText) progText.innerText = `${sent + failed} / ${total} (${pct}%)`;
            if (progBar) progBar.style.width = `${pct}%`;

            if (statusStr === 'running') {
                pill.className = 'px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse';
                pill.innerText = 'Dispatching...';
            } else if (statusStr === 'paused') {
                pill.className = 'px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-blue-500/20 text-blue-300 border border-blue-500/30';
                pill.innerText = 'Paused';
            } else if (statusStr === 'completed' || (total > 0 && (sent + failed) >= total)) {
                pill.className = 'px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
                pill.innerText = 'Completed';
            } else if (statusStr === 'revoked') {
                pill.className = 'px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-rose-500/20 text-rose-400 border border-rose-500/30';
                pill.innerText = 'Aborted';
            } else {
                pill.className = 'px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-slate-800 text-slate-400';
                pill.innerText = 'Ready';
            }

            if (logsBox && Array.isArray(c?.logs) && c.logs.length > 0) {
                logsBox.innerHTML = c.logs.map(l => {
                    const color = l.status === 'sent' ? 'text-emerald-400' : (l.status === 'revoked' ? 'text-amber-400' : 'text-rose-400');
                    return `<div class="flex items-center justify-between border-b border-slate-900 pb-1">
                        <span class="${color} font-bold">[${escapeHtml(String(l.status || '').toUpperCase())}] +${escapeHtml(l.phone || '')}</span>
                        <span class="text-slate-500 text-[10px]">${escapeHtml(l.timestamp || '')}</span>
                    </div>`;
                }).join('');
            }
        } catch (err) {
            // ignore transient polling error
        }
    }

    window.pollBulkStatusNow = pollBulkStatus;

    window.controlBulkCampaign = async function(action) {
        const senderNode = document.getElementById('bulk-sender-node')?.value || 'admin';
        try {
            const res = await fetch(`/api/bulk/${action}`, {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ username: senderNode })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showToast(data.message || `Campaign ${action}d!`, true);
                pollBulkStatus();
            } else {
                showToast(data.message || data.error || `Cannot ${action} campaign`, false);
            }
        } catch (err) {
            showToast(`Error executing ${action}`, false);
        }
    };

    window.startBulkCampaign = async function(e) {
        e.preventDefault();
        const phones = parseValidPhoneNumbers();
        if (phones.length === 0) {
            return showToast('Please enter at least 1 valid phone number with country code', false);
        }
        const message = document.getElementById('bulk-message')?.value.trim() || '';
        const image_url = document.getElementById('bulk-image-url')?.value.trim() || '';
        if (!message && !image_url) {
            return showToast('Please enter a broadcast message or image URL', false);
        }

        const btn = document.getElementById('bulk-btn');
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Queuing Campaign...`;
        btn.disabled = true;

        const senderNode = document.getElementById('bulk-sender-node')?.value || 'admin';
        const delayMs = parseInt(document.getElementById('bulk-delay')?.value) || 3000;

        try {
            const res = await fetch('/api/bulk/start', {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    username: senderNode,
                    phones,
                    numbers: phones.join(','),
                    message,
                    image_url,
                    use_anti_ban: true,
                    delay_ms: delayMs
                })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showToast(data.message || `Broadcast campaign started for ${phones.length} recipients!`, true);
                pollBulkStatus();
            } else {
                showToast(data.message || data.error || "Failed to start campaign", false);
            }
        } catch (err) {
            showToast("Server error starting campaign", false);
        } finally {
            btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Launch WhatsApp Broadcast Campaign`;
            btn.disabled = false;
        }
    };

    populateSenderNodes();
    pollBulkStatus();
    statusInterval = setInterval(pollBulkStatus, 2500);
}
