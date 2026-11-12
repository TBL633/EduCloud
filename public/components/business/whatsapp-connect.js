import { loadUserProfile } from "./profile-security.js";
import { getActiveUsername, escapeHtml, checkBusinessAuth, checkNeonStatus } from "../shared/auth-guard.js";
import { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync } from "../shared/media-cropper.js";

// ==============================================================
// BUSINESS PORTAL: PREMIUM WHATSAPP LINK SETUP & LIVE CHAT HUB
// ==============================================================

let fastPairingPollInterval = null;
let currentLoadedOrderState = null;
let currentActiveChatPhone = '';
let cachedConversationsList = [];

function showWhatsAppNotice(message, type = 'success') {
    const existing = document.getElementById('wa-connect-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'wa-connect-toast';
    const isErr = type === 'error';
    toast.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl border shadow-2xl flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-200 ${
        isErr
            ? 'bg-rose-950/95 border-rose-500/40 text-rose-200'
            : 'bg-slate-900/95 border-emerald-500/40 text-emerald-200'
    }`;
    toast.innerHTML = `<i class="fa-solid ${isErr ? 'fa-circle-exclamation text-rose-400' : 'fa-circle-check text-emerald-400'}"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        if (toast && toast.parentNode) toast.remove();
    }, 3200);
}

function startFastPairingChecker() {
    if (fastPairingPollInterval) return;
    fastPairingPollInterval = setInterval(async () => {
        const username = getActiveUsername() || 'user';
        try {
            const res = await fetch(`/api/whatsapp/status?username=${encodeURIComponent(username)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'Connected' || data.connected) {
                    stopFastPairingChecker();
                    fetchWhatsAppQR();
                    loadUserProfile();
                }
            }
        } catch (e) {}
    }, 1500);
}

function stopFastPairingChecker() {
    if (fastPairingPollInterval) {
        clearInterval(fastPairingPollInterval);
        fastPairingPollInterval = null;
    }
}

function updateGatewayTelemetryBar(isConnected, jid = '') {
    const stateLabel = document.getElementById('wa-gateway-state-label');
    const jidLabel = document.getElementById('wa-gateway-jid-label');
    const modeLabel = document.getElementById('wa-gateway-mode-label');
    const connectedBanner = document.getElementById('biz-connected-hero-card');
    const connectedPhoneEl = document.getElementById('biz-connected-jid-display');

    if (isConnected) {
        const cleanJid = String(jid || 'Active Session').replace(/@.*$/, '');
        if (stateLabel) {
            stateLabel.innerText = 'Connected & Synchronized';
            stateLabel.className = 'text-sm font-bold text-emerald-400 font-mono tabular-nums';
        }
        if (jidLabel) {
            jidLabel.innerText = cleanJid.startsWith('+') ? cleanJid : `+${cleanJid}`;
        }
        if (modeLabel) {
            modeLabel.innerText = '24/7 AI Auto-Responder Ready';
        }
        if (connectedBanner) connectedBanner.classList.remove('hidden');
        if (connectedPhoneEl) {
            connectedPhoneEl.innerText = cleanJid.startsWith('+') ? cleanJid : `+${cleanJid}`;
        }
    } else {
        if (stateLabel) {
            stateLabel.innerText = 'Awaiting Device Link';
            stateLabel.className = 'text-sm font-bold text-amber-400 font-mono tabular-nums';
        }
        if (jidLabel) {
            jidLabel.innerText = 'No device linked';
        }
        if (modeLabel) {
            modeLabel.innerText = 'Standby · Scan QR or Enter 8-Digit Code';
        }
        if (connectedBanner) connectedBanner.classList.add('hidden');
    }
}

async function fetchWhatsAppQR() {
    const box = document.getElementById('biz-qrcode-box');
    const pairingSection = document.getElementById('biz-pairing-section');
    const sessionActions = document.getElementById('biz-session-actions');
    if (!box) return;
    const username = getActiveUsername() || 'user';

    box.innerHTML = `
        <div class="py-12 px-6 text-center space-y-3">
            <div class="w-12 h-12 mx-auto rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-emerald-400">
                <i class="fa-solid fa-circle-notch fa-spin text-xl"></i>
            </div>
            <div>
                <p class="text-xs font-bold text-slate-200">Establishing Gateway Handshake</p>
                <p class="text-[11px] text-slate-500 mt-0.5">Fetching encrypted session key for @${escapeHtml(username)}...</p>
            </div>
        </div>
    `;

    try {
        const res = await fetch(`/api/whatsapp/qr?username=${encodeURIComponent(username)}`);
        if (!res.ok) {
            throw new Error(`Server status ${res.status}`);
        }
        const data = await res.json();
        const deskPill = document.getElementById('biz-wa-status-text');

        if (data.status === 'Connected' || data.connected) {
            stopFastPairingChecker();
            updateGatewayTelemetryBar(true, data.jid || 'Connected');
            if (pairingSection) pairingSection.classList.add('hidden');
            if (sessionActions) sessionActions.classList.add('hidden');

            const chatsCard = document.getElementById('biz-customer-chats-container');
            if (chatsCard) chatsCard.classList.remove('hidden');
            loadCustomerConversationsList();

            box.innerHTML = `
                <div class="text-center p-6 space-y-4">
                    <div class="w-14 h-14 mx-auto rounded-2xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-2xl">
                        <i class="fa-solid fa-check"></i>
                    </div>
                    <div>
                        <div class="text-sm font-bold text-white">WhatsApp Session Active</div>
                        <div class="text-xs text-emerald-400 font-mono font-bold mt-1 tabular-nums">+${escapeHtml(String(data.jid || 'Connected').replace(/@.*$/, ''))}</div>
                    </div>
                </div>
            `;
            if (deskPill) deskPill.innerText = 'Connected';
        } else {
            startFastPairingChecker();
            updateGatewayTelemetryBar(false);
            if (pairingSection) pairingSection.classList.remove('hidden');
            if (sessionActions) sessionActions.classList.remove('hidden');
            const chatsCard = document.getElementById('biz-customer-chats-container');
            if (chatsCard) chatsCard.classList.add('hidden');
            backToContactList();

            if (data.qr) {
                box.innerHTML = '';
                const outerWrap = document.createElement('div');
                outerWrap.className = 'flex flex-col items-center justify-center space-y-3 py-2';

                const qrFrame = document.createElement('div');
                qrFrame.className = 'relative p-4 bg-white rounded-2xl shadow-2xl border border-slate-200 flex items-center justify-center mx-auto w-fit';

                const qrContainer = document.createElement('div');
                qrContainer.className = 'flex items-center justify-center';
                qrFrame.appendChild(qrContainer);
                outerWrap.appendChild(qrFrame);

                const caption = document.createElement('div');
                caption.className = 'text-[11px] text-slate-400 font-mono flex items-center gap-2';
                caption.innerHTML = `<i class="fa-solid fa-shield-halved text-emerald-400"></i><span>End-to-End Encrypted Multi-Device QR</span>`;
                outerWrap.appendChild(caption);

                box.appendChild(outerWrap);

                if (window.QRCode) {
                    try {
                        new QRCode(qrContainer, {
                            text: data.qr,
                            width: 196,
                            height: 196,
                            colorDark: "#020617",
                            colorLight: "#ffffff",
                            correctLevel: QRCode.CorrectLevel.M
                        });
                        setTimeout(() => {
                            const imgEl = qrContainer.querySelector('img');
                            if (imgEl) imgEl.style.display = 'none';
                        }, 50);
                    } catch (e) {
                        qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=196x196&data=${encodeURIComponent(data.qr)}" alt="WhatsApp QR Code" class="w-48 h-48 object-contain">`;
                    }
                } else {
                    qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=196x196&data=${encodeURIComponent(data.qr)}" alt="WhatsApp QR Code" class="w-48 h-48 object-contain">`;
                }
                if (deskPill) deskPill.innerText = 'Scan QR';
            } else {
                box.innerHTML = `
                    <div class="text-center py-8 px-4 space-y-3">
                        <div class="w-12 h-12 mx-auto rounded-2xl bg-slate-900 border border-slate-800 text-emerald-400 flex items-center justify-center text-xl">
                            <i class="fa-solid fa-qrcode"></i>
                        </div>
                        <div class="space-y-1">
                            <div class="text-xs font-bold text-white">QR Session Ready to Generate</div>
                            <p class="text-[11px] text-slate-400 max-w-xs mx-auto leading-relaxed">Click below to request a fresh QR code or switch to 8-Digit Phone Pairing.</p>
                        </div>
                        <button type="button" onclick="fetchWhatsAppQR()" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold cursor-pointer transition inline-flex items-center gap-1.5">
                            <i class="fa-solid fa-rotate"></i>
                            <span>Generate Fresh QR</span>
                        </button>
                    </div>
                `;
                if (deskPill) deskPill.innerText = 'Disconnected';
            }
        }
    } catch (err) {
        console.warn('WhatsApp service notice:', err);
        updateGatewayTelemetryBar(false);
        if (pairingSection) pairingSection.classList.remove('hidden');
        if (sessionActions) sessionActions.classList.remove('hidden');
        const chatsCard = document.getElementById('biz-customer-chats-container');
        if (chatsCard) chatsCard.classList.add('hidden');
        box.innerHTML = `
            <div class="text-center py-8 px-4 space-y-3">
                <div class="w-12 h-12 mx-auto rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 flex items-center justify-center text-lg">
                    <i class="fa-brands fa-whatsapp text-emerald-400"></i>
                </div>
                <div class="space-y-1">
                    <div class="text-xs font-bold text-slate-200">Gateway Socket Standby</div>
                    <div class="text-[11px] text-slate-500">Click below to initialize or switch to 8-Digit Phone Code mode.</div>
                </div>
                <button type="button" onclick="fetchWhatsAppQR()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 rounded-xl text-xs font-bold cursor-pointer transition inline-flex items-center gap-1.5">
                    <i class="fa-solid fa-rotate"></i>
                    <span>Retry Handshake</span>
                </button>
            </div>
        `;
    }
}

