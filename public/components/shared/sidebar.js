// Shared Responsive Sidebar & Mobile Bottom Navigation Bar for Business Portal
function toggleSidebar() {
    const drawer = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!drawer || !backdrop) return;
    const isClosed = drawer.classList.contains('-translate-x-full');

    if (isClosed) {
        drawer.classList.remove('-translate-x-full');
        backdrop.classList.remove('hidden');
    } else {
        drawer.classList.add('-translate-x-full');
        backdrop.classList.add('hidden');
    }
}

export function getSidebarHTML() {
    return `        <div id="sidebar-backdrop" onclick="toggleSidebar()" class="hidden fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-40 md:hidden transition-opacity"></div>

        <!-- Responsive Sidebar Navigation (Desktop Fixed Left Sidebar + Mobile Slide-Out Drawer) -->
        <aside id="sidebar-drawer" class="fixed inset-y-0 left-0 z-50 md:static md:translate-x-0 -translate-x-full w-72 md:w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col shrink-0 transition-transform duration-300 ease-in-out shadow-2xl md:shadow-none">
            <!-- Brand -->
            <div class="h-16 px-5 flex items-center justify-between border-b border-slate-800/80">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 text-base shadow-sm">
                        <i class="fa-brands fa-whatsapp"></i>
                    </div>
                    <div>
                        <span class="font-black text-sm tracking-tight text-white">Wa<span class="text-emerald-400">Mart</span></span>
                        <div class="text-[9px] font-bold text-emerald-400 uppercase font-mono tracking-wider">BUSINESS PORTAL</div>
                    </div>
                </div>
                <!-- Close Button on Mobile (44px touch target) -->
                <button type="button" onclick="toggleSidebar()" class="md:hidden min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl bg-slate-900/80 border border-slate-800 cursor-pointer" aria-label="Close Menu">
                    <i class="fa-solid fa-xmark text-lg"></i>
                </button>
            </div>

            <!-- Business Tenant Header Card -->
            <div class="p-4 border-b border-slate-800/60 bg-slate-900/40">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-xl bg-indigo-950 text-indigo-400 flex items-center justify-center text-xs font-bold border border-indigo-800 shrink-0">
                        <i class="fa-solid fa-briefcase"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div id="biz-tenant-name" class="text-xs font-bold text-white truncate">Business Client</div>
                        <div id="biz-tenant-sub" class="text-[10px] text-slate-400 font-mono truncate">@tenant</div>
                    </div>
                </div>
            </div>

            <!-- Admin Preview Mode Banner (3rd div child in sidebar-drawer) -->
            <div id="admin-preview-banner" class="hidden p-3 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1.5 font-bold text-[11px] truncate">
                        <i class="fa-solid fa-shield-halved text-amber-400 shrink-0"></i>
                        <span id="admin-preview-text" class="truncate">Admin Preview Mode</span>
                    </div>
                    <button type="button" onclick="exitAdminMode()" class="min-h-9 px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 rounded-lg text-[10px] font-bold transition shrink-0 cursor-pointer">
                        Exit
                    </button>
                </div>
            </div>

            <!-- Sidebar Tabs (All buttons min-h-11 for 44px+ touch ergonomics) -->
            <nav class="flex-1 p-3 space-y-1.5 overflow-y-auto">
                <button type="button" onclick="switchTab('dashboard')" id="nav-tab-dashboard" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-white bg-slate-900 border border-slate-800 transition cursor-pointer">
                    <i class="fa-solid fa-chart-line text-emerald-400 w-4 text-center"></i>
                    <span>Dashboard & Orders</span>
                </button>
                <button type="button" onclick="switchTab('connect')" id="nav-tab-connect" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-qrcode text-indigo-400 w-4 text-center"></i>
                    <span>WhatsApp & Live Chats</span>
                </button>
                <button type="button" onclick="switchTab('catalog')" id="nav-tab-catalog" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-boxes-stacked text-amber-400 w-4 text-center"></i>
                    <span>Product Catalog</span>
                </button>
                <button type="button" onclick="switchTab('store')" id="nav-tab-store" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-shop text-emerald-400 w-4 text-center"></i>
                    <span>Store Management</span>
                </button>
                <button type="button" onclick="switchTab('ai')" id="nav-tab-ai" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-robot text-purple-400 w-4 text-center"></i>
                    <span>AI Lead Responder</span>
                </button>
                <button type="button" onclick="switchTab('bulk')" id="nav-tab-bulk" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-paper-plane text-cyan-400 w-4 text-center"></i>
                    <span>Bulk Outreach</span>
                </button>
                <button type="button" onclick="switchTab('channels')" id="nav-tab-channels" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-arrows-split-up-and-left text-amber-400 w-4 text-center"></i>
                    <span>Channel Forwarding</span>
                </button>
                <button type="button" onclick="switchTab('profile')" id="nav-tab-profile" class="biz-nav w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition cursor-pointer">
                    <i class="fa-solid fa-user-shield text-emerald-400 w-4 text-center"></i>
                    <span>Profile & Security</span>
                </button>
            </nav>

            <!-- Bottom Actions -->
            <div class="p-3 border-t border-slate-800/80">
                <button type="button" onclick="handleLogout()" class="w-full min-h-11 py-2.5 bg-slate-900 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 rounded-xl text-xs font-bold transition border border-slate-800 hover:border-rose-900 flex items-center justify-center gap-2 cursor-pointer">
                    <i class="fa-solid fa-arrow-right-from-bracket"></i>
                    <span>Logout Session</span>
                </button>
            </div>
        </aside>`;
}

