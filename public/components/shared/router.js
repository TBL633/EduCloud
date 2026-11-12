// Core Dynamic Component Router for WaMart Business Portal (Cloudflare Pages Static Architecture)
import { initAuthGuard, checkBusinessAuth, checkNeonStatus, getApiBaseUrl, getActiveUsername } from "./auth-guard.js";
import { getMobileHeaderHTML, getDesktopHeaderHTML, initHeader } from "./header.js";
import { getSidebarHTML, getMobileBottomNavHTML, initSidebar } from "./sidebar.js";
import { getMediaModalsHTML, initMediaCropper } from "./media-cropper.js";

import { getDashboardHTML, initDashboard } from "../business/dashboard.js";
import { getWhatsAppConnectHTML, initWhatsAppConnect, initLiveChatStream } from "../business/whatsapp-connect.js";
import { getBulkOutreachHTML, initBulkOutreach } from "../business/bulk-outreach.js";
import { getChannelForwardingHTML, initChannelForwarding } from "../business/channel-forwarding.js";
import { getProductCatalogHTML, initProductCatalog } from "../business/product-catalog.js";
import { getAIResponderHTML, initAIResponder } from "../business/ai-responder.js";
import { getStoreManagementHTML, initStoreManagement } from "../business/store-management.js";
import { getProfileSecurityHTML, initProfileSecurity } from "../business/profile-security.js";

const BUSINESS_ROUTES = {
    dashboard: {
        title: "Business Dashboard & Omnichannel Orders",
        shortTitle: "Dashboard",
        getHTML: getDashboardHTML,
        init: initDashboard
    },
    connect: {
        title: "WhatsApp Link & Live Order Chats",
        shortTitle: "Orders & WA",
        getHTML: getWhatsAppConnectHTML,
        init: initWhatsAppConnect
    },
    bulk: {
        title: "Bulk WhatsApp Outreach Studio",
        shortTitle: "Bulk Outreach",
        getHTML: getBulkOutreachHTML,
        init: initBulkOutreach
    },
    channels: {
        title: "Automated Channel Forwarding Engine",
        shortTitle: "Channels",
        getHTML: getChannelForwardingHTML,
        init: initChannelForwarding
    },
    catalog: {
        title: "Product Catalog & Inventory Engine",
        shortTitle: "Catalog",
        getHTML: getProductCatalogHTML,
        init: initProductCatalog
    },
    store: {
        title: "Store Management & Digital Shopfront",
        shortTitle: "Store Setup",
        getHTML: getStoreManagementHTML,
        init: initStoreManagement
    },
    ai: {
        title: "AI Lead Responder",
        shortTitle: "AI Responder",
        getHTML: getAIResponderHTML,
        init: initAIResponder
    },
    profile: {
        title: "Profile & Security Settings",
        shortTitle: "Settings",
        getHTML: getProfileSecurityHTML,
        init: initProfileSecurity
    }
};

export function switchTab(tabId) {
    const apiBaseUrl = getApiBaseUrl();
    const routeKey = BUSINESS_ROUTES[tabId] ? tabId : "dashboard";
    const route = BUSINESS_ROUTES[routeKey];

    // 1. Update Desktop/Drawer Sidebar Navigation Active Highlight
    document.querySelectorAll(".biz-nav").forEach((el) => {
        el.classList.remove("bg-slate-900", "text-white", "border", "border-slate-800");
        el.classList.add("text-slate-400");
    });

    const navBtn = document.getElementById("nav-tab-" + routeKey);
    if (navBtn) {
        navBtn.classList.add("bg-slate-900", "text-white", "border", "border-slate-800");
        navBtn.classList.remove("text-slate-400");
    }

    // 2. Update Mobile Bottom Navigation Active Highlight
    document.querySelectorAll(".mob-biz-nav").forEach((el) => {
        el.classList.remove("text-emerald-400", "bg-emerald-500/10", "font-bold");
        el.classList.add("text-slate-400", "font-semibold");
    });
    const mobBtn = document.getElementById("mob-nav-tab-" + routeKey);
    if (mobBtn) {
        mobBtn.classList.add("text-emerald-400", "bg-emerald-500/10", "font-bold");
        mobBtn.classList.remove("text-slate-400", "font-semibold");
    }

    // 3. Update Desktop & Mobile Header Titles
    const titleEl = document.getElementById("biz-view-title");
    if (titleEl) {
        titleEl.innerText = route.title || "Workspace";
    }
    const mobTitleEl = document.getElementById("biz-mobile-view-title");
    if (mobTitleEl) {
        mobTitleEl.innerText = route.shortTitle || route.title || "Workspace";
    }

    // 4. Close Mobile Drawer on Small Screens
    if (window.innerWidth < 768) {
        const drawer = document.getElementById("sidebar-drawer");
        const backdrop = document.getElementById("sidebar-backdrop");
        if (drawer) drawer.classList.add("-translate-x-full");
        if (backdrop) backdrop.classList.add("hidden");
    }

    // 5. Dynamically Inject Component HTML into Content Container Viewport
    const scrollContainer = document.getElementById("biz-main-scroll-container");
    if (scrollContainer && route) {
        scrollContainer.innerHTML = route.getHTML();
        if (scrollContainer.firstElementChild) {
            scrollContainer.firstElementChild.classList.remove("hidden");
        }
        scrollContainer.scrollTop = 0;
        if (typeof route.init === "function") {
            route.init(apiBaseUrl);
        }
    }
}