// PAIRING MODE SWITCHER
function setPairingMode(mode) {
    const qrBtn = document.getElementById('btn-mode-qr');
    const codeBtn = document.getElementById('btn-mode-code');
    const qrSec = document.getElementById('section-mode-qr');
    const codeSec = document.getElementById('section-mode-code');

    if (mode === 'code') {
        if (codeBtn) codeBtn.className = "flex-1 py-2.5 px-4 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 bg-emerald-500 text-slate-950 shadow-sm cursor-pointer whitespace-nowrap";
        if (qrBtn) qrBtn.className = "flex-1 py-2.5 px-4 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap";
        if (codeSec) codeSec.classList.remove('hidden');
        if (qrSec) qrSec.classList.add('hidden');
        const phoneInput = document.getElementById('biz-pair-phone-input');
        if (phoneInput) setTimeout(() => phoneInput.focus(), 80);
    } else {
        if (qrBtn) qrBtn.className = "flex-1 py-2.5 px-4 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 bg-emerald-500 text-slate-950 shadow-sm cursor-pointer whitespace-nowrap";
        if (codeBtn) codeBtn.className = "flex-1 py-2.5 px-4 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap";
        if (qrSec) qrSec.classList.remove('hidden');
        if (codeSec) codeSec.classList.add('hidden');
    }
}

function copyPairingCode() {
    const codeEl = document.getElementById('eight-digit-code');
    if (!codeEl) return;
    const codeText = codeEl.innerText.replace(/\s+/g, '');
    navigator.clipboard.writeText(codeText).then(() => {
        const btn = document.getElementById('btn-copy-code');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i> <span>Copied</span>';
            setTimeout(() => {
                btn.innerHTML = '<i class="fa-solid fa-copy"></i> <span>Copy Code</span>';
            }, 2000);
        }
        showWhatsAppNotice('8-digit pairing code copied to clipboard!');
    }).catch(() => {});
}

