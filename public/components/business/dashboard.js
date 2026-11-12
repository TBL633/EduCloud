// Enterprise-Grade Business Dashboard Component for WaMart Multi-Tenant E-Commerce SaaS
// 100% Real Golang/PostgreSQL API Data Integration | Zero Dummy Data | Mobile-First Responsive UI
import { getActiveUsername, getAuthHeaders, formatLocalDateTime, escapeHtml } from "../shared/auth-guard.js";

let salesTrendChartInstance = null;
let orderSourceChartInstance = null;
let currentOrdersState = [];
let currentDashboardFilter = "ALL";
let currentDashboardStats = null;

function formatINR(amount) {
    const num = Number(amount) || 0;
    return "₹" + num.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function getDashboardHTML() {
    return `
    <div id="view-dashboard" class="max-w-[1440px] mx-auto space-y-6 pb-8">

        <!-- 1. ENTERPRISE HEADER SECTION -->
        <section class="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/95 to-slate-950 border border-slate-800/80 p-4 sm:p-6 shadow-xl">
            <div class="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl"></div>
            <div class="pointer-events-none absolute -bottom-24 -left-24 w-72 h-72 rounded-full bg-indigo-500/10 blur-3xl"></div>

            <div class="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div class="space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            Omnichannel Commerce Engine
                        </span>
                        <span id="dash-hyperlocal-pill" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-slate-800/90 text-slate-300 border border-slate-700/70 font-mono">
                            <i class="fa-solid fa-location-dot text-emerald-400 text-[10px]"></i>
                            <span id="dash-delivery-radius-label">Loading zone...</span>
                        </span>
                    </div>
                    <h1 class="text-xl sm:text-2xl lg:text-3xl font-black text-white tracking-tight flex items-center gap-2.5 flex-wrap">
                        <span>Welcome back, <span id="dash-store-name" class="text-emerald-400">Loading...</span></span>
                        <span class="text-xl sm:text-2xl">🚀</span>
                    </h1>
                    <p class="text-xs sm:text-sm text-slate-400 max-w-2xl">
                        Real-time command center unifying <span class="text-slate-200 font-semibold">WhatsApp AI Bot</span> orders, <span class="text-slate-200 font-semibold">Web Storefront</span> checkouts, instant UPI QR settlements, and hyperlocal inventory.
                    </p>
                </div>

                <!-- Quick Actions & Store Link Bar (Touch-Friendly min-h-11) -->
                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shrink-0">
                    <div class="flex items-center gap-2 bg-slate-950/90 border border-slate-800 rounded-xl px-3.5 py-2 min-h-11">
                        <i class="fa-solid fa-store text-emerald-400 text-xs"></i>
                        <div class="min-w-0">
                            <div class="text-[9px] uppercase tracking-wider font-bold text-slate-500 font-mono">Live Web Storefront</div>
                            <div id="dash-store-url-preview" class="text-xs font-mono text-slate-200 truncate max-w-[190px] sm:max-w-[220px]">/storefront.html</div>
                        </div>
                    </div>

                    <div class="flex items-center gap-2">
                        <button type="button" id="dash-copy-store-link-btn" onclick="copyDashboardStoreLink()" class="flex-1 sm:flex-initial min-h-11 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.99] text-slate-950 font-black text-xs sm:text-sm shadow-lg shadow-emerald-500/20 transition cursor-pointer">
                            <span>🔗</span>
                            <span id="dash-copy-store-link-text">Copy Store Link</span>
                        </button>
                        <button type="button" onclick="openDashboardStorefrontPreview()" title="Open Live Storefront" class="min-h-11 min-w-11 inline-flex items-center justify-center px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition cursor-pointer">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        </button>
                        <button type="button" onclick="refreshBusinessDashboard()" id="dash-refresh-btn" title="Sync Live Data" class="min-h-11 min-w-11 inline-flex items-center justify-center px-3.5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-bold transition cursor-pointer">
                            <i id="dash-refresh-icon" class="fa-solid fa-rotate"></i>
                        </button>
                    </div>
                </div>
            </div>
        </section>

        <!-- 2. TOP KPI SUMMARY CARDS (Responsive 1 -> 2 -> 4 Grid Layout) -->
        <section aria-label="Key Performance Indicators" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">

            <!-- KPI Card 1: Gross Sales (Today) -->
            <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg hover:border-emerald-500/30 transition flex flex-col justify-between">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Gross Sales (Today)</span>
                        <div id="kpi-gross-sales" class="mt-2 text-2xl sm:text-3xl font-black text-white font-mono tracking-tight">
                            <div class="h-8 w-28 rounded-lg bg-slate-800 animate-pulse"></div>
                        </div>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                        <i class="fa-solid fa-indian-rupee-sign text-base"></i>
                    </div>
                </div>
                <div class="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                    <span id="kpi-sales-growth-badge" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 font-mono">
                        <i class="fa-solid fa-arrow-trend-up text-[10px]"></i>
                        <span id="kpi-sales-growth-text">0% from yesterday</span>
                    </span>
                    <span id="kpi-yesterday-sales" class="text-[11px] text-slate-500 font-mono">Yest: ₹0</span>
                </div>
            </div>

            <!-- KPI Card 2: Total Orders (Today) Split by Source -->
            <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg hover:border-indigo-500/30 transition flex flex-col justify-between">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Total Orders (Today)</span>
                        <div class="mt-2 flex items-baseline gap-2">
                            <span id="kpi-total-orders" class="text-2xl sm:text-3xl font-black text-white font-mono tracking-tight">
                                <span class="inline-block h-8 w-16 rounded-lg bg-slate-800 animate-pulse"></span>
                            </span>
                            <span class="text-xs font-semibold text-slate-400">Orders</span>
                        </div>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
                        <i class="fa-solid fa-bag-shopping text-base"></i>
                    </div>
                </div>
                <div class="mt-4 pt-3 border-t border-slate-800/80">
                    <div id="kpi-orders-split-label" class="text-xs font-bold text-slate-200 font-mono mb-2">
                        0 Total: 0 Web, 0 WhatsApp
                    </div>
                    <div class="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden flex">
                        <div id="kpi-orders-web-bar" class="bg-indigo-500 h-full transition-all duration-500" style="width: 50%"></div>
                        <div id="kpi-orders-wa-bar" class="bg-emerald-500 h-full transition-all duration-500" style="width: 50%"></div>
                    </div>
                </div>
            </div>

            <!-- KPI Card 3: Payment Breakdown (UPI/Online vs Pending COD) -->
            <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg hover:border-cyan-500/30 transition flex flex-col justify-between">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Payment Breakdown</span>
                        <div class="mt-2 grid grid-cols-2 gap-2">
                            <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                                <div class="text-[10px] font-semibold text-emerald-400 flex items-center gap-1">
                                    <i class="fa-solid fa-qrcode text-[9px]"></i> UPI / Online
                                </div>
                                <div id="kpi-upi-amount" class="text-sm sm:text-base font-black text-white font-mono mt-0.5">
                                    <div class="h-5 w-16 rounded bg-slate-800 animate-pulse"></div>
                                </div>
                            </div>
                            <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                                <div class="text-[10px] font-semibold text-amber-400 flex items-center gap-1">
                                    <i class="fa-solid fa-truck-Ramp-Box text-[9px]"></i> Pending COD
                                </div>
                                <div id="kpi-cod-amount" class="text-sm sm:text-base font-black text-white font-mono mt-0.5">
                                    <div class="h-5 w-16 rounded bg-slate-800 animate-pulse"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
                        <i class="fa-solid fa-building-columns text-base"></i>
                    </div>
                </div>
                <div class="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                    <span class="text-slate-400">Zero-Fee Paytm / UPI QR</span>
                    <span id="kpi-upi-share" class="font-mono font-bold text-cyan-400">0% Prepaid</span>
                </div>
            </div>

            <!-- KPI Card 4: AI Automation Stats -->
            <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg hover:border-purple-500/30 transition flex flex-col justify-between">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">AI Automation Stats</span>
                        <div class="mt-2 grid grid-cols-2 gap-2">
                            <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                                <div class="text-[10px] font-semibold text-purple-400">Leads Captured</div>
                                <div id="kpi-leads-captured" class="text-base sm:text-lg font-black text-white font-mono mt-0.5">
                                    <div class="h-5 w-12 rounded bg-slate-800 animate-pulse"></div>
                                </div>
                            </div>
                            <div class="bg-slate-950/70 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                                <div class="text-[10px] font-semibold text-emerald-400">Auto-Replied</div>
                                <div id="kpi-messages-replied" class="text-base sm:text-lg font-black text-white font-mono mt-0.5">
                                    <div class="h-5 w-12 rounded bg-slate-800 animate-pulse"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
                        <i class="fa-solid fa-robot text-base"></i>
                    </div>
                </div>
                <div class="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                    <span class="text-slate-400">24/7 WhatsApp AI Agent</span>
                    <button type="button" onclick="switchTab('ai')" class="text-purple-400 hover:text-purple-300 font-bold cursor-pointer">
                        Configure AI →
                    </button>
                </div>
            </div>

        </section>

        <!-- 3. VISUAL ANALYTICS (Charts Section) -->
        <section aria-label="Visual Sales Analytics" class="grid grid-cols-1 lg:grid-cols-3 gap-6">

            <!-- Primary Chart: Sales Trend (Last 7 Days) -->
            <div class="lg:col-span-2 rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg flex flex-col justify-between">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-800/80">
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 class="text-sm sm:text-base font-black text-white">Sales Trend (Last 7 Days)</h3>
                            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE DB</span>
                        </div>
                        <p class="text-xs text-slate-400 mt-0.5">Combined daily gross revenue across Web Storefront & WhatsApp AI Bot</p>
                    </div>
                    <div class="flex items-center gap-4 text-xs font-mono">
                        <div class="flex items-center gap-1.5">
                            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                            <span class="text-slate-300">7-Day Total: <strong id="chart-7d-total" class="text-white">₹0</strong></span>
                        </div>
                    </div>
                </div>

                <div class="relative mt-4 h-64 sm:h-72 w-full">
                    <div id="sales-chart-skeleton" class="absolute inset-0 flex flex-col justify-end gap-2 p-4 bg-slate-950/40 rounded-xl animate-pulse">
                        <div class="flex items-end justify-between gap-3 h-44">
                            <div class="w-full bg-slate-800 rounded-t-lg h-1/3"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-1/2"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-2/5"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-3/4"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-2/3"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-4/5"></div>
                            <div class="w-full bg-slate-800 rounded-t-lg h-full"></div>
                        </div>
                        <div class="h-3 bg-slate-800 rounded w-full"></div>
                    </div>
                    <canvas id="dashSalesTrendChart"></canvas>
                </div>
            </div>

            <!-- Secondary Chart: Order Source: WhatsApp vs Web -->
            <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg flex flex-col justify-between">
                <div class="pb-4 border-b border-slate-800/80">
                    <h3 class="text-sm sm:text-base font-black text-white">Order Source: WhatsApp vs Web</h3>
                    <p class="text-xs text-slate-400 mt-0.5">Omnichannel conversion split (Last 7 Days)</p>
                </div>

                <div class="relative my-auto py-4 flex items-center justify-center h-52">
                    <div id="source-chart-skeleton" class="w-40 h-40 rounded-full border-[16px] border-slate-800 animate-pulse"></div>
                    <canvas id="dashOrderSourceChart" class="hidden"></canvas>
                    <div id="source-chart-center-label" class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <span id="chart-source-total-orders" class="text-xl font-black text-white font-mono">0</span>
                        <span class="text-[10px] uppercase tracking-wider text-slate-400 font-bold">7d Orders</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-2.5 pt-3 border-t border-slate-800/80">
                    <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                        <div class="flex items-center gap-1.5 text-xs font-bold text-indigo-400">
                            <span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                            <span>Web Store</span>
                        </div>
                        <div id="chart-web-breakdown" class="mt-1 text-sm font-black text-white font-mono">0 orders</div>
                        <div id="chart-web-rev" class="text-[11px] text-slate-400 font-mono">₹0</div>
                    </div>
                    <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                        <div class="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                            <span>WhatsApp Bot</span>
                        </div>
                        <div id="chart-wa-breakdown" class="mt-1 text-sm font-black text-white font-mono">0 orders</div>
                        <div id="chart-wa-rev" class="text-[11px] text-slate-400 font-mono">₹0</div>
                    </div>
                </div>
            </div>

        </section>

        <!-- 4. LIVE ORDER PIPELINE + 5. INVENTORY & SYSTEM ALERTS -->
        <section class="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">

            <!-- 4. LIVE ORDER PIPELINE (Recent Orders Table & Mobile Cards - Spans 2 Columns on XL) -->
            <div class="xl:col-span-2 rounded-xl bg-slate-900/90 border border-slate-800/90 shadow-lg overflow-hidden">
                <div class="p-4 sm:p-5 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 class="text-sm sm:text-base font-black text-white">Live Order Pipeline</h3>
                            <span id="dash-orders-count-pill" class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">0 orders</span>
                        </div>
                        <p class="text-xs text-slate-400 mt-0.5">Real-time orders from Web Storefront & WhatsApp conversational checkout</p>
                    </div>

                    <!-- Source Filter Buttons (min-h-11 Touch Targets) -->
                    <div class="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800 self-start sm:self-auto">
                        <button type="button" onclick="filterDashboardOrders('ALL')" id="dash-filter-ALL" class="dash-order-filter min-h-10 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 text-white transition cursor-pointer">
                            All
                        </button>
                        <button type="button" onclick="filterDashboardOrders('Web')" id="dash-filter-Web" class="dash-order-filter min-h-10 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                            <i class="fa-solid fa-globe text-indigo-400 mr-1"></i>Web
                        </button>
                        <button type="button" onclick="filterDashboardOrders('WhatsApp')" id="dash-filter-WhatsApp" class="dash-order-filter min-h-10 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                            <i class="fa-brands fa-whatsapp text-emerald-400 mr-1"></i>WhatsApp
                        </button>
                    </div>
                </div>

                <!-- Mobile Card-Style Order List (< 768px) to Prevent Horizontal Scroll -->
                <div id="dash-recent-orders-mobile" class="md:hidden divide-y divide-slate-800/70">
                    ${getOrdersMobileSkeletonHTML()}
                </div>

                <!-- Desktop & Tablet Data Table (md: and up) -->
                <div class="hidden md:block overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="border-b border-slate-800/80 bg-slate-950/60 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                <th class="py-3.5 px-4">Order ID</th>
                                <th class="py-3.5 px-4">Customer Info</th>
                                <th class="py-3.5 px-4">Amount</th>
                                <th class="py-3.5 px-4">Source</th>
                                <th class="py-3.5 px-4">Payment</th>
                                <th class="py-3.5 px-4">Order Status</th>
                                <th class="py-3.5 px-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="dash-recent-orders-tbody" class="divide-y divide-slate-800/60 text-xs">
                            ${getOrdersTableSkeletonHTML()}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 5. INVENTORY & SYSTEM ALERTS (Side Panel) -->
            <div class="space-y-6">

                <!-- System Status Card -->
                <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-sm font-black text-white uppercase tracking-wider">System Status</h3>
                        <span id="dash-wa-bot-badge" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700 font-mono">
                            <span id="dash-wa-bot-dot" class="w-2 h-2 rounded-full bg-slate-400 animate-pulse"></span>
                            <span id="dash-wa-bot-status-text">Checking...</span>
                        </span>
                    </div>

                    <div class="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5">
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-slate-400 flex items-center gap-2">
                                <i class="fa-brands fa-whatsapp text-emerald-400"></i>
                                WhatsApp AI Responder
                            </span>
                            <span id="dash-sys-wa-jid" class="font-mono font-bold text-slate-200">Checking...</span>
                        </div>
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-slate-400 flex items-center gap-2">
                                <i class="fa-solid fa-qrcode text-cyan-400"></i>
                                Instant UPI QR Gateway
                            </span>
                            <span class="font-mono font-bold text-cyan-400">0% Fee Active</span>
                        </div>
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-slate-400 flex items-center gap-2">
                                <i class="fa-solid fa-truck-fast text-indigo-400"></i>
                                Hyperlocal Delivery Zone
                            </span>
                            <span id="dash-sys-radius" class="font-mono font-bold text-slate-200">-- km</span>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-2.5">
                        <button type="button" onclick="switchTab('connect')" class="min-h-11 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition flex items-center justify-center gap-1.5 cursor-pointer">
                            <i class="fa-solid fa-link text-indigo-400"></i>
                            <span>Device Link</span>
                        </button>
                        <button type="button" onclick="switchTab('store')" class="min-h-11 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition flex items-center justify-center gap-1.5 cursor-pointer">
                            <i class="fa-solid fa-sliders text-emerald-400"></i>
                            <span>Store Rules</span>
                        </button>
                    </div>
                </div>

                <!-- Low Stock Alerts Card -->
                <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg space-y-4">
                    <div class="flex items-center justify-between">
                        <div>
                            <h3 class="text-sm font-black text-white flex items-center gap-2">
                                <i class="fa-solid fa-triangle-exclamation text-amber-400"></i>
                                <span>Low Stock Alerts</span>
                            </h3>
                            <p class="text-[11px] text-slate-400 mt-0.5">Products out of stock or running low in inventory</p>
                        </div>
                        <button type="button" onclick="switchTab('catalog')" class="min-h-10 px-2.5 py-1.5 rounded-lg text-xs font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 cursor-pointer">
                            Manage All →
                        </button>
                    </div>

                    <div id="dash-low-stock-list" class="space-y-2.5">
                        ${getLowStockSkeletonHTML()}
                    </div>
                </div>

                <!-- Recent WhatsApp Inquiries & Leads Feed -->
                <div class="rounded-xl bg-slate-900/90 border border-slate-800/90 p-5 shadow-lg space-y-3">
                    <div class="flex items-center justify-between">
                        <div>
                            <h3 class="text-sm font-black text-white flex items-center gap-2">
                                <i class="fa-solid fa-bolt text-purple-400"></i>
                                <span>Live AI Lead Stream</span>
                            </h3>
                            <p class="text-[11px] text-slate-400 mt-0.5">Latest customer inquiries via WhatsApp</p>
                        </div>
                        <button type="button" onclick="refreshBusinessDashboard()" class="min-h-10 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-slate-300 cursor-pointer">
                            Sync
                        </button>
                    </div>
                    <div id="dash-live-leads-list" class="space-y-2 max-h-56 overflow-y-auto pr-1">
                        <div class="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 animate-pulse space-y-2">
                            <div class="h-3 w-28 bg-slate-800 rounded"></div>
                            <div class="h-2.5 w-44 bg-slate-800 rounded"></div>
                        </div>
                    </div>
                </div>

            </div>

        </section>

        <!-- ORDER DETAILS & FULFILLMENT LIFECYCLE MODAL -->
        <div id="dash-order-detail-modal" class="hidden fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
                <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
                    <div class="flex items-center gap-2.5">
                        <div class="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                            <i class="fa-solid fa-receipt"></i>
                        </div>
                        <div>
                            <h4 id="modal-order-id" class="text-sm font-black text-white font-mono">Order Details</h4>
                            <p id="modal-order-time" class="text-[11px] text-slate-400">Timestamp</p>
                        </div>
                    </div>
                    <button type="button" onclick="closeDashboardOrderModal()" class="min-h-11 min-w-11 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div id="modal-order-body" class="p-5 space-y-4 text-xs overflow-y-auto flex-1"></div>
                <div class="px-5 py-3.5 bg-slate-950/80 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
                    <span class="text-[11px] text-slate-400 flex items-center gap-1.5">
                        <i class="fa-brands fa-whatsapp text-emerald-400"></i>
                        <span>Auto-sends WhatsApp status alert</span>
                    </span>
                    <div class="flex items-center gap-2">
                        <button type="button" onclick="closeDashboardOrderModal()" class="min-h-11 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold cursor-pointer">
                            Close
                        </button>
                        <button type="button" id="modal-dispatch-btn" class="min-h-11 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black cursor-pointer">
                            Next Stage
                        </button>
                    </div>
                </div>
            </div>
        </div>

    </div>`;
}

function getOrdersTableSkeletonHTML() {
    return Array.from({ length: 4 }).map(() => `
        <tr class="animate-pulse">
            <td class="py-4 px-4"><div class="h-4 w-24 bg-slate-800 rounded"></div></td>
            <td class="py-4 px-4"><div class="h-4 w-32 bg-slate-800 rounded mb-1.5"></div><div class="h-3 w-24 bg-slate-800/70 rounded"></div></td>
            <td class="py-4 px-4"><div class="h-4 w-16 bg-slate-800 rounded"></div></td>
            <td class="py-4 px-4"><div class="h-6 w-20 bg-slate-800 rounded-md"></div></td>
            <td class="py-4 px-4"><div class="h-6 w-20 bg-slate-800 rounded-md"></div></td>
            <td class="py-4 px-4"><div class="h-6 w-20 bg-slate-800 rounded-md"></div></td>
            <td class="py-4 px-4 text-right"><div class="h-9 w-28 bg-slate-800 rounded-lg ml-auto"></div></td>
        </tr>
    `).join("");
}

function getOrdersMobileSkeletonHTML() {
    return Array.from({ length: 3 }).map(() => `
        <div class="p-4 space-y-3 animate-pulse">
            <div class="flex items-center justify-between">
                <div class="h-4 w-28 bg-slate-800 rounded"></div>
                <div class="h-5 w-16 bg-slate-800 rounded"></div>
            </div>
            <div class="h-3.5 w-40 bg-slate-800 rounded"></div>
            <div class="flex items-center gap-2">
                <div class="h-6 w-20 bg-slate-800 rounded-md"></div>
                <div class="h-6 w-20 bg-slate-800 rounded-md"></div>
            </div>
            <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
        </div>
    `).join("");
}

function getLowStockSkeletonHTML() {
    return Array.from({ length: 3 }).map(() => `
        <div class="p-3 rounded-xl bg-slate-950/75 border border-slate-800 animate-pulse flex items-center justify-between gap-3">
            <div class="space-y-1.5 flex-1">
                <div class="h-3.5 w-36 bg-slate-800 rounded"></div>
                <div class="h-2.5 w-24 bg-slate-800/80 rounded"></div>
            </div>
            <div class="h-6 w-20 bg-slate-800 rounded-md"></div>
        </div>
    `).join("");
}

function getStorefrontUrl(storeSlug) {
    const slug = encodeURIComponent(storeSlug || getActiveUsername() || "admin");
    return `${window.location.origin}/storefront.html?slug=${slug}`;
}

function renderKPISection(data) {
    const storeProfile = data.store_profile || {};
    const kpis = data.kpis || {};

    const storeNameEl = document.getElementById("dash-store-name");
    if (storeNameEl) storeNameEl.innerText = storeProfile.store_name || getActiveUsername() || "Store";

    const radiusLabelEl = document.getElementById("dash-delivery-radius-label");
    if (radiusLabelEl) {
        radiusLabelEl.innerText = `${storeProfile.delivery_radius_km || 15} km Hyperlocal Zone • Free ≥ ₹${storeProfile.free_delivery_threshold || 499}`;
    }

    const urlPreviewEl = document.getElementById("dash-store-url-preview");
    if (urlPreviewEl) {
        urlPreviewEl.innerText = getStorefrontUrl(storeProfile.store_slug);
    }

    // Card 1: Gross Sales
    const grossSalesEl = document.getElementById("kpi-gross-sales");
    if (grossSalesEl) grossSalesEl.innerText = formatINR(kpis.gross_sales_today || 0);

    const growthPct = Number(kpis.sales_growth_pct || 0);
    const growthTextEl = document.getElementById("kpi-sales-growth-text");
    if (growthTextEl) {
        const sign = growthPct >= 0 ? "+" : "";
        growthTextEl.innerText = `${sign}${growthPct}% from yesterday`;
    }

    const yestSalesEl = document.getElementById("kpi-yesterday-sales");
    if (yestSalesEl) yestSalesEl.innerText = `Yest: ${formatINR(kpis.gross_sales_yesterday || 0)}`;

    // Card 2: Total Orders Split
    const totalOrders = Number(kpis.total_orders_today || 0);
    const webOrders = Number(kpis.web_orders_today || 0);
    const waOrders = Number(kpis.whatsapp_orders_today || 0);

    const totalOrdersEl = document.getElementById("kpi-total-orders");
    if (totalOrdersEl) totalOrdersEl.innerText = String(totalOrders);

    const splitLabelEl = document.getElementById("kpi-orders-split-label");
    if (splitLabelEl) {
        splitLabelEl.innerText = `${totalOrders} Total: ${webOrders} Web, ${waOrders} WhatsApp`;
    }

    const webPct = totalOrders > 0 ? Math.round((webOrders / totalOrders) * 100) : 50;
    const waPct = 100 - webPct;
    const webBar = document.getElementById("kpi-orders-web-bar");
    const waBar = document.getElementById("kpi-orders-wa-bar");
    if (webBar) webBar.style.width = `${webPct}%`;
    if (waBar) waBar.style.width = `${waPct}%`;

    // Card 3: Payment Breakdown
    const upiAmt = Number(kpis.upi_collected_amount || 0);
    const codAmt = Number(kpis.cod_pending_amount || 0);
    const upiEl = document.getElementById("kpi-upi-amount");
    const codEl = document.getElementById("kpi-cod-amount");
    const upiShareEl = document.getElementById("kpi-upi-share");
    if (upiEl) upiEl.innerText = formatINR(upiAmt);
    if (codEl) codEl.innerText = formatINR(codAmt);
    if (upiShareEl) {
        const totalPay = upiAmt + codAmt;
        const share = totalPay > 0 ? Math.round((upiAmt / totalPay) * 100) : 0;
        upiShareEl.innerText = `${share}% Prepaid`;
    }

    // Card 4: AI Automation
    const leadsEl = document.getElementById("kpi-leads-captured");
    const repliedEl = document.getElementById("kpi-messages-replied");
    if (leadsEl) leadsEl.innerText = String(kpis.leads_captured_today ?? 0);
    if (repliedEl) repliedEl.innerText = String(kpis.messages_auto_replied_today ?? 0);

    // System Status Side Card
    const sysJidEl = document.getElementById("dash-sys-wa-jid");
    if (sysJidEl) {
        sysJidEl.innerText = storeProfile.wa_jid
            ? `+${String(storeProfile.wa_jid).replace(/@.*$/, "")}`
            : (storeProfile.wa_connected ? "Active Session" : "Not Linked");
    }
    const sysRadEl = document.getElementById("dash-sys-radius");
    if (sysRadEl) sysRadEl.innerText = `${storeProfile.delivery_radius_km || 15} km Radius`;

    const botBadge = document.getElementById("dash-wa-bot-badge");
    const botStatusText = document.getElementById("dash-wa-bot-status-text");
    const botDot = document.getElementById("dash-wa-bot-dot");
    if (botBadge && botStatusText) {
        if (storeProfile.wa_connected) {
            botBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono";
            botStatusText.innerText = "WhatsApp Bot: Connected & Active";
            if (botDot) botDot.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse";
        } else {
            botBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono";
            botStatusText.innerText = "WhatsApp Bot: Awaiting QR Link";
            if (botDot) botDot.className = "w-2 h-2 rounded-full bg-amber-400 animate-pulse";
        }
    }
}

function renderChartsSection(data) {
    const charts = data.charts || {};
    const labels = Array.isArray(charts.seven_day_labels) ? charts.seven_day_labels : [];
    const salesSeries = Array.isArray(charts.seven_day_sales) ? charts.seven_day_sales : [];
    const split = charts.source_split || { web_orders: 0, whatsapp_orders: 0, web_revenue: 0, whatsapp_revenue: 0 };

    // Remove chart skeletons
    const salesSkel = document.getElementById("sales-chart-skeleton");
    if (salesSkel) salesSkel.classList.add("hidden");
    const sourceSkel = document.getElementById("source-chart-skeleton");
    if (sourceSkel) sourceSkel.classList.add("hidden");
    const sourceCanvas = document.getElementById("dashOrderSourceChart");
    if (sourceCanvas) sourceCanvas.classList.remove("hidden");

    const total7dSales = salesSeries.reduce((acc, v) => acc + (Number(v) || 0), 0);
    const total7dEl = document.getElementById("chart-7d-total");
    if (total7dEl) total7dEl.innerText = formatINR(total7dSales);

    const total7dOrders = (Number(split.web_orders) || 0) + (Number(split.whatsapp_orders) || 0);
    const centerOrdersEl = document.getElementById("chart-source-total-orders");
    if (centerOrdersEl) centerOrdersEl.innerText = String(total7dOrders);

    const webBreakdownEl = document.getElementById("chart-web-breakdown");
    const webRevEl = document.getElementById("chart-web-rev");
    const waBreakdownEl = document.getElementById("chart-wa-breakdown");
    const waRevEl = document.getElementById("chart-wa-rev");

    const webPct = total7dOrders > 0 ? Math.round((split.web_orders / total7dOrders) * 100) : 0;
    const waPct = total7dOrders > 0 ? 100 - webPct : 0;

    if (webBreakdownEl) webBreakdownEl.innerText = `${split.web_orders || 0} (${webPct}%)`;
    if (webRevEl) webRevEl.innerText = formatINR(split.web_revenue || 0);
    if (waBreakdownEl) waBreakdownEl.innerText = `${split.whatsapp_orders || 0} (${waPct}%)`;
    if (waRevEl) waRevEl.innerText = formatINR(split.whatsapp_revenue || 0);

    const ChartLib = window.Chart;
    if (!ChartLib) return;

    // 1. Curved Line Chart: Sales Trend (Last 7 Days)
    const lineCanvas = document.getElementById("dashSalesTrendChart");
    if (lineCanvas) {
        if (salesTrendChartInstance) {
            salesTrendChartInstance.destroy();
            salesTrendChartInstance = null;
        }
        const ctx = lineCanvas.getContext("2d");
        const gradient = ctx.createLinearGradient(0, 0, 0, 260);
        gradient.addColorStop(0, "rgba(16, 185, 129, 0.35)");
        gradient.addColorStop(1, "rgba(16, 185, 129, 0.01)");

        salesTrendChartInstance = new ChartLib(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Gross Sales (₹)",
                        data: salesSeries,
                        borderColor: "#10b981",
                        backgroundColor: gradient,
                        borderWidth: 3,
                        pointBackgroundColor: "#0f172a",
                        pointBorderColor: "#10b981",
                        pointBorderWidth: 2,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        tension: 0.42,
                        fill: true
                    }
                ]
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
                        titleColor: "#94a3b8",
                        bodyColor: "#f8fafc",
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: (context) => ` Revenue: ₹${Number(context.parsed.y || 0).toLocaleString("en-IN")}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: "rgba(30, 41, 59, 0.35)", drawBorder: false },
                        ticks: { color: "#94a3b8", font: { size: 11 } }
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: "rgba(30, 41, 59, 0.5)", drawBorder: false },
                        ticks: {
                            color: "#94a3b8",
                            font: { size: 11 },
                            callback: (value) => "₹" + Number(value).toLocaleString("en-IN")
                        }
                    }
                }
            }
        });
    }

    // 2. Doughnut Chart: Order Source (WhatsApp vs Web)
    if (sourceCanvas) {
        if (orderSourceChartInstance) {
            orderSourceChartInstance.destroy();
            orderSourceChartInstance = null;
        }
        const ctx2 = sourceCanvas.getContext("2d");
        const hasOrders = (Number(split.web_orders) || 0) + (Number(split.whatsapp_orders) || 0) > 0;
        const chartDataPoints = hasOrders
            ? [Number(split.web_orders) || 0, Number(split.whatsapp_orders) || 0]
            : [1, 1];
        const bgColors = hasOrders ? ["#6366f1", "#10b981"] : ["#1e293b", "#334155"];

        orderSourceChartInstance = new ChartLib(ctx2, {
            type: "doughnut",
            data: {
                labels: ["Web Storefront", "WhatsApp AI Bot"],
                datasets: [
                    {
                        data: chartDataPoints,
                        backgroundColor: bgColors,
                        borderColor: "#0f172a",
                        borderWidth: 4,
                        hoverOffset: 6
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "72%",
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: hasOrders,
                        backgroundColor: "#020617",
                        borderColor: "#1e293b",
                        borderWidth: 1,
                        titleColor: "#94a3b8",
                        bodyColor: "#f8fafc",
                        padding: 10
                    }
                }
            }
        });
    }
}

function normalizeDashboardOrderStatus(rawStatus) {
    const s = String(rawStatus || "New").toUpperCase().trim();
    if (s === "DELIVERED" || s === "COMPLETED") return "Delivered";
    if (s === "OUT_FOR_DELIVERY" || s === "OUT FOR DELIVERY" || s === "ON_THE_WAY" || s === "ON THE WAY") return "Out for Delivery";
    if (s === "DISPATCHED" || s === "SHIPPED") return "Dispatched";
    if (s === "PROCESSING" || s === "PREPARING" || s === "PACKING") return "Processing";
    if (s === "CANCELLED" || s === "CANCELED") return "Cancelled";
    return "New";
}

function getOrderStatusCode(statusLabel) {
    const s = String(statusLabel || "").toUpperCase().trim();
    if (s === "DELIVERED" || s === "COMPLETED") return "DELIVERED";
    if (s === "OUT FOR DELIVERY" || s === "OUT_FOR_DELIVERY") return "OUT_FOR_DELIVERY";
    if (s === "DISPATCHED" || s === "SHIPPED") return "DISPATCHED";
    if (s === "PROCESSING") return "PROCESSING";
    return "CONFIRMED";
}

function getOrderHelperBadges(order) {
    const isWhatsApp = String(order.source).toLowerCase() === "whatsapp";
    const sourceBadge = isWhatsApp
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
               <i class="fa-brands fa-whatsapp text-xs"></i> WhatsApp
           </span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
               <i class="fa-solid fa-globe text-[11px]"></i> Web Store
           </span>`;

    const isPaid = String(order.payment_status).toLowerCase() === "paid";
    const paymentBadge = isPaid
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
               <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Paid (${escapeHtml(order.payment_method || "UPI")})
           </span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
               <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Pending (${escapeHtml(order.payment_method || "COD")})
           </span>`;

    const normalizedLabel = normalizeDashboardOrderStatus(order.order_status);
    const statusLower = normalizedLabel.toLowerCase();
    const statusCode = getOrderStatusCode(normalizedLabel);

    let orderStatusBadge = "";
    if (statusLower === "delivered") {
        orderStatusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono">
            <i class="fa-solid fa-circle-check text-[10px]"></i> Delivered
        </span>`;
    } else if (statusLower === "out for delivery") {
        orderStatusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-purple-500/15 text-purple-300 border border-purple-500/30 font-mono">
            <i class="fa-solid fa-motorcycle text-[10px]"></i> Out for Delivery
        </span>`;
    } else if (statusLower === "dispatched") {
        orderStatusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono">
            <i class="fa-solid fa-box text-[10px]"></i> Dispatched
        </span>`;
    } else if (statusLower === "processing") {
        orderStatusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono">
            <i class="fa-solid fa-gear fa-spin text-[10px]"></i> Processing
        </span>`;
    } else {
        orderStatusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono">
            <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span> New
        </span>`;
    }

    let nextActionHTML = "";
    let nextActionMobileHTML = "";
    if (statusLower === "new" || statusLower === "processing") {
        nextActionHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'DISPATCHED')" class="min-h-10 px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1.5" title="Mark Dispatched & Notify on WhatsApp">
            <i class="fa-solid fa-box"></i> <span>Dispatch</span>
        </button>`;
        nextActionMobileHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'DISPATCHED')" class="flex-1 min-h-11 px-3 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-box"></i> <span>Mark Dispatched</span>
        </button>`;
    } else if (statusLower === "dispatched") {
        nextActionHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'OUT_FOR_DELIVERY')" class="min-h-10 px-3 py-1.5 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1.5" title="Mark Out for Delivery & Notify on WhatsApp">
            <i class="fa-solid fa-motorcycle"></i> <span>Out for Delivery</span>
        </button>`;
        nextActionMobileHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'OUT_FOR_DELIVERY')" class="flex-1 min-h-11 px-3 py-2 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-motorcycle"></i> <span>Out for Delivery</span>
        </button>`;
    } else if (statusLower === "out for delivery") {
        nextActionHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'DELIVERED')" class="min-h-10 px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold transition cursor-pointer inline-flex items-center gap-1.5" title="Mark Delivered & Notify on WhatsApp">
            <i class="fa-solid fa-circle-check"></i> <span>Mark Delivered</span>
        </button>`;
        nextActionMobileHTML = `<button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', 'DELIVERED')" class="flex-1 min-h-11 px-3 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-circle-check"></i> <span>Mark Delivered</span>
        </button>`;
    } else {
        nextActionHTML = `<span class="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-mono px-2"><i class="fa-solid fa-check-double"></i> Fulfilled</span>`;
        nextActionMobileHTML = `<span class="flex-1 min-h-11 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono font-bold flex items-center justify-center gap-1.5"><i class="fa-solid fa-check-double"></i> Delivered</span>`;
    }

    const statusSelectHTML = `
        <select onchange="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', this.value)" aria-label="Order fulfillment status" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-slate-950 border border-slate-700 hover:border-slate-600 text-[11px] font-bold text-slate-200 outline-none focus:border-emerald-500 cursor-pointer">
            <option value="CONFIRMED" ${statusCode === "CONFIRMED" ? "selected" : ""}>🆕 New / Confirmed</option>
            <option value="PROCESSING" ${statusCode === "PROCESSING" ? "selected" : ""}>👨‍🍳 Processing</option>
            <option value="DISPATCHED" ${statusCode === "DISPATCHED" ? "selected" : ""}>📦 Dispatched</option>
            <option value="OUT_FOR_DELIVERY" ${statusCode === "OUT_FOR_DELIVERY" ? "selected" : ""}>🛵 Out for Delivery</option>
            <option value="DELIVERED" ${statusCode === "DELIVERED" ? "selected" : ""}>✅ Delivered</option>
        </select>
    `;

    return { sourceBadge, paymentBadge, orderStatusBadge, statusLower, statusCode, nextActionHTML, nextActionMobileHTML, statusSelectHTML };
}

function renderRecentOrdersTable() {
    const tbody = document.getElementById("dash-recent-orders-tbody");
    const mobileContainer = document.getElementById("dash-recent-orders-mobile");
    const countPill = document.getElementById("dash-orders-count-pill");

    const filtered = currentDashboardFilter === "ALL"
        ? currentOrdersState
        : currentOrdersState.filter((o) => String(o.source).toLowerCase() === currentDashboardFilter.toLowerCase());

    if (countPill) {
        countPill.innerText = `${filtered.length} order${filtered.length === 1 ? "" : "s"}`;
    }

    if (filtered.length === 0) {
        const emptyStateHTML = `
            <div class="py-10 px-4 text-center space-y-2">
                <div class="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700 text-slate-400 flex items-center justify-center mx-auto">
                    <i class="fa-solid fa-box-open text-lg"></i>
                </div>
                <div class="text-sm font-bold text-slate-300">No orders found yet</div>
                <p class="text-xs text-slate-500 max-w-xs mx-auto">Share your Web Storefront link or connect your WhatsApp AI Bot to start receiving live customer orders.</p>
            </div>`;
        if (mobileContainer) mobileContainer.innerHTML = emptyStateHTML;
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7">${emptyStateHTML}</td></tr>`;
        }
        return;
    }

    // 1. Populate Mobile Card View (< 768px)
    if (mobileContainer) {
        mobileContainer.innerHTML = filtered.map((order) => {
            const { sourceBadge, paymentBadge, orderStatusBadge, nextActionMobileHTML, statusSelectHTML } = getOrderHelperBadges(order);

            return `
            <div class="p-4 space-y-3 hover:bg-slate-800/30 transition">
                <div class="flex items-start justify-between gap-2">
                    <div>
                        <div class="font-mono font-black text-white text-xs">${escapeHtml(order.order_id)}</div>
                        <div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(formatLocalDateTime(order.created_at))}</div>
                    </div>
                    <div class="text-right">
                        <div class="font-mono font-black text-white text-sm">${formatINR(order.amount)}</div>
                        <div class="mt-1">${orderStatusBadge}</div>
                    </div>
                </div>

                <div class="bg-slate-950/60 border border-slate-800/80 rounded-xl p-2.5">
                    <div class="font-bold text-slate-200 text-xs">${escapeHtml(order.customer_name)}</div>
                    <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(order.customer_phone)}</div>
                    <div class="text-[11px] text-slate-400 truncate mt-1">${escapeHtml(order.items_summary || "")}</div>
                </div>

                <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-1.5">
                        ${sourceBadge}
                        ${paymentBadge}
                    </div>
                    ${statusSelectHTML}
                </div>

                <div class="flex items-center gap-2 pt-1">
                    ${nextActionMobileHTML}
                    <button type="button" onclick="viewDashboardOrderDetails('${escapeHtml(order.order_id)}')" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition cursor-pointer">
                        View Details
                    </button>
                </div>
            </div>`;
        }).join("");
    }

    // 2. Populate Desktop Table View (md: and up)
    if (tbody) {
        tbody.innerHTML = filtered.map((order) => {
            const { sourceBadge, paymentBadge, orderStatusBadge, nextActionHTML, statusSelectHTML } = getOrderHelperBadges(order);

            return `
            <tr class="hover:bg-slate-800/40 transition group">
                <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="font-mono font-black text-white">${escapeHtml(order.order_id)}</div>
                    <div class="text-[11px] text-slate-500">${escapeHtml(formatLocalDateTime(order.created_at))}</div>
                </td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-200">${escapeHtml(order.customer_name)}</div>
                    <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(order.customer_phone)}</div>
                    <div class="text-[11px] text-slate-500 truncate max-w-[220px]" title="${escapeHtml(order.items_summary || "")}">${escapeHtml(order.items_summary || "")}</div>
                </td>
                <td class="py-3.5 px-4 whitespace-nowrap">
                    <span class="font-mono font-black text-sm text-white">${formatINR(order.amount)}</span>
                </td>
                <td class="py-3.5 px-4 whitespace-nowrap">${sourceBadge}</td>
                <td class="py-3.5 px-4 whitespace-nowrap">${paymentBadge}</td>
                <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="flex flex-col gap-1.5">
                        ${orderStatusBadge}
                    </div>
                </td>
                <td class="py-3.5 px-4 whitespace-nowrap text-right">
                    <div class="inline-flex items-center justify-end gap-1.5">
                        ${statusSelectHTML}
                        ${nextActionHTML}
                        <button type="button" onclick="viewDashboardOrderDetails('${escapeHtml(order.order_id)}')" class="min-h-10 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-bold transition cursor-pointer">
                            Details
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join("");
    }
}

function renderLowStockList(items) {
    const container = document.getElementById("dash-low-stock-list");
    if (!container) return;

    const list = Array.isArray(items) ? items.slice(0, 5) : [];
    if (list.length === 0) {
        container.innerHTML = `
            <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-emerald-400 font-semibold">
                <i class="fa-solid fa-circle-check mr-1.5"></i> All catalog products are sufficiently stocked!
            </div>`;
        return;
    }

    container.innerHTML = list.map((item) => {
        const qty = Number(item.stock_quantity || 0);
        const isOut = qty <= 0 || item.in_stock === false;
        const badge = isOut
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 font-mono">OUT OF STOCK</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono">${qty} left</span>`;

        return `
        <div class="p-3 rounded-xl bg-slate-950/75 border border-slate-800/90 flex items-center justify-between gap-3">
            <div class="min-w-0">
                <div class="text-xs font-bold text-white truncate">${escapeHtml(item.name)}</div>
                <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(item.sku || "SKU")} • ${escapeHtml(item.category || "Catalog")}</div>
            </div>
            <div class="shrink-0 flex items-center gap-2">
                ${badge}
            </div>
        </div>`;
    }).join("");
}

