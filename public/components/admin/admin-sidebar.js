// Master Admin Portal: Enterprise Responsive Sidebar, Desktop Command Header, Mobile Bottom Nav & Toast
import { checkNeonStatus } from "../shared/auth-guard.js";

function showToast(msg, isSuccess = true) {
    const ok = isSuccess !== false && isSuccess !== 'error';
    const toast = document.getElementById('admin-toast');
    const msgEl = document.getElementById('toast-message');
    const iconEl = document.getElementById('toast-icon');
    if (!toast || !msgEl) return;

    msgEl.innerText = msg;
    if (iconEl) {
        iconEl.className = ok
            ? 'fa-solid fa-circle-check text-emerald-400 text-sm'
            : 'fa-solid fa-circle-exclamation text-rose-400 text-sm';
    }
    toast.className = `fixed top-4 right-4 z-50 max-w-md px-4 py-3.5 rounded-2xl border text-xs font-bold flex items-center gap-3 shadow-2xl backdrop-blur-xl transition-all ${
        ok
            ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200'
            : 'bg-rose-950/90 border-rose-500/40 text-rose-200'
    }`;
    toast.classList.remove('hidden');

    if (window._adminToastTimer) clearTimeout(window._adminToastTimer);
    window._adminToastTimer = setTimeout(() => {
        toast.classList.add('hidden');
    }, 4500);
}

function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('mobile-backdrop');
    if (!sidebar) return;
    const isOpen = !sidebar.classList.contains('-translate-x-full');
    if (isOpen) {
        sidebar.classList.add('-translate-x-full');
        if (backdrop) backdrop.classList.add('hidden');
    } else {
        sidebar.classList.remove('-translate-x-full');
        if (backdrop) backdrop.classList.remove('hidden');
    }
}

function logoutAdmin() {
    localStorage.removeItem('wamart_token');
    localStorage.removeItem('token');
    localStorage.removeItem('wamart_user');
    localStorage.removeItem('user_data');
    localStorage.removeItem('role');
    window.location.href = '/index.html';
}

export function getAdminDesktopHeaderHTML() {
    return `    <header class="hidden md:flex h-16 px-6 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800/80 items-center justify-between shrink-0">
        <div class="flex items-center gap-3">
            <span class="px-2.5 py-1 rounded-md text-[10px] font-mono font-bold uppercase tracking-wider bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                SUPERADMIN • BUSINESS CONTROL PLANE
            </span>
            <h2 id="admin-view-title" class="text-sm font-black text-white tracking-wide">Business Stores & Multi-Tenant Control Hub</h2>
        </div>

        <div class="flex items-center gap-2.5">
            <div id="biz-neon-status-pill" class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                <i class="fa-solid fa-database text-emerald-400 text-xs"></i>
                <span id="biz-neon-status-text">Neon Cloud DB</span>
            </div>

            <button type="button" onclick="switchAdminTab('tenants'); setTimeout(() => { if (window.openCreateUserModal) window.openCreateUserModal(); }, 80);" class="min-h-10 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black shadow-lg shadow-indigo-600/25 transition flex items-center gap-1.5 cursor-pointer">
                <i class="fa-solid fa-store text-[11px]"></i>
                <span>+ Add Business Store</span>
            </button>
        </div>
    </header>`;
}

