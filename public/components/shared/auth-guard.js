// Shared Authentication, Session & Cloud API Base URL Guard
export function getApiBaseUrl() {
    return window.WAMART_API_BASE_URL || localStorage.getItem("wamart_api_base_url") || "";
}

export function getAuthToken() {
    return localStorage.getItem("token") || localStorage.getItem("wamart_token") || "";
}

export function getAuthHeaders(extraHeaders = {}) {
    const token = getAuthToken();
    const headers = { ...extraHeaders };
    if (token && !headers["Authorization"] && !headers["authorization"]) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
}

export function formatLocalDateTime(isoOrDateStr) {
    if (!isoOrDateStr) return "—";
    const d = new Date(isoOrDateStr);
    if (isNaN(d.getTime())) return String(isoOrDateStr);
    return d.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });
}

export function installApiBaseUrlInterceptor(apiBaseUrl = "") {
    if (apiBaseUrl) {
        window.WAMART_API_BASE_URL = apiBaseUrl.replace(/\/+$/, "");
    }
    if (window.__wamartFetchIntercepted) return;
    window.__wamartFetchIntercepted = true;
    const origFetch = window.fetch ? window.fetch.bind(window) : fetch.bind(window);
    const customFetch = function(input, init = {}) {
        const base = getApiBaseUrl();
        let urlStr = typeof input === "string" ? input : (input && input.url ? input.url : "");
        const isApiCall = urlStr.startsWith("/api/") || (base && urlStr.startsWith(base + "/api/"));
        let nextInit = init ? { ...init } : {};

        if (isApiCall) {
            const token = getAuthToken();
            if (token) {
                if (nextInit.headers instanceof Headers) {
                    if (!nextInit.headers.has("Authorization")) {
                        nextInit.headers.set("Authorization", `Bearer ${token}`);
                    }
                } else {
                    nextInit.headers = {
                        ...(nextInit.headers || {}),
                    };
                    if (!nextInit.headers["Authorization"] && !nextInit.headers["authorization"]) {
                        nextInit.headers["Authorization"] = `Bearer ${token}`;
                    }
                }
            }
            if (typeof nextInit.body === "string" && !(nextInit.headers instanceof Headers)) {
                nextInit.headers = { ...(nextInit.headers || {}) };
                if (!nextInit.headers["Content-Type"] && !nextInit.headers["content-type"]) {
                    nextInit.headers["Content-Type"] = "application/json";
                }
            }
        }

        if (base && typeof input === "string" && input.startsWith("/api/")) {
            return origFetch(base + input, nextInit);
        }
        return origFetch(input, nextInit);
    };
    try {
        window.fetch = customFetch;
    } catch (e) {
        window.WAMART_CUSTOM_FETCH = customFetch;
    }
}

        function getActiveUsername() {
            const userStr = localStorage.getItem('user_data') || localStorage.getItem('wamart_user') || '{}';
            let user = {};
            try { user = JSON.parse(userStr); } catch {}
            
            let raw = '';
            const impersonating = localStorage.getItem('impersonating');
            const role = localStorage.getItem('role') || user.role || user.user_type || '';

            if (impersonating && (role === 'admin' || role === 'superadmin' || user.role === 'admin')) {
                raw = impersonating;
            } else {
                raw = user.username || user.account_name || user.email || '';
            }

            if (!raw) {
                // Fallback: recover active username from wamart-token-<username>
                const tok = localStorage.getItem('token') || localStorage.getItem('wamart_token') || '';
                if (tok.includes('wamart-token-')) {
                    raw = tok.split('wamart-token-')[1] || '';
                }
            }

            raw = String(raw).replace(/^@/, '').trim();
            if (raw.includes('@')) {
                raw = raw.split('@')[0];
            }
            return raw ? raw.toLowerCase() : 'admin';
        }

        function exitAdminMode() {
            localStorage.removeItem('impersonating');
            localStorage.removeItem('impersonating_name');
            window.location.href = '/admin-portal.html';
        }

        function checkBusinessAuth() {
            const token = localStorage.getItem('token') || localStorage.getItem('wamart_token');
            if (!token) {
                window.location.href = '/index.html';
                return;
            }

            const userStr = localStorage.getItem('user_data') || localStorage.getItem('wamart_user') || '{}';
            const user = JSON.parse(userStr);
            const role = localStorage.getItem('role') || user.role || user.user_type || '';
            
            // Non-admins cannot impersonate
            if (role !== 'admin' && user.role !== 'admin' && user.user_type !== 'admin') {
                localStorage.removeItem('impersonating');
                localStorage.removeItem('impersonating_name');
            }

            const activeImpersonating = localStorage.getItem('impersonating');
            const impersonatingName = localStorage.getItem('impersonating_name');

            const banner = document.getElementById('admin-preview-banner');
            const bannerText = document.getElementById('admin-preview-text');

            if (activeImpersonating && (role === 'admin' || user.role === 'admin' || user.user_type === 'admin')) {
                if (banner) banner.classList.remove('hidden');
                if (bannerText) bannerText.innerText = `Admin Managing: @${activeImpersonating}`;
            } else {
                if (banner) banner.classList.add('hidden');
            }

            const activeUser = activeImpersonating || user.username || 'business';
            const activeName = (activeImpersonating ? impersonatingName : user.account_name) || activeUser;

            const nameEl = document.getElementById('biz-tenant-name');
            const subEl = document.getElementById('biz-tenant-sub');
            if (nameEl) nameEl.innerText = activeName;
            if (subEl) subEl.innerText = `@${activeUser}`;
        }

        function handleLogout() {
            localStorage.clear();
            window.location.href = '/index.html';
        }

        // ==============================================================
        // GOLANG BACKEND & NEON DB CONNECTORS
        // ==============================================================

        // 0. LIVE NEON DB CONNECTION CHECK
        async function checkNeonStatus() {
            try {
                const res = await fetch('/api/db-status');
                const data = await res.json();
                const deskPill = document.getElementById('biz-neon-status-pill');
                const deskText = document.getElementById('biz-neon-status-text');
                const mobPill = document.getElementById('biz-mobile-neon-pill');
                const mobText = document.getElementById('biz-mobile-neon-text');

                if (data.connected) {
                    if (deskPill) deskPill.className = "flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono";
                    if (deskText) deskText.innerText = "Database Connected";
                    if (mobPill) mobPill.className = "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono";
                    if (mobText) mobText.innerText = "Cloud DB";
                } else {
                    if (deskPill) deskPill.className = "flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono";
                    if (deskText) deskText.innerText = "Embedded Mode";
                    if (mobPill) mobPill.className = "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono";
                    if (mobText) mobText.innerText = "Local";
                }
            } catch (err) {
                console.warn('DB check error:', err);
            }
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }


export { getActiveUsername, exitAdminMode, checkBusinessAuth, handleLogout, checkNeonStatus, escapeHtml };

export function initAuthGuard(apiBaseUrl = "") {
    installApiBaseUrlInterceptor(apiBaseUrl);
    Object.assign(window, { getApiBaseUrl, getAuthToken, getAuthHeaders, formatLocalDateTime, installApiBaseUrlInterceptor, getActiveUsername, exitAdminMode, checkBusinessAuth, handleLogout, checkNeonStatus, escapeHtml });
}

Object.assign(window, { getApiBaseUrl, getAuthToken, getAuthHeaders, formatLocalDateTime, installApiBaseUrlInterceptor, getActiveUsername, exitAdminMode, checkBusinessAuth, handleLogout, checkNeonStatus, escapeHtml });