function renderLiveLeadsList(leads) {
    const container = document.getElementById("dash-live-leads-list");
    if (!container) return;

    if (!Array.isArray(leads) || leads.length === 0) {
        container.innerHTML = `
            <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 text-center text-xs text-slate-400">
                No WhatsApp inquiries recorded yet. Connect your WhatsApp bot to capture live customer leads.
            </div>`;
        return;
    }

    container.innerHTML = leads.slice(0, 6).map((lead) => `
        <div class="p-3 rounded-xl bg-slate-950/75 border border-slate-800/80 flex items-start justify-between gap-2.5">
            <div class="min-w-0">
                <div class="text-xs font-bold text-emerald-400 font-mono">+${escapeHtml(String(lead.customer_phone || "").replace(/^\+/, ""))}</div>
                <div class="text-xs text-slate-300 line-clamp-1 mt-0.5">${escapeHtml(lead.inquiry_text || "Product Catalog Inquiry")}</div>
            </div>
            <span class="shrink-0 px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-300 border border-purple-500/20">
                ${escapeHtml(lead.status || "AI Replied")}
            </span>
        </div>
    `).join("");
}

export function filterDashboardOrders(sourceFilter) {
    currentDashboardFilter = sourceFilter || "ALL";
    document.querySelectorAll(".dash-order-filter").forEach((btn) => {
        btn.classList.remove("bg-slate-800", "text-white");
        btn.classList.add("text-slate-400");
    });
    const activeBtn = document.getElementById(`dash-filter-${currentDashboardFilter}`);
    if (activeBtn) {
        activeBtn.classList.add("bg-slate-800", "text-white");
        activeBtn.classList.remove("text-slate-400");
    }
    renderRecentOrdersTable();
}

