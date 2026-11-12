// Master Admin Portal: Enterprise Business Stores & Analytics Control Plane + Store Orders Fulfillment Pipeline
// 100% Real PostgreSQL Data | Chart.js Visual Analytics | Full Business Store CRUD & Credentials
import { showToast } from "./admin-sidebar.js";
import { getAuthHeaders, escapeHtml, formatLocalDateTime } from "../shared/auth-guard.js";

if (!window._allTenants) window._allTenants = [];
let pendingDeleteTenantUsername = "";
let adminGmvChartInstance = null;
let globalPlatformOrders = [];

function formatINR(val) {
    return "₹" + (Number(val) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

async function loadAdminDashboard() {
    const refreshIcon = document.getElementById('btn-refresh-icon');
    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    try {
        const [usersRes, dashRes] = await Promise.all([
            fetch('/api/admin/users', { headers: getAuthHeaders() }),
            fetch('/api/admin/dashboard', { headers: getAuthHeaders() }).catch(() => null)
        ]);

        if (!usersRes.ok) throw new Error('HTTP ' + usersRes.status);
        const userData = await usersRes.json();
        const users = Array.isArray(userData) ? userData : (userData.users || []);
        window._allTenants = users;

        const computedGMV = users.reduce((acc, u) => acc + (Number(u.revenue_total) || 0), 0);
        const computedOrders = users.reduce((acc, u) => acc + (Number(u.orders_count) || 0), 0);
        const computedProds = users.reduce((acc, u) => acc + (Number(u.products_count) || 0), 0);
        const activeStores = users.filter(u => u.store_open_status !== false).length;

        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.innerText = String(val);
        };

        setEl('stat-total-users', users.length);
        setEl('stat-active-stores', activeStores);
        setEl('stat-active-automations', users.filter(u => u.automation_access || u.is_automated).length);
        setEl('stat-connected-wa', users.filter(u => u.status === 'Connected' || Boolean(u.wa_jid)).length);
        setEl('stat-total-products', computedProds);
        setEl('stat-total-gmv', formatINR(computedGMV));
        setEl('stat-total-orders', computedOrders);

        let dashData = null;
        if (dashRes && dashRes.ok) {
            dashData = await dashRes.json();
            const m = dashData.metrics || {};
            if (m.totalMediaItems !== undefined) setEl('stat-total-products', m.totalMediaItems);
            if (m.totalGMV !== undefined) setEl('stat-total-gmv', formatINR(Math.max(computedGMV, Number(m.totalGMV) || 0)));
            if (m.totalOrders !== undefined) setEl('stat-total-orders', Math.max(computedOrders, Number(m.totalOrders) || 0));
            if (m.activeChannelRules !== undefined) setEl('stat-channel-rules', m.activeChannelRules);
        }

        renderAdminAnalyticsCharts(dashData, users);
        filterTenants();
    } catch (err) {
        showToast('Failed to sync business store database: ' + err.message, false);
    } finally {
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
}

function renderAdminAnalyticsCharts(dashData, users) {
    const ChartLib = window.Chart;
    if (!ChartLib) return;

    const charts = (dashData && dashData.charts) || {};
    const labels = Array.isArray(charts.seven_day_labels) && charts.seven_day_labels.length > 0
        ? charts.seven_day_labels
        : ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Today"];
    const gmvSeries = Array.isArray(charts.seven_day_gmv) && charts.seven_day_gmv.length > 0
        ? charts.seven_day_gmv
        : [0, 0, 0, 0, 0, 0, 0];

    const skel1 = document.getElementById("admin-gmv-chart-skeleton");
    if (skel1) skel1.classList.add("hidden");

    const gmvCanvas = document.getElementById("adminGmvTrendChart");
    if (gmvCanvas) {
        if (adminGmvChartInstance) {
            adminGmvChartInstance.destroy();
            adminGmvChartInstance = null;
        }
        const ctx = gmvCanvas.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, 0, 220);
        grad.addColorStop(0, "rgba(99, 102, 241, 0.38)");
        grad.addColorStop(1, "rgba(99, 102, 241, 0.01)");

        adminGmvChartInstance = new ChartLib(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Platform GMV (₹)",
                    data: gmvSeries,
                    borderColor: "#6366f1",
                    backgroundColor: grad,
                    borderWidth: 3,
                    pointBackgroundColor: "#0f172a",
                    pointBorderColor: "#818cf8",
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#020617",
                        borderColor: "#1e293b",
                        borderWidth: 1,
                        callbacks: {
                            label: (c) => ` Platform GMV: ₹${Number(c.parsed.y || 0).toLocaleString("en-IN")}`
                        }
                    }
                },
                scales: {
                    x: { grid: { color: "rgba(30,41,59,0.35)" }, ticks: { color: "#94a3b8", font: { size: 11 } } },
                    y: { beginAtZero: true, grid: { color: "rgba(30,41,59,0.5)" }, ticks: { color: "#94a3b8", font: { size: 11 }, callback: (v) => "₹" + v } }
                }
            }
        });
    }

    // Top Tenants Leaderboard
    const leaderboardEl = document.getElementById("admin-top-tenants-list");
    if (leaderboardEl) {
        const sorted = [...users].sort((a, b) => (Number(b.revenue_total) || 0) - (Number(a.revenue_total) || 0) || (Number(b.orders_count) || 0) - (Number(a.orders_count) || 0)).slice(0, 4);
        if (sorted.length === 0) {
            leaderboardEl.innerHTML = `<div class="p-4 text-center text-xs text-slate-500">No tenant activity recorded yet</div>`;
        } else {
            leaderboardEl.innerHTML = sorted.map((u, idx) => `
                <div class="p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <span class="w-6 h-6 rounded-lg ${idx === 0 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-800 text-slate-400'} text-[11px] font-black font-mono flex items-center justify-center shrink-0">#${idx + 1}</span>
                        <div class="min-w-0">
                            <div class="text-xs font-bold text-white truncate">${escapeHtml(u.account_name || u.username)}</div>
                            <div class="text-[10px] font-mono text-indigo-400 truncate">@${escapeHtml(u.username)} • ${Number(u.products_count || 0)} SKUs</div>
                        </div>
                    </div>
                    <div class="text-right shrink-0">
                        <div class="text-xs font-black font-mono text-emerald-400">${formatINR(u.revenue_total || 0)}</div>
                        <div class="text-[10px] font-mono text-slate-400">${Number(u.orders_count || 0)} orders</div>
                    </div>
                </div>
            `).join("");
        }
    }
}

function getCategoryBadgeLabel(type) {
    switch (type) {
        case 'library_owner': return 'Study Library';
        case 'kirana': return 'Kirana & Supermarket';
        case 'restaurant': return 'Restaurant & Cafe';
        case 'pharmacy': return 'Pharmacy & Healthcare';
        case 'fashion': return 'Fashion & Lifestyle';
        case 'electronics': return 'Electronics & Gadgets';
        default: return 'E-Commerce Store';
    }
}

