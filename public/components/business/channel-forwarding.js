import { getActiveUsername, escapeHtml, checkBusinessAuth, checkNeonStatus } from "../shared/auth-guard.js";
import { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync } from "../shared/media-cropper.js";
// Business Portal: Automated Channel Forwarding Engine & Campaign Logs Component
        async function loadAdminNewsletters() {
            // Load active forwarding rules immediately in parallel so table never waits
            loadChannelForwardingRules();

            const srcSelect = document.getElementById('channel-source-select');
            const tgtSelect = document.getElementById('channel-target-select');
            if (!srcSelect || !tgtSelect) return;

            const activeUser = getActiveUsername();

            srcSelect.innerHTML = '<option value="">Loading subscribed WhatsApp channels...</option>';
            tgtSelect.innerHTML = '<option value="">Loading subscribed WhatsApp channels...</option>';

            try {
                const res = await fetch(`/api/admin/newsletters?username=${encodeURIComponent(activeUser)}`);
                const data = await res.json();
                
                // Format can be array directly or {newsletters: [...]}
                const newsletters = Array.isArray(data) ? data : (data.newsletters || []);
                window._loadedNewsletters = newsletters;
                
                srcSelect.innerHTML = '<option value="">-- Select Source Channel --</option>';
                tgtSelect.innerHTML = '<option value="">-- Select Target Channel (Admin / Owner) --</option>';

                if (newsletters.length === 0) {
                    srcSelect.innerHTML = '<option value="">No subscribed channels found on WhatsApp</option>';
                    tgtSelect.innerHTML = '<option value="">No subscribed channels found on WhatsApp</option>';
                } else {
                    // Source Dropdown (Copy From): Show ALL channels from API
                    newsletters.forEach(nl => {
                        const channelName = nl.name || nl.jid || 'Unknown Channel';
                        const roleTag = (nl.role || 'SUBSCRIBER').toUpperCase();
                        const optSrc = document.createElement('option');
                        optSrc.value = nl.jid;
                        optSrc.textContent = `${channelName} (${roleTag})`;
                        optSrc.setAttribute('data-name', channelName);
                        srcSelect.appendChild(optSrc);
                    });

                    // Target Dropdown (Publish To): Prioritize ADMIN/OWNER channels, and include all others as fallback
                    const writeableChannels = newsletters.filter(nl => {
                        const r = (nl.role || '').toUpperCase();
                        return r === 'ADMIN' || r === 'OWNER';
                    });
                    const otherChannels = newsletters.filter(nl => {
                        const r = (nl.role || '').toUpperCase();
                        return r !== 'ADMIN' && r !== 'OWNER';
                    });

                    if (writeableChannels.length > 0) {
                        const adminGroup = document.createElement('optgroup');
                        adminGroup.label = '👑 Admin / Owner Channels (Publish Ready)';
                        writeableChannels.forEach(nl => {
                            const channelName = nl.name || nl.jid || 'Unknown Channel';
                            const optTgt = document.createElement('option');
                            optTgt.value = nl.jid;
                            optTgt.textContent = `${channelName} (${(nl.role || 'OWNER').toUpperCase()})`;
                            optTgt.setAttribute('data-name', channelName);
                            adminGroup.appendChild(optTgt);
                        });
                        tgtSelect.appendChild(adminGroup);
                    }

                    if (otherChannels.length > 0) {
                        const otherGroup = document.createElement('optgroup');
                        otherGroup.label = '📢 All Other Subscribed Channels';
                        otherChannels.forEach(nl => {
                            const channelName = nl.name || nl.jid || 'Unknown Channel';
                            const optTgt = document.createElement('option');
                            optTgt.value = nl.jid;
                            optTgt.textContent = `${channelName} (${(nl.role || 'SUBSCRIBER').toUpperCase()})`;
                            optTgt.setAttribute('data-name', channelName);
                            otherGroup.appendChild(optTgt);
                        });
                        tgtSelect.appendChild(otherGroup);
                    }
                }
            } catch (err) {
                console.error('Error fetching admin newsletters:', err);
                srcSelect.innerHTML = '<option value="">Failed to load channels</option>';
                tgtSelect.innerHTML = '<option value="">Failed to load channels</option>';
            }
        }

        // RULES CACHE FOR MODAL EDITING
        window.channelRulesMap = {};

        // LOAD ACTIVE FORWARDING RULES TABLE (MANY-TO-MANY)
        async function loadChannelForwardingRules() {
            const tbody = document.getElementById('channel-rules-tbody');
            const countBadge = document.getElementById('rules-count-badge');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/channel-rules');
                if (!res.ok) throw new Error('Failed to fetch rules');
                const data = await res.json();
                const rules = Array.isArray(data) ? data : (data.rules || []);

                window.channelRulesMap = {};
                rules.forEach(r => {
                    window.channelRulesMap[r.id] = r;
                });

                if (countBadge) {
                    countBadge.innerText = `${rules.length} rule${rules.length === 1 ? '' : 's'}`;
                }

                if (rules.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="6" class="p-8 text-center text-slate-500 text-xs">
                                <i class="fa-solid fa-arrows-split-up-and-left text-slate-600 text-base mb-2 block"></i>
                                No forwarding rules created yet. Configure a source, target, logic, and blockers above and click <strong>"Add Forwarding Rule"</strong> to start routing posts.
                            </td>
                        </tr>
                    `;
                    return;
                }

                tbody.innerHTML = rules.map(rule => {
                    const srcDisplay = escapeHtml(rule.source_name || rule.source_jid);
                    const tgtDisplay = escapeHtml(rule.target_name || rule.target_jid);
                    const isActive = Boolean(rule.is_active);
                    
                    const statusButton = isActive
                        ? `<button type="button" onclick="toggleForwardingRule(${rule.id})" class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition cursor-pointer inline-flex items-center gap-1.5" title="Click to pause rule">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> ACTIVE
                           </button>`
                        : `<button type="button" onclick="toggleForwardingRule(${rule.id})" class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 transition cursor-pointer inline-flex items-center gap-1.5" title="Click to activate rule">
                                <span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> PAUSED
                           </button>`;

                    // Logic badge
                    let logicBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">⚡ All</span>';
                    const logic = (rule.forward_logic || 'all').toLowerCase();
                    if (logic === 'only_text') {
                        logicBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">📝 Text Only</span>';
                    } else if (logic === 'only_media') {
                        logicBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">📸 Media Only</span>';
                    } else if (logic === 'text_and_media') {
                        logicBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">🖼️ Text + Media</span>';
                    }

                    // Blockers badges
                    let blockers = [];
                    if (rule.block_urls) {
                        blockers.push('<span class="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30" title="Do not forward posts containing URLs">🚫 No URLs</span>');
                    }
                    if (rule.strip_channel_links) {
                        blockers.push('<span class="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30" title="Native channel context and View channel button stripped">✂️ Clean Post</span>');
                    }
                    const blockersDisplay = blockers.length > 0 
                        ? `<div class="flex flex-wrap gap-1 mt-1">${blockers.join('')}</div>` 
                        : '';

                    return `
                        <tr class="border-b border-slate-800/60 hover:bg-slate-900/40 transition">
                            <td class="p-3 font-semibold text-cyan-300">
                                <div class="flex items-center gap-2">
                                    <i class="fa-solid fa-bullhorn text-cyan-400 text-xs"></i>
                                    <span>${srcDisplay}</span>
                                </div>
                                <div class="text-[10px] text-slate-500 font-mono mt-0.5 truncate max-w-[200px]">${escapeHtml(rule.source_jid)}</div>
                            </td>
                            <td class="p-3 text-center">
                                <span class="text-amber-400 text-sm font-bold">➡️</span>
                            </td>
                            <td class="p-3 font-semibold text-emerald-300">
                                <div class="flex items-center gap-2">
                                    <i class="fa-solid fa-circle-check text-emerald-400 text-xs"></i>
                                    <span>${tgtDisplay}</span>
                                </div>
                                <div class="text-[10px] text-slate-500 font-mono mt-0.5 truncate max-w-[200px]">${escapeHtml(rule.target_jid)}</div>
                            </td>
                            <td class="p-3">
                                <div>${logicBadge}</div>
                                ${blockersDisplay}
                            </td>
                            <td class="p-3 text-center">
                                ${statusButton}
                            </td>
                            <td class="p-3 text-right">
                                <div class="inline-flex items-center gap-1.5">
                                    <button type="button" onclick="openEditRuleModal(${rule.id})" class="px-2.5 py-1 text-xs text-amber-400 hover:text-white hover:bg-amber-500/20 rounded-lg border border-amber-500/30 transition cursor-pointer inline-flex items-center gap-1" title="Edit Rule">
                                        <i class="fa-solid fa-pen-to-square text-[11px]"></i> Edit
                                    </button>
                                    <button type="button" onclick="deleteForwardingRule(${rule.id})" class="px-2.5 py-1 text-xs text-rose-400 hover:text-white hover:bg-rose-500/20 rounded-lg border border-rose-500/30 transition cursor-pointer inline-flex items-center gap-1" title="Delete Rule">
                                        <i class="fa-solid fa-trash-can text-[11px]"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (err) {
                console.error('Error loading channel rules:', err);
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="p-6 text-center text-rose-400 text-xs">
                            Failed to load forwarding rules. Check network connection.
                        </td>
                    </tr>
                `;
            }
        }

        // OPEN EDIT RULE MODAL
        function openEditRuleModal(ruleId) {
            const rule = window.channelRulesMap[ruleId];
            if (!rule) return;
            document.getElementById('edit-rule-id').value = rule.id;
            document.getElementById('edit-rule-id-display').innerText = rule.id;
            document.getElementById('edit-rule-source-name').value = rule.source_name || rule.source_jid;
            document.getElementById('edit-rule-source-jid').value = rule.source_jid;
            document.getElementById('edit-rule-target-name').value = rule.target_name || rule.target_jid;
            document.getElementById('edit-rule-target-jid').value = rule.target_jid;
            document.getElementById('edit-rule-logic').value = rule.forward_logic || 'all';
            document.getElementById('edit-rule-block-urls').checked = Boolean(rule.block_urls);
            document.getElementById('edit-rule-strip-links').checked = rule.strip_channel_links !== false;
            document.getElementById('edit-rule-is-active').checked = rule.is_active !== false;

            document.getElementById('edit-rule-modal').classList.remove('hidden');
        }

        // CLOSE EDIT RULE MODAL
        function closeEditRuleModal() {
            document.getElementById('edit-rule-modal').classList.add('hidden');
        }

        // SAVE EDITED RULE (PUT /api/admin/channel-rules)
        async function saveEditedRule() {
            const id = parseInt(document.getElementById('edit-rule-id').value);
            const srcJid = document.getElementById('edit-rule-source-jid').value;
            const srcName = document.getElementById('edit-rule-source-name').value;
            const tgtJid = document.getElementById('edit-rule-target-jid').value;
            const tgtName = document.getElementById('edit-rule-target-name').value;
            const forwardLogic = document.getElementById('edit-rule-logic').value;
            const blockURLs = document.getElementById('edit-rule-block-urls').checked;
            const stripLinks = document.getElementById('edit-rule-strip-links').checked;
            const isActive = document.getElementById('edit-rule-is-active').checked;

            const saveBtn = document.getElementById('save-rule-btn');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-slate-950"></i> Saving...';
            }

            try {
                const res = await fetch('/api/admin/channel-rules', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: id,
                        source_jid: srcJid,
                        source_name: srcName,
                        target_jid: tgtJid,
                        target_name: tgtName,
                        forward_logic: forwardLogic,
                        block_urls: blockURLs,
                        strip_channel_links: stripLinks,
                        is_active: isActive
                    })
                });

                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    if (typeof showToast === 'function') {
                        showToast(`Rule #${id} updated successfully!`, 'success');
                    } else {
                        alert(`Rule #${id} updated successfully!`);
                    }
                    closeEditRuleModal();
                    await loadChannelForwardingRules();
                } else {
                    alert(data.message || 'Failed to update rule');
                }
            } catch (err) {
                alert('Failed to save changes. Check network connection.');
            } finally {
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Changes';
                }
            }
        }

        // ADD FORWARDING RULE
        async function addForwardingRule() {
            const srcSelect = document.getElementById('channel-source-select');
            const tgtSelect = document.getElementById('channel-target-select');
            const logicSelect = document.getElementById('channel-forward-logic');
            const blockUrlsCheck = document.getElementById('channel-block-urls');
            const stripLinksCheck = document.getElementById('channel-strip-links');
            const addBtn = document.getElementById('add-rule-btn');
            
            const srcJid = srcSelect?.value || '';
            const tgtJid = tgtSelect?.value || '';

            if (!srcJid || !tgtJid) {
                alert('Please select both a Source Channel and a Target Channel.');
                return;
            }

            if (srcJid === tgtJid) {
                alert('Source Channel and Target Channel cannot be the same!');
                return;
            }

            const srcOpt = srcSelect.options[srcSelect.selectedIndex];
            const tgtOpt = tgtSelect.options[tgtSelect.selectedIndex];
            const srcName = srcOpt?.getAttribute('data-name') || srcOpt?.textContent || srcJid;
            const tgtName = tgtOpt?.getAttribute('data-name') || tgtOpt?.textContent || tgtJid;
            const forwardLogic = logicSelect?.value || 'all';
            const blockURLs = Boolean(blockUrlsCheck?.checked);
            const stripLinks = stripLinksCheck ? Boolean(stripLinksCheck.checked) : true;
            const activeUser = getActiveUsername() || 'admin';

            if (addBtn) {
                addBtn.disabled = true;
                addBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-slate-950"></i> Adding Rule...';
            }

            try {
                const res = await fetch('/api/admin/channel-rules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        admin_account_id: activeUser,
                        source_jid: srcJid,
                        source_name: srcName,
                        target_jid: tgtJid,
                        target_name: tgtName,
                        forward_logic: forwardLogic,
                        block_urls: blockURLs,
                        strip_channel_links: stripLinks
                    })
                });

                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    if (typeof showToast === 'function') {
                        showToast(`Forwarding rule added: "${srcName}" ➡️ "${tgtName}"`, 'success');
                    } else {
                        alert(`Forwarding rule added: "${srcName}" ➡️ "${tgtName}"`);
                    }
                    // Reset selects
                    if (srcSelect) srcSelect.selectedIndex = 0;
                    if (tgtSelect) tgtSelect.selectedIndex = 0;
                    if (logicSelect) logicSelect.value = 'all';
                    if (blockUrlsCheck) blockUrlsCheck.checked = false;
                    if (stripLinksCheck) stripLinksCheck.checked = true;
                    // Reload rules list
                    await loadChannelForwardingRules();
                } else {
                    alert(data.message || 'Failed to add forwarding rule');
                }
            } catch (err) {
                alert('Request failed. Check network connection.');
            } finally {
                if (addBtn) {
                    addBtn.disabled = false;
                    addBtn.innerHTML = '<i class="fa-solid fa-plus text-slate-950"></i> <span>Add Forwarding Rule</span>';
                }
            }
        }

        // TOGGLE FORWARDING RULE ACTIVE STATE
        async function toggleForwardingRule(id) {
            try {
                const res = await fetch(`/api/admin/channel-rules/toggle?id=${id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    await loadChannelForwardingRules();
                } else {
                    alert(data.message || 'Failed to toggle rule');
                }
            } catch (err) {
                alert('Failed to toggle rule state.');
            }
        }

        // DELETE FORWARDING RULE
        async function deleteForwardingRule(id) {
            if (!confirm(`Are you sure you want to delete forwarding rule #${id}?`)) {
                return;
            }

            try {
                const res = await fetch(`/api/admin/channel-rules?id=${id}`, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    if (typeof showToast === 'function') {
                        showToast('Forwarding rule deleted successfully!', 'success');
                    }
                    await loadChannelForwardingRules();
                } else {
                    alert(data.message || 'Failed to delete rule');
                }
            } catch (err) {
                alert('Failed to delete rule. Check connection.');
            }
        }

        // 7. FETCH CAMPAIGN LOGS
        async function fetchCampaignLogs() {
            const tbody = document.getElementById('bulk-logs-body');
            if (!tbody) return;
            const user = JSON.parse(localStorage.getItem('user_data') || '{}');
            const username = getActiveUsername();
            try {
                const res = await fetch(`/api/bulk/status?username=${encodeURIComponent(username)}`);
                const data = await res.json();
                const logs = data.campaign?.logs || data.recent_logs || [];
                if (logs.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-500">No active campaign logs yet. Launch a broadcast above.</td></tr>`;
                    return;
                }
                tbody.innerHTML = logs.map(l => `
                    <tr class="hover:bg-slate-900/40">
                        <td class="p-2.5 font-bold text-white">${l.phone}</td>
                        <td class="p-2.5">
                            <span class="px-2 py-0.5 rounded text-[10px] ${l.status === 'sent' || l.status === 'Delivered' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
                                ${l.status === 'sent' ? 'Delivered' : l.status}
                            </span>
                        </td>
                        <td class="p-2.5 text-slate-400 text-[11px]">${l.timestamp || l.time || 'Just now'}</td>
                    </tr>
                `).join('');
            } catch (err) {
                console.warn('Logs error:', err);
            }
        }


export function getChannelForwardingHTML() {
    return `<div id="view-channels" class="biz-tab-content max-w-3xl mx-auto space-y-6">
                    <!-- AUTOMATED CHANNEL FORWARDING ENGINE (ADMIN-ONLY ZERO-LOAD ROUTING ENGINE) -->
                    <div id="channel-forwarder-card" class="glass-card p-5 sm:p-8 rounded-3xl border border-slate-800 space-y-6">
                        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
                            <div>
                                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                                    <i class="fa-solid fa-bullhorn text-amber-400"></i> Automated Channel Forwarding Engine
                                </h3>
                                <p class="text-xs text-slate-400 mt-1 leading-relaxed">
                                    Real-time Many-to-Many WhatsApp Channel auto-forwarder. Incoming posts from source channels are duplicated to target channels with zero media-download RAM load on the server.
                                </p>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-full font-mono font-bold flex items-center gap-1.5 shrink-0">
                                    <i class="fa-solid fa-bolt text-amber-400"></i> Zero-Load RAM Magic
                                </span>
                                <button type="button" onclick="loadAdminNewsletters()" class="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-xl text-xs font-bold border border-slate-700 transition cursor-pointer flex items-center gap-1.5 shrink-0">
                                    <i class="fa-solid fa-rotate text-emerald-400"></i> Refresh Channels
                                </button>
                            </div>
                        </div>

                        <!-- RULE BUILDER FORM -->
                        <div class="bg-slate-900/60 p-4 sm:p-5 rounded-2xl border border-slate-800/80 space-y-4">
                            <h4 class="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                                <i class="fa-solid fa-plus-circle text-amber-400"></i> Add New Forwarding Rule
                            </h4>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <!-- Source Channel Dropdown -->
                                <div>
                                    <label class="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                        <i class="fa-solid fa-right-from-bracket text-cyan-400 mr-1"></i> Source Channel (Copy From)
                                    </label>
                                    <select id="channel-source-select" class="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-amber-500 font-semibold cursor-pointer">
                                        <option value="">-- Select Source Channel --</option>
                                    </select>
                                    <p class="text-[11px] text-slate-500 mt-1">Select channel to monitor for incoming posts.</p>
                                </div>

                                <!-- Target Channel Dropdown -->
                                <div>
                                    <label class="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                        <i class="fa-solid fa-right-to-bracket text-emerald-400 mr-1"></i> Target Channel (Publish To)
                                    </label>
                                    <select id="channel-target-select" class="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-emerald-500 font-semibold cursor-pointer">
                                        <option value="">-- Select Target Channel (Admin / Owner Only) --</option>
                                    </select>
                                    <p class="text-[11px] text-slate-500 mt-1">Filtered: only channels where you have ADMIN or OWNER role.</p>
                                </div>
                            </div>

                            <!-- ADVANCED CONFIGURATION ROW (LOGIC & BLOCKERS) -->
                            <div class="pt-3 border-t border-slate-800/70 grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
                                <!-- Forward Logic Dropdown -->
                                <div>
                                    <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                        <i class="fa-solid fa-filter text-amber-400"></i> Forward Logic
                                    </label>
                                    <select id="channel-forward-logic" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-amber-500 font-semibold cursor-pointer">
                                        <option value="all">⚡ All Posts (Text & Media)</option>
                                        <option value="only_text">📝 Only Text Messages</option>
                                        <option value="text_and_media">🖼️ Text + Image/Video</option>
                                        <option value="only_media">📸 Only Image/Video</option>
                                    </select>
                                </div>

                                <!-- Block URLs Checkbox -->
                                <div class="flex items-center gap-2.5 bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 cursor-pointer hover:border-slate-700 transition" title="Do not forward posts that contain external links (http://, https://, www.)">
                                    <input type="checkbox" id="channel-block-urls" class="w-4 h-4 rounded text-amber-500 bg-slate-900 border-slate-700 focus:ring-amber-500 cursor-pointer">
                                    <label for="channel-block-urls" class="text-xs font-semibold text-slate-300 cursor-pointer select-none">
                                        <span class="block text-slate-200">Block URLs (Links)</span>
                                        <span class="text-[10px] text-slate-500 font-normal">Skip posts with web links</span>
                                    </label>
                                </div>

                                <!-- Remove View Channel Button Checkbox -->
                                <div class="flex items-center gap-2.5 bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 cursor-pointer hover:border-slate-700 transition" title="Strip original channel context so it looks like an original post">
                                    <input type="checkbox" id="channel-strip-links" checked class="w-4 h-4 rounded text-emerald-500 bg-slate-900 border-slate-700 focus:ring-emerald-500 cursor-pointer">
                                    <label for="channel-strip-links" class="text-xs font-semibold text-slate-300 cursor-pointer select-none">
                                        <span class="block text-slate-200">Remove 'View channel' Button</span>
                                        <span class="text-[10px] text-slate-500 font-normal">Strip context & forwarded tag</span>
                                    </label>
                                </div>
                            </div>

                            <div class="flex justify-end pt-1">
                                <button type="button" onclick="addForwardingRule()" id="add-rule-btn" class="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-600 hover:to-emerald-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-lg">
                                    <i class="fa-solid fa-plus text-slate-950"></i>
                                    <span>Add Forwarding Rule</span>
                                </button>
                            </div>
                        </div>

                        <!-- ACTIVE RULES TABLE -->
                        <div class="space-y-3">
                            <div class="flex items-center justify-between">
                                <h4 class="text-xs font-bold text-white flex items-center gap-2">
                                    <i class="fa-solid fa-arrows-split-up-and-left text-cyan-400"></i> Active Forwarding Rules (Many-to-Many)
                                </h4>
                                <span id="rules-count-badge" class="text-[10px] bg-slate-800 text-slate-300 px-2.5 py-0.5 rounded-full font-mono">0 rules</span>
                            </div>

                            <div class="overflow-x-auto w-full rounded-2xl border border-slate-800/80 bg-slate-950/50">
                                <table class="w-full text-left text-xs min-w-[650px]">
                                    <thead>
                                        <tr class="text-[10px] uppercase text-slate-400 border-b border-slate-800 font-mono bg-slate-900/40">
                                            <th class="p-3">Source Channel (Copy From)</th>
                                            <th class="p-3 text-center">Route</th>
                                            <th class="p-3">Target Channel (Publish To)</th>
                                            <th class="p-3">Logic & Filters</th>
                                            <th class="p-3 text-center">Status</th>
                                            <th class="p-3 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody id="channel-rules-tbody">
                                        <tr>
                                            <td colspan="6" class="p-6 text-center text-slate-500 text-xs">
                                                Loading forwarding rules...
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <!-- EDIT FORWARDING RULE MODAL -->
                    <div id="edit-rule-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                        <div class="glass-card max-w-lg w-full p-6 rounded-3xl border border-slate-700 space-y-5 bg-slate-900/95 shadow-2xl">
                            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                                    <i class="fa-solid fa-pen-to-square text-amber-400"></i>
                                    <span>Edit Forwarding Rule #<span id="edit-rule-id-display"></span></span>
                                </h3>
                                <button type="button" onclick="closeEditRuleModal()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer">
                                    <i class="fa-solid fa-xmark text-base"></i>
                                </button>
                            </div>

                            <input type="hidden" id="edit-rule-id" value="">
                            
                            <div class="space-y-4 text-xs">
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label class="block font-bold text-slate-300 uppercase tracking-wider mb-1">Source Channel Name</label>
                                        <input type="text" id="edit-rule-source-name" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 outline-none focus:border-amber-500">
                                    </div>
                                    <div>
                                        <label class="block font-bold text-slate-300 uppercase tracking-wider mb-1">Source Channel JID</label>
                                        <input type="text" id="edit-rule-source-jid" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-400 font-mono text-[11px] outline-none focus:border-amber-500">
                                    </div>
                                </div>

                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label class="block font-bold text-slate-300 uppercase tracking-wider mb-1">Target Channel Name</label>
                                        <input type="text" id="edit-rule-target-name" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 outline-none focus:border-emerald-500">
                                    </div>
                                    <div>
                                        <label class="block font-bold text-slate-300 uppercase tracking-wider mb-1">Target Channel JID</label>
                                        <input type="text" id="edit-rule-target-jid" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-400 font-mono text-[11px] outline-none focus:border-emerald-500">
                                    </div>
                                </div>

                                <div>
                                    <label class="block font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                                        <i class="fa-solid fa-filter text-amber-400"></i> Forward Logic
                                    </label>
                                    <select id="edit-rule-logic" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white outline-none focus:ring-2 focus:ring-amber-500 font-semibold cursor-pointer">
                                        <option value="all">⚡ All Posts (Text & Media)</option>
                                        <option value="only_text">📝 Only Text Messages</option>
                                        <option value="text_and_media">🖼️ Text + Image/Video</option>
                                        <option value="only_media">📸 Only Image/Video</option>
                                    </select>
                                </div>

                                <div class="space-y-2 pt-2">
                                    <div class="flex items-center gap-2.5 bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 cursor-pointer">
                                        <input type="checkbox" id="edit-rule-block-urls" class="w-4 h-4 rounded text-amber-500 bg-slate-900 border-slate-700 focus:ring-amber-500 cursor-pointer">
                                        <label for="edit-rule-block-urls" class="cursor-pointer select-none">
                                            <span class="block font-semibold text-slate-200">Block URLs (Links)</span>
                                            <span class="text-[10px] text-slate-500">Do not forward posts containing http://, https://, or www.</span>
                                        </label>
                                    </div>

                                    <div class="flex items-center gap-2.5 bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 cursor-pointer">
                                        <input type="checkbox" id="edit-rule-strip-links" class="w-4 h-4 rounded text-emerald-500 bg-slate-900 border-slate-700 focus:ring-emerald-500 cursor-pointer">
                                        <label for="edit-rule-strip-links" class="cursor-pointer select-none">
                                            <span class="block font-semibold text-slate-200">Remove 'View channel' Button</span>
                                            <span class="text-[10px] text-slate-500">Strip original channel context to appear as original post</span>
                                        </label>
                                    </div>
                                    
                                    <div class="flex items-center gap-2.5 bg-slate-950/70 p-2.5 rounded-xl border border-slate-800/80 cursor-pointer">
                                        <input type="checkbox" id="edit-rule-is-active" class="w-4 h-4 rounded text-cyan-500 bg-slate-900 border-slate-700 focus:ring-cyan-500 cursor-pointer">
                                        <label for="edit-rule-is-active" class="cursor-pointer select-none">
                                            <span class="block font-semibold text-slate-200">Rule Active</span>
                                            <span class="text-[10px] text-slate-500">Enable or pause this forwarding pipeline</span>
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div class="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-800">
                                <button type="button" onclick="closeEditRuleModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer">
                                    Cancel
                                </button>
                                <button type="button" onclick="saveEditedRule()" id="save-rule-btn" class="px-5 py-2 bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-600 hover:to-emerald-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-2">
                                    <i class="fa-solid fa-check"></i> Save Changes
                                </button>
                            </div>
                        </div>
                    </div>
</div>`;
}

export function initChannelForwarding(apiBaseUrl = "") {
    Object.assign(window, { loadAdminNewsletters, escapeHtml, loadChannelForwardingRules, openEditRuleModal, closeEditRuleModal, saveEditedRule, addForwardingRule, toggleForwardingRule, deleteForwardingRule, fetchCampaignLogs });
    loadChannelForwardingRules();
    loadAdminNewsletters();
}

export { loadAdminNewsletters, escapeHtml, loadChannelForwardingRules, openEditRuleModal, closeEditRuleModal, saveEditedRule, addForwardingRule, toggleForwardingRule, deleteForwardingRule, fetchCampaignLogs };
Object.assign(window, { loadAdminNewsletters, escapeHtml, loadChannelForwardingRules, openEditRuleModal, closeEditRuleModal, saveEditedRule, addForwardingRule, toggleForwardingRule, deleteForwardingRule, fetchCampaignLogs });
