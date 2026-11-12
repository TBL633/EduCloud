import { getActiveUsername, escapeHtml, checkBusinessAuth, checkNeonStatus } from "../shared/auth-guard.js";

// Business Portal: Workspace Identity, Account Profile & Security Vault Component

function showProfileToast(msg, type = 'success') {
    const existing = document.getElementById('profile-security-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'profile-security-toast';
    const isSuccess = type === 'success';
    const isWarn = type === 'warn';

    const bgClass = isSuccess
        ? 'bg-emerald-950/95 border-emerald-500/50 text-emerald-200 shadow-emerald-950/60'
        : isWarn
        ? 'bg-amber-950/95 border-amber-500/50 text-amber-200 shadow-amber-950/60'
        : 'bg-rose-950/95 border-rose-500/50 text-rose-200 shadow-rose-950/60';

    const iconClass = isSuccess
        ? 'fa-solid fa-circle-check text-emerald-400'
        : isWarn
        ? 'fa-solid fa-triangle-exclamation text-amber-400'
        : 'fa-solid fa-circle-exclamation text-rose-400';

    toast.className = `fixed bottom-6 right-6 z-50 px-4 py-3 rounded-2xl border text-xs font-bold flex items-center gap-2.5 shadow-2xl transition-all duration-300 ${bgClass}`;
    toast.innerHTML = `<i class="${iconClass} text-sm"></i><span>${escapeHtml(msg)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 300);
    }, 3600);
}

function togglePasswordInput(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const icon = btn ? btn.querySelector('i') : null;
    if (icon) {
        icon.className = isPassword ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }
}

function showPassAlert(msg, type = 'success') {
    const banner = document.getElementById('pass-change-alert');
    const icon = document.getElementById('pass-alert-icon');
    const text = document.getElementById('pass-alert-text');
    if (!banner || !text) return;
    text.innerText = msg;
    if (type === 'success') {
        banner.className = "p-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 bg-emerald-950/80 border border-emerald-500/40 text-emerald-300";
        if (icon) icon.className = "fa-solid fa-circle-check text-emerald-400";
    } else {
        banner.className = "p-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 bg-rose-950/80 border border-rose-500/40 text-rose-300";
        if (icon) icon.className = "fa-solid fa-circle-exclamation text-rose-400";
    }
    banner.classList.remove('hidden');
}

function evaluatePasswordStrength() {
    const newPass = document.getElementById('new-password-input')?.value || '';
    const confirmPass = document.getElementById('confirm-password-input')?.value || '';

    const bar = document.getElementById('pass-strength-bar');
    const label = document.getElementById('pass-strength-label');
    const reqLen = document.getElementById('pass-req-len');
    const reqMix = document.getElementById('pass-req-mix');
    const reqMatch = document.getElementById('pass-req-match');

    const hasLen = newPass.length >= 6;
    const hasMix = /[A-Za-z]/.test(newPass) && /[0-9]/.test(newPass);
    const hasSpecial = /[^A-Za-z0-9]/.test(newPass) || newPass.length >= 10;
    const isMatched = newPass.length > 0 && newPass === confirmPass;

    let score = 0;
    if (hasLen) score++;
    if (hasMix) score++;
    if (hasSpecial) score++;
    if (isMatched) score++;

    if (reqLen) {
        reqLen.className = hasLen
            ? 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1'
            : 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1';
    }
    if (reqMix) {
        reqMix.className = hasMix
            ? 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1'
            : 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1';
    }
    if (reqMatch) {
        reqMatch.className = isMatched
            ? 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1'
            : 'px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1';
    }

    if (!bar || !label) return;
    if (!newPass) {
        bar.style.width = '0%';
        bar.className = 'h-full bg-slate-700 transition-all duration-300';
        label.innerText = 'Not entered';
        label.className = 'text-[10px] font-mono text-slate-500 font-bold';
    } else if (score <= 1) {
        bar.style.width = '28%';
        bar.className = 'h-full bg-rose-500 transition-all duration-300';
        label.innerText = 'Weak';
        label.className = 'text-[10px] font-mono text-rose-400 font-bold';
    } else if (score === 2) {
        bar.style.width = '55%';
        bar.className = 'h-full bg-amber-500 transition-all duration-300';
        label.innerText = 'Fair';
        label.className = 'text-[10px] font-mono text-amber-400 font-bold';
    } else if (score === 3) {
        bar.style.width = '80%';
        bar.className = 'h-full bg-cyan-400 transition-all duration-300';
        label.innerText = 'Good';
        label.className = 'text-[10px] font-mono text-cyan-300 font-bold';
    } else {
        bar.style.width = '100%';
        bar.className = 'h-full bg-emerald-400 transition-all duration-300';
        label.innerText = 'Strong & Matched';
        label.className = 'text-[10px] font-mono text-emerald-400 font-bold';
    }
}

async function saveAccountProfileDetails() {
    const username = getActiveUsername();
    if (!username) return;

    const accountName = document.getElementById('prof-account-name-input')?.value.trim() || '';
    const email = document.getElementById('prof-email-input')?.value.trim() || '';
    const rawPhone = document.getElementById('prof-phone-input')?.value.trim() || '';
    const phone = rawPhone.replace(/[^0-9]/g, '');

    if (!accountName) {
        showProfileToast('Please enter an Account / Workspace Display Name.', 'warn');
        return;
    }

    const btn = document.getElementById('btn-save-account-profile');
    const originalHtml = btn ? btn.innerHTML : 'Save Account Profile';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Saving...</span>';
    }

    try {
        const res = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                account_name: accountName,
                email,
                phone
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            // Update local session cache
            try {
                const cached = JSON.parse(localStorage.getItem('user_data') || '{}');
                cached.account_name = accountName;
                cached.email = email;
                cached.phone = phone;
                localStorage.setItem('user_data', JSON.stringify(cached));
            } catch (e) {
                // ignore storage errors
            }
            showProfileToast('Account Identity & Contact details saved to PostgreSQL!', 'success');
            await loadUserProfile();
        } else {
            showProfileToast(data.message || 'Failed to update account profile.', 'error');
        }
    } catch (err) {
        showProfileToast('Network error saving account profile.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

// Preserved for backward compatibility if invoked externally
async function saveProfileNotificationPhone() {
    const input = document.getElementById('prof-notif-phone-input');
    const notifPhone = input ? input.value.trim().replace(/[^0-9]/g, '') : '';
    const username = getActiveUsername();
    if (!notifPhone) {
        showProfileToast('Configure your Lead Alert Phone inside AI Lead Responder.', 'warn');
        return;
    }
    try {
        const res = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, notification_phone: notifPhone })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showProfileToast('Lead Alert Notification Phone synced!', 'success');
            loadUserProfile();
        }
    } catch (err) {
        showProfileToast('Failed to save notification phone.', 'error');
    }
}

function copyWorkspaceUsername() {
    const username = getActiveUsername();
    if (!username) return;
    navigator.clipboard.writeText(username).then(() => {
        showProfileToast(`Copied username handle @${username}`, 'success');
    }).catch(() => {});
}

function resetPasswordStep1() {
    const curInput = document.getElementById('current-password-input');
    if (curInput) {
        curInput.value = '';
        curInput.disabled = false;
        curInput.focus();
    }
    const vBtn = document.getElementById('btn-verify-current-pass');
    if (vBtn) {
        vBtn.disabled = false;
        vBtn.className = "px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-2 shadow-lg shadow-amber-500/10";
        vBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i><span>Verify Current Password</span>';
    }
    const statusStep = document.getElementById('current-pass-status');
    if (statusStep) {
        statusStep.innerText = 'Step 1 of 2';
        statusStep.className = 'text-[10px] font-mono text-amber-400 font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20';
    }
    const step2 = document.getElementById('new-password-step-container');
    if (step2) step2.classList.add('hidden');

    const alertBox = document.getElementById('pass-change-alert');
    if (alertBox) alertBox.classList.add('hidden');
}

async function loadUserProfile() {
    const username = getActiveUsername();
    if (!username) return;

    const user = JSON.parse(localStorage.getItem('user_data') || '{}');
    const dispName = document.getElementById('prof-display-name');
    const uName = document.getElementById('prof-username');
    const emailEl = document.getElementById('prof-email');
    const phoneEl = document.getElementById('prof-phone-text');
    const typeBadge = document.getElementById('prof-type-badge');
    const monogramEl = document.getElementById('prof-avatar-monogram');

    const accountNameInput = document.getElementById('prof-account-name-input');
    const emailInput = document.getElementById('prof-email-input');
    const phoneInput = document.getElementById('prof-phone-input');
    const usernameInput = document.getElementById('prof-username-readonly');

    const initialTitle = user.account_name || `${username} Workspace`;
    if (dispName) dispName.innerText = initialTitle;
    if (monogramEl) monogramEl.innerText = initialTitle.trim().slice(0, 2).toUpperCase();
    if (uName) uName.innerText = `@${username}`;
    if (usernameInput) usernameInput.value = `@${username}`;
    if (emailEl) emailEl.innerText = user.email || '—';
    if (phoneEl) phoneEl.innerText = user.phone ? `+${String(user.phone).replace(/^\+/, '')}` : 'Not Linked';
    if (accountNameInput && user.account_name) accountNameInput.value = user.account_name;
    if (emailInput && user.email) emailInput.value = user.email;
    if (phoneInput && user.phone) phoneInput.value = String(user.phone).replace(/^\+/, '');
    if (typeBadge) {
        typeBadge.innerText = (user.user_type === 'library_owner' || user.user_type === 'library_partner')
            ? 'Library Partner'
            : 'Business Suite';
    }

    try {
        const res = await fetch(`/api/user/profile?username=${encodeURIComponent(username)}`);
        if (!res.ok) return;
        const data = await res.json();

        const resolvedName = data.account_name || data.business_name || `${data.username} Workspace`;
        if (dispName) dispName.innerText = resolvedName;
        if (monogramEl) monogramEl.innerText = resolvedName.trim().slice(0, 2).toUpperCase();
        if (uName) uName.innerText = `@${data.username}`;
        if (usernameInput) usernameInput.value = `@${data.username}`;

        if (emailEl) emailEl.innerText = data.email || 'Not Set';
        if (phoneEl) phoneEl.innerText = data.phone ? `+${String(data.phone).replace(/^\+/, '')}` : 'Not Linked';

        if (accountNameInput) accountNameInput.value = data.account_name || data.business_name || '';
        if (emailInput) emailInput.value = data.email || '';
        if (phoneInput) phoneInput.value = data.phone ? String(data.phone).replace(/^\+/, '') : '';

        const roleLabel = (data.user_type === 'library_owner' || data.user_type === 'library_partner')
            ? 'Library Partner'
            : 'Business Suite';
        if (typeBadge) typeBadge.innerText = roleLabel;
        const planTitleEl = document.getElementById('prof-plan-title');
        if (planTitleEl) planTitleEl.innerText = roleLabel;

        const statusPill = document.getElementById('prof-status-pill');
        if (statusPill) {
            const st = data.wa_status || data.status || 'Disconnected';
            statusPill.innerText = st;
            if (st === 'Connected') {
                statusPill.className = "px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono";
            } else if (st === 'Pairing' || st === 'QR_Ready') {
                statusPill.className = "px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono";
            } else {
                statusPill.className = "px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 font-mono";
            }
        }

        const aiProv = document.getElementById('prof-ai-provider');
        const providerText = `${data.ai_provider || 'Groq'} · ${data.ai_model || 'llama-3.3-70b-versatile'}`;
        if (aiProv) aiProv.innerText = providerText;

        const createdAt = document.getElementById('prof-created-at');
        if (createdAt) createdAt.innerText = data.created_at || 'Active Tenant';

        // Connected Ecosystem Summary Cards (Read-only organized pointers, no duplicate forms)
        const storeSlug = data.store_slug || data.username || username;
        const storeNameSum = document.getElementById('prof-store-name-summary');
        const storeSlugSum = document.getElementById('prof-store-slug-summary');
        const upiSum = document.getElementById('prof-upi-summary');
        const aiModelSum = document.getElementById('prof-ai-model-summary');
        const leadAlertSum = document.getElementById('prof-lead-alert-summary');

        if (storeNameSum) storeNameSum.innerText = data.business_name || resolvedName;
        if (storeSlugSum) storeSlugSum.innerText = `/${storeSlug}`;
        if (upiSum) {
            upiSum.innerText = data.paytm_vpa
                ? `UPI: ${data.paytm_vpa}`
                : (data.allow_cod !== false ? 'COD Enabled (No UPI VPA)' : 'Payment Setup Pending');
        }
        if (aiModelSum) aiModelSum.innerText = providerText;
        if (leadAlertSum) {
            leadAlertSum.innerText = data.notification_phone
                ? `Alerts -> +${String(data.notification_phone).replace(/^\+/, '')}`
                : 'No Lead Alert Number Set';
        }
    } catch (err) {
        console.warn('Failed to load profile details:', err);
    }
}

async function verifyCurrentPassword() {
    const username = getActiveUsername();
    const currentPassInput = document.getElementById('current-password-input');
    const verifyBtn = document.getElementById('btn-verify-current-pass');
    const statusStep = document.getElementById('current-pass-status');
    const currentPassword = currentPassInput ? currentPassInput.value.trim() : '';

    if (!currentPassword) {
        showPassAlert('Please enter your current password first.', 'error');
        return;
    }

    const originalBtnHtml = verifyBtn ? verifyBtn.innerHTML : 'Verify';
    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Verifying...</span>';
    }

    try {
        const res = await fetch('/api/user/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, current_password: currentPassword })
        });
        const data = await res.json();
        if (res.ok && data.verified) {
            showPassAlert(data.message || 'Current password verified! You can now set your new password below.', 'success');
            if (currentPassInput) currentPassInput.disabled = true;
            if (verifyBtn) {
                verifyBtn.className = "px-4 py-2.5 bg-emerald-500/20 text-emerald-300 font-bold rounded-xl text-xs border border-emerald-500/40 flex items-center gap-2";
                verifyBtn.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i><span>Verified</span>';
            }
            if (statusStep) {
                statusStep.innerText = 'Step 1 Verified ✓';
                statusStep.className = 'text-[10px] font-mono text-emerald-400 font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30';
            }
            const step2 = document.getElementById('new-password-step-container');
            if (step2) {
                step2.classList.remove('hidden');
                document.getElementById('new-password-input')?.focus();
            }
        } else {
            showPassAlert(data.message || data.error || 'Current password is incorrect. Please try again.', 'error');
        }
    } catch (err) {
        showPassAlert('Verification failed. Please check your network connection.', 'error');
    } finally {
        if (verifyBtn && !document.getElementById('current-password-input')?.disabled) {
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = originalBtnHtml;
        }
    }
}

async function saveNewPassword() {
    const username = getActiveUsername();
    const currentPass = document.getElementById('current-password-input')?.value.trim();
    const newPass = document.getElementById('new-password-input')?.value.trim();
    const confirmPass = document.getElementById('confirm-password-input')?.value.trim();
    const saveBtn = document.getElementById('btn-save-new-pass');

    if (!newPass || !confirmPass) {
        showPassAlert('Please enter and confirm your new password.', 'error');
        return;
    }
    if (newPass.length < 6) {
        showPassAlert('New password must be at least 6 characters long.', 'error');
        return;
    }
    if (newPass !== confirmPass) {
        showPassAlert('New password and Confirm password do not match!', 'error');
        return;
    }

    const originalBtnHtml = saveBtn ? saveBtn.innerHTML : 'Save New Password';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Updating Password...</span>';
    }

    try {
        const res = await fetch('/api/user/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                current_password: currentPass,
                new_password: newPass
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showPassAlert(data.message || 'Password updated! Use your new password on your next login.', 'success');
            showProfileToast('Account password updated in PostgreSQL!', 'success');

            const newInput = document.getElementById('new-password-input');
            const confInput = document.getElementById('confirm-password-input');
            if (newInput) newInput.value = '';
            if (confInput) confInput.value = '';
            evaluatePasswordStrength();

            const step2 = document.getElementById('new-password-step-container');
            if (step2) step2.classList.add('hidden');

            const curInput = document.getElementById('current-password-input');
            if (curInput) {
                curInput.value = '';
                curInput.disabled = false;
            }
            const vBtn = document.getElementById('btn-verify-current-pass');
            if (vBtn) {
                vBtn.disabled = false;
                vBtn.className = "px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-2 shadow-lg shadow-amber-500/10";
                vBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i><span>Verify Current Password</span>';
            }
            const statusStep = document.getElementById('current-pass-status');
            if (statusStep) {
                statusStep.innerText = 'Step 1 of 2';
                statusStep.className = 'text-[10px] font-mono text-amber-400 font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20';
            }
        } else {
            showPassAlert(data.message || data.error || 'Failed to update password.', 'error');
        }
    } catch (err) {
        showPassAlert('Network error while saving new password.', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = originalBtnHtml;
        }
    }
}

export function getProfileSecurityHTML() {
    return `
    <div id="view-profile" class="biz-tab-content max-w-6xl mx-auto space-y-6 pb-12">

        <!-- TOP IDENTITY HERO & TELEMETRY STRIP -->
        <div class="glass-card rounded-3xl p-6 sm:p-7 border border-slate-800/90 shadow-2xl relative overflow-hidden">
            <div class="
                absolute -top-24 -right-24 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none
            "></div>
            <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-5 pb-6 border-b border-slate-800/80 relative z-10">
                <div class="flex items-start sm:items-center gap-4">
                    <div class="relative shrink-0">
                        <div id="prof-avatar-monogram" class="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/25 via-teal-500/15 to-cyan-500/20 border border-emerald-500/30 text-emerald-300 font-black text-xl flex items-center justify-center shadow-lg">
                            WS
                        </div>
                        <span class="w-3.5 h-3.5 rounded-full bg-emerald-400 ring-4 ring-slate-950 absolute -bottom-1 -right-1" title="Authenticated Workspace"></span>
                    </div>
                    <div class="space-y-1.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <h2 id="prof-display-name" class="text-lg sm:text-xl font-black text-white tracking-tight">Workspace Account</h2>
                            <span id="prof-type-badge" class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">
                                Business Suite
                            </span>
                        </div>
                        <div class="flex flex-wrap items-center gap-2.5 text-xs text-slate-400">
                            <button type="button" onclick="copyWorkspaceUsername()" class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-cyan-400 font-mono font-bold text-[11px] transition cursor-pointer" title="Click to copy username handle">
                                <span id="prof-username">@workspace</span>
                                <i class="fa-regular fa-copy text-[10px] text-slate-400"></i>
                            </button>
                            <span class="text-slate-600">•</span>
                            <span class="inline-flex items-center gap-1 text-[11px] text-slate-400">
                                <i class="fa-regular fa-calendar-check text-emerald-400"></i>
                                <span>Provisioned:</span>
                                <strong id="prof-created-at" class="text-slate-200 font-mono">Active Tenant</strong>
                            </span>
                        </div>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2.5">
                    <button type="button" onclick="loadUserProfile()" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 rounded-xl text-xs font-bold border border-slate-800 transition flex items-center gap-2 cursor-pointer">
                        <i class="fa-solid fa-arrows-rotate text-emerald-400"></i>
                        <span>Sync Profile</span>
                    </button>
                    <button type="button" onclick="switchTab('store')" class="px-3.5 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 rounded-xl text-xs font-bold border border-emerald-500/30 transition flex items-center gap-2 cursor-pointer">
                        <i class="fa-solid fa-store"></i>
                        <span>Store Branding</span>
                    </button>
                </div>
            </div>

            <!-- 4 KPI TELEMETRY CARDS -->
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-5 relative z-10">
                <!-- Card 1: Account Tier -->
                <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Account Role & Tier</span>
                        <i class="fa-solid fa-id-card-clip text-emerald-400 text-xs"></i>
                    </div>
                    <div id="prof-plan-title" class="text-sm font-black text-white">Business Suite</div>
                    <div class="text-[11px] text-slate-400 flex items-center gap-1.5">
                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        <span id="prof-email" class="truncate">Authenticated Session</span>
                    </div>
                </div>

                <!-- Card 2: WhatsApp Device Link -->
                <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">WhatsApp Gateway</span>
                        <span id="prof-status-pill" class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 font-mono">Disconnected</span>
                    </div>
                    <div id="prof-phone" class="text-sm font-black font-mono text-emerald-400 flex items-center gap-1.5">
                        <i class="fa-brands fa-whatsapp"></i>
                        <span id="prof-phone-text">Not Linked</span>
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                        <span>Primary Device</span>
                        <button type="button" onclick="switchTab('whatsapp')" class="text-emerald-400 hover:underline font-bold cursor-pointer">Device Setup →</button>
                    </div>
                </div>

                <!-- Card 3: Active AI Engine -->
                <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">AI Sales Engine</span>
                        <i class="fa-solid fa-wand-magic-sparkles text-purple-400 text-xs"></i>
                    </div>
                    <div id="prof-ai-provider" class="text-xs font-black text-purple-300 font-mono truncate">Groq · llama-3.3-70b</div>
                    <div class="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                        <span>24/7 RAG Responder</span>
                        <button type="button" onclick="switchTab('ai')" class="text-purple-300 hover:underline font-bold cursor-pointer">Configure AI →</button>
                    </div>
                </div>

                <!-- Card 4: Security Posture -->
                <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Security Vault</span>
                        <i class="fa-solid fa-shield-halved text-amber-400 text-xs"></i>
                    </div>
                    <div class="text-sm font-black text-white">2-Step Verified</div>
                    <div class="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
                        <i class="fa-solid fa-lock text-[10px]"></i>
                        <span>Tenant Isolation Active</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- MAIN 2-COLUMN WORKSPACE IDENTITY & SECURITY GRID -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

            <!-- LEFT COLUMN (7 COLS): EDITABLE ACCOUNT IDENTITY & CONNECTED WORKSPACE MODULES -->
            <div class="lg:col-span-7 space-y-6">

                <!-- 1. Editable Account & Owner Contact Details -->
                <div class="glass-card rounded-3xl p-6 sm:p-7 border border-slate-800/90 shadow-xl space-y-5">
                    <div class="flex items-center justify-between pb-4 border-b border-slate-800/80">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center text-base shrink-0">
                                <i class="fa-solid fa-user-pen"></i>
                            </div>
                            <div>
                                <h3 class="text-sm font-black text-white">Account Identity & Owner Contact</h3>
                                <p class="text-xs text-slate-400">Update your workspace owner name, registered email, and primary mobile number.</p>
                            </div>
                        </div>
                        <span class="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-400">
                            PostgreSQL Synced
                        </span>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                Account / Owner Display Name
                            </label>
                            <div class="relative">
                                <i class="fa-solid fa-user-tie absolute left-3.5 top-3 text-slate-500 text-xs"></i>
                                <input type="text" id="prof-account-name-input" placeholder="e.g. Rahul Sharma" class="w-full pl-9 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white outline-none focus:ring-2 focus:ring-cyan-500 transition">
                            </div>
                        </div>

                        <div>
                            <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                Workspace Username (Immutable ID)
                            </label>
                            <div class="relative">
                                <i class="fa-solid fa-at absolute left-3.5 top-3 text-slate-500 text-xs"></i>
                                <input type="text" id="prof-username-readonly" readonly class="w-full pl-9 pr-9 py-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl text-xs font-mono font-bold text-cyan-400 outline-none cursor-not-allowed">
                                <button type="button" onclick="copyWorkspaceUsername()" class="absolute right-3 top-2.5 text-slate-400 hover:text-white text-xs cursor-pointer" title="Copy Username">
                                    <i class="fa-regular fa-copy"></i>
                                </button>
                            </div>
                        </div>

                        <div>
                            <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                Registered Email Address
                            </label>
                            <div class="relative">
                                <i class="fa-solid fa-envelope absolute left-3.5 top-3 text-slate-500 text-xs"></i>
                                <input type="email" id="prof-email-input" placeholder="owner@business.com" class="w-full pl-9 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white outline-none focus:ring-2 focus:ring-cyan-500 transition">
                            </div>
                        </div>

                        <div>
                            <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                                Primary Contact Phone (With Country Code)
                            </label>
                            <div class="relative">
                                <i class="fa-brands fa-whatsapp absolute left-3.5 top-3 text-emerald-400 text-xs"></i>
                                <input type="text" id="prof-phone-input" placeholder="e.g. 919876543210" class="w-full pl-9 pr-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono font-semibold text-emerald-300 outline-none focus:ring-2 focus:ring-emerald-500 transition">
                            </div>
                        </div>
                    </div>

                    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
                        <span class="text-[11px] text-slate-400">
                            <i class="fa-solid fa-circle-info text-cyan-400 mr-1"></i>
                            Looking for Store Logo, Address, or UPI settings? Use the Connected Modules below.
                        </span>
                        <button type="button" id="btn-save-account-profile" onclick="saveAccountProfileDetails()" class="w-full sm:w-auto px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/15 shrink-0">
                            <i class="fa-solid fa-floppy-disk"></i>
                            <span>Save Account Profile</span>
                        </button>
                    </div>
                </div>

                <!-- 2. Connected Workspace Modules (Organized Hub — Eliminates Duplicate Forms) -->
                <div class="glass-card rounded-3xl p-6 sm:p-7 border border-slate-800/90 shadow-xl space-y-4">
                    <div class="flex items-center justify-between pb-3 border-b border-slate-800/80">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-2xl bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center justify-center text-base shrink-0">
                                <i class="fa-solid fa-layer-group"></i>
                            </div>
                            <div>
                                <h3 class="text-sm font-black text-white">Connected Workspace Configuration</h3>
                                <p class="text-xs text-slate-400">Dedicated shortcuts to Storefront, AI Lead Alerts, and WhatsApp Gateway settings.</p>
                            </div>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <!-- Storefront & UPI Card -->
                        <div class="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 hover:border-emerald-500/30 transition flex flex-col justify-between gap-3">
                            <div class="space-y-1">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Storefront & UPI</span>
                                    <span id="prof-store-slug-summary" class="text-[10px] font-mono text-slate-400">/store</span>
                                </div>
                                <div id="prof-store-name-summary" class="text-xs font-bold text-white truncate">Online Storefront</div>
                                <div id="prof-upi-summary" class="text-[11px] font-mono text-slate-400 truncate">UPI & Delivery Logistics</div>
                            </div>
                            <button type="button" onclick="switchTab('store')" class="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-emerald-300 border border-slate-800 text-xs font-bold flex items-center justify-between transition cursor-pointer">
                                <span>Manage Store & UPI</span>
                                <i class="fa-solid fa-arrow-right text-[10px]"></i>
                            </button>
                        </div>

                        <!-- AI Lead Responder & Lead Alert Routing Card -->
                        <div class="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/80 hover:border-purple-500/30 transition flex flex-col justify-between gap-3">
                            <div class="space-y-1">
                                <div class="flex items-center justify-between">
                                    <span class="text-[10px] font-bold uppercase tracking-wider text-purple-400">AI & Lead Alerts</span>
                                    <span class="text-[10px] font-mono text-purple-300">RAG Active</span>
                                </div>
                                <div id="prof-ai-model-summary" class="text-xs font-bold text-white truncate">Groq / Gemini AI</div>
                                <div id="prof-lead-alert-summary" class="text-[11px] font-mono text-slate-400 truncate">Lead Alert WhatsApp Routing</div>
                            </div>
                            <button type="button" onclick="switchTab('ai')" class="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-purple-300 border border-slate-800 text-xs font-bold flex items-center justify-between transition cursor-pointer">
                                <span>Configure AI & Alerts</span>
                                <i class="fa-solid fa-arrow-right text-[10px]"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- RIGHT COLUMN (5 COLS): 2-STEP PASSWORD VAULT & SESSION CONTROLS -->
            <div class="lg:col-span-5 space-y-6">

                <!-- 2-Step Password Change Vault -->
                <div class="glass-card rounded-3xl p-6 sm:p-7 border border-slate-800/90 shadow-xl space-y-5">
                    <div class="flex items-center justify-between pb-4 border-b border-slate-800/80">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-base shrink-0">
                                <i class="fa-solid fa-key"></i>
                            </div>
                            <div>
                                <h3 class="text-sm font-black text-white">2-Step Password Security Vault</h3>
                                <p class="text-xs text-slate-400">Verify your existing password to unlock new password setup.</p>
                            </div>
                        </div>
                        <span id="current-pass-status" class="text-[10px] font-mono text-amber-400 font-bold px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 shrink-0">
                            Step 1 of 2
                        </span>
                    </div>

                    <!-- Feedback Banner -->
                    <div id="pass-change-alert" class="hidden p-3.5 rounded-2xl text-xs font-semibold flex items-center gap-2.5 transition">
                        <i id="pass-alert-icon" class="text-sm"></i>
                        <span id="pass-alert-text"></span>
                    </div>

                    <!-- STEP 1: Verify Current Password -->
                    <div class="space-y-3">
                        <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider">
                            1. Verify Current Password
                        </label>
                        <div class="relative">
                            <i class="fa-solid fa-lock absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                            <input type="password" id="current-password-input" onkeydown="if(event.key==='Enter'){event.preventDefault();verifyCurrentPassword();}" placeholder="Enter current password to unlock" class="w-full pl-9 pr-10 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:ring-2 focus:ring-amber-500 text-white outline-none text-xs font-semibold transition placeholder-slate-600">
                            <button type="button" onclick="togglePasswordInput('current-password-input', this)" class="absolute right-3 top-3 text-slate-500 hover:text-slate-300 text-xs cursor-pointer">
                                <i class="fa-solid fa-eye-slash"></i>
                            </button>
                        </div>
                        <div class="flex items-center justify-between gap-2">
                            <button type="button" onclick="resetPasswordStep1()" class="text-[11px] text-slate-500 hover:text-slate-300 font-semibold cursor-pointer">
                                Reset Verification
                            </button>
                            <button type="button" id="btn-verify-current-pass" onclick="verifyCurrentPassword()" class="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-2 shadow-lg shadow-amber-500/10">
                                <i class="fa-solid fa-shield-halved"></i>
                                <span>Verify Current Password</span>
                            </button>
                        </div>
                    </div>

                    <!-- STEP 2: New Password & Confirm (Revealed after verification) -->
                    <div id="new-password-step-container" class="hidden p-5 rounded-2xl bg-emerald-950/20 border border-emerald-500/30 space-y-4 transition-all duration-300">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2 text-emerald-400 text-xs font-bold">
                                <i class="fa-solid fa-circle-check"></i>
                                <span>Identity Verified — Set New Password</span>
                            </div>
                            <span id="pass-strength-label" class="text-[10px] font-mono text-slate-500 font-bold">Not entered</span>
                        </div>

                        <!-- Live Password Strength Bar -->
                        <div class="w-full h-1.5 rounded-full bg-slate-900 overflow-hidden">
                            <div id="pass-strength-bar" class="h-full bg-slate-700 transition-all duration-300" style="width: 0%"></div>
                        </div>

                        <!-- Live Password Requirement Pills -->
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span id="pass-req-len" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1">
                                <i class="fa-solid fa-check text-[8px]"></i> 6+ Chars
                            </span>
                            <span id="pass-req-mix" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1">
                                <i class="fa-solid fa-check text-[8px]"></i> Letters + Numbers
                            </span>
                            <span id="pass-req-match" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900 text-slate-500 border border-slate-800 flex items-center gap-1">
                                <i class="fa-solid fa-check text-[8px]"></i> Passwords Match
                            </span>
                        </div>

                        <div class="space-y-3">
                            <div>
                                <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">New Password</label>
                                <div class="relative">
                                    <i class="fa-solid fa-lock-open absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                                    <input type="password" id="new-password-input" oninput="evaluatePasswordStrength()" minlength="6" placeholder="Minimum 6 characters" class="w-full pl-9 pr-10 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 text-white outline-none text-xs font-semibold transition placeholder-slate-600">
                                    <button type="button" onclick="togglePasswordInput('new-password-input', this)" class="absolute right-3 top-3 text-slate-500 hover:text-slate-300 text-xs cursor-pointer">
                                        <i class="fa-solid fa-eye-slash"></i>
                                    </button>
                                </div>
                            </div>

                            <div>
                                <label class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">Confirm New Password</label>
                                <div class="relative">
                                    <i class="fa-solid fa-check-double absolute left-3.5 top-3.5 text-slate-500 text-xs"></i>
                                    <input type="password" id="confirm-password-input" oninput="evaluatePasswordStrength()" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewPassword();}" minlength="6" placeholder="Re-enter new password" class="w-full pl-9 pr-10 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:ring-2 focus:ring-emerald-500 text-white outline-none text-xs font-semibold transition placeholder-slate-600">
                                    <button type="button" onclick="togglePasswordInput('confirm-password-input', this)" class="absolute right-3 top-3 text-slate-500 hover:text-slate-300 text-xs cursor-pointer">
                                        <i class="fa-solid fa-eye-slash"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <button type="button" id="btn-save-new-pass" onclick="saveNewPassword()" class="w-full py-2.5 px-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20">
                            <i class="fa-solid fa-floppy-disk"></i>
                            <span>Save New Password</span>
                        </button>
                    </div>
                </div>

                <!-- Session & Security Hygiene Card -->
                <div class="glass-card rounded-3xl p-5 sm:p-6 border border-slate-800/90 shadow-xl space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-black text-white flex items-center gap-2">
                            <i class="fa-solid fa-user-shield text-emerald-400"></i>
                            <span>Active Workspace Session</span>
                        </span>
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            Encrypted
                        </span>
                    </div>
                    <p class="text-[11px] text-slate-400 leading-relaxed">
                        Your workspace credentials and API keys are isolated by tenant username in PostgreSQL. Changing your password immediately protects future sign-ins.
                    </p>
                </div>

            </div>
        </div>
    </div>`;
}

export function initProfileSecurity(apiBaseUrl = "") {
    Object.assign(window, {
        togglePasswordInput,
        showPassAlert,
        evaluatePasswordStrength,
        saveAccountProfileDetails,
        saveProfileNotificationPhone,
        copyWorkspaceUsername,
        resetPasswordStep1,
        loadUserProfile,
        verifyCurrentPassword,
        saveNewPassword
    });
    loadUserProfile();
}

export {
    togglePasswordInput,
    showPassAlert,
    evaluatePasswordStrength,
    saveAccountProfileDetails,
    saveProfileNotificationPhone,
    copyWorkspaceUsername,
    resetPasswordStep1,
    loadUserProfile,
    verifyCurrentPassword,
    saveNewPassword
};
Object.assign(window, {
    togglePasswordInput,
    showPassAlert,
    evaluatePasswordStrength,
    saveAccountProfileDetails,
    saveProfileNotificationPhone,
    copyWorkspaceUsername,
    resetPasswordStep1,
    loadUserProfile,
    verifyCurrentPassword,
    saveNewPassword
});