function filterTenants() {
    const tbody = document.getElementById('tenants-table-body');
    const mobileList = document.getElementById('tenants-mobile-cards');
    if (!tbody && !mobileList) return;

    const searchTxt = (document.getElementById('tenant-search-input')?.value || '').toLowerCase().trim();
    const typeFilter = (document.getElementById('tenant-type-filter')?.value || '').trim();
    const statusFilter = (document.getElementById('tenant-wa-filter')?.value || '').trim();
    const openFilter = (document.getElementById('tenant-open-filter')?.value || '').trim();

    const filtered = window._allTenants.filter(u => {
        const name = (u.full_name || u.account_name || u.business_name || u.username || '').toLowerCase();
        const uname = (u.username || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const phone = (u.phone || '').toLowerCase();
        const slug = (u.store_slug || '').toLowerCase();
        const matchesSearch = !searchTxt || name.includes(searchTxt) || uname.includes(searchTxt) || email.includes(searchTxt) || phone.includes(searchTxt) || slug.includes(searchTxt);
        const matchesType = !typeFilter || (u.user_type || u.business_type || 'business_user') === typeFilter;
        const isWaConn = u.status === 'Connected' || Boolean(u.wa_jid);
        const matchesWa = !statusFilter || (statusFilter === 'connected' ? isWaConn : !isWaConn);
        const isOpen = u.store_open_status !== false;
        const matchesOpen = !openFilter || (openFilter === 'open' ? isOpen : !isOpen);
        return matchesSearch && matchesType && matchesWa && matchesOpen;
    });

    const countEl = document.getElementById('tenant-count-display');
    if (countEl) countEl.innerText = String(filtered.length);

    if (filtered.length === 0) {
        const emptyHtml = `
            <div class="p-10 text-center text-slate-500">
                <i class="fa-solid fa-store-slash text-2xl mb-2 text-slate-600 block"></i>
                <span class="text-xs font-bold text-slate-400">No Matching Business Stores Found</span>
            </div>
        `;
        if (mobileList) mobileList.innerHTML = emptyHtml;
        if (tbody) tbody.innerHTML = `<tr><td colspan="7">${emptyHtml}</td></tr>`;
        return;
    }

    // 1. Mobile Card View (< 768px)
    if (mobileList) {
        mobileList.innerHTML = filtered.map(u => {
            const isAuto = u.automation_access ?? u.is_automated ?? true;
            const isAutoReply = u.auto_reply !== false;
            const isWaConnected = u.status === 'Connected' || Boolean(u.wa_jid);
            const typeLabel = getCategoryBadgeLabel(u.user_type || u.business_type);
            const displayName = escapeHtml(u.business_name || u.account_name || u.full_name || u.username);
            const safeUsername = escapeHtml(u.username);
            const safeSlug = escapeHtml(u.store_slug || u.username);
            const hasPaytm = Boolean(u.paytm_vpa);
            const isOpen = u.store_open_status !== false;

            return `
            <div class="p-4 space-y-3 hover:bg-slate-800/30 transition">
                <div class="flex items-start justify-between gap-2">
                    <div>
                        <div class="font-black text-white text-sm flex items-center gap-1.5">
                            <span>${displayName}</span>
                            <button type="button" onclick="toggleStoreOpenStatus('${safeUsername}', ${!isOpen})" class="cursor-pointer" title="Click to toggle store open/closed">
                                ${isOpen
                                    ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> OPEN</span>`
                                    : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> CLOSED</span>`}
                            </button>
                        </div>
                        <div class="text-xs font-mono text-indigo-400 mt-0.5">@${safeUsername} • <span class="text-slate-400">${safeSlug}</span></div>
                        ${u.phone ? `<div class="text-[11px] font-mono text-slate-400 mt-0.5">+${escapeHtml(String(u.phone).replace(/^\+/, ''))}</div>` : ''}
                    </div>
                    <span class="px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 text-[10px] font-mono font-bold uppercase border border-slate-700">
                        ${typeLabel}
                    </span>
                </div>

                <!-- Business Store Metrics Row -->
                <div class="grid grid-cols-3 gap-2 bg-slate-950/75 border border-slate-800/90 rounded-xl p-2.5 text-center font-mono">
                    <div>
                        <div class="text-[10px] text-slate-500 uppercase">Catalog SKUs</div>
                        <div class="text-xs font-black text-white">${Number(u.products_count || 0)}</div>
                    </div>
                    <div>
                        <div class="text-[10px] text-slate-500 uppercase">Orders</div>
                        <div class="text-xs font-black text-indigo-400">${Number(u.orders_count || 0)}</div>
                    </div>
                    <div>
                        <div class="text-[10px] text-slate-500 uppercase">Gross GMV</div>
                        <div class="text-xs font-black text-emerald-400">${formatINR(u.revenue_total || 0)}</div>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    ${isWaConnected
                        ? `<span class="px-2.5 py-1 rounded-md bg-teal-500/10 text-teal-300 border border-teal-500/30 text-[11px] font-mono font-bold inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-teal-400"></span> WA Online</span>`
                        : `<span class="px-2.5 py-1 rounded-md bg-slate-800 text-slate-400 text-[11px] font-mono font-bold inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span> WA Offline</span>`}
                    <button type="button" onclick="toggleAutomation('${safeUsername}')" class="min-h-9 px-2.5 py-1 rounded-lg ${isAuto ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 text-slate-400 border-slate-700'} border text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1">
                        <i class="fa-solid ${isAuto ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> Access: ${isAuto ? 'Active' : 'Locked'}
                    </button>
                    <button type="button" onclick="toggleTenantAutoReply('${safeUsername}')" class="min-h-9 px-2.5 py-1 rounded-lg ${isAutoReply ? 'bg-purple-500/15 text-purple-300 border-purple-500/30' : 'bg-slate-800 text-slate-400 border-slate-700'} border text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1">
                        <i class="fa-solid fa-robot"></i> AI ${isAutoReply ? 'ON' : 'OFF'}
                    </button>
                    <span class="px-2 py-1 rounded-md text-[10px] font-mono ${hasPaytm ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30' : 'bg-slate-800 text-slate-500'}">
                        ${hasPaytm ? 'UPI Ready' : 'No UPI'}
                    </span>
                </div>

                <div class="grid grid-cols-4 gap-1.5 pt-1">
                    <a href="/storefront.html?slug=${encodeURIComponent(safeSlug)}" target="_blank" class="min-h-11 px-2 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 text-[11px] font-bold transition flex items-center justify-center gap-1">
                        <i class="fa-solid fa-store"></i> <span>Store</span>
                    </a>
                    <button type="button" onclick="openEditTenantModal('${safeUsername}')" class="min-h-11 px-2 py-2 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-pen-to-square"></i> <span>Edit</span>
                    </button>
                    <button type="button" onclick="openPaytmModal('${safeUsername}', '${displayName}')" class="min-h-11 px-2 py-2 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 transition cursor-pointer">
                        <i class="fa-solid fa-qrcode"></i> <span>UPI</span>
                    </button>
                    <button type="button" onclick="promptDeleteTenantAccount('${safeUsername}')" class="min-h-11 px-2 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 text-[11px] font-bold transition flex items-center justify-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
    }

    // 2. Desktop Table View (md: and up)
    if (tbody) {
        tbody.innerHTML = filtered.map(u => {
            const isAuto = u.automation_access ?? u.is_automated ?? true;
            const isAutoReply = u.auto_reply !== false;
            const safeUsername = escapeHtml(u.username);
            const safeSlug = escapeHtml(u.store_slug || u.username);
            const displayName = escapeHtml(u.business_name || u.account_name || u.full_name || u.username);
            const hasPaytm = Boolean(u.paytm_vpa);
            const isOpen = u.store_open_status !== false;

            const autoBadge = `
                <div class="flex flex-col gap-1.5">
                    <button type="button" onclick="toggleAutomation('${safeUsername}')" class="min-h-9 px-2.5 py-1 rounded-lg ${isAuto ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-700'} border text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1.5 w-max">
                        <i class="fa-solid ${isAuto ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${isAuto ? 'Access Active' : 'Suspended'}
                    </button>
                    <button type="button" onclick="toggleTenantAutoReply('${safeUsername}')" class="min-h-8 px-2.5 py-0.5 rounded-lg ${isAutoReply ? 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border-purple-500/25' : 'bg-slate-900 text-slate-500 border-slate-800'} border text-[10px] font-mono font-bold transition cursor-pointer inline-flex items-center gap-1 w-max">
                        <i class="fa-solid fa-robot text-[9px]"></i> AI Bot: ${isAutoReply ? 'ON' : 'OFF'}
                    </button>
                </div>`;

            const isWaConnected = u.status === 'Connected' || Boolean(u.wa_jid);
            const waBadge = isWaConnected
                ? `<div class="space-y-1">
                       <span class="px-2.5 py-1 rounded-md bg-teal-500/10 text-teal-300 border border-teal-500/30 text-[10px] font-mono font-bold flex items-center gap-1.5 w-max"><span class="w-1.5 h-1.5 rounded-full bg-teal-400"></span> Connected</span>
                       ${u.wa_jid ? `<div class="text-[10px] font-mono text-slate-400">+${escapeHtml(String(u.wa_jid).replace(/@.*$/, ''))}</div>` : ''}
                   </div>`
                : `<span class="px-2.5 py-1 rounded-md bg-slate-800 text-slate-500 text-[10px] font-mono font-bold flex items-center gap-1.5 w-max"><span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span> Disconnected</span>`;

            const typeLabel = getCategoryBadgeLabel(u.user_type || u.business_type);

            return `
                <tr class="hover:bg-slate-800/40 transition group">
                    <td class="p-3.5">
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="toggleStoreOpenStatus('${safeUsername}', ${!isOpen})" class="cursor-pointer" title="Click to toggle store open/closed">
                                <span class="w-2.5 h-2.5 rounded-full ${isOpen ? 'bg-emerald-400' : 'bg-rose-400'} inline-block"></span>
                            </button>
                            <div class="font-black text-white text-xs">${displayName}</div>
                            <span class="text-[10px] font-mono px-1.5 py-0.2 rounded ${isOpen ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
                                ${isOpen ? 'OPEN' : 'CLOSED'}
                            </span>
                        </div>
                        <div class="text-[11px] font-mono text-indigo-400 mt-0.5">@${safeUsername} • <span class="text-slate-400">${safeSlug}</span></div>
                        ${u.email ? `<div class="text-[11px] text-slate-500">${escapeHtml(u.email)}</div>` : ''}
                        ${u.phone ? `<div class="text-[10px] font-mono text-slate-400">+${escapeHtml(String(u.phone).replace(/^\+/, ''))}</div>` : ''}
                    </td>
                    <td class="p-3.5">
                        <span class="px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 text-[10px] font-mono font-bold uppercase border border-slate-700 block w-max">
                            ${typeLabel}
                        </span>
                        <span class="text-[10px] font-mono text-slate-500 mt-1 block">${Number(u.max_delivery_radius_km || 15)} km zone</span>
                    </td>
                    <td class="p-3.5 font-mono">
                        <div class="text-xs font-black text-emerald-400">${formatINR(u.revenue_total || 0)} <span class="text-[10px] font-normal text-slate-400">GMV</span></div>
                        <div class="text-[11px] text-slate-300 mt-0.5">${Number(u.orders_count || 0)} Orders</div>
                        <div class="text-[10px] text-indigo-300">${Number(u.products_count || 0)} Catalog SKUs</div>
                    </td>
                    <td class="p-3.5">${waBadge}</td>
                    <td class="p-3.5">${autoBadge}</td>
                    <td class="p-3.5">
                        <button type="button" onclick="openPaytmModal('${safeUsername}', '${displayName}')" class="min-h-10 px-3 py-1.5 ${hasPaytm ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border-blue-500/30'} border rounded-xl text-xs font-bold flex items-center gap-1.5 transition cursor-pointer">
                            <i class="fa-solid fa-qrcode"></i>
                            <span>${hasPaytm ? escapeHtml(u.paytm_vpa) : 'Setup UPI QR'}</span>
                        </button>
                    </td>
                    <td class="p-3.5 text-right">
                        <div class="flex items-center justify-end gap-1.5">
                            <a href="/storefront.html?slug=${encodeURIComponent(safeSlug)}" target="_blank" title="View Live Storefront" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition flex items-center gap-1">
                                <i class="fa-solid fa-store text-indigo-400 text-[11px]"></i>
                            </a>
                            <button type="button" onclick="window.switchAdminTab('whatsapp'); setTimeout(() => { if (window.switchAdminWaTargetNode) window.switchAdminWaTargetNode('${safeUsername}'); }, 80);" title="Manage Business WhatsApp Node" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 border border-teal-500/30 text-xs font-bold transition flex items-center gap-1 cursor-pointer">
                                <i class="fa-brands fa-whatsapp text-[12px]"></i>
                            </button>
                            <button type="button" onclick="window.switchAdminTab('ai'); setTimeout(() => { if (window.loadAdminTargetAISettings) window.loadAdminTargetAISettings('${safeUsername}'); }, 80);" title="Configure Business AI Responder" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 text-xs font-bold transition flex items-center gap-1 cursor-pointer">
                                <i class="fa-solid fa-robot text-[11px]"></i>
                            </button>
                            <button type="button" onclick="openEditTenantModal('${safeUsername}')" title="Edit Business Store & Credentials" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 text-xs font-bold transition flex items-center justify-center cursor-pointer">
                                <i class="fa-solid fa-pen-to-square"></i>
                            </button>
                            <button type="button" onclick="promptDeleteTenantAccount('${safeUsername}')" title="Delete Business Store" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-bold transition flex items-center justify-center cursor-pointer">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }
}

async function toggleStoreOpenStatus(username, newStatus) {
    try {
        const res = await fetch('/api/admin/update-user', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ username, store_open_status: Boolean(newStatus) })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast(`Store @${username} is now ${newStatus ? 'OPEN' : 'CLOSED'}`);
            loadAdminDashboard();
        } else {
            showToast(data.message || 'Failed to update store status', false);
        }
    } catch (e) {
        showToast('Network error updating store status', false);
    }
}

async function toggleAutomation(username) {
    try {
        const res = await fetch('/api/admin/toggle-automation', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(data.message || `Automation access for @${username} updated!`);
            loadAdminDashboard();
        } else {
            showToast(data.message || 'Failed to toggle automation', false);
        }
    } catch (err) {
        showToast('Network error toggling automation', false);
    }
}

async function toggleTenantAutoReply(username) {
    try {
        const res = await fetch('/api/admin/toggle-auto-reply', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(data.message || `AI Auto-Reply for @${username} updated!`);
            loadAdminDashboard();
        } else {
            showToast(data.message || 'Failed to toggle AI Auto-Reply', false);
        }
    } catch (err) {
        showToast('Network error toggling AI Auto-Reply', false);
    }
}

function openEditTenantModal(username) {
    const u = window._allTenants.find(item => item.username === username);
    if (!u) return;

    document.getElementById('edit-tenant-username').value = u.username;
    document.getElementById('edit-tenant-handle-display').innerText = `@${u.username}`;
    document.getElementById('edit-tenant-name').value = u.account_name || u.full_name || u.username;
    document.getElementById('edit-tenant-email').value = u.email || '';
    document.getElementById('edit-tenant-phone').value = u.phone || '';
    document.getElementById('edit-tenant-slug').value = u.store_slug || u.username;
    document.getElementById('edit-tenant-type').value = u.user_type || 'business_user';
    document.getElementById('edit-tenant-radius').value = u.max_delivery_radius_km || 15;
    document.getElementById('edit-tenant-password').value = '';
    document.getElementById('edit-tenant-store-open').checked = u.store_open_status !== false;
    document.getElementById('edit-tenant-auto-access').checked = Boolean(u.automation_access);
    document.getElementById('edit-tenant-auto-reply').checked = u.auto_reply !== false;

    document.getElementById('modal-edit-tenant').classList.remove('hidden');
}

function closeEditTenantModal() {
    const m = document.getElementById('modal-edit-tenant');
    if (m) m.classList.add('hidden');
}

async function submitEditTenant() {
    const username = document.getElementById('edit-tenant-username').value.trim();
    const account_name = document.getElementById('edit-tenant-name').value.trim();
    const email = document.getElementById('edit-tenant-email').value.trim();
    const phone = document.getElementById('edit-tenant-phone').value.trim();
    const store_slug = document.getElementById('edit-tenant-slug').value.trim();
    const user_type = document.getElementById('edit-tenant-type').value;
    const max_delivery_radius_km = parseFloat(document.getElementById('edit-tenant-radius').value) || 15;
    const new_password = document.getElementById('edit-tenant-password').value.trim();
    const store_open_status = document.getElementById('edit-tenant-store-open').checked;
    const automation_access = document.getElementById('edit-tenant-auto-access').checked;
    const auto_reply = document.getElementById('edit-tenant-auto-reply').checked;

    try {
        const res = await fetch('/api/admin/update-user', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                username,
                account_name,
                email,
                phone,
                store_slug,
                user_type,
                max_delivery_radius_km,
                new_password,
                store_open_status,
                automation_access,
                auto_reply
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast(data.message || `Tenant @${username} updated!`);
            closeEditTenantModal();
            loadAdminDashboard();
        } else {
            showToast(data.message || 'Failed to update tenant', false);
        }
    } catch (e) {
        showToast('Network error updating tenant', false);
    }
}

function exportTenantsCSV() {
    const list = window._allTenants || [];
    if (list.length === 0) {
        showToast('No tenants available to export', false);
        return;
    }
    const headers = ['ID', 'Username', 'Store_Slug', 'Business_Name', 'Email', 'Phone', 'Type', 'WA_Status', 'Products', 'Orders', 'Revenue_INR', 'Paytm_VPA'];
    const rows = list.map(u => [
        u.id || '',
        `"${(u.username || '').replace(/"/g, '""')}"`,
        `"${(u.store_slug || u.username || '').replace(/"/g, '""')}"`,
        `"${(u.account_name || '').replace(/"/g, '""')}"`,
        `"${(u.email || '').replace(/"/g, '""')}"`,
        `"${(u.phone || '').replace(/"/g, '""')}"`,
        u.user_type || 'business_user',
        u.status || 'Disconnected',
        u.products_count || 0,
        u.orders_count || 0,
        u.revenue_total || 0,
        `"${(u.paytm_vpa || '').replace(/"/g, '""')}"`
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wamart_tenants_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Tenants directory exported to CSV!');
}

function promptDeleteTenantAccount(username) {
    if (!username) return;
    pendingDeleteTenantUsername = username;
    const modal = document.getElementById('modal-confirm-delete-tenant');
    const label = document.getElementById('delete-tenant-username-label');
    if (label) label.innerText = `@${username}`;
    if (modal) modal.classList.remove('hidden');
}

function closeDeleteTenantModal() {
    pendingDeleteTenantUsername = "";
    const modal = document.getElementById('modal-confirm-delete-tenant');
    if (modal) modal.classList.add('hidden');
}

async function deleteTenantAccount(usernameArg) {
    const username = usernameArg || pendingDeleteTenantUsername;
    if (!username) return;
    closeDeleteTenantModal();

    try {
        const res = await fetch(`/api/admin/delete-user?username=${encodeURIComponent(username)}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (res.ok && (data.status === 'success' || data.success)) {
            showToast(`Tenant account @${username} and all store data deleted`);
            loadAdminDashboard();
        } else {
            showToast(data.message || data.error || 'Failed to delete tenant', false);
        }
    } catch (err) {
        showToast('Network error deleting tenant', false);
    }
}

function openCreateUserModal() {
    const m = document.getElementById('modal-create-user');
    if (m) m.classList.remove('hidden');
}
function closeCreateUserModal() {
    const m = document.getElementById('modal-create-user');
    if (m) m.classList.add('hidden');
}

async function submitCreateUser() {
    const accountName = document.getElementById('new-account-name').value.trim();
    const email = document.getElementById('new-email').value.trim();
    const phone = document.getElementById('new-phone')?.value.trim() || '';
    const password = document.getElementById('new-password').value.trim();
    const userType = document.getElementById('new-user-type').value;
    const storeSlug = document.getElementById('new-store-slug')?.value.trim() || '';
    const deliveryRadius = parseFloat(document.getElementById('new-delivery-radius')?.value) || 15;
    const autoAccess = document.getElementById('new-automation-access').checked;

    if (!accountName || !email || !password) {
        showToast('Please fill out all required fields.', false);
        return;
    }

    try {
        const res = await fetch('/api/admin/create-user', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                account_name: accountName,
                business_name: accountName,
                email,
                phone,
                password,
                user_type: userType,
                store_slug: storeSlug,
                max_delivery_radius_km: deliveryRadius,
                automation_access: autoAccess
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast(data.message || `Business store ${accountName} provisioned successfully!`);
            closeCreateUserModal();
            loadAdminDashboard();
        } else {
            showToast(data.message || data.error || 'Failed to create business store', false);
        }
    } catch (err) {
        showToast('Network error creating business store', false);
    }
}

async function openPaytmModal(username, payeeName) {
    document.getElementById('paytm-tenant-username').value = username;
    document.getElementById('paytm-modal-tenant').innerText = `@${username}`;
    document.getElementById('paytm-payee-name').value = payeeName || username;
    document.getElementById('paytm-enabled').checked = false;
    document.getElementById('paytm-merchant-vpa').value = '';
    document.getElementById('paytm-merchant-mid').value = '';

    try {
        const res = await fetch(`/api/payment/config?tenant_id=${encodeURIComponent(username)}`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            document.getElementById('paytm-enabled').checked = Boolean(data.enabled);
            document.getElementById('paytm-merchant-vpa').value = data.merchant_vpa || '';
            document.getElementById('paytm-merchant-mid').value = data.paytm_mid || '';
            if (data.payee_name) document.getElementById('paytm-payee-name').value = data.payee_name;
        }
    } catch (e) {}

    document.getElementById('modal-paytm-config').classList.remove('hidden');
}

function closePaytmModal() { document.getElementById('modal-paytm-config').classList.add('hidden'); }

async function submitPaytmConfig() {
    const username = document.getElementById('paytm-tenant-username').value;
    const enabled = document.getElementById('paytm-enabled').checked;
    const vpa = document.getElementById('paytm-merchant-vpa').value.trim();
    const mid = document.getElementById('paytm-merchant-mid').value.trim();
    const payeeName = document.getElementById('paytm-payee-name').value.trim();

    try {
        const res = await fetch('/api/payment/config', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ tenant_id: username, username, enabled, merchant_vpa: vpa, paytm_mid: mid, payee_name: payeeName || username })
        });
        if (res.ok) {
            showToast('Paytm QR configuration saved successfully!');
            closePaytmModal();
            loadAdminDashboard();
        } else {
            showToast('Failed to save Paytm configuration', false);
        }
    } catch (err) {
        showToast('Network error saving Paytm config', false);
    }
}

export function getTenantsHubHTML() {
    return `        <section id="sec-tenants" class="space-y-6">

            <!-- 1. EXECUTIVE HERO BANNER -->
            <div class="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/95 to-indigo-950/40 border border-slate-800/90 p-5 sm:p-6 shadow-xl">
                <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div class="space-y-1.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase tracking-wider bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                                MULTI-TENANT BUSINESS CONTROL PLANE
                            </span>
                            <span class="px-2.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                Zero-Fee UPI QR • Multi-Node WhatsApp Gateways
                            </span>
                        </div>
                        <h2 class="text-xl sm:text-2xl font-black text-white tracking-tight">Enterprise Business Management & Store Control Plane</h2>
                        <p class="text-xs sm:text-sm text-slate-400 max-w-2xl">
                            Centrally provision and configure merchant stores, audit real-time GMV and catalog SKUs health, customize Paytm zero-fee UPI QR gateways, and manage WhatsApp AI bot nodes.
                        </p>
                    </div>

                    <div class="flex flex-wrap items-center gap-2.5 shrink-0">
                        <button type="button" onclick="exportTenantsCSV()" class="min-h-11 px-3.5 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl text-xs font-bold flex items-center gap-1.5 transition cursor-pointer">
                            <i class="fa-solid fa-file-csv text-emerald-400"></i>
                            <span>Export CSV</span>
                        </button>
                        <button type="button" onclick="loadAdminDashboard()" class="min-h-11 px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl transition cursor-pointer text-xs font-bold flex items-center gap-1.5">
                            <i class="fa-solid fa-rotate-right text-indigo-400" id="btn-refresh-icon"></i>
                            <span>Sync DB</span>
                        </button>
                        <button type="button" onclick="openCreateUserModal()" class="min-h-11 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-black rounded-xl text-xs flex items-center gap-2 transition cursor-pointer shadow-lg shadow-indigo-600/25">
                            <i class="fa-solid fa-store"></i>
                            <span>+ Add Business Store</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- 2. ENTERPRISE KPI SUMMARY GRID (1 -> 2 -> 4 Columns) -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div class="glass-card rounded-2xl p-5 shadow-lg border border-slate-800/90 flex items-start justify-between">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Registered Businesses</span>
                        <div class="mt-2 text-2xl sm:text-3xl font-black text-white font-mono" id="stat-total-users">
                            <div class="h-8 w-16 bg-slate-800 rounded animate-pulse"></div>
                        </div>
                        <p class="text-[11px] text-indigo-400 font-mono mt-1"><span id="stat-active-stores" class="text-emerald-400 font-bold">0</span> open & accepting orders</p>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
                        <i class="fa-solid fa-store text-base"></i>
                    </div>
                </div>

                <div class="glass-card rounded-2xl p-5 shadow-lg border border-slate-800/90 flex items-start justify-between">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Platform Gross GMV</span>
                        <div class="mt-2 text-2xl sm:text-3xl font-black text-emerald-400 font-mono" id="stat-total-gmv">
                            <div class="h-8 w-24 bg-slate-800 rounded animate-pulse"></div>
                        </div>
                        <p class="text-[11px] text-slate-400 font-mono mt-1"><span id="stat-total-orders" class="text-white font-bold">0</span> store orders fulfilled</p>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                        <i class="fa-solid fa-indian-rupee-sign text-base"></i>
                    </div>
                </div>

                <div class="glass-card rounded-2xl p-5 shadow-lg border border-slate-800/90 flex items-start justify-between">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Connected WA Nodes</span>
                        <div class="mt-2 text-2xl sm:text-3xl font-black text-teal-400 font-mono" id="stat-connected-wa">
                            <div class="h-8 w-14 bg-slate-800 rounded animate-pulse"></div>
                        </div>
                        <p class="text-[11px] text-slate-400 font-mono mt-1"><span id="stat-active-automations" class="text-emerald-400 font-bold">0</span> business bots active</p>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400 flex items-center justify-center">
                        <i class="fa-brands fa-whatsapp text-lg"></i>
                    </div>
                </div>

                <div class="glass-card rounded-2xl p-5 shadow-lg border border-slate-800/90 flex items-start justify-between">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Catalog SKUs Inventory</span>
                        <div class="mt-2 text-2xl sm:text-3xl font-black text-purple-400 font-mono" id="stat-total-products">
                            <div class="h-8 w-16 bg-slate-800 rounded animate-pulse"></div>
                        </div>
                        <p class="text-[11px] text-slate-400 font-mono mt-1">Total products listed across stores</p>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center">
                        <i class="fa-solid fa-boxes-stacked text-base"></i>
                    </div>
                </div>
            </div>

            <!-- 3. PLATFORM VISUAL ANALYTICS & TOP TENANTS LEADERBOARD -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg:col-span-2 rounded-2xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-xl flex flex-col justify-between">
                    <div class="flex items-center justify-between pb-3 border-b border-slate-800/80">
                        <div>
                            <h3 class="text-sm font-black text-white">Platform GMV Velocity (Last 7 Days)</h3>
                            <p class="text-xs text-slate-400">Aggregated daily order volume across all business storefronts & WhatsApp bots</p>
                        </div>
                        <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/25">LIVE POSTGRESQL</span>
                    </div>
                    <div class="relative mt-4 h-56 w-full">
                        <div id="admin-gmv-chart-skeleton" class="absolute inset-0 rounded-xl bg-slate-950/50 animate-pulse"></div>
                        <canvas id="adminGmvTrendChart"></canvas>
                    </div>
                </div>

                <div class="rounded-2xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-xl flex flex-col justify-between space-y-4">
                    <div class="flex items-center justify-between pb-3 border-b border-slate-800/80">
                        <div>
                            <h3 class="text-sm font-black text-white">Top Performing Stores</h3>
                            <p class="text-xs text-slate-400">Ranked by total GMV, orders & SKUs</p>
                        </div>
                        <button type="button" onclick="switchAdminTab('orders')" class="text-xs font-bold text-indigo-400 hover:text-indigo-300 cursor-pointer">
                            All Store Orders →
                        </button>
                    </div>
                    <div id="admin-top-tenants-list" class="space-y-2.5 flex-1">
                        <div class="h-14 rounded-xl bg-slate-800/70 animate-pulse"></div>
                        <div class="h-14 rounded-xl bg-slate-800/70 animate-pulse"></div>
                        <div class="h-14 rounded-xl bg-slate-800/70 animate-pulse"></div>
                    </div>
                </div>
            </div>

            <!-- 4. BUSINESS STORE DIRECTORY SEARCH & FILTER BAR -->
            <div class="flex flex-col lg:flex-row gap-3 items-stretch lg:items-center justify-between bg-slate-900/90 p-4 rounded-2xl border border-slate-800">
                <div class="relative flex-1">
                    <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                    <input type="text" id="tenant-search-input" oninput="filterTenants()" placeholder="Search store by business name, @slug, email, or phone..." class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500 font-medium">
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <select id="tenant-type-filter" onchange="filterTenants()" class="min-h-11 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 font-semibold outline-none focus:border-indigo-500">
                        <option value="">All Store Categories</option>
                        <option value="kirana">Kirana & Supermarkets</option>
                        <option value="restaurant">Restaurants & Cafes</option>
                        <option value="library_owner">Study Libraries & Coaching</option>
                        <option value="pharmacy">Pharmacies & Health</option>
                        <option value="fashion">Fashion & Lifestyle</option>
                        <option value="electronics">Electronics & Gadgets</option>
                        <option value="business_user">General Retail / E-Commerce</option>
                    </select>

                    <select id="tenant-wa-filter" onchange="filterTenants()" class="min-h-11 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 font-semibold outline-none focus:border-indigo-500">
                        <option value="">All WhatsApp States</option>
                        <option value="connected">WA Connected</option>
                        <option value="disconnected">WA Disconnected</option>
                    </select>

                    <select id="tenant-open-filter" onchange="filterTenants()" class="min-h-11 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 font-semibold outline-none focus:border-indigo-500">
                        <option value="">All Operational States</option>
                        <option value="open">Open Stores Only</option>
                        <option value="closed">Closed Stores Only</option>
                    </select>

                    <div class="text-xs text-slate-400 font-medium px-2 font-mono whitespace-nowrap">
                        <span class="text-white font-bold" id="tenant-count-display">0</span> stores
                    </div>
                </div>
            </div>

            <!-- 5. TENANTS DIRECTORY (Mobile Cards + Desktop Table) -->
            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
                <!-- Mobile Card List (< 768px) -->
                <div id="tenants-mobile-cards" class="md:hidden divide-y divide-slate-800/80">
                    <div class="p-4 space-y-3 animate-pulse">
                        <div class="h-4 w-36 bg-slate-800 rounded"></div>
                        <div class="h-3 w-24 bg-slate-800/70 rounded"></div>
                        <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
                    </div>
                </div>

                <!-- Desktop Table (md: and up) -->
                <div class="hidden md:block overflow-x-auto">
                    <table class="w-full text-left text-xs border-collapse">
                        <thead>
                            <tr class="bg-slate-950/90 border-b border-slate-800 text-[10px] uppercase text-slate-400 font-mono tracking-wider">
                                <th class="p-3.5">Business Store & Contact</th>
                                <th class="p-3.5">Category & Zone</th>
                                <th class="p-3.5">Store Financials & SKUs</th>
                                <th class="p-3.5">WhatsApp Gateway</th>
                                <th class="p-3.5">AI & Platform Access</th>
                                <th class="p-3.5">Paytm UPI QR</th>
                                <th class="p-3.5 text-right">Business Actions</th>
                            </tr>
                        </thead>
                        <tbody id="tenants-table-body" class="divide-y divide-slate-800/80">
                            <tr class="animate-pulse">
                                <td class="p-4"><div class="h-4 w-32 bg-slate-800 rounded mb-1"></div><div class="h-3 w-20 bg-slate-800/70 rounded"></div></td>
                                <td class="p-4"><div class="h-5 w-24 bg-slate-800 rounded"></div></td>
                                <td class="p-4"><div class="h-5 w-24 bg-slate-800 rounded"></div></td>
                                <td class="p-4"><div class="h-5 w-24 bg-slate-800 rounded"></div></td>
                                <td class="p-4"><div class="h-8 w-24 bg-slate-800 rounded-lg"></div></td>
                                <td class="p-4"><div class="h-8 w-32 bg-slate-800 rounded-lg"></div></td>
                                <td class="p-4 text-right"><div class="h-8 w-36 bg-slate-800 rounded-lg ml-auto"></div></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </section>

    <!-- EDIT BUSINESS STORE & PASSWORD RESET MODAL -->
    <div id="modal-edit-tenant" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div class="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                <div class="flex items-center gap-2.5">
                    <div class="w-9 h-9 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center text-sm border border-indigo-500/30">
                        <i class="fa-solid fa-store"></i>
                    </div>
                    <div>
                        <h3 class="text-sm font-black text-white">Edit Business Store Profile & Credentials</h3>
                        <p id="edit-tenant-handle-display" class="text-[11px] font-mono text-indigo-400">@store</p>
                    </div>
                </div>
                <button type="button" onclick="closeEditTenantModal()" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl cursor-pointer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <form onsubmit="event.preventDefault(); submitEditTenant();" class="space-y-3.5">
                <input type="hidden" id="edit-tenant-username" value="">

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Business / Store Name *</label>
                        <input type="text" id="edit-tenant-name" required class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white outline-none focus:border-indigo-500 font-medium">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Store URL Slug *</label>
                        <input type="text" id="edit-tenant-slug" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-emerald-400 outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Owner Email Address</label>
                        <input type="email" id="edit-tenant-email" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Owner WhatsApp Phone</label>
                        <input type="text" id="edit-tenant-phone" placeholder="e.g. 919876543210" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-white outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Business Category</label>
                        <select id="edit-tenant-type" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white outline-none focus:border-indigo-500 font-semibold">
                            <option value="kirana">Kirana & Supermarket</option>
                            <option value="restaurant">Restaurant & Cloud Kitchen</option>
                            <option value="library_owner">Study Library & Coaching</option>
                            <option value="pharmacy">Pharmacy & Health</option>
                            <option value="fashion">Fashion & Lifestyle</option>
                            <option value="electronics">Electronics & Gadgets</option>
                            <option value="business_user">General Retail / E-Commerce</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Delivery Radius (KM)</label>
                        <input type="number" step="0.5" id="edit-tenant-radius" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-white outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div>
                    <label class="block text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-1">Reset Owner Password (Optional — leave blank to keep current)</label>
                    <input type="password" id="edit-tenant-password" placeholder="Enter new password to reset store login..." class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white outline-none focus:border-amber-500">
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                    <label class="flex items-center justify-between p-2.5 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer">
                        <span class="text-[11px] font-bold text-slate-300">Store Open</span>
                        <input type="checkbox" id="edit-tenant-store-open" class="w-4 h-4 accent-emerald-500">
                    </label>
                    <label class="flex items-center justify-between p-2.5 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer">
                        <span class="text-[11px] font-bold text-slate-300">Portal Access</span>
                        <input type="checkbox" id="edit-tenant-auto-access" class="w-4 h-4 accent-indigo-500">
                    </label>
                    <label class="flex items-center justify-between p-2.5 bg-slate-950 rounded-xl border border-slate-800 cursor-pointer">
                        <span class="text-[11px] font-bold text-slate-300">AI Auto-Reply</span>
                        <input type="checkbox" id="edit-tenant-auto-reply" class="w-4 h-4 accent-purple-500">
                    </label>
                </div>

                <div class="pt-2 flex items-center justify-end gap-2">
                    <button type="button" onclick="closeEditTenantModal()" class="min-h-11 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs cursor-pointer">
                        Cancel
                    </button>
                    <button type="submit" class="min-h-11 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-black rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-indigo-600/25">
                        <i class="fa-solid fa-floppy-disk"></i>
                        <span>Save Changes</span>
                    </button>
                </div>
            </form>
        </div>
    </div>

    <!-- CONFIRM DELETE BUSINESS STORE MODAL -->
    <div id="modal-confirm-delete-tenant" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div class="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <div>
                    <h3 class="text-sm font-black text-white">Delete Business Store?</h3>
                    <p id="delete-tenant-username-label" class="text-xs font-mono text-rose-400">@store</p>
                </div>
            </div>
            <p class="text-xs text-slate-400">This permanently removes the business store account, catalog products, orders, and assets from the platform.</p>
            <div class="flex items-center justify-end gap-2 pt-2">
                <button type="button" onclick="closeDeleteTenantModal()" class="min-h-11 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold cursor-pointer">
                    Cancel
                </button>
                <button type="button" onclick="deleteTenantAccount()" class="min-h-11 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-black cursor-pointer">
                    Confirm Delete
                </button>
            </div>
        </div>
    </div>

    <!-- PROVISION NEW BUSINESS STORE MODAL -->
    <div id="modal-create-user" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div class="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative space-y-4 max-h-[92vh] overflow-y-auto">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                <div class="flex items-center gap-2.5">
                    <div class="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-sm border border-indigo-500/20">
                        <i class="fa-solid fa-store"></i>
                    </div>
                    <div>
                        <h3 class="text-sm font-bold text-white">Provision New Business Store</h3>
                        <p class="text-[11px] text-slate-400">Setup storefront, credentials, category, and radius</p>
                    </div>
                </div>
                <button type="button" onclick="closeCreateUserModal()" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl cursor-pointer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <form id="form-create-user" onsubmit="event.preventDefault(); submitCreateUser();" class="space-y-3.5">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Business / Store Name *</label>
                        <input type="text" id="new-account-name" placeholder="e.g. Laxmi Kirana Store" required class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-indigo-500 font-medium">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Store URL Slug (Handle)</label>
                        <input type="text" id="new-store-slug" placeholder="e.g. laxmi-kirana" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs font-mono text-emerald-400 outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Owner Email (Login ID) *</label>
                        <input type="email" id="new-email" placeholder="owner@kirana.in" required class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-indigo-500 font-medium">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">WhatsApp Phone Number</label>
                        <input type="text" id="new-phone" placeholder="919876543210" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs font-mono text-white outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Password *</label>
                        <input type="password" id="new-password" placeholder="Minimum 6 characters" minlength="6" required class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-indigo-500 font-medium">
                    </div>
                    <div>
                        <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Delivery Radius (KM)</label>
                        <input type="number" step="0.5" id="new-delivery-radius" value="15" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs font-mono text-white outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div>
                    <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Business Category *</label>
                    <select id="new-user-type" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-indigo-500 font-semibold">
                        <option value="kirana">Kirana, Grocery & Supermarket</option>
                        <option value="restaurant">Restaurant, Cloud Kitchen & Cafe</option>
                        <option value="library_owner">Study Library & Coaching Center</option>
                        <option value="pharmacy">Pharmacy & Healthcare</option>
                        <option value="fashion">Fashion, Apparel & Boutique</option>
                        <option value="electronics">Electronics & Gadgets</option>
                        <option value="business_user">General Retail / E-Commerce Store</option>
                    </select>
                </div>

                <div class="flex items-center justify-between p-3 bg-slate-950/80 rounded-xl border border-slate-800">
                    <div>
                        <div class="text-xs font-bold text-slate-300">Grant Immediate AI Bot & Platform Access</div>
                        <div class="text-[10px] text-slate-500">Enables automated WhatsApp responder for this store</div>
                    </div>
                    <input type="checkbox" id="new-automation-access" checked class="w-5 h-5 accent-indigo-500 cursor-pointer">
                </div>

                <div class="pt-2 flex items-center justify-end gap-2">
                    <button type="button" onclick="closeCreateUserModal()" class="min-h-11 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs cursor-pointer">
                        Cancel
                    </button>
                    <button type="submit" id="btn-submit-create" class="min-h-11 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-indigo-600/20">
                        <i class="fa-solid fa-check"></i>
                        <span>Provision Business Store</span>
                    </button>
                </div>
            </form>
        </div>
    </div>

    <!-- PAYTM PAYMENT GATEWAY CONFIG MODAL -->
    <div id="modal-paytm-config" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
        <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl relative space-y-4">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center text-xs border border-blue-500/20">
                        <i class="fa-solid fa-credit-card"></i>
                    </div>
                    <div>
                        <h3 class="text-sm font-bold text-white">Configure Paytm QR Gateway</h3>
                        <p class="text-[11px] text-slate-400 font-mono" id="paytm-modal-tenant">@tenant</p>
                    </div>
                </div>
                <button type="button" onclick="closePaytmModal()" class="min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl cursor-pointer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <form id="form-paytm-config" onsubmit="event.preventDefault(); submitPaytmConfig();" class="space-y-3.5">
                <input type="hidden" id="paytm-tenant-username" value="">

                <div class="flex items-center justify-between p-3 bg-slate-950/80 rounded-xl border border-slate-800">
                    <span class="text-xs font-bold text-white">Enable Online Paytm UPI QR</span>
                    <input type="checkbox" id="paytm-enabled" class="w-5 h-5 accent-blue-500 cursor-pointer">
                </div>

                <div>
                    <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Paytm Merchant VPA (UPI ID) *</label>
                    <input type="text" id="paytm-merchant-vpa" placeholder="e.g. paytm.s1f6syj@pty or 9876543210@paytm" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-emerald-400 outline-none focus:border-blue-500">
                </div>

                <div>
                    <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Paytm Merchant ID (MID)</label>
                    <input type="text" id="paytm-merchant-mid" placeholder="e.g. WAMART123456789" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-slate-300 outline-none focus:border-blue-500">
                </div>

                <div>
                    <label class="block text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1">Display Payee Name</label>
                    <input type="text" id="paytm-payee-name" placeholder="e.g. Laxmi Kirana Store" class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white outline-none focus:border-blue-500 font-medium">
                </div>

                <div class="pt-2 flex items-center justify-end gap-2">
                    <button type="button" onclick="closePaytmModal()" class="min-h-11 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs cursor-pointer">
                        Cancel
                    </button>
                    <button type="submit" id="btn-submit-paytm" class="min-h-11 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-blue-600/20">
                        <i class="fa-solid fa-floppy-disk"></i>
                        <span>Save Gateway Config</span>
                    </button>
                </div>
            </form>
        </div>
    </div>`;
}

// ============================================================================
// MODULE 2: ENTERPRISE STORE ORDERS & FULFILLMENT PIPELINE (/api/admin/orders)
// ============================================================================
export function getAdminOrdersMonitorHTML() {
    return `    <section id="sec-admin-orders" class="space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <div>
                <div class="flex items-center gap-2">
                    <span class="px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">FULFILLMENT AUDIT</span>
                    <h2 class="text-xl font-black text-white tracking-tight">Store Orders & Fulfillment Lifecycle Pipeline</h2>
                </div>
                <p class="text-xs text-slate-400 mt-1">Superadmin fulfillment oversight and transaction logs across all merchant stores</p>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 font-mono text-xs">
                    <span class="text-slate-400 mr-2">Total Store Orders:</span>
                    <span id="admin-global-orders-count" class="font-black text-emerald-400">0</span>
                </div>

                <button type="button" onclick="loadAdminGlobalOrders()" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 cursor-pointer flex items-center gap-1.5">
                    <i class="fa-solid fa-rotate" id="admin-orders-refresh-icon"></i>
                    <span>Refresh</span>
                </button>
            </div>
        </div>

        <!-- Filter Bar -->
        <div class="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between bg-slate-900/80 p-4 rounded-2xl border border-slate-800">
            <div class="relative flex-1">
                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                <input type="text" id="admin-global-order-search" oninput="renderAdminGlobalOrdersView()" placeholder="Search by Order ID, business store, or amount..." class="w-full min-h-11 bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500">
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <select id="admin-global-source-filter" onchange="renderAdminGlobalOrdersView()" class="min-h-11 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 font-semibold outline-none focus:border-indigo-500">
                    <option value="">All Order Channels</option>
                    <option value="Web">Web Storefront</option>
                    <option value="WhatsApp">WhatsApp AI Bot</option>
                </select>

                <select id="admin-global-status-filter" onchange="renderAdminGlobalOrdersView()" class="min-h-11 px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 font-semibold outline-none focus:border-indigo-500">
                    <option value="">All Fulfillment Statuses</option>
                    <option value="CONFIRMED">Confirmed (New)</option>
                    <option value="PROCESSING">Processing</option>
                    <option value="DISPATCHED">Dispatched</option>
                    <option value="OUT_FOR_DELIVERY">Out for Delivery</option>
                    <option value="DELIVERED">Delivered</option>
                </select>
            </div>
        </div>

        <!-- Orders View -->
        <div id="admin-global-orders-panel" class="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div id="admin-global-orders-mobile" class="md:hidden divide-y divide-slate-800/80"></div>
            <div class="hidden md:block overflow-x-auto">
                <table class="w-full text-left text-xs border-collapse">
                    <thead>
                        <tr class="bg-slate-950/90 border-b border-slate-800 text-[10px] uppercase text-slate-400 font-mono tracking-wider">
                            <th class="p-3.5">Order ID & Time</th>
                            <th class="p-3.5">Business Store</th>
                            <th class="p-3.5">Buyer Contact</th>
                            <th class="p-3.5">Amount</th>
                            <th class="p-3.5">Source & Payment</th>
                            <th class="p-3.5">Fulfillment Status</th>
                            <th class="p-3.5 text-right">Update Lifecycle</th>
                        </tr>
                    </thead>
                    <tbody id="admin-global-orders-tbody" class="divide-y divide-slate-800/70"></tbody>
                </table>
            </div>
        </div>
    </section>`;
}

export function switchAdminOrderLeadSubtab() {}

export async function loadAdminGlobalOrders() {
    const icon = document.getElementById("admin-orders-refresh-icon");
    if (icon) icon.classList.add("fa-spin");

    try {
        const res = await fetch("/api/admin/orders", { headers: getAuthHeaders() });
        if (res.ok) {
            const data = await res.json();
            globalPlatformOrders = Array.isArray(data.orders) ? data.orders : [];
        }
        renderAdminGlobalOrdersView();
    } catch (e) {
        showToast("Failed to load platform orders", false);
    } finally {
        if (icon) icon.classList.remove("fa-spin");
    }
}

export function renderAdminGlobalOrdersView() {
    const q = (document.getElementById("admin-global-order-search")?.value || "").toLowerCase().trim();
    const src = (document.getElementById("admin-global-source-filter")?.value || "").trim();
    const stFilter = (document.getElementById("admin-global-status-filter")?.value || "").trim().toUpperCase();

    const oCount = document.getElementById("admin-global-orders-count");
    if (oCount) oCount.innerText = String(globalPlatformOrders.length);

    const filteredOrders = globalPlatformOrders.filter(o => {
        const tHandle = String(o.tenant_id || o.username || "").toLowerCase();
        const bName = String(o.business_name || "").toLowerCase();
        const rawSt = String(o.order_status || "CONFIRMED").toUpperCase();
        const matchQ = !q ||
            String(o.order_id || "").toLowerCase().includes(q) ||
            String(o.customer_name || "").toLowerCase().includes(q) ||
            String(o.customer_phone || "").toLowerCase().includes(q) ||
            tHandle.includes(q) ||
            bName.includes(q);
        const matchSrc = !src || o.source === src;
        const matchSt = !stFilter || (stFilter === 'OUT_FOR_DELIVERY' ? (rawSt === 'OUT_FOR_DELIVERY' || rawSt === 'OUT FOR DELIVERY') : rawSt === stFilter);
        return matchQ && matchSrc && matchSt;
    });

    const tbody = document.getElementById("admin-global-orders-tbody");
    const mob = document.getElementById("admin-global-orders-mobile");

    if (filteredOrders.length === 0) {
        const empty = `<div class="p-10 text-center text-xs text-slate-500">No store orders match your filter.</div>`;
        if (mob) mob.innerHTML = empty;
        if (tbody) tbody.innerHTML = `<tr><td colspan="7">${empty}</td></tr>`;
    } else {
        if (mob) {
            mob.innerHTML = filteredOrders.map(o => {
                const tHandle = o.tenant_id || o.username || "admin";
                const bName = o.business_name || tHandle;
                const rawSt = String(o.order_status || "CONFIRMED").toUpperCase();
                return `
                <div class="p-4 space-y-2.5">
                    <div class="flex items-center justify-between">
                        <span class="font-mono font-black text-white text-xs">${escapeHtml(o.order_id)}</span>
                        <span class="font-mono font-black text-emerald-400 text-sm">${formatINR(o.total_amount)}</span>
                    </div>
                    <div class="flex items-center justify-between text-xs">
                        <span class="font-bold text-white">${escapeHtml(bName)} <span class="text-indigo-400 font-mono">(@${escapeHtml(tHandle)})</span></span>
                        <span class="text-slate-400 font-mono text-[11px]">${escapeHtml(o.source)}</span>
                    </div>
                    <div class="text-[11px] text-slate-300">${escapeHtml(o.customer_name || 'Buyer')} <span class="font-mono text-slate-400">(${escapeHtml(o.customer_phone)})</span></div>
                    <div class="flex items-center justify-between text-[11px] pt-1">
                        <span class="text-slate-400">Payment: <span class="font-bold text-white">${escapeHtml(o.payment_status || 'Pending')}</span></span>
                        <span class="font-mono font-bold text-indigo-300">${escapeHtml(o.order_status || 'CONFIRMED')}</span>
                    </div>
                    <select onchange="adminUpdateOrderStatus('${escapeHtml(o.order_id)}', '${escapeHtml(tHandle)}', this.value)" class="w-full min-h-10 px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-xs font-bold text-slate-200 cursor-pointer">
                        <option value="CONFIRMED" ${rawSt === "CONFIRMED" || rawSt === "NEW" ? "selected" : ""}>🆕 Confirmed</option>
                        <option value="PROCESSING" ${rawSt === "PROCESSING" ? "selected" : ""}>👨‍🍳 Processing</option>
                        <option value="DISPATCHED" ${rawSt === "DISPATCHED" ? "selected" : ""}>📦 Dispatched</option>
                        <option value="OUT_FOR_DELIVERY" ${rawSt === "OUT_FOR_DELIVERY" || rawSt === "OUT FOR DELIVERY" ? "selected" : ""}>🛵 Out for Delivery</option>
                        <option value="DELIVERED" ${rawSt === "DELIVERED" ? "selected" : ""}>✅ Delivered</option>
                    </select>
                </div>
            `;
            }).join("");
        }
        if (tbody) {
            tbody.innerHTML = filteredOrders.map(o => {
                const tHandle = o.tenant_id || o.username || "admin";
                const bName = o.business_name || tHandle;
                const rawSt = String(o.order_status || "CONFIRMED").toUpperCase();
                const isPaid = String(o.payment_status || "").toUpperCase() === "PAID";
                const statusColor = rawSt === "DELIVERED"
                    ? "text-emerald-400"
                    : rawSt.includes("OUT")
                    ? "text-purple-300"
                    : rawSt === "DISPATCHED"
                    ? "text-amber-300"
                    : "text-cyan-300";
                return `
                <tr class="hover:bg-slate-800/40 transition">
                    <td class="p-3.5 font-mono">
                        <div class="font-black text-white">${escapeHtml(o.order_id)}</div>
                        <div class="text-[10px] text-slate-500">${escapeHtml(formatLocalDateTime(o.created_at || o.updated_at))}</div>
                    </td>
                    <td class="p-3.5">
                        <div class="font-bold text-white text-xs">${escapeHtml(bName)}</div>
                        <span class="font-mono text-[11px] text-indigo-400">@${escapeHtml(tHandle)}</span>
                    </td>
                    <td class="p-3.5">
                        <div class="font-bold text-white">${escapeHtml(o.customer_name || 'Buyer')}</div>
                        <div class="text-[11px] font-mono text-slate-400">${escapeHtml(o.customer_phone)}</div>
                    </td>
                    <td class="p-3.5 font-mono font-black text-emerald-400 text-sm">${formatINR(o.total_amount)}</td>
                    <td class="p-3.5">
                        <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-200 text-[10px] font-bold">${escapeHtml(o.source)}</span>
                        <span class="ml-1 px-2 py-0.5 rounded ${isPaid ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-300'} text-[10px] font-bold">${escapeHtml(o.payment_status)}</span>
                    </td>
                    <td class="p-3.5 font-mono text-xs font-bold ${statusColor}">${escapeHtml(o.order_status)}</td>
                    <td class="p-3.5 text-right">
                        <select onchange="adminUpdateOrderStatus('${escapeHtml(o.order_id)}', '${escapeHtml(tHandle)}', this.value)" class="min-h-9 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-[11px] font-bold text-slate-200 cursor-pointer">
                            <option value="CONFIRMED" ${rawSt === "CONFIRMED" || rawSt === "NEW" ? "selected" : ""}>🆕 Confirmed</option>
                            <option value="PROCESSING" ${rawSt === "PROCESSING" ? "selected" : ""}>👨‍🍳 Processing</option>
                            <option value="DISPATCHED" ${rawSt === "DISPATCHED" ? "selected" : ""}>📦 Dispatched</option>
                            <option value="OUT_FOR_DELIVERY" ${rawSt === "OUT_FOR_DELIVERY" || rawSt === "OUT FOR DELIVERY" ? "selected" : ""}>🛵 Out for Delivery</option>
                            <option value="DELIVERED" ${rawSt === "DELIVERED" ? "selected" : ""}>✅ Delivered</option>
                        </select>
                    </td>
                </tr>`;
            }).join("");
        }
    }
}

export async function adminUpdateOrderStatus(orderId, tenantId, newStatus = "DISPATCHED") {
    try {
        const res = await fetch("/api/business/orders/status", {
            method: "POST",
            headers: getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ username: tenantId || "admin", order_id: orderId, order_status: newStatus })
        });
        const data = await res.json().catch(() => ({}));
        showToast(data.message || `Order ${orderId} updated to ${newStatus}`);
        loadAdminGlobalOrders();
    } catch (e) {
        showToast("Failed to update order status", false);
    }
}

export async function adminMarkOrderDispatched(orderId, tenantId) {
    return adminUpdateOrderStatus(orderId, tenantId, "DISPATCHED");
}

export function initAdminOrdersMonitor(apiBaseUrl = "") {
    Object.assign(window, {
        switchAdminOrderLeadSubtab,
        loadAdminGlobalOrders,
        renderAdminGlobalOrdersView,
        adminUpdateOrderStatus,
        adminMarkOrderDispatched
    });
    loadAdminGlobalOrders();
}
    Object.assign(window, {
        switchAdminOrderLeadSubtab,
        loadAdminGlobalOrders,
        renderAdminGlobalOrdersView,
        adminUpdateOrderStatus,
        adminMarkOrderDispatched
    });
    loadAdminGlobalOrders();
}

export function initTenantsHub(apiBaseUrl = "") {
    Object.assign(window, {
        loadAdminDashboard,
        filterTenants,
        toggleAutomation,
        toggleTenantAutoReply,
        openEditTenantModal,
        closeEditTenantModal,
        submitEditTenant,
        exportTenantsCSV,
        promptDeleteTenantAccount,
        closeDeleteTenantModal,
        deleteTenantAccount,
        openCreateUserModal,
        closeCreateUserModal,
        submitCreateUser,
        openPaytmModal,
        closePaytmModal,
        submitPaytmConfig,
        toggleStoreOpenStatus
    });
    loadAdminDashboard();
}

export {
    loadAdminDashboard,
    filterTenants,
    toggleAutomation,
    toggleTenantAutoReply,
    toggleStoreOpenStatus,
    openEditTenantModal,
    closeEditTenantModal,
    submitEditTenant,
    exportTenantsCSV,
    promptDeleteTenantAccount,
    closeDeleteTenantModal,
    deleteTenantAccount,
    openCreateUserModal,
    closeCreateUserModal,
    submitCreateUser,
    openPaytmModal,
    closePaytmModal,
    submitPaytmConfig
};
Object.assign(window, {
    loadAdminDashboard,
    filterTenants,
    toggleAutomation,
    toggleTenantAutoReply,
    toggleStoreOpenStatus,
    openEditTenantModal,
    closeEditTenantModal,
    submitEditTenant,
    exportTenantsCSV,
    promptDeleteTenantAccount,
    closeDeleteTenantModal,
    deleteTenantAccount,
    openCreateUserModal,
    closeCreateUserModal,
    submitCreateUser,
    openPaytmModal,
    closePaytmModal,
    submitPaytmConfig
});