// 4. PAIR WITH 8-DIGIT CODE
async function pairWithEightDigitCode() {
    const phoneInput = document.getElementById('biz-pair-phone-input');
    let phone = phoneInput ? phoneInput.value.trim().replace(/\D/g, '') : '';
    if (!phone) {
        showWhatsAppNotice('Please enter your WhatsApp phone number with country code (e.g. 919876543210)', 'error');
        return;
    }
    if (phone.length === 10 && ['6', '7', '8', '9'].includes(phone[0])) {
        phone = '91' + phone;
        if (phoneInput) phoneInput.value = phone;
    }

    const username = getActiveUsername() || 'user';
    const btn = document.getElementById('btn-request-pairing-code') || document.querySelector('button[onclick="pairWithEightDigitCode()"]');
    const originalBtnHtml = btn ? btn.innerHTML : 'Generate 8-Digit Pairing Code';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Generating Code...</span>`;
    }

    try {
        const res = await fetch('/api/whatsapp/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, username })
        });
        const data = await res.json();
        if (data.code) {
            const display = document.getElementById('eight-digit-display-box');
            const codeEl = document.getElementById('eight-digit-code');
            if (display) display.classList.remove('hidden');
            if (codeEl) codeEl.innerText = data.code;

            const deskPill = document.getElementById('biz-wa-status-text');
            if (deskPill) deskPill.innerText = 'Pairing Active';
            showWhatsAppNotice('8-digit code generated! Enter it in WhatsApp Linked Devices.');
            startFastPairingChecker();
        } else {
            const display = document.getElementById('eight-digit-display-box');
            if (display) display.classList.add('hidden');
            showWhatsAppNotice(data.message || data.error || 'Failed to generate pairing code.', 'error');
        }
    } catch (err) {
        showWhatsAppNotice('Unable to generate pairing code. Please try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtnHtml;
        }
    }
}

// 5. UNLINK WHATSAPP DEVICE
async function unlinkWhatsAppDevice() {
    if (!confirm('Are you sure you want to disconnect and unlink this WhatsApp session?')) return;
    const username = getActiveUsername();
    try {
        await fetch('/api/whatsapp/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        backToContactList();
        const chatsCard = document.getElementById('biz-customer-chats-container');
        if (chatsCard) chatsCard.classList.add('hidden');
        const deskPill = document.getElementById('biz-wa-status-text');
        if (deskPill) deskPill.innerText = 'Disconnected';
        const codeDisplay = document.getElementById('eight-digit-display-box');
        if (codeDisplay) codeDisplay.classList.add('hidden');
        fetchWhatsAppQR();
        loadUserProfile();
        showWhatsAppNotice('WhatsApp session disconnected successfully.');
    } catch (err) {
        try {
            await fetch('/api/whatsapp/unlink', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            backToContactList();
            fetchWhatsAppQR();
            showWhatsAppNotice('WhatsApp unlinked successfully.');
        } catch (e) {
            showWhatsAppNotice('Failed to disconnect WhatsApp.', 'error');
        }
    }
}

// --- 5C. LIVE CUSTOMER ORDER & PAYMENT FORM STATE ---
async function loadCustomerOrderState(phone) {
    const banner = document.getElementById('chat-customer-order-banner');
    if (!banner) return;
    const cleanPhone = String(phone).replace(/\D/g, '');
    const username = getActiveUsername();

    try {
        const res = await fetch(`/api/customer/order-state?username=${encodeURIComponent(username)}&customer_phone=${encodeURIComponent(cleanPhone)}`);
        const data = await res.json();
        const order = data?.order;
        currentLoadedOrderState = order;

        if (!order || (!order.customer_name && !order.delivery_address && (!order.items || order.items.length === 0) && (!order.total_amount || order.total_amount <= 0))) {
            banner.classList.add('hidden');
            return;
        }

        banner.classList.remove('hidden');
        const nameEl = document.getElementById('order-customer-name');
        const ordIdEl = document.getElementById('order-id-badge');
        const summaryEl = document.getElementById('order-summary-text');
        const addrEl = document.getElementById('order-address-text');
        const modeBadge = document.getElementById('order-payment-mode-badge');
        const statusBadge = document.getElementById('order-payment-status-badge');
        const btnPaid = document.getElementById('btn-toggle-paid');

        if (nameEl) nameEl.innerText = order.customer_name || 'Customer Inquiry';
        if (ordIdEl) ordIdEl.innerText = order.order_id ? `#${order.order_id}` : '';

        let itemsStr = 'No items';
        if (Array.isArray(order.items) && order.items.length > 0) {
            itemsStr = order.items.map(it => `${it.name || it.item || 'Item'} (x${it.qty || 1})`).join(', ');
        }
        const amt = parseFloat(order.total_amount) || 0;
        if (summaryEl) summaryEl.innerText = `${itemsStr} · Total: ₹${amt}`;

        const addr = order.delivery_address || '';
        const delPhone = order.delivery_phone || cleanPhone;
        if (addrEl) addrEl.innerText = addr ? `${addr} (${delPhone})` : 'Delivery address not provided yet';

        const isOnline = String(order.payment_mode).toLowerCase() === 'online';
        if (modeBadge) {
            modeBadge.innerText = isOnline ? 'ONLINE (UPI)' : 'COD';
            modeBadge.className = isOnline
                ? 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-300 border border-indigo-500/30'
                : 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700';
        }

        const isPaid = String(order.payment_status).toLowerCase() === 'paid';
        if (statusBadge) {
            statusBadge.innerText = isPaid ? 'PAID' : 'UNPAID';
            statusBadge.className = isPaid
                ? 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30';
        }

        if (btnPaid) {
            btnPaid.style.display = isPaid ? 'none' : 'inline-flex';
        }
    } catch (err) {
        console.warn('Failed to load customer order state:', err);
        banner.classList.add('hidden');
    }
}