async function syncHeaderWhatsAppBadge() {
    try {
        const username = getActiveUsername() || "admin";
        const res = await fetch(`/api/whatsapp/status?username=${encodeURIComponent(username)}`);
        if (!res.ok) return;
        const data = await res.json();
        const isOnline = data.status === "Connected" || Boolean(data.connected);
        const deskText = document.getElementById("biz-wa-status-text");
        if (deskText) {
            deskText.innerText = isOnline ? "Connected" : "Disconnected";
        }
        const mobText = document.getElementById("biz-mobile-wa-text");
        if (mobText) {
            mobText.innerText = isOnline ? "WA Online" : "WA Offline";
        }
    } catch (e) {}
}

export function initBusinessPortalRouter() {
    const apiBaseUrl = getApiBaseUrl();
    initAuthGuard(apiBaseUrl);

    // 1. Mount Mobile Header
    const mobileHeaderSlot = document.getElementById("mobile-header-container");
    if (mobileHeaderSlot) {
        mobileHeaderSlot.innerHTML = getMobileHeaderHTML();
    }

    // 2. Mount Sidebar into #sidebar-container
    const sidebarContainer = document.getElementById("sidebar-container");
    if (sidebarContainer) {
        sidebarContainer.innerHTML = getSidebarHTML();
    }

    // 3. Mount Desktop Header & Scrollable Viewport into <main id="content-container">
    const contentContainer = document.getElementById("content-container");
    if (contentContainer) {
        contentContainer.innerHTML = `
            ${getDesktopHeaderHTML()}
            <div id="biz-main-scroll-container" class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3.5 sm:p-6 pb-28 md:pb-12 space-y-6"></div>
        `;
    }

    // 4. Mount Mobile App Bottom Navigation Bar
    let bottomNavSlot = document.getElementById("mobile-bottom-nav-container");
    if (!bottomNavSlot) {
        bottomNavSlot = document.createElement("div");
        bottomNavSlot.id = "mobile-bottom-nav-container";
        bottomNavSlot.className = "md:hidden shrink-0";
        document.body.appendChild(bottomNavSlot);
    }
    bottomNavSlot.innerHTML = getMobileBottomNavHTML();

    // 5. Mount Shared Cropper & Lightbox Modals
    const modalsContainer = document.getElementById("shared-modals-container");
    if (modalsContainer) {
        modalsContainer.innerHTML = getMediaModalsHTML();
    }

    // 6. Initialize Shared Services & Bindings
    window.switchTab = switchTab;
    initSidebar(switchTab);
    initHeader(apiBaseUrl);
    initMediaCropper(apiBaseUrl);

    // 7. Verify Auth, Cloud DB Status, Live Chat Stream & Load Default Tab
    checkBusinessAuth();
    checkNeonStatus();
    syncHeaderWhatsAppBadge();
    initLiveChatStream();
    switchTab("dashboard");
}

window.switchTab = switchTab;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBusinessPortalRouter);
} else {
    initBusinessPortalRouter();
}