export function getAdminSidebarHTML() {
    return `    <!-- MOBILE TOP NAVBAR WITH HAMBURGER DRAWER BUTTON -->
    <div class="md:hidden sticky top-0 z-40 bg-slate-950/95 backdrop-blur-xl border-b border-slate-800/80 px-3.5 py-2 flex items-center justify-between">
        <div class="flex items-center gap-2.5 min-w-0">
            <button type="button" onclick="toggleMobileMenu()" class="min-h-11 min-w-11 flex items-center justify-center bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl transition cursor-pointer shrink-0" aria-label="Open Navigation Drawer">
                <i class="fa-solid fa-bars text-base" id="mobile-hamburger-icon"></i>
            </button>
            <div class="flex items-center gap-2 min-w-0">
                <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center text-white font-black text-xs shrink-0 shadow-md shadow-indigo-500/20">
                    <i class="fa-solid fa-building-columns"></i>
                </div>
                <div class="min-w-0">
                    <div class="font-black text-xs text-white tracking-tight leading-tight">WaMart <span class="text-indigo-400">Business Admin</span></div>
                    <div id="admin-mobile-view-title" class="text-[10px] text-slate-400 font-semibold truncate">Business Hub</div>
                </div>
            </div>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick="switchAdminTab('tenants'); setTimeout(() => { if (window.openCreateUserModal) window.openCreateUserModal(); }, 80);" class="min-h-10 px-2.5 py-1.5 rounded-xl bg-indigo-600 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer">
                <i class="fa-solid fa-plus text-[10px]"></i>
                <span>Store</span>
            </button>
        </div>
    </div>

    <!-- RESPONSIVE DESKTOP SIDEBAR & MOBILE DRAWER -->
    <aside id="sidebar-drawer" class="fixed md:sticky top-0 left-0 z-50 h-[100dvh] w-72 md:w-64 bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between transition-transform duration-300 -translate-x-full md:translate-x-0 shadow-2xl md:shadow-none">
        <div class="p-4 space-y-5 overflow-y-auto flex-1">
            <!-- Brand Header -->
            <div class="flex items-center justify-between border-b border-slate-800/80 pb-4">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white font-black shadow-lg shadow-indigo-500/20 text-base">
                        <i class="fa-solid fa-building-columns"></i>
                    </div>
                    <div>
                        <h1 class="text-sm font-black text-white tracking-tight">WaMart <span class="text-indigo-400">Master</span></h1>
                        <span class="text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 px-2 py-0.5 rounded-md font-mono font-bold uppercase tracking-wider">
                            Business Control Plane
                        </span>
                    </div>
                </div>
                <button type="button" onclick="toggleMobileMenu()" class="md:hidden min-h-11 min-w-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl bg-slate-900 border border-slate-800 cursor-pointer" aria-label="Close Drawer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Superadmin Identity Card -->
            <div class="p-3 rounded-xl bg-slate-900/70 border border-slate-800/80 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 flex items-center justify-center text-xs shrink-0">
                        <i class="fa-solid fa-crown"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="text-xs font-bold text-white truncate">Master Admin</div>
                        <div class="text-[10px] font-mono text-emerald-400 truncate">Enterprise Merchant Ops</div>
                    </div>
                </div>
                <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
            </div>

            <!-- Navigation Links (All min-h-11 for 44px+ touch ergonomics) -->
            <div class="space-y-1">
                <div class="px-2 pb-1 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">Business Management</div>
                <nav class="space-y-1.5">
                    <button type="button" onclick="switchAdminTab('tenants')" id="nav-btn-tenants" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer bg-indigo-600 text-white shadow-lg shadow-indigo-600/25">
                        <i class="fa-solid fa-store text-sm w-4 text-center"></i>
                        <span>Businesses & Stores</span>
                    </button>

                    <button type="button" onclick="switchAdminTab('orders')" id="nav-btn-orders" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white">
                        <i class="fa-solid fa-boxes-packing text-sm w-4 text-center text-emerald-400"></i>
                        <span>Store Orders & GMV</span>
                    </button>

                    <button type="button" onclick="switchAdminTab('whatsapp')" id="nav-btn-whatsapp" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white">
                        <i class="fa-brands fa-whatsapp text-sm w-4 text-center text-teal-400"></i>
                        <span>Business WhatsApp Nodes</span>
                    </button>

                    <button type="button" onclick="switchAdminTab('ai')" id="nav-btn-ai" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white">
                        <i class="fa-solid fa-robot text-sm w-4 text-center text-purple-400"></i>
                        <span>Business AI Engine</span>
                    </button>

                    <button type="button" onclick="switchAdminTab('broadcast')" id="nav-btn-broadcast" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white">
                        <i class="fa-solid fa-paper-plane text-sm w-4 text-center text-cyan-400"></i>
                        <span>Merchant Broadcasts</span>
                    </button>

                    <button type="button" onclick="switchAdminTab('channels')" id="nav-btn-channels" class="w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white">
                        <i class="fa-solid fa-shield-halved text-sm w-4 text-center text-amber-400"></i>
                        <span>Business Security & Controls</span>
                    </button>
                </nav>
            </div>
        </div>

        <!-- Sidebar Footer Actions -->
        <div class="p-3.5 border-t border-slate-800/80">
            <button type="button" onclick="logoutAdmin()" class="w-full min-h-11 flex items-center justify-center gap-2 px-3.5 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-xl text-xs font-bold transition cursor-pointer">
                <i class="fa-solid fa-right-from-bracket"></i>
                <span>Logout Superadmin</span>
            </button>
        </div>
    </aside>

    <!-- Mobile Drawer Backdrop -->
    <div id="mobile-backdrop" onclick="toggleMobileMenu()" class="hidden fixed inset-0 z-40 bg-slate-950/80 backdrop-blur-sm md:hidden"></div>`;
}