async function toggleOrderPaymentPaid() {
    if (!currentActiveChatPhone) return;
    const username = getActiveUsername();
    const btn = document.getElementById('btn-toggle-paid');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/customer/order-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                customer_phone: currentActiveChatPhone,
                order_data: {
                    ...(currentLoadedOrderState || {}),
                    payment_status: 'paid',
                    order_status: 'confirmed'
                }
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadCustomerOrderState(currentActiveChatPhone);
            showWhatsAppNotice('Order marked as Paid!');
        }
    } catch (e) {
        showWhatsAppNotice('Failed to update payment status.', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// --- 5B. LIVE CUSTOMER CHATS & DB LAST 10 CHATS MANAGER ---
function formatPhoneNumberDisplay(phone) {
    const clean = String(phone).replace(/\D/g, '');
    if (!clean) {
        return 'Customer';
    }
    if (clean.length === 12 && clean.startsWith('91')) {
        return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
    }
    if (clean.length === 10 && ['6', '7', '8', '9'].includes(clean[0])) {
        return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`;
    }
    return `+${clean}`;
}

function renderFilteredContactsList() {
    const listEl = document.getElementById('chat-contact-list');
    if (!listEl) return;

    const searchQuery = (document.getElementById('chat-contact-search')?.value || '').toLowerCase().trim();
    const filtered = cachedConversationsList.filter(c => {
        if (!searchQuery) return true;
        const ph = String(c.customer_phone || '').toLowerCase();
        const msg = String(c.last_message || '').toLowerCase();
        return ph.includes(searchQuery) || msg.includes(searchQuery);
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="p-8 rounded-2xl bg-slate-950 border border-slate-800/80 text-slate-500 text-xs text-center leading-relaxed">
                <i class="fa-solid fa-inbox text-2xl text-slate-700 mb-2 block"></i>
                <p class="font-bold text-slate-300">${cachedConversationsList.length === 0 ? 'No Inbound Customer Chats Yet' : 'No Matching Contacts'}</p>
                <p class="text-[11px] text-slate-500 mt-1">When customers message your linked WhatsApp number, their real-time conversation threads appear here automatically.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(c => {
        const formattedPhone = formatPhoneNumberDisplay(c.customer_phone);
        const lastMsg = escapeHtml(c.last_message || 'Inbound customer message');

        return `
            <button type="button" onclick="openCustomerChat('${escapeHtml(c.customer_phone)}')" class="w-full p-3.5 rounded-xl text-left transition cursor-pointer flex items-center justify-between border bg-slate-950 hover:bg-slate-900/90 border-slate-800/80 hover:border-emerald-500/40 text-slate-300 group">
                <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="w-10 h-10 rounded-xl bg-slate-900 group-hover:bg-emerald-500/10 text-emerald-400 border border-slate-800 group-hover:border-emerald-500/30 flex items-center justify-center text-sm font-mono shrink-0 transition">
                        <i class="fa-solid fa-user"></i>
                    </div>
                    <div class="truncate">
                        <div class="font-mono font-bold text-xs flex items-center gap-2 text-white group-hover:text-emerald-300 transition tabular-nums">
                            <span>${formattedPhone}</span>
                        </div>
                        <div class="text-[11px] text-slate-400 truncate mt-0.5 font-sans">${lastMsg}</div>
                    </div>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                    <span class="text-[11px] font-mono text-slate-400 tabular-nums">${c.total_count || 1} msgs</span>
                    <span class="text-xs text-slate-500 group-hover:text-emerald-400 transition flex items-center gap-1">
                        <i class="fa-solid fa-chevron-right text-[10px]"></i>
                    </span>
                </div>
            </button>
        `;
    }).join('');
}

async function loadCustomerConversationsList() {
    const listEl = document.getElementById('chat-contact-list');
    if (!listEl) return;
    const username = getActiveUsername();
    try {
        const res = await fetch(`/api/chats?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        let conversations = data.conversations || [];

        conversations = conversations.filter(c => {
            const phoneStr = String(c.customer_phone || '').replace(/\D/g, '');
            return phoneStr.length >= 8 && !phoneStr.startsWith('120363');
        });

        cachedConversationsList = conversations;

        const counterEl = document.getElementById('chat-contacts-counter');
        if (counterEl) counterEl.innerText = `${conversations.length} Active`;

        renderFilteredContactsList();

        if (currentActiveChatPhone) {
            loadCustomerChatHistory(currentActiveChatPhone);
        }
    } catch (err) {
        console.warn('Failed to fetch customer conversations:', err);
    }
}

function openCustomerChat(phone) {
    const cleanPhone = String(phone).replace(/\D/g, '');
    currentActiveChatPhone = cleanPhone;
    const contactsView = document.getElementById('chat-contacts-view');
    const convoView = document.getElementById('chat-conversation-view');
    if (contactsView) contactsView.classList.add('hidden');
    if (convoView) {
        convoView.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
    const titleEl = document.getElementById('chat-active-phone');
    if (titleEl) {
        titleEl.innerHTML = formatPhoneNumberDisplay(cleanPhone);
    }
    loadCustomerChatHistory(cleanPhone);
    loadCustomerOrderState(cleanPhone);
    const input = document.getElementById('chat-reply-text');
    if (input) {
        setTimeout(() => input.focus(), 150);
    }
}

function backToContactList() {
    currentActiveChatPhone = '';
    const contactsView = document.getElementById('chat-contacts-view');
    const convoView = document.getElementById('chat-conversation-view');
    if (convoView) {
        convoView.classList.add('hidden');
        document.body.style.overflow = '';
    }
    if (contactsView) contactsView.classList.remove('hidden');
    loadCustomerConversationsList();
}

function selectCustomerChat(phone) {
    openCustomerChat(phone);
}

async function loadCustomerChatHistory(phone) {
    const box = document.getElementById('chat-messages-box');
    if (!box) return;
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (!cleanPhone) {
        box.innerHTML = `<div class="text-center text-slate-500 py-12">Select a customer from the list to view their conversation thread.</div>`;
        return;
    }

    const username = getActiveUsername();
    box.innerHTML = `<div class="text-center text-emerald-400 py-12"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading conversation history...</div>`;

    try {
        const res = await fetch(`/api/chats/messages?username=${encodeURIComponent(username)}&phone=${encodeURIComponent(cleanPhone)}`);
        const data = await res.json();
        const messages = data.messages || [];

        if (messages.length === 0) {
            box.innerHTML = `<div class="text-center text-slate-500 py-12">No chat history recorded yet for ${formatPhoneNumberDisplay(cleanPhone)}.</div>`;
            return;
        }

        box.innerHTML = messages.map(m => {
            const isUser = m.role === 'customer' || m.role === 'user';
            const rawMsg = m.text || m.message_text || '';
            const parsedHtml = (typeof marked !== 'undefined' && marked.parse) ? marked.parse(rawMsg) : rawMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            const timeStr = m.time || 'Recent';

            return `
                <div class="flex flex-col ${isUser ? 'items-start' : 'items-end'} mb-2">
                    <div class="max-w-[88%] sm:max-w-[72%] p-3 rounded-lg text-xs shadow-sm ${isUser ? 'bg-[#202c33] text-[#e9edef] rounded-tl-none border border-[#2a3942]/60' : 'bg-[#005c4b] text-[#e9edef] rounded-tr-none border border-[#00755f]/60'}">
                        <div class="text-xs leading-relaxed font-sans break-words whitespace-pre-wrap select-text">${parsedHtml}</div>
                        <div class="text-[10px] font-mono mt-1 tabular-nums ${isUser ? 'text-slate-400' : 'text-emerald-200/80'} flex items-center justify-end gap-1 select-none">
                            <span>${timeStr}</span>
                            ${!isUser ? '<i class="fa-solid fa-check-double text-[10px] text-[#53bdeb]"></i>' : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        box.scrollTop = box.scrollHeight;
    } catch (err) {
        box.innerHTML = `<div class="text-center text-rose-400 py-12">Error loading chat history from database.</div>`;
    }
}

function showChatTypingIndicator() {
    const box = document.getElementById('chat-messages-box');
    if (!box || document.getElementById('chat-typing-indicator')) return;
    const typingDiv = document.createElement('div');
    typingDiv.id = 'chat-typing-indicator';
    typingDiv.className = 'flex items-center gap-2 p-3 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 w-fit my-1.5';
    typingDiv.innerHTML = `
        <span class="text-[10px] font-mono text-slate-400">AI Responder is composing reply...</span>
    `;
    box.appendChild(typingDiv);
    box.scrollTop = box.scrollHeight;
}

function hideChatTypingIndicator() {
    const ind = document.getElementById('chat-typing-indicator');
    if (ind) ind.remove();
}

function refreshActiveChatMessages() {
    if (currentActiveChatPhone) {
        loadCustomerChatHistory(currentActiveChatPhone);
    } else {
        loadCustomerConversationsList();
    }
}

async function sendDirectChatReply() {
    const input = document.getElementById('chat-reply-text');
    const message = input ? input.value.trim() : '';
    if (!message || !currentActiveChatPhone) return;

    const username = getActiveUsername();
    input.value = '';
    input.focus();

    const box = document.getElementById('chat-messages-box');
    const tempId = 'temp-msg-' + Date.now();
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    if (box) {
        const bubble = document.createElement('div');
        bubble.id = tempId;
        bubble.className = 'flex flex-col items-end mb-2';
        const safeText = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        bubble.innerHTML = `
            <div class="max-w-[88%] sm:max-w-[72%] p-3 rounded-lg rounded-tr-none text-xs bg-[#005c4b] text-[#e9edef] shadow-sm border border-[#00755f]/60">
                <div class="text-xs leading-relaxed font-sans break-words whitespace-pre-wrap select-text">${safeText}</div>
                <div class="text-[10px] text-emerald-200/80 font-mono mt-1 tabular-nums flex items-center justify-end gap-1 select-none">
                    <span>${nowTime}</span>
                    <i class="fa-regular fa-clock text-[10px] text-emerald-300 temp-tick"></i>
                </div>
            </div>
        `;
        box.appendChild(bubble);
        box.scrollTop = box.scrollHeight;
    }

    try {
        await fetch('/api/chats/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, phone: currentActiveChatPhone, message })
        });

        const tempEl = document.getElementById(tempId);
        if (tempEl) {
            const tick = tempEl.querySelector('.temp-tick');
            if (tick) {
                tick.className = 'fa-solid fa-check-double text-[10px] text-[#53bdeb]';
            }
        }
    } catch (err) {
        console.error('Error sending message:', err);
        const tempEl = document.getElementById(tempId);
        if (tempEl) {
            const tick = tempEl.querySelector('.temp-tick');
            if (tick) {
                tick.className = 'fa-solid fa-circle-exclamation text-[10px] text-rose-400';
                tick.title = 'Message delivery issue';
            }
        }
    }
}

// 14. REAL-TIME WHATSAPP SESSION & CHAT SSE LISTENER
function initLiveChatStream() {
    const username = getActiveUsername();
    if (!username) return;

    if (window._chatEventSource) {
        try { window._chatEventSource.close(); } catch {}
    }

    try {
        const es = new EventSource(`/api/chat/stream?username=${encodeURIComponent(username)}`);
        window._chatEventSource = es;

        es.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                if (['incoming', 'outgoing', 'outgoing_ai', 'outgoing_manual', 'lead_alert'].includes(data.type)) {
                    loadCustomerConversationsList();
                    if (data.phone && currentActiveChatPhone === data.phone) {
                        loadCustomerChatHistory(data.phone);
                    }
                } else if (data.type === 'session_unlinked') {
                    const deskPill = document.getElementById('biz-wa-status-text');
                    if (deskPill) deskPill.innerText = 'Disconnected';
                    const display = document.getElementById('eight-digit-display-box');
                    if (display) display.classList.add('hidden');
                    const chatsCard = document.getElementById('biz-customer-chats-container');
                    if (chatsCard) chatsCard.classList.add('hidden');
                    backToContactList();
                    fetchWhatsAppQR();
                    loadUserProfile();
                } else if (data.type === 'session_connected') {
                    const chatsCard = document.getElementById('biz-customer-chats-container');
                    if (chatsCard) chatsCard.classList.remove('hidden');
                    fetchWhatsAppQR();
                    loadUserProfile();
                }
            } catch (e) {}
        };
    } catch (err) {}
}

export function getWhatsAppConnectHTML() {
    return `                <div id="view-connect" class="biz-tab-content max-w-6xl mx-auto space-y-6">

                    <!-- TOP TELEMETRY & SESSION ARCHITECTURE STRIP -->
                    <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div class="space-y-1">
                            <div class="text-xs font-medium text-slate-400 flex items-center gap-2">
                                <span>WhatsApp Multi-Device Gateway</span>
                                <span aria-hidden="true">·</span>
                                <span class="font-mono text-emerald-400">Direct WebSocket Bridge</span>
                            </div>
                            <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">WhatsApp Business Link & Live Session Control</h2>
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-800">
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Connection State</span>
                                <span id="wa-gateway-state-label" class="text-sm font-bold text-amber-400 font-mono tabular-nums">Checking...</span>
                            </div>
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Linked WhatsApp ID</span>
                                <span id="wa-gateway-jid-label" class="text-sm font-bold text-white font-mono tabular-nums">No device linked</span>
                            </div>
                            <div class="bg-slate-950/80 border border-slate-800/80 rounded-xl px-4 py-2.5">
                                <span class="text-[11px] text-slate-400 block">Automation Pipeline</span>
                                <span id="wa-gateway-mode-label" class="text-xs font-semibold text-slate-300">24/7 AI & Order Sync</span>
                            </div>
                        </div>
                    </div>

                    <!-- CONNECTED STATE HERO BANNER (SHOWN WHEN ACCOUNT IS LINKED) -->
                    <div id="biz-connected-hero-card" class="hidden bg-slate-900/90 border border-emerald-500/30 rounded-2xl p-6">
                        <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                            <div class="flex items-center gap-4">
                                <div class="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-xl shrink-0">
                                    <i class="fa-brands fa-whatsapp"></i>
                                </div>
                                <div>
                                    <div class="flex items-center gap-2.5">
                                        <h3 class="text-base font-bold text-white">WhatsApp Device Active & Synchronized</h3>
                                        <span class="text-xs font-mono text-emerald-400" id="biz-connected-jid-display">+91 Connected</span>
                                    </div>
                                    <p class="text-xs text-slate-400 mt-1">Inbound customer messages, AI auto-replies, and catalog orders are actively routing through this session.</p>
                                </div>
                            </div>
                            <div class="flex items-center gap-2.5 shrink-0 w-full md:w-auto justify-end">
                                <button type="button" onclick="fetchWhatsAppQR()" class="px-4 py-2 bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-2 whitespace-nowrap">
                                    <i class="fa-solid fa-rotate text-emerald-400"></i>
                                    <span>Verify Sync</span>
                                </button>
                                <button type="button" onclick="unlinkWhatsAppDevice()" class="px-4 py-2 bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/60 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-2 whitespace-nowrap">
                                    <i class="fa-solid fa-link-slash"></i>
                                    <span>Disconnect Device</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- 2-COLUMN PAIRING WORKSPACE (SHOWN WHEN DISCONNECTED) -->
                    <div id="biz-pairing-section" class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">

                        <!-- LEFT COLUMN (7 COLS): INTERACTIVE QR & 8-DIGIT PAIRING TERMINAL -->
                        <div class="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-6">
                            <div class="space-y-5">
                                <!-- Top Bar: Title + Segmented Mode Switcher -->
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
                                    <div>
                                        <h3 class="text-base font-bold text-white">Select Pairing Method</h3>
                                        <p class="text-xs text-slate-400 mt-0.5">Choose instant QR scan or 8-digit phone number verification</p>
                                    </div>

                                    <!-- Segmented Control -->
                                    <div class="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl shrink-0">
                                        <button type="button" id="btn-mode-qr" onclick="setPairingMode('qr')" class="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 bg-emerald-500 text-slate-950 shadow-sm cursor-pointer whitespace-nowrap">
                                            <i class="fa-solid fa-qrcode"></i>
                                            <span>Scan QR Code</span>
                                        </button>
                                        <button type="button" id="btn-mode-code" onclick="setPairingMode('code')" class="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold text-slate-400 hover:text-white transition flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap">
                                            <i class="fa-solid fa-keyboard"></i>
                                            <span>8-Digit Phone Code</span>
                                        </button>
                                    </div>
                                </div>

                                <!-- MODE 1: QR CODE VIEWPORT -->
                                <div id="section-mode-qr" class="space-y-4">
                                    <div class="min-h-[270px] w-full bg-slate-950/90 p-6 rounded-2xl border border-slate-800 flex items-center justify-center">
                                        <div id="biz-qrcode-box" class="w-full"></div>
                                    </div>
                                </div>

                                <!-- MODE 2: 8-DIGIT PHONE PAIRING VIEWPORT -->
                                <div id="section-mode-code" class="hidden space-y-5">
                                    <div class="p-5 rounded-2xl bg-slate-950/90 border border-slate-800 space-y-4">
                                        <div>
                                            <div class="flex items-center justify-between mb-1.5">
                                                <label for="biz-pair-phone-input" class="text-xs font-semibold text-slate-200">WhatsApp Mobile Number (with Country Code)</label>
                                                <span class="text-[11px] text-emerald-400 font-mono">Format: 919876543210</span>
                                            </div>
                                            <div class="relative">
                                                <span class="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-500 font-mono text-xs">+</span>
                                                <input type="text" id="biz-pair-phone-input" placeholder="919876543210" onkeydown="if(event.key==='Enter'){event.preventDefault();pairWithEightDigitCode();}" class="w-full pl-8 pr-4 py-3 bg-slate-900 border border-slate-800 rounded-xl text-sm font-mono text-white outline-none focus:border-emerald-500 transition tabular-nums">
                                            </div>
                                            <p class="text-[11px] text-slate-400 mt-1.5">Enter your 10-digit mobile number prefixed with country code (e.g. <span class="font-mono text-slate-300">91</span> for India).</p>
                                        </div>

                                        <button type="button" id="btn-request-pairing-code" onclick="pairWithEightDigitCode()" class="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-sm whitespace-nowrap">
                                            <i class="fa-solid fa-key"></i>
                                            <span>Generate 8-Digit Pairing Code</span>
                                        </button>

                                        <!-- 8-Digit Code Output Box -->
                                        <div id="eight-digit-display-box" class="hidden pt-4 border-t border-slate-800 space-y-3">
                                            <div class="flex items-center justify-between">
                                                <span class="text-xs font-semibold text-slate-300">Generated Verification Code</span>
                                                <span class="text-[11px] font-mono text-emerald-400">Valid for 60 seconds</span>
                                            </div>
                                            <div class="flex items-center justify-between gap-3 p-3.5 bg-slate-900 border border-emerald-500/40 rounded-xl">
                                                <div id="eight-digit-code" class="text-2xl sm:text-3xl font-black text-emerald-300 font-mono tracking-widest tabular-nums">--------</div>
                                                <button type="button" onclick="copyPairingCode()" id="btn-copy-code" class="px-3.5 py-2 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap">
                                                    <i class="fa-solid fa-copy"></i>
                                                    <span>Copy Code</span>
                                                </button>
                                            </div>
                                            <p class="text-xs text-slate-400">On your phone, tap the WhatsApp notification <strong class="text-white">"Enter code to link new device"</strong> and type the 8-digit code shown above.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Session Action Controls -->
                            <div id="biz-session-actions" class="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
                                <button type="button" onclick="fetchWhatsAppQR()" class="px-4 py-2.5 bg-slate-950 hover:bg-slate-800 text-slate-200 rounded-xl text-xs font-semibold border border-slate-800 cursor-pointer flex items-center gap-2 transition whitespace-nowrap">
                                    <i class="fa-solid fa-arrows-rotate text-emerald-400"></i>
                                    <span>Refresh QR / Status</span>
                                </button>
                                <button type="button" onclick="unlinkWhatsAppDevice()" class="px-4 py-2.5 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 rounded-xl text-xs font-semibold border border-rose-900/60 cursor-pointer flex items-center gap-2 transition whitespace-nowrap">
                                    <i class="fa-solid fa-link-slash"></i>
                                    <span>Reset Session</span>
                                </button>
                            </div>
                        </div>

                        <!-- RIGHT COLUMN (5 COLS): GUIDED SETUP PROTOCOL & ARCHITECTURE SPECS -->
                        <div class="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-6">
                            <div class="space-y-5">
                                <div class="pb-4 border-b border-slate-800">
                                    <h3 class="text-base font-bold text-white">Device Linking Protocol</h3>
                                    <p class="text-xs text-slate-400 mt-0.5">Follow these 4 steps on your mobile phone to authorize 24/7 automation</p>
                                </div>

                                <div class="space-y-4">
                                    <div class="flex items-start gap-3.5">
                                        <span class="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center shrink-0 tabular-nums">01</span>
                                        <div>
                                            <h4 class="text-xs font-bold text-white">Open WhatsApp or WhatsApp Business</h4>
                                            <p class="text-xs text-slate-400 mt-0.5 leading-relaxed">Launch the app on your primary Android or iPhone device.</p>
                                        </div>
                                    </div>

                                    <div class="flex items-start gap-3.5">
                                        <span class="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center shrink-0 tabular-nums">02</span>
                                        <div>
                                            <h4 class="text-xs font-bold text-white">Navigate to Linked Devices</h4>
                                            <p class="text-xs text-slate-400 mt-0.5 leading-relaxed">Tap <strong class="text-slate-200">Menu ⋮</strong> on Android or <strong class="text-slate-200">Settings ⚙️</strong> on iPhone, then select <strong class="text-slate-200">Linked Devices</strong>.</p>
                                        </div>
                                    </div>

                                    <div class="flex items-start gap-3.5">
                                        <span class="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center shrink-0 tabular-nums">03</span>
                                        <div>
                                            <h4 class="text-xs font-bold text-white">Scan QR or Link with Phone Number</h4>
                                            <p class="text-xs text-slate-400 mt-0.5 leading-relaxed">Tap <strong class="text-slate-200">Link a Device</strong> and scan the QR code, or tap <strong class="text-slate-200">"Link with phone number instead"</strong> to enter the 8-digit code.</p>
                                        </div>
                                    </div>

                                    <div class="flex items-start gap-3.5">
                                        <span class="w-7 h-7 rounded-lg bg-slate-950 border border-slate-800 text-emerald-400 font-mono text-xs font-bold flex items-center justify-center shrink-0 tabular-nums">04</span>
                                        <div>
                                            <h4 class="text-xs font-bold text-white">Cloud AI & Storefront Sync Activated</h4>
                                            <p class="text-xs text-slate-400 mt-0.5 leading-relaxed">Once linked, AI Lead Responder and Catalog Order replies operate 24/7 even when your phone screen is off.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="p-4 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2">
                                <div class="text-xs font-bold text-slate-200 flex items-center justify-between">
                                    <span>Session Security & Persistence</span>
                                    <span class="text-[11px] font-mono text-emerald-400">TLS 1.3 · Neon DB</span>
                                </div>
                                <p class="text-[11px] text-slate-400 leading-relaxed">Device credentials are stored in your isolated multi-tenant session store. You can revoke access anytime from this dashboard or directly from your phone.</p>
                            </div>
                        </div>
                    </div>

                    <!-- LIVE CUSTOMER CHATS & CONTACTS CARD (VISIBLE WHEN WHATSAPP IS LINKED) -->
                    <div id="biz-customer-chats-container" class="bg-slate-900/90 p-6 rounded-2xl border border-slate-800 space-y-5 text-left hidden">
                        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
                            <div>
                                <h3 class="text-base font-bold text-white flex items-center gap-2">
                                    <i class="fa-solid fa-comments text-emerald-400"></i>
                                    <span>Live Customer Conversations</span>
                                </h3>
                                <p class="text-xs text-slate-400 mt-0.5">Real-time customer threads synced with AI Responder & Storefront Order State.</p>
                            </div>
                            <div class="flex items-center gap-3 text-xs text-slate-400">
                                <span id="chat-contacts-counter" class="font-mono font-bold text-emerald-400 tabular-nums">0 Active</span>
                                <span aria-hidden="true">·</span>
                                <button type="button" onclick="loadCustomerConversationsList()" class="px-3 py-1.5 bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 rounded-xl text-xs font-semibold cursor-pointer transition flex items-center gap-1.5 whitespace-nowrap">
                                    <i class="fa-solid fa-rotate text-emerald-400"></i>
                                    <span>Refresh Inbox</span>
                                </button>
                            </div>
                        </div>

                        <!-- 1. Customer Contacts List View -->
                        <div id="chat-contacts-view" class="space-y-4">
                            <div class="relative">
                                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-500 text-xs"></i>
                                <input type="text" id="chat-contact-search" oninput="renderFilteredContactsList()" placeholder="Search customer phone number or message preview..." class="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-emerald-500">
                            </div>

                            <div id="chat-contact-list" class="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                                <div class="p-6 rounded-xl bg-slate-950 border border-slate-800 text-slate-500 text-xs text-center">
                                    Loading customer conversations...
                                </div>
                            </div>
                        </div>

                        <!-- 2. FULL-SCREEN WhatsApp Chatting Area -->
                        <div id="chat-conversation-view" class="hidden fixed inset-0 z-[9999] w-full h-[100dvh] max-h-[100dvh] flex flex-col bg-[#0b141a] text-slate-100 overflow-hidden select-none">
                            <!-- WhatsApp Top Header Bar -->
                            <div class="px-3 sm:px-4 py-2.5 bg-[#202c33] border-b border-[#2a3942] flex items-center justify-between gap-3 shrink-0 shadow-md">
                                <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
                                    <button type="button" onclick="backToContactList()" class="w-9 h-9 rounded-full hover:bg-slate-700/60 text-slate-300 hover:text-white flex items-center justify-center cursor-pointer transition shrink-0" title="Back to Contacts list">
                                        <i class="fa-solid fa-arrow-left text-base"></i>
                                    </button>
                                    <div class="relative w-10 h-10 rounded-full bg-[#111b21] border border-[#2a3942] flex items-center justify-center text-slate-300 shrink-0">
                                        <i class="fa-solid fa-user text-base text-emerald-400"></i>
                                    </div>
                                    <div class="truncate">
                                        <div id="chat-active-phone" class="text-sm font-bold text-white font-mono truncate tracking-tight tabular-nums">+91 ...</div>
                                        <div class="text-[11px] text-emerald-400 font-sans">WhatsApp Business Session Active</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
                                    <button type="button" onclick="refreshActiveChatMessages()" class="w-9 h-9 rounded-full hover:bg-slate-700/60 text-slate-300 hover:text-emerald-400 flex items-center justify-center transition cursor-pointer" title="Refresh messages">
                                        <i class="fa-solid fa-arrows-rotate text-sm"></i>
                                    </button>
                                    <button type="button" onclick="backToContactList()" class="w-9 h-9 rounded-full hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 flex items-center justify-center transition cursor-pointer" title="Close Chat">
                                        <i class="fa-solid fa-xmark text-lg"></i>
                                    </button>
                                </div>
                            </div>

                            <!-- Live Customer Order & Payment Tracking Banner -->
                            <div id="chat-customer-order-banner" class="hidden px-3 sm:px-4 py-2 bg-[#111b21] border-b border-[#2a3942] flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs shadow-inner">
                                <div class="flex items-center gap-2.5 min-w-0">
                                    <div class="w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-amber-400 shrink-0">
                                        <i class="fa-solid fa-cart-shopping text-xs"></i>
                                    </div>
                                    <div class="truncate">
                                        <div class="flex items-center gap-2">
                                            <span class="font-bold text-white" id="order-customer-name">Customer Order</span>
                                            <span id="order-id-badge" class="text-[10px] font-mono text-slate-400">#ORD</span>
                                        </div>
                                        <div class="text-[11px] text-amber-300 font-mono truncate tabular-nums" id="order-summary-text">Items: -- | Total: ₹0</div>
                                        <div class="text-[10px] text-slate-400 truncate" id="order-address-text">Address: Not provided</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 shrink-0">
                                    <span id="order-payment-mode-badge" class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">COD</span>
                                    <span id="order-payment-status-badge" class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">UNPAID</span>
                                    <button type="button" onclick="toggleOrderPaymentPaid()" id="btn-toggle-paid" class="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold cursor-pointer transition flex items-center gap-1 whitespace-nowrap">
                                        <i class="fa-solid fa-check"></i> <span>Mark Paid</span>
                                    </button>
                                </div>
                            </div>

                            <!-- WhatsApp Messages Area -->
                            <div id="chat-messages-box" class="flex-1 p-3 sm:p-5 space-y-2.5 overflow-y-auto bg-[#0b141a]" style="background-image: radial-gradient(rgba(32, 44, 51, 0.4) 1px, transparent 1px); background-size: 20px 20px;">
                                <div class="text-center text-slate-500 py-16">Loading conversation...</div>
                            </div>

                            <!-- WhatsApp Typing Bar -->
                            <div class="bg-[#202c33] px-3 py-2.5 sm:py-3 border-t border-[#2a3942] flex items-center gap-2.5 shrink-0 w-full sticky bottom-0 z-30 shadow-2xl pb-[max(0.6rem,env(safe-area-inset-bottom))]">
                                <input type="text" id="chat-reply-text" placeholder="Type a direct WhatsApp reply..." class="flex-1 px-4 py-3 bg-[#2a3942] text-[#e9edef] placeholder-slate-400 rounded-2xl text-sm outline-none focus:ring-1 focus:ring-emerald-500 border-none transition shadow-inner" onkeydown="if(event.key==='Enter') sendDirectChatReply()" autocomplete="off">
                                <button type="button" onclick="sendDirectChatReply()" id="chat-send-btn" class="w-11 h-11 rounded-full bg-[#00a884] hover:bg-[#008f6f] active:scale-95 text-slate-950 flex items-center justify-center transition cursor-pointer shrink-0 shadow-lg" title="Send (Enter)">
                                    <i class="fa-solid fa-paper-plane text-sm"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>`;
}

const exportedWaFunctions = {
    startFastPairingChecker,
    stopFastPairingChecker,
    fetchWhatsAppQR,
    setPairingMode,
    copyPairingCode,
    pairWithEightDigitCode,
    unlinkWhatsAppDevice,
    loadCustomerOrderState,
    toggleOrderPaymentPaid,
    formatPhoneNumberDisplay,
    renderFilteredContactsList,
    loadCustomerConversationsList,
    openCustomerChat,
    backToContactList,
    selectCustomerChat,
    loadCustomerChatHistory,
    showChatTypingIndicator,
    hideChatTypingIndicator,
    refreshActiveChatMessages,
    sendDirectChatReply,
    initLiveChatStream
};

export function initWhatsAppConnect(apiBaseUrl = "") {
    Object.assign(window, exportedWaFunctions);
    fetchWhatsAppQR();
    loadCustomerConversationsList();
}

export {
    startFastPairingChecker,
    stopFastPairingChecker,
    fetchWhatsAppQR,
    setPairingMode,
    copyPairingCode,
    pairWithEightDigitCode,
    unlinkWhatsAppDevice,
    loadCustomerOrderState,
    toggleOrderPaymentPaid,
    formatPhoneNumberDisplay,
    renderFilteredContactsList,
    loadCustomerConversationsList,
    openCustomerChat,
    backToContactList,
    selectCustomerChat,
    loadCustomerChatHistory,
    showChatTypingIndicator,
    hideChatTypingIndicator,
    refreshActiveChatMessages,
    sendDirectChatReply,
    initLiveChatStream
};

Object.assign(window, exportedWaFunctions);
