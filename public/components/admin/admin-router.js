// Core Dynamic Component Router for WaMart Master Admin Portal
import { initAuthGuard, getApiBaseUrl } from "../shared/auth-guard.js";
import { getAdminSidebarHTML, getAdminDesktopHeaderHTML, getAdminMobileBottomNavHTML, getAdminToastHTML, initAdminSidebar } from "./admin-sidebar.js";
import { getTenantsHubHTML, initTenantsHub, getAdminOrdersMonitorHTML, initAdminOrdersMonitor } from "./tenants-hub.js";
import { getWhatsAppPairHTML, initWhatsAppPair } from "./whatsapp-pair.js";
import { getAIConfigHTML, initAIConfig } from "./ai-config.js";
import { getBroadcastCampaignsHTML, initBroadcastCampaigns } from "./broadcast-campaigns.js";
import { getChannelRoutingHTML, initChannelRouting } from "./channel-routing.js";

const ADMIN_ROUTES = {
    tenants: {
        title: "Business Stores & Multi-Tenant Control Hub",
        shortTitle: "Business Hub",
        getHTML: getTenantsHubHTML,
        init: initTenantsHub
    },
    orders: {
        title: "Store Orders & Omnichannel Revenue Pipeline",
        shortTitle: "Store Orders",
        getHTML: getAdminOrdersMonitorHTML,
        init: initAdminOrdersMonitor
    },
    whatsapp: {
        title: "Business WhatsApp Multi-Node Gateway Hub",
        shortTitle: "WA Gateways",
        getHTML: getWhatsAppPairHTML,
        init: initWhatsAppPair
    },
    ai: {
        title: "Business AI Auto-Reply Engine & Prompt Lab",
        shortTitle: "Business AI",
        getHTML: getAIConfigHTML,
        init: initAIConfig
    },
    broadcast: {
        title: "Merchant Broadcast & Platform Announcement Studio",
        shortTitle: "Merchant Broadcast",
        getHTML: getBroadcastCampaignsHTML,
        init: initBroadcastCampaigns
    },
    channels: {
        title: "Business Security, Automation & Channel Controls",
        shortTitle: "Business Security",
        getHTML: getChannelRoutingHTML,
        init: initChannelRouting
    }
};

export function switchAdminTab(tabName) {
    const apiBaseUrl = getApiBaseUrl();
    const routeKey = ADMIN_ROUTES[tabName] ? tabName : "tenants";
    const route = ADMIN_ROUTES[routeKey];

    // 1. Update Desktop/Drawer Sidebar Navigation Highlight + Mobile Bottom Nav Highlight
    const tabs = ["tenants", "orders", "whatsapp", "ai", "broadcast", "channels"];
    tabs.forEach((t) => {
        const btn = document.getElementById("nav-btn-" + t);
        if (btn) {
            if (t === routeKey) {
                btn.className = "w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer bg-indigo-600 text-white shadow-lg shadow-indigo-600/25";
            } else {
                btn.className = "w-full min-h-11 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer text-slate-400 hover:bg-slate-900 hover:text-white";
            }
        }
        const mobBtn = document.getElementById("mob-admin-btn-" + t);
        if (mobBtn) {
            if (t === routeKey) {
                mobBtn.className = "mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-indigo-400 bg-indigo-500/15 font-bold transition active:scale-95 cursor-pointer";
            } else {
                mobBtn.className = "mob-admin-nav min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-xl text-slate-400 hover:text-slate-200 font-semibold transition active:scale-95 cursor-pointer";
            }
        }
    });

    // 2. Update Header Titles
    const deskTitle = document.getElementById("admin-view-title");
    if (deskTitle) deskTitle.innerText = route.title;
    const mobTitle = document.getElementById("admin-mobile-view-title");
    if (mobTitle) mobTitle.innerText = route.shortTitle;

    // 3. Close Mobile Menu Drawer
    const sidebar = document.getElementById("sidebar-drawer");
    const backdrop = document.getElementById("mobile-backdrop");
    if (sidebar) sidebar.classList.add("-translate-x-full");
    if (backdrop) backdrop.classList.add("hidden");

    // 4. Dynamically Inject Component HTML into Content Container & Initialize
    const viewport = document.getElementById("admin-tab-viewport");
    const contentContainer = document.getElementById("content-container");
    if (viewport && route) {
        viewport.innerHTML = route.getHTML();
        if (viewport.firstElementChild) {
            viewport.firstElementChild.classList.remove("hidden");
        }
        if (contentContainer) contentContainer.scrollTop = 0;
        if (typeof route.init === "function") {
            route.init(apiBaseUrl);
        }
    }
}

export function initAdminPortalRouter() {
    const token = localStorage.getItem("wamart_token") || localStorage.getItem("token");
    if (!token) {
        window.location.href = "/index.html";
        return;
    }

    const apiBaseUrl = getApiBaseUrl();
    initAuthGuard(apiBaseUrl);

    window._allTenants = window._allTenants || [];
    window._allNewsletters = window._allNewsletters || [];

    // 1. Mount Sidebar & Mobile Navbar into #sidebar-container
    const sidebarContainer = document.getElementById("sidebar-container");
    if (sidebarContainer) {
        sidebarContainer.innerHTML = getAdminSidebarHTML();
    }

    // 2. Mount Desktop Command Header
    const headerSlot = document.getElementById("admin-desktop-header-slot");
    if (headerSlot) {
        headerSlot.innerHTML = getAdminDesktopHeaderHTML();
    }

    // 3. Mount Notification Toast & Dynamic Tab Viewport into <main id="content-container">
    const contentContainer = document.getElementById("content-container");
    if (contentContainer) {
        contentContainer.innerHTML = `
            ${getAdminToastHTML()}
            <div id="admin-tab-viewport" class="max-w-[1440px] mx-auto space-y-6 pb-24 md:pb-10"></div>
        `;
    }

    // 4. Mount Mobile Bottom Navigation Bar
    let bottomNavSlot = document.getElementById("admin-mobile-bottom-nav");
    if (!bottomNavSlot) {
        bottomNavSlot = document.createElement("div");
        bottomNavSlot.id = "admin-mobile-bottom-nav";
        bottomNavSlot.className = "md:hidden shrink-0";
        document.body.appendChild(bottomNavSlot);
    }
    bottomNavSlot.innerHTML = getAdminMobileBottomNavHTML();

    // 5. Initialize Sidebar & Load Default Tenants Hub Tab
    window.switchAdminTab = switchAdminTab;
    initAdminSidebar(switchAdminTab);
    switchAdminTab("tenants");
}

window.switchAdminTab = switchAdminTab;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdminPortalRouter);
} else {
    initAdminPortalRouter();
}
