/**
 * Admin WhatsApp Multi-Node Gateway & Device Pairing Component
 * Supports pairing Master Admin or any Tenant WhatsApp node, with multi-tenant node status grid and zero blocking dialogs.
 */

import { showToast } from './admin-sidebar.js';
import { getAuthHeaders } from '../shared/auth-guard.js';

export function getWhatsAppPairHTML() {
    return `
        <div class="space-y-6 pb-8">
            <!-- Header Banner -->
            <div class="bg-gradient-to-r from-slate-900 via-emerald-950/80 to-slate-900 p-6 rounded-3xl border border-emerald-500/20 shadow-xl flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <div>
                    <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-black uppercase tracking-widest mb-2">
                        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> WhatsApp Web Multi-Node Engine
                    </div>
                    <h2 class="text-2xl md:text-3xl font-black text-white tracking-tight">WhatsApp Gateway & Node Pairing</h2>
                    <p class="text-slate-400 text-xs md:text-sm mt-1">Manage the Master Admin WhatsApp session or pair/inspect any tenant store's WhatsApp node in real time.</p>
                </div>

                <!-- Target Node Selector -->
                <div class="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
                    <div class="flex items-center gap-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3 py-1.5 flex-1 sm:flex-initial">
                        <i class="fa-solid fa-server text-emerald-400 text-xs"></i>
                        <span class="text-[11px] font-bold text-slate-400 uppercase">Target Node:</span>
                        <select id="wa-target-node-select" onchange="window.switchAdminWaTargetNode(this.value)" class="bg-transparent text-white text-xs font-bold outline-none pr-2 min-h-9 cursor-pointer">
                            <option value="admin" class="bg-slate-900 text-white">Master Admin (@admin)</option>
                        </select>
                    </div>
                    <button onclick="window.refreshAdminWaGateway()" class="min-h-11 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition flex items-center gap-2 border border-slate-700">
                        <i class="fa-solid fa-rotate"></i> Refresh Status
                    </button>
                </div>
            </div>

            <!-- Active Node Status & Pairing Workspace -->
            <div class="bg-slate-900/90 p-6 md:p-8 rounded-3xl border border-slate-800 shadow-xl">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 pb-5 border-b border-slate-800/80">
                    <div>
                        <div class="flex items-center gap-2.5">
                            <h3 class="text-xl font-black text-white">Node Session: <span id="wa-active-node-label" class="text-emerald-400 font-mono">@admin</span></h3>
                            <span id="wa-status-badge" class="px-3 py-1 rounded-full text-[11px] font-black bg-amber-500/10 text-amber-400 border border-amber-500/20">Checking...</span>
                        </div>
                        <p class="text-slate-400 text-xs mt-1">Scan QR code or generate an 8-digit phone link code to connect WhatsApp.</p>
                    </div>
                    <button onclick="window.promptDisconnectWaSession()" id="wa-logout-btn" class="hidden min-h-11 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 px-4 py-2.5 rounded-xl text-xs font-bold transition items-center gap-2">
                        <i class="fa-solid fa-power-off"></i> Disconnect Node
                    </button>
                </div>

                <!-- Non-blocking Disconnect Confirmation Bar -->
                <div id="wa-disconnect-confirm-bar" class="hidden mb-6 p-4 rounded-2xl bg-rose-950/50 border border-rose-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                        </div>
                        <div>
                            <h4 class="text-xs font-black text-white uppercase tracking-wider">Confirm WhatsApp Node Disconnect</h4>
                            <p class="text-xs text-rose-200/80">Disconnecting will pause automated AI replies and order notifications for <span id="wa-disconnect-node-name" class="font-mono font-bold text-white">@admin</span>.</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
                        <button onclick="document.getElementById('wa-disconnect-confirm-bar').classList.add('hidden')" class="min-h-11 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold">Cancel</button>
                        <button onclick="window.confirmDisconnectWaSession()" id="wa-confirm-disconnect-btn" class="min-h-11 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-black shadow-lg">Yes, Disconnect</button>
                    </div>
                </div>

                <!-- Pairing Container (Shown when Disconnected) -->
                <div id="wa-pairing-container" class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                    <!-- Option 1: QR Scanner -->
                    <div class="bg-slate-950/90 p-6 rounded-2xl border border-slate-800 flex flex-col items-center justify-center text-center">
                        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[10px] font-black uppercase tracking-widest mb-3">
                            <i class="fa-solid fa-qrcode"></i> Method 1: Instant QR Scan
                        </div>
                        <h4 class="font-bold text-white text-base mb-1">Scan WhatsApp QR Code</h4>
                        <p class="text-xs text-slate-400 mb-5 max-w-xs">Open WhatsApp on your phone → Linked Devices → Link a Device</p>
                        <div id="qr-box" class="bg-white p-4 rounded-2xl shadow-xl border-4 border-emerald-500/30 flex items-center justify-center min-h-[220px] min-w-[220px]">
                            <span class="text-slate-400 text-xs font-semibold animate-pulse">Loading QR Engine...</span>
                        </div>
                    </div>

                    <!-- Option 2: Phone Number Pairing Code -->
                    <div class="bg-slate-950/90 p-6 rounded-2xl border border-slate-800 flex flex-col justify-center">
                        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-black uppercase tracking-widest mb-3 w-fit">
                            <i class="fa-solid fa-mobile-screen-button"></i> Method 2: 8-Digit Phone Code
                        </div>
                        <h4 class="font-bold text-white text-base mb-1">Link with Phone Number</h4>
                        <p class="text-xs text-slate-400 mb-5">Enter the WhatsApp number with country code (e.g., <code class="text-emerald-400 font-mono">919876543210</code>) to get an 8-character pairing code.</p>
                        
                        <div class="space-y-3">
                            <div>
                                <label class="block text-[11px] font-bold text-slate-400 uppercase mb-1.5">WhatsApp Phone Number (With Country Code)</label>
                                <input type="text" id="pair-phone" placeholder="e.g. 919876543210" class="w-full min-h-11 bg-slate-900 border border-slate-700 focus:border-emerald-500 p-3.5 rounded-xl text-white text-sm font-mono outline-none transition">
                            </div>
                            <button onclick="window.getPairCode()" id="pair-btn" class="w-full min-h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-black py-3 rounded-xl shadow-lg shadow-emerald-600/20 transition flex items-center justify-center gap-2 text-sm">
                                <i class="fa-solid fa-key"></i> Generate 8-Digit Pairing Code
                            </button>
                        </div>

                        <div id="pair-code-display" class="mt-5 hidden p-4 bg-slate-900 border border-emerald-500/30 rounded-2xl text-center">
                            <p class="text-[11px] text-slate-400 uppercase font-bold mb-1">Enter this code in WhatsApp Linked Devices:</p>
                            <div id="pair-code-text" class="text-2xl md:text-3xl font-mono font-black tracking-[0.25em] text-emerald-400 bg-slate-950 p-3.5 rounded-xl border border-emerald-500/30 select-all"></div>
                        </div>
                    </div>
                </div>

                <!-- Connected Container -->
                <div id="wa-connected-container" class="hidden text-center py-10">
                    <div class="w-20 h-20 bg-emerald-500/20 text-emerald-400 rounded-3xl flex items-center justify-center text-4xl mx-auto mb-4 border border-emerald-500/30 shadow-lg shadow-emerald-500/10">
                        <i class="fa-brands fa-whatsapp"></i>
                    </div>
                    <h4 class="text-2xl font-black text-white">WhatsApp Session Active & Synced</h4>
                    <p id="wa-jid-display" class="text-emerald-400 font-mono text-sm mt-2 bg-slate-950 inline-block px-4 py-1.5 rounded-xl border border-slate-800"></p>
                    <p class="text-slate-400 text-xs mt-3 max-w-md mx-auto">This node is actively listening for incoming WhatsApp orders, AI lead queries, and automated channel forwarding triggers.</p>
                </div>
            </div>

            <!-- Multi-Tenant WhatsApp Node Cluster Grid -->
            <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-5">
                    <div>
                        <h3 class="text-base font-black text-white flex items-center gap-2">
                            <i class="fa-solid fa-network-wired text-emerald-400"></i> Multi-Tenant WhatsApp Node Cluster
                        </h3>
                        <p class="text-xs text-slate-400">Live connection health across all registered tenant stores. Click any store to inspect or pair its WhatsApp node.</p>
                    </div>
                    <span id="wa-cluster-summary-pill" class="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-bold text-slate-300">Loading nodes...</span>
                </div>

                <div id="wa-tenant-nodes-grid" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <div class="col-span-full py-8 text-center text-slate-500 text-xs animate-pulse">Scanning tenant WhatsApp sessions...</div>
                </div>
            </div>
        </div>
    `;
}