function showDashboardFulfillmentToast(message, isSuccess = true) {
    if (typeof window.showToast === "function") {
        window.showToast(message, isSuccess);
        return;
    }
    const existing = document.getElementById("dash-fulfillment-toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "dash-fulfillment-toast";
    el.className = `fixed bottom-20 md:bottom-6 right-4 z-50 px-4 py-3 rounded-xl border text-xs font-bold shadow-2xl flex items-center gap-2.5 ${
        isSuccess
            ? "bg-slate-900 border-emerald-500/40 text-emerald-300"
            : "bg-slate-900 border-rose-500/40 text-rose-300"
    }`;
    el.innerHTML = `<i class="fa-brands fa-whatsapp text-base text-emerald-400"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

export async function updateDashboardOrderStatus(orderId, newStatusInput) {
    const target = currentOrdersState.find((o) => o.order_id === orderId);
    const statusCode = getOrderStatusCode(newStatusInput);
    const statusLabel = normalizeDashboardOrderStatus(statusCode);

    if (target) {
        target.order_status = statusLabel;
        if (statusCode === "DELIVERED") {
            target.payment_status = "Paid";
        }
        renderRecentOrdersTable();
    }

    // If modal is currently open for this order, refresh modal view too
    const modal = document.getElementById("dash-order-detail-modal");
    if (modal && !modal.classList.contains("hidden") && target) {
        viewDashboardOrderDetails(orderId);
    }

    try {
        const username = getActiveUsername() || "admin";
        const res = await fetch(`/api/business/orders/status`, {
            method: "POST",
            headers: getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                username,
                order_id: orderId,
                order_status: statusCode
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === "success") {
            showDashboardFulfillmentToast(
                data.message || `Order #${orderId} updated to ${statusLabel} & customer notified on WhatsApp!`,
                true
            );
        } else {
            showDashboardFulfillmentToast(data.message || "Failed to update order status", false);
        }
    } catch (e) {
        console.warn("Order status update error:", e);
        showDashboardFulfillmentToast("Network error updating order status", false);
    }
}

