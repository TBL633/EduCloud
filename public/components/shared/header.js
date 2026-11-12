// Shared Mobile & Desktop Header Component for Business Portal
import { checkNeonStatus } from "./auth-guard.js";

export function getMobileHeaderHTML() {
    return `    <header class="md:hidden h-14 px-3 bg-slate-950/95 backdrop-blur-xl border-b border-slate-800/80 flex items-center justify-between shrink-0 z-30">
        <div class="flex items-center gap-2 min-w-0">
            <button type="button" onclick="toggleSidebar()" class="min-h-11 min-w-11 flex items-center justify-center text-slate-300 hover:text-white active:scale-95 rounded-xl bg-slate-900/80 border border-slate-800/80 focus:outline-none cursor-pointer transition" aria-label="Toggle Navigation">
                <i class="fa-solid fa-bars text-base"></i>
            </button>
            <div class="flex items-center gap-2 min-w-0">
                <div class="w-8 h-8 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 text-xs shrink-0">
                    <i class="fa-brands fa-whatsapp"></i>
                </div>
                <div class="min-w-0">
                    <div class="font-black text-xs tracking-tight text-white leading-tight">Wa<span class="text-emerald-400">Mart</span></div>
                    <div id="biz-mobile-view-title" class="text-[10px] font-semibold text-slate-400 truncate max-w-[140px]">Dashboard</div>
                </div>
            </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
            <div id="biz-mobile-neon-pill" class="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                <i class="fa-solid fa-database text-[9px]"></i>
                <span id="biz-mobile-neon-text">Cloud DB</span>
            </div>
            <div id="biz-mobile-wa-pill" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                <span id="biz-mobile-wa-dot" class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span id="biz-mobile-wa-text">Online</span>
            </div>
        </div>
    </header>`;
}

export function getDesktopHeaderHTML() {
    return `            <header class="hidden md:flex h-16 px-6 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md items-center justify-between shrink-0">
                <div class="flex items-center gap-3">
                    <h2 id="biz-view-title" class="text-sm font-bold text-white tracking-wide">Business Dashboard & Leads</h2>
                </div>
                <div class="flex items-center gap-3">
                    <div id="biz-neon-status-pill" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                        <i class="fa-solid fa-database text-emerald-400 text-xs"></i>
                        <span id="biz-neon-status-text">Database Connected</span>
                    </div>
                    <div id="biz-wa-status-pill" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        <span id="biz-wa-status-text">Connected</span>
                    </div>
                </div>
            </header>`;
}

export function getHeaderHTML() {
    return getDesktopHeaderHTML();
}

export function initHeader(apiBaseUrl = "") {
    checkNeonStatus();
}
