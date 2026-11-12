/**
 * Admin Automated Channel Routing & Master Security Component
 * Features WhatsApp Newsletter/Channel-to-Channel Forwarding Rules (with mobile cards + desktop table, zero blocking dialogs)
 * and Master Admin Password & Security Manager.
 */

import { showToast } from './admin-sidebar.js';
import { getAuthHeaders, escapeHtml } from '../shared/auth-guard.js';

export function getChannelRoutingHTML() {
    return `
        <div class="space-y-6 pb-8">
            <!-- Header Banner -->
            <div class="bg-gradient-to-r from-slate-900 via-blue-950/70 to-slate-900 p-6 rounded-3xl border border-blue-500/20 shadow-xl flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                <div>
                    <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[11px] font-black uppercase tracking-widest mb-2">
                        <i class="fa-solid fa-tower-broadcast"></i> Automated Newsletter Relay & Security
                    </div>
                    <h2 class="text-2xl md:text-3xl font-black text-white tracking-tight">Channel Routing & Master Security</h2>
                    <p class="text-slate-400 text-xs md:text-sm mt-1">Configure automated WhatsApp Channel-to-Channel media & post forwarding rules and manage Master Admin credentials.</p>
                </div>
                <button type="button" onclick="window.fetchAdminChannels()" class="min-h-11 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition flex items-center gap-2 border border-slate-700 cursor-pointer">
                    <i class="fa-solid fa-rotate"></i> Sync Subscribed Channels
                </button>
            </div>

            <!-- Add / Edit Forwarding Rule Card -->
            <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                <div class="mb-5">
                    <h3 class="text-lg font-black text-white flex items-center gap-2">
                        <i class="fa-solid fa-diagram-project text-blue-400"></i> Create / Update Channel Forwarding Pipeline
                    </h3>
                    <p class="text-slate-400 text-xs mt-0.5">Automatically clone incoming posts, images, videos, and captions from a Source WhatsApp Channel to a Destination Channel.</p>
                </div>

                <form onsubmit="window.saveChannelRule(event)" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
                    <input type="hidden" id="cf-id">
                    <div>
                        <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Pipeline Label / Source Name</label>
                        <input type="text" id="cf-name" placeholder="e.g. Deals Main to VIP Channel" required class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-blue-500 p-3 rounded-xl text-white text-sm outline-none">
                    </div>
                    <div>
                        <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Source Channel JID</label>
                        <input type="text" id="cf-source" list="wa-channels-datalist" placeholder="1203630...@newsletter" required class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-blue-500 p-3 rounded-xl text-white text-sm font-mono outline-none">
                    </div>
                    <div>
                        <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Destination Channel JID</label>
                        <input type="text" id="cf-dest" list="wa-channels-datalist" placeholder="1203630...@newsletter" required class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-blue-500 p-3 rounded-xl text-white text-sm font-mono outline-none">
                    </div>
                    <div class="flex items-end gap-2">
                        <button type="submit" id="cf-submit-btn" class="w-full min-h-11 bg-blue-600 hover:bg-blue-500 text-white font-black py-3 rounded-xl shadow-lg shadow-blue-600/20 transition text-xs uppercase tracking-wider cursor-pointer">
                            Save Routing Rule
                        </button>
                        <button type="button" id="cf-cancel-btn" onclick="window.resetChannelForm()" class="hidden min-h-11 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-3 px-4 rounded-xl transition text-xs cursor-pointer">
                            Cancel
                        </button>
                    </div>
                </form>
                <datalist id="wa-channels-datalist"></datalist>
            </div>

            <!-- Active Forwarding Rules List -->
            <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-base font-black text-white flex items-center gap-2">
                        <i class="fa-solid fa-bolt text-emerald-400"></i> Active Channel Forwarding Pipelines
                    </h3>
                    <span id="cf-count-badge" class="px-3 py-1 rounded-full bg-slate-950 border border-slate-800 text-xs font-bold text-slate-400">0 Rules</span>
                </div>

                <!-- Mobile Card View -->
                <div id="cf-mobile-cards" class="md:hidden space-y-3"></div>

                <!-- Desktop Table View -->
                <div class="hidden md:block overflow-x-auto rounded-2xl border border-slate-800">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                                <th class="p-4">ID</th>
                                <th class="p-4">Pipeline Name</th>
                                <th class="p-4">Source Channel JID</th>
                                <th class="p-4">Destination Channel JID</th>
                                <th class="p-4">Status</th>
                                <th class="p-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="cf-table-body" class="text-sm divide-y divide-slate-800/60 bg-slate-900/40">
                            <tr><td colspan="6" class="p-6 text-center text-slate-500">Loading forwarding rules...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Master Admin Security & Credentials Section -->
            <div class="bg-slate-900/90 p-6 rounded-3xl border border-slate-800 shadow-xl">
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-5 pb-4 border-b border-slate-800">
                    <div>
                        <h3 class="text-lg font-black text-white flex items-center gap-2">
                            <i class="fa-solid fa-shield-halved text-indigo-400"></i> Master Admin Security & Password Manager
                        </h3>
                        <p class="text-xs text-slate-400 mt-0.5">Update the Master Superadmin (<code class="text-indigo-400 font-mono">@admin</code>) password and session security.</p>
                    </div>
                    <span class="px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[11px] font-black uppercase">JWT Protected</span>
                </div>

                <form onsubmit="window.updateMasterAdminPassword(event)" class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div>
                        <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">Current Admin Password</label>
                        <input type="password" id="admin-sec-old-pass" required placeholder="Enter current password" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-indigo-500 p-3 rounded-xl text-white text-sm outline-none">
                    </div>
                    <div>
                        <label class="block text-xs text-slate-400 font-bold uppercase mb-1.5">New Master Password</label>
                        <input type="password" id="admin-sec-new-pass" required placeholder="Minimum 6 characters" class="w-full min-h-11 bg-slate-950 border border-slate-800 focus:border-indigo-500 p-3 rounded-xl text-white text-sm outline-none">
                    </div>
                    <div>
                        <button type="submit" id="admin-sec-save-btn" class="w-full min-h-11 bg-indigo-600 hover:bg-indigo-500 text-white font-black py-3 rounded-xl shadow-lg shadow-indigo-600/20 transition flex items-center justify-center gap-2 text-xs uppercase tracking-wider cursor-pointer">
                            <i class="fa-solid fa-key"></i> Update Master Password
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;
}

export function initChannelRouting() {
    window.fetchAdminChannels = async function() {
        try {
            const res = await fetch('/api/whatsapp/channels?username=admin', { headers: getAuthHeaders() });
            const channels = await res.json();
            const dl = document.getElementById('wa-channels-datalist');
            if (dl && Array.isArray(channels)) {
                dl.innerHTML = channels.map(c => `<option value="${escapeHtml(c.jid)}">${escapeHtml(c.name || c.jid)}</option>`).join('');
                showToast(`Synced ${channels.length} subscribed WhatsApp channels`, true);
            }
        } catch (err) {
            console.error('Error syncing channels:', err);
        }
    };

    async function loadChannelRules() {
        const tbody = document.getElementById('cf-table-body');
        const mobileCards = document.getElementById('cf-mobile-cards');
        const countBadge = document.getElementById('cf-count-badge');
        if (!tbody) return;

        try {
            const res = await fetch('/api/channel-forward/list?username=admin', { headers: getAuthHeaders() });
            const rules = await res.json();
            const list = Array.isArray(rules) ? rules : (rules.rules || []);

            if (countBadge) countBadge.innerText = `${list.length} Rule${list.length === 1 ? '' : 's'}`;

            if (list.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-500">No channel forwarding pipelines configured yet.</td></tr>`;
                if (mobileCards) {
                    mobileCards.innerHTML = `<div class="p-6 text-center text-slate-500 text-xs bg-slate-950 rounded-2xl border border-slate-800">No channel forwarding pipelines configured yet.</div>`;
                }
                return;
            }

            tbody.innerHTML = list.map(r => {
                const isEnabled = r.enabled !== undefined ? Boolean(r.enabled) : Boolean(r.is_active);
                const destJid = r.dest_jid || r.target_jid || '';
                const ruleName = r.name || r.source_name || `Pipeline #${r.id}`;
                return `
                <tr class="hover:bg-slate-800/40 transition">
                    <td class="p-4 font-mono text-xs text-slate-400">#${r.id}</td>
                    <td class="p-4 font-bold text-white">${escapeHtml(ruleName)}</td>
                    <td class="p-4 font-mono text-xs text-blue-400">${escapeHtml(r.source_jid)}</td>
                    <td class="p-4 font-mono text-xs text-purple-400">${escapeHtml(destJid)}</td>
                    <td class="p-4">
                        <button type="button" onclick="window.toggleChannelRule(${r.id}, ${!isEnabled})" class="min-h-9 px-3 py-1 rounded-lg text-xs font-black border transition cursor-pointer ${isEnabled ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 text-slate-400 border-slate-700'}">
                            ${isEnabled ? 'ACTIVE' : 'PAUSED'}
                        </button>
                    </td>
                    <td class="p-4 text-right">
                        <div class="flex items-center justify-end gap-1.5">
                            <button type="button" onclick="window.editChannelRule(${r.id}, '${escapeHtml(ruleName).replace(/'/g, "\\'")}', '${escapeHtml(r.source_jid)}', '${escapeHtml(destJid)}')" class="min-h-9 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-blue-600/20 text-blue-400 text-xs font-bold border border-slate-700 transition cursor-pointer">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button type="button" onclick="window.deleteChannelRule(${r.id})" class="min-h-9 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/20 text-rose-400 text-xs font-bold border border-slate-700 transition cursor-pointer">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
            }).join('');

            if (mobileCards) {
                mobileCards.innerHTML = list.map(r => {
                    const isEnabled = r.enabled !== undefined ? Boolean(r.enabled) : Boolean(r.is_active);
                    const destJid = r.dest_jid || r.target_jid || '';
                    const ruleName = r.name || r.source_name || `Pipeline #${r.id}`;
                    return `
                    <div class="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2.5">
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-white text-sm">${escapeHtml(ruleName)} <span class="text-xs font-mono text-slate-500">#${r.id}</span></span>
                            <button type="button" onclick="window.toggleChannelRule(${r.id}, ${!isEnabled})" class="min-h-9 px-2.5 py-1 rounded-lg text-[10px] font-black border cursor-pointer ${isEnabled ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 text-slate-400 border-slate-700'}">
                                ${isEnabled ? 'ACTIVE' : 'PAUSED'}
                            </button>
                        </div>
                        <div class="text-[11px] font-mono text-blue-400 truncate">From: ${escapeHtml(r.source_jid)}</div>
                        <div class="text-[11px] font-mono text-purple-400 truncate">To: ${escapeHtml(destJid)}</div>
                        <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-900">
                            <button type="button" onclick="window.editChannelRule(${r.id}, '${escapeHtml(ruleName).replace(/'/g, "\\'")}', '${escapeHtml(r.source_jid)}', '${escapeHtml(destJid)}')" class="min-h-9 px-3 py-1 rounded-lg bg-slate-900 text-blue-400 text-xs font-bold border border-slate-800 cursor-pointer">Edit</button>
                            <button type="button" onclick="window.deleteChannelRule(${r.id})" class="min-h-9 px-3 py-1 rounded-lg bg-slate-900 text-rose-400 text-xs font-bold border border-slate-800 cursor-pointer">Delete</button>
                        </div>
                    </div>
                `;
                }).join('');
            }
        } catch (err) {
            console.error("Failed to load channel rules", err);
        }
    }

    window.saveChannelRule = async function(e) {
        e.preventDefault();
        const id = document.getElementById('cf-id').value;
        const payload = {
            username: 'admin',
            name: document.getElementById('cf-name').value.trim(),
            source_jid: document.getElementById('cf-source').value.trim(),
            dest_jid: document.getElementById('cf-dest').value.trim()
        };

        const url = id ? '/api/channel-forward/update' : '/api/channel-forward/add';
        if (id) payload.id = parseInt(id);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && (data.status === 'success' || data.success)) {
                showToast(id ? "Forwarding pipeline updated!" : "Forwarding pipeline created!", true);
                window.resetChannelForm();
                loadChannelRules();
            } else {
                showToast(data.error || data.message || "Failed to save rule", false);
            }
        } catch (err) {
            showToast("Server error saving rule", false);
        }
    };

    window.editChannelRule = function(id, name, source, dest) {
        document.getElementById('cf-id').value = id;
        document.getElementById('cf-name').value = name;
        document.getElementById('cf-source').value = source;
        document.getElementById('cf-dest').value = dest;
        document.getElementById('cf-submit-btn').innerText = "Update Rule";
        document.getElementById('cf-cancel-btn').classList.remove('hidden');
    };

    window.resetChannelForm = function() {
        document.getElementById('cf-id').value = '';
        document.getElementById('cf-name').value = '';
        document.getElementById('cf-source').value = '';
        document.getElementById('cf-dest').value = '';
        document.getElementById('cf-submit-btn').innerText = "Save Routing Rule";
        document.getElementById('cf-cancel-btn').classList.add('hidden');
    };

    window.toggleChannelRule = async function(id, enabled) {
        try {
            await fetch('/api/channel-forward/toggle', {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ id, username: 'admin', enabled })
            });
            showToast(`Pipeline #${id} ${enabled ? 'activated' : 'paused'}`, true);
            loadChannelRules();
        } catch (err) {
            showToast("Failed to toggle rule", false);
        }
    };

    window.deleteChannelRule = async function(id) {
        try {
            await fetch(`/api/channel-forward/delete?id=${id}&username=admin`, {
                method: 'DELETE',
                headers: getAuthHeaders()
            });
            showToast(`Deleted pipeline #${id}`, true);
            loadChannelRules();
        } catch (err) {
            showToast("Failed to delete rule", false);
        }
    };

    window.updateMasterAdminPassword = async function(e) {
        e.preventDefault();
        const currentPassword = document.getElementById('admin-sec-old-pass')?.value || '';
        const newPassword = document.getElementById('admin-sec-new-pass')?.value || '';
        if (newPassword.length < 6) {
            return showToast('New password must be at least 6 characters', false);
        }
        const btn = document.getElementById('admin-sec-save-btn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;
        }
        try {
            const res = await fetch('/api/user/change-password', {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    username: 'admin',
                    current_password: currentPassword,
                    old_password: currentPassword,
                    new_password: newPassword
                })
            });
            const data = await res.json();
            if (res.ok && (data.status === 'success' || data.success)) {
                showToast(data.message || 'Master Admin password updated!', true);
                document.getElementById('admin-sec-old-pass').value = '';
                document.getElementById('admin-sec-new-pass').value = '';
            } else {
                showToast(data.message || data.error || 'Failed to update password', false);
            }
        } catch (err) {
            showToast('Server error updating password', false);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-key"></i> Update Master Password`;
            }
        }
    };

    loadChannelRules();
    window.fetchAdminChannels();
}