export async function markDashboardOrderDispatched(orderId) {
    return updateDashboardOrderStatus(orderId, "DISPATCHED");
}

export function viewDashboardOrderDetails(orderId) {
    const order = currentOrdersState.find((o) => o.order_id === orderId);
    if (!order) return;

    const modal = document.getElementById("dash-order-detail-modal");
    const idEl = document.getElementById("modal-order-id");
    const timeEl = document.getElementById("modal-order-time");
    const bodyEl = document.getElementById("modal-order-body");
    const dispatchBtn = document.getElementById("modal-dispatch-btn");

    const normalizedLabel = normalizeDashboardOrderStatus(order.order_status);
    const statusCode = getOrderStatusCode(normalizedLabel);

    const stageMap = {
        CONFIRMED: 1,
        PROCESSING: 1,
        DISPATCHED: 2,
        OUT_FOR_DELIVERY: 3,
        DELIVERED: 4
    };
    const activeStage = stageMap[statusCode] || 1;

    if (idEl) idEl.innerText = `${order.order_id} • ${order.source}`;
    if (timeEl) timeEl.innerText = `Placed on ${formatLocalDateTime(order.created_at)}`;

    if (bodyEl) {
        const steps = [
            { step: 1, code: "CONFIRMED", label: "Confirmed", icon: "fa-clipboard-check" },
            { step: 2, code: "DISPATCHED", label: "Dispatched", icon: "fa-box" },
            { step: 3, code: "OUT_FOR_DELIVERY", label: "Out for Delivery", icon: "fa-motorcycle" },
            { step: 4, code: "DELIVERED", label: "Delivered", icon: "fa-circle-check" }
        ];

        const stepperHTML = steps.map((st) => {
            const done = activeStage >= st.step;
            const current = activeStage === st.step;
            return `
                <button type="button" onclick="updateDashboardOrderStatus('${escapeHtml(order.order_id)}', '${st.code}')" class="flex-1 p-2.5 rounded-xl border text-center transition cursor-pointer ${
                    current
                        ? "bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-sm"
                        : done
                        ? "bg-slate-900 border-emerald-500/30 text-emerald-400"
                        : "bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300"
                }">
                    <div class="w-7 h-7 rounded-lg mx-auto flex items-center justify-center text-xs mb-1 ${
                        done ? "bg-emerald-500 text-slate-950 font-black" : "bg-slate-800 text-slate-400"
                    }">
                        <i class="fa-solid ${st.icon}"></i>
                    </div>
                    <div class="text-[10px] font-bold leading-tight">${st.label}</div>
                </button>
            `;
        }).join("");

        bodyEl.innerHTML = `
            <!-- 4-Stage Interactive Order Fulfillment Lifecycle Tracker -->
            <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                <div class="flex items-center justify-between">
                    <span class="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Order Fulfillment Pipeline (Click to Update)</span>
                    <span class="text-[11px] font-mono font-bold text-emerald-400">${escapeHtml(normalizedLabel)}</span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    ${stepperHTML}
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-950 border border-slate-800">
                <div>
                    <div class="text-[10px] uppercase font-bold text-slate-500">Customer</div>
                    <div class="text-xs font-bold text-white mt-0.5">${escapeHtml(order.customer_name)}</div>
                    <div class="text-[11px] font-mono text-emerald-400">${escapeHtml(order.customer_phone)}</div>
                </div>
                <div>
                    <div class="text-[10px] uppercase font-bold text-slate-500">Payment & Status</div>
                    <div class="text-xs font-bold text-white mt-0.5">${formatINR(order.amount)} (${escapeHtml(order.payment_method)})</div>
                    <div class="text-[11px] font-mono text-slate-300">Payment: ${escapeHtml(order.payment_status)} • Status: ${escapeHtml(normalizedLabel)}</div>
                </div>
            </div>
            <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                <div class="text-[10px] uppercase font-bold text-slate-500">Ordered Items</div>
                <div class="text-xs text-slate-200 font-medium">${escapeHtml(order.items_summary || "Catalog Order")}</div>
            </div>
            <div class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                <div class="text-[10px] uppercase font-bold text-slate-500">Hyperlocal Delivery Address</div>
                <div class="text-xs text-slate-300">${escapeHtml(order.delivery_address || "Customer Location Shared on WhatsApp")}</div>
            </div>
        `;
    }

    if (dispatchBtn) {
        if (statusCode === "CONFIRMED" || statusCode === "PROCESSING") {
            dispatchBtn.classList.remove("hidden");
            dispatchBtn.innerHTML = `<i class="fa-solid fa-box mr-1.5"></i>Mark Dispatched`;
            dispatchBtn.onclick = () => updateDashboardOrderStatus(order.order_id, "DISPATCHED");
        } else if (statusCode === "DISPATCHED") {
            dispatchBtn.classList.remove("hidden");
            dispatchBtn.innerHTML = `<i class="fa-solid fa-motorcycle mr-1.5"></i>Mark Out for Delivery`;
            dispatchBtn.onclick = () => updateDashboardOrderStatus(order.order_id, "OUT_FOR_DELIVERY");
        } else if (statusCode === "OUT_FOR_DELIVERY") {
            dispatchBtn.classList.remove("hidden");
            dispatchBtn.innerHTML = `<i class="fa-solid fa-circle-check mr-1.5"></i>Mark Delivered`;
            dispatchBtn.onclick = () => updateDashboardOrderStatus(order.order_id, "DELIVERED");
        } else {
            dispatchBtn.classList.add("hidden");
        }
    }

    if (modal) modal.classList.remove("hidden");
}