export function initWhatsAppPair() {
    let waPollInterval = null;
    let activeTargetNode = 'admin';

    async function loadTenantNodesList() {
        try {
            const res = await fetch('/api/admin/users', { headers: getAuthHeaders() });
            const data = await res.json();
            const users = Array.isArray(data) ? data : [];
            window._allTenants = users;

            // Populate dropdown
            const select = document.getElementById('wa-target-node-select');
            if (select) {
                const currentVal = select.value || activeTargetNode;
                select.innerHTML = `<option value="admin" class="bg-slate-900 text-white">Master Admin (@admin)</option>` +
                    users.map(u => `<option value="${u.username}" class="bg-slate-900 text-white">${u.business_name || u.username} (@${u.username})</option>`).join('');
                select.value = currentVal;
            }

            // Render multi-tenant node cluster cards
            const grid = document.getElementById('wa-tenant-nodes-grid');
            const summaryPill = document.getElementById('wa-cluster-summary-pill');
            const onlineCount = users.filter(u => u.wa_connected).length;
            if (summaryPill) {
                summaryPill.innerHTML = `<span class="text-emerald-400 font-black">${onlineCount} Online</span> / ${users.length} Tenant Nodes`;
            }

            if (grid) {
                if (users.length === 0) {
                    grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-500 text-xs">No tenant nodes provisioned yet.</div>`;
                } else {
                    grid.innerHTML = users.map(u => {
                        const isSelected = activeTargetNode === u.username;
                        return `
                            <div class="p-4 rounded-2xl bg-slate-950/90 border ${isSelected ? 'border-emerald-500/60 ring-1 ring-emerald-500/30' : 'border-slate-800/90'} flex flex-col justify-between gap-3 transition hover:border-slate-700">
                                <div class="flex items-start justify-between gap-2">
                                    <div>
                                        <div class="font-bold text-white text-sm flex items-center gap-1.5">
                                            ${u.business_name || u.username}
                                            ${isSelected ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-black uppercase">Inspecting</span>' : ''}
                                        </div>
                                        <div class="text-[11px] text-slate-400 font-mono">@${u.username}</div>
                                    </div>
                                    ${u.wa_connected
                                        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-black"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>ONLINE</span>`
                                        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 text-[10px] font-bold"><span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span>OFFLINE</span>`
                                    }
                                </div>
                                <div class="flex items-center justify-between pt-2 border-t border-slate-900 text-[11px] text-slate-400">
                                    <span class="font-mono truncate max-w-[170px]">${u.wa_jid || 'No JID linked'}</span>
                                    <button onclick="window.switchAdminWaTargetNode('${u.username}')" class="min-h-9 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-emerald-600 hover:text-white text-emerald-400 border border-slate-800 font-bold text-xs transition">
                                        ${u.wa_connected ? 'Manage Node' : 'Pair Node'}
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
        } catch (err) {
            console.error('Failed to load tenant nodes:', err);
        }
    }

    async function checkWaStatus() {
        const badge = document.getElementById('wa-status-badge');
        const labelEl = document.getElementById('wa-active-node-label');
        if (!badge) {
            if (waPollInterval) clearInterval(waPollInterval);
            return;
        }
        if (labelEl) labelEl.innerText = `@${activeTargetNode}`;

        try {
            const res = await fetch(`/api/whatsapp/status?username=${encodeURIComponent(activeTargetNode)}`, { headers: getAuthHeaders() });
            const data = await res.json();

            const pairingContainer = document.getElementById('wa-pairing-container');
            const connectedContainer = document.getElementById('wa-connected-container');
            const logoutBtn = document.getElementById('wa-logout-btn');
            const qrBox = document.getElementById('qr-box');

            if (data.connected) {
                badge.className = "px-3 py-1 rounded-full text-[11px] font-black bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
                badge.innerHTML = `<i class="fa-solid fa-check-circle mr-1"></i> Connected`;
                if (pairingContainer) pairingContainer.classList.add('hidden');
                if (connectedContainer) connectedContainer.classList.remove('hidden');
                if (logoutBtn) {
                    logoutBtn.classList.remove('hidden');
                    logoutBtn.classList.add('inline-flex');
                }
                const jidEl = document.getElementById('wa-jid-display');
                if (jidEl) jidEl.innerText = `Linked JID: ${data.jid || 'Active Session'}`;
            } else {
                badge.className = "px-3 py-1 rounded-full text-[11px] font-black bg-amber-500/10 text-amber-400 border border-amber-500/20";
                badge.innerHTML = `<i class="fa-solid fa-plug-circle-xmark mr-1"></i> Disconnected`;
                if (pairingContainer) pairingContainer.classList.remove('hidden');
                if (connectedContainer) connectedContainer.classList.add('hidden');
                if (logoutBtn) {
                    logoutBtn.classList.add('hidden');
                    logoutBtn.classList.remove('inline-flex');
                }

                if (qrBox) {
                    if (data.qr) {
                        qrBox.innerHTML = "";
                        new QRCode(qrBox, { text: data.qr, width: 200, height: 200 });
                    } else {
                        qrBox.innerHTML = `<div class="text-slate-500 text-xs p-4 text-center"><i class="fa-solid fa-spinner fa-spin text-emerald-500 text-lg mb-2 block"></i>Generating fresh QR code for <span class="font-mono font-bold text-slate-700">@${activeTargetNode}</span>...</div>`;
                    }
                }
            }
        } catch (e) {
            console.error("WA Status error", e);
        }
    }

    window.switchAdminWaTargetNode = function(username) {
        activeTargetNode = username || 'admin';
        const select = document.getElementById('wa-target-node-select');
        if (select) select.value = activeTargetNode;
        const codeDisplay = document.getElementById('pair-code-display');
        if (codeDisplay) codeDisplay.classList.add('hidden');
        const confirmBar = document.getElementById('wa-disconnect-confirm-bar');
        if (confirmBar) confirmBar.classList.add('hidden');
        checkWaStatus();
        loadTenantNodesList();
        showToast(`Switched WhatsApp gateway inspector to @${activeTargetNode}`, 'success');
    };

    window.refreshAdminWaGateway = function() {
        checkWaStatus();
        loadTenantNodesList();
        showToast('Refreshed WhatsApp gateway status', 'success');
    };

    window.getPairCode = async function() {
        const phoneInput = document.getElementById('pair-phone');
        const phone = phoneInput ? phoneInput.value.trim() : '';
        if (!phone) return showToast("Enter phone number with country code (e.g. 919876543210)", "error");
        
        const btn = document.getElementById('pair-btn');
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Requesting Code...`;
        btn.disabled = true;

        try {
            const res = await fetch(`/api/whatsapp/pair-phone?phone=${encodeURIComponent(phone)}&username=${encodeURIComponent(activeTargetNode)}`, { headers: getAuthHeaders() });
            const data = await res.json();
            if (data.code) {
                document.getElementById('pair-code-display').classList.remove('hidden');
                document.getElementById('pair-code-text').innerText = data.code;
                showToast(`Pairing code generated for @${activeTargetNode}!`, "success");
            } else {
                showToast(data.error || "Failed to get code", "error");
            }
        } catch (e) {
            showToast("Server error generating code", "error");
        } finally {
            btn.innerHTML = `<i class="fa-solid fa-key"></i> Generate 8-Digit Pairing Code`;
            btn.disabled = false;
        }
    };

    window.promptDisconnectWaSession = function() {
        const bar = document.getElementById('wa-disconnect-confirm-bar');
        const nameEl = document.getElementById('wa-disconnect-node-name');
        if (nameEl) nameEl.innerText = `@${activeTargetNode}`;
        if (bar) bar.classList.remove('hidden');
    };

    window.confirmDisconnectWaSession = async function() {
        const btn = document.getElementById('wa-confirm-disconnect-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'Disconnecting...';
        }
        try {
            await fetch(`/api/whatsapp/logout?username=${encodeURIComponent(activeTargetNode)}`, { method: 'POST', headers: getAuthHeaders() });
            showToast(`Disconnected WhatsApp node @${activeTargetNode}`, "success");
            const bar = document.getElementById('wa-disconnect-confirm-bar');
            if (bar) bar.classList.add('hidden');
            checkWaStatus();
            loadTenantNodesList();
        } catch (e) {
            showToast("Error disconnecting session", "error");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerText = 'Yes, Disconnect';
            }
        }
    };

    loadTenantNodesList();
    checkWaStatus();
    waPollInterval = setInterval(checkWaStatus, 4000);
}