export function getMobileBottomNavHTML() {
    return `    <nav aria-label="Mobile Bottom Navigation" class="md:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-950/95 backdrop-blur-xl border-t border-slate-800/90 px-1.5 py-1 shadow-[0_-10px_30px_rgba(0,0,0,0.45)]">
        <div class="grid grid-cols-5 gap-1 max-w-md mx-auto">
            <button type="button" onclick="switchTab('dashboard')" id="mob-nav-tab-dashboard" class="mob-biz-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-emerald-400 bg-emerald-500/10 font-bold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-chart-pie text-sm"></i>
                <span class="text-[10px] leading-tight">Dashboard</span>
            </button>
            <button type="button" onclick="switchTab('connect')" id="mob-nav-tab-connect" class="mob-biz-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-brands fa-whatsapp text-sm"></i>
                <span class="text-[10px] leading-tight">Orders/WA</span>
            </button>
            <button type="button" onclick="switchTab('catalog')" id="mob-nav-tab-catalog" class="mob-biz-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-boxes-stacked text-sm"></i>
                <span class="text-[10px] leading-tight">Catalog</span>
            </button>
            <button type="button" onclick="switchTab('store')" id="mob-nav-tab-store" class="mob-biz-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-store text-sm"></i>
                <span class="text-[10px] leading-tight">Store</span>
            </button>
            <button type="button" onclick="switchTab('profile')" id="mob-nav-tab-profile" class="mob-biz-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-gear text-sm"></i>
                <span class="text-[10px] leading-tight">Settings</span>
            </button>
        </div>
    </nav>`;
}

export function initSidebar(switchTabCallback) {
    window.toggleSidebar = toggleSidebar;
    if (typeof switchTabCallback === "function") {
        window.switchTab = switchTabCallback;
    }
    document.querySelectorAll("#sidebar-drawer .biz-nav").forEach((btn) => {
        const idAttr = btn.getAttribute("id") || "";
        if (idAttr.startsWith("nav-tab-")) {
            const tabId = idAttr.replace("nav-tab-", "");
            btn.onclick = (e) => {
                e.preventDefault();
                if (typeof window.switchTab === "function") {
                    window.switchTab(tabId);
                }
            };
        }
    });
}

export { toggleSidebar };
window.toggleSidebar = toggleSidebar;