export function closeDashboardOrderModal() {
    const modal = document.getElementById("dash-order-detail-modal");
    if (modal) modal.classList.add("hidden");
}

export async function copyDashboardStoreLink() {
    const slug = (currentDashboardStats && currentDashboardStats.store_profile && currentDashboardStats.store_profile.store_slug) || getActiveUsername() || "admin";
    const url = getStorefrontUrl(slug);
    const btnText = document.getElementById("dash-copy-store-link-text");

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
        } else {
            const tempInput = document.createElement("input");
            tempInput.value = url;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
        }
        if (btnText) {
            btnText.innerText = "Copied Store Link! ✓";
            setTimeout(() => {
                if (btnText) btnText.innerText = "Copy Store Link";
            }, 2200);
        }
    } catch (e) {
        if (btnText) btnText.innerText = url;
    }
}

export function openDashboardStorefrontPreview() {
    const slug = (currentDashboardStats && currentDashboardStats.store_profile && currentDashboardStats.store_profile.store_slug) || getActiveUsername() || "admin";
    window.location.href = `/storefront.html?slug=${encodeURIComponent(slug)}`;
}

export async function refreshBusinessDashboard() {
    const icon = document.getElementById("dash-refresh-icon");
    if (icon) icon.classList.add("fa-spin");
    try {
        await initDashboard();
    } finally {
        setTimeout(() => {
            if (icon) icon.classList.remove("fa-spin");
        }, 400);
    }
}