export function getAdminMobileBottomNavHTML() {
    return `    <nav aria-label="Admin Mobile Bottom Navigation" class="md:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-950/95 backdrop-blur-xl border-t border-slate-800/90 px-1.5 py-1 shadow-[0_-10px_30px_rgba(0,0,0,0.45)]">
        <div class="grid grid-cols-5 gap-1 max-w-md mx-auto">
            <button type="button" onclick="switchAdminTab('tenants')" id="mob-admin-btn-tenants" class="mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-indigo-400 bg-indigo-500/15 font-bold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-store text-sm"></i>
                <span class="text-[10px] leading-tight">Stores</span>
            </button>
            <button type="button" onclick="switchAdminTab('orders')" id="mob-admin-btn-orders" class="mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-boxes-packing text-sm"></i>
                <span class="text-[10px] leading-tight">Orders</span>
            </button>
            <button type="button" onclick="switchAdminTab('whatsapp')" id="mob-admin-btn-whatsapp" class="mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-brands fa-whatsapp text-sm"></i>
                <span class="text-[10px] leading-tight">WA Nodes</span>
            </button>
            <button type="button" onclick="switchAdminTab('ai')" id="mob-admin-btn-ai" class="mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-robot text-sm"></i>
                <span class="text-[10px] leading-tight">AI Engine</span>
            </button>
            <button type="button" onclick="switchAdminTab('channels')" id="mob-admin-btn-channels" class="mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer">
                <i class="fa-solid fa-shield-halved text-sm"></i>
                <span class="text-[10px] leading-tight">Security</span>
            </button>
        </div>
    </nav>`;
}

export function getAdminToastHTML() {
    return `        <!-- Floating Notification Toast -->
        <div id="admin-toast" class="hidden fixed top-4 right-4 z-50 max-w-md px-4 py-3.5 rounded-2xl border text-xs font-bold flex items-center gap-3 shadow-2xl">
            <i id="toast-icon" class="fa-solid fa-circle-check text-emerald-400 text-sm"></i>
            <span id="toast-message" class="flex-1"></span>
            <button type="button" onclick="document.getElementById('admin-toast').classList.add('hidden')" class="min-h-8 min-w-8 flex items-center justify-center text-slate-400 hover:text-white rounded-lg cursor-pointer">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`;
}

export function initAdminSidebar(switchAdminTabCallback) {
    Object.assign(window, { showToast, toggleMobileMenu, logoutAdmin });
    if (typeof switchAdminTabCallback === "function") {
        window.switchAdminTab = switchAdminTabCallback;
    }
    const tabs = ["tenants", "orders", "whatsapp", "ai", "broadcast", "channels"];
    tabs.forEach((t) => {
        const btn = document.getElementById("nav-btn-" + t);
        if (btn) {
            btn.onclick = (e) => {
                e.preventDefault();
                if (typeof window.switchAdminTab === "function") {
                    window.switchAdminTab(t);
                }
            };
        }
    });
    checkNeonStatus();
}

export { showToast, toggleMobileMenu, logoutAdmin };
Object.assign(window, { showToast, toggleMobileMenu, logoutAdmin });