export async function initDashboard(apiBaseUrl = "") {
    const username = getActiveUsername() || "admin";
    currentDashboardFilter = "ALL";

    // Expose interactive handlers on window for inline onclick bindings
    Object.assign(window, {
        copyDashboardStoreLink,
        openDashboardStorefrontPreview,
        refreshBusinessDashboard,
        filterDashboardOrders,
        updateDashboardOrderStatus,
        markDashboardOrderDispatched,
        viewDashboardOrderDetails,
        closeDashboardOrderModal
    });

    try {
        const [dashRes, leadsRes] = await Promise.all([
            fetch(`/api/business/dashboard/stats?username=${encodeURIComponent(username)}`, {
                headers: getAuthHeaders()
            }).catch(() => null),
            fetch(`/api/leads?username=${encodeURIComponent(username)}`, {
                headers: getAuthHeaders()
            }).catch(() => null)
        ]);

        if (dashRes && dashRes.ok) {
            const liveStats = await dashRes.json();
            currentDashboardStats = liveStats;
            currentOrdersState = Array.isArray(liveStats.recent_orders) ? liveStats.recent_orders : [];

            renderKPISection(liveStats);
            renderChartsSection(liveStats);
            renderRecentOrdersTable();
            renderLowStockList(liveStats.low_stock_items || []);
        } else {
            // Empty fallback state if API is unreachable — strictly zero fake data
            const emptyState = {
                store_profile: {
                    store_name: username,
                    store_slug: username,
                    delivery_radius_km: 15,
                    free_delivery_threshold: 499,
                    wa_connected: false,
                    wa_jid: ""
                },
                kpis: {
                    gross_sales_today: 0,
                    gross_sales_yesterday: 0,
                    sales_growth_pct: 0,
                    total_orders_today: 0,
                    web_orders_today: 0,
                    whatsapp_orders_today: 0,
                    upi_collected_amount: 0,
                    cod_pending_amount: 0,
                    leads_captured_today: 0,
                    messages_auto_replied_today: 0
                },
                charts: {
                    seven_day_labels: ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Today"],
                    seven_day_sales: [0, 0, 0, 0, 0, 0, 0],
                    source_split: { web_orders: 0, whatsapp_orders: 0, web_revenue: 0, whatsapp_revenue: 0 }
                },
                recent_orders: [],
                low_stock_items: []
            };
            currentDashboardStats = emptyState;
            currentOrdersState = [];
            renderKPISection(emptyState);
            renderChartsSection(emptyState);
            renderRecentOrdersTable();
            renderLowStockList([]);
        }

        if (leadsRes && leadsRes.ok) {
            const leadsJson = await leadsRes.json();
            if (Array.isArray(leadsJson.leads)) {
                renderLiveLeadsList(leadsJson.leads);
            } else {
                renderLiveLeadsList([]);
            }
        } else {
            renderLiveLeadsList([]);
        }
    } catch (err) {
        console.warn("Dashboard live sync notice:", err);
        renderRecentOrdersTable();
        renderLowStockList([]);
        renderLiveLeadsList([]);
    }
}
