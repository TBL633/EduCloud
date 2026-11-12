import { getActiveUsername, escapeHtml } from "../shared/auth-guard.js";
import { uploadToMediaWorker, openCropperModal, openLightbox, handleDeleteImageSync } from "../shared/media-cropper.js";
import { loadUserProfile } from "./profile-security.js";

// ============================================================================
// BUSINESS PORTAL: STORE MANAGEMENT & E-COMMERCE COMMAND CENTER
// ============================================================================

window._promotionalBanners = window._promotionalBanners || [];
window._storeLoadedCategories = window._storeLoadedCategories || [];
window._storeLoadedProducts = window._storeLoadedProducts || [];

// Non-blocking executive toast notification (replaces window.alert)
function showStoreToast(message, type = 'success') {
    const banner = document.getElementById('store-toast-banner');
    const icon = document.getElementById('store-toast-icon');
    const text = document.getElementById('store-toast-text');
    if (!banner || !text) return;

    text.textContent = message;
    banner.classList.remove('hidden', 'border-emerald-500/40', 'bg-emerald-950/90', 'text-emerald-200', 'border-rose-500/40', 'bg-rose-950/90', 'text-rose-200', 'border-cyan-500/40', 'bg-cyan-950/90', 'text-cyan-200');

    if (type === 'error') {
        banner.classList.add('border-rose-500/40', 'bg-rose-950/90', 'text-rose-200');
        if (icon) icon.className = 'fa-solid fa-triangle-exclamation text-rose-400 text-sm shrink-0';
    } else if (type === 'info') {
        banner.classList.add('border-cyan-500/40', 'bg-cyan-950/90', 'text-cyan-200');
        if (icon) icon.className = 'fa-solid fa-circle-info text-cyan-400 text-sm shrink-0';
    } else {
        banner.classList.add('border-emerald-500/40', 'bg-emerald-950/90', 'text-emerald-200');
        if (icon) icon.className = 'fa-solid fa-circle-check text-emerald-400 text-sm shrink-0';
    }

    if (window._storeToastTimer) clearTimeout(window._storeToastTimer);
    window._storeToastTimer = setTimeout(() => {
        banner.classList.add('hidden');
    }, 4500);
}

function getLiveStorefrontUrl() {
    const input = document.getElementById('prof-live-store-link-input');
    if (input && input.value.trim()) return input.value.trim();
    const slugInput = document.getElementById('prof-store-slug-input');
    const slug = (slugInput && slugInput.value.trim()) ? slugInput.value.trim() : (getActiveUsername() || 'store');
    return `${window.location.origin}/${slug}`;
}

function syncStorePreviewAnchors(url) {
    const cleanUrl = url || getLiveStorefrontUrl();
    const input = document.getElementById('prof-live-store-link-input');
    if (input) input.value = cleanUrl;
    const anchor = document.getElementById('store-live-preview-anchor');
    if (anchor) anchor.href = cleanUrl;
    const qrUrlText = document.getElementById('store-qr-url-label');
    if (qrUrlText) qrUrlText.textContent = cleanUrl;
    const qrImg = document.getElementById('store-qr-code-img');
    if (qrImg && !document.getElementById('store-qr-modal')?.classList.contains('hidden')) {
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=${encodeURIComponent(cleanUrl)}`;
    }
}

function copyStorefrontLink() {
    const link = getLiveStorefrontUrl();
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
        showStoreToast(`Live Storefront URL copied: ${link}`, 'success');
        const copyBtnText = document.getElementById('copy-store-link-text');
        if (copyBtnText) {
            const orig = copyBtnText.textContent;
            copyBtnText.textContent = 'Copied!';
            setTimeout(() => { copyBtnText.textContent = orig; }, 2000);
        }
    }).catch(() => {
        showStoreToast('Could not copy link automatically. Please copy from the URL box.', 'info');
    });
}

function openStorefrontPreview() {
    const link = getLiveStorefrontUrl();
    if (!link) return;
    const anchor = document.getElementById('store-live-preview-anchor');
    if (anchor) {
        anchor.href = link;
        anchor.click();
    } else {
        window.location.href = link;
    }
}

function shareStoreOnWhatsApp() {
    const link = getLiveStorefrontUrl();
    const bName = document.getElementById('prof-business-name-input')?.value.trim() || getActiveUsername() || 'Our Store';
    const tagline = document.getElementById('prof-tagline-input')?.value.trim();
    const msg = `🛍️ *Welcome to ${bName}!*\n${tagline ? `_${tagline}_\n\n` : '\n'}Browse our live catalog & order directly on WhatsApp:\n👉 ${link}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    const tempAnchor = document.createElement('a');
    tempAnchor.href = waUrl;
    tempAnchor.target = '_blank';
    tempAnchor.rel = 'noopener noreferrer';
    document.body.appendChild(tempAnchor);
    tempAnchor.click();
    document.body.removeChild(tempAnchor);
}

function openStoreQRModal() {
    const modal = document.getElementById('store-qr-modal');
    const qrImg = document.getElementById('store-qr-code-img');
    const qrTitle = document.getElementById('store-qr-modal-title');
    const qrUrlText = document.getElementById('store-qr-url-label');
    const link = getLiveStorefrontUrl();
    const bName = document.getElementById('prof-business-name-input')?.value.trim() || getActiveUsername() || 'My Store';

    if (qrTitle) qrTitle.textContent = bName;
    if (qrUrlText) qrUrlText.textContent = link;
    if (qrImg) {
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=${encodeURIComponent(link)}`;
    }
    if (modal) modal.classList.remove('hidden');
}

function closeStoreQRModal() {
    const modal = document.getElementById('store-qr-modal');
    if (modal) modal.classList.add('hidden');
}

function updateStoreSlugPreview(val) {
    const clean = (val || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const slugToUse = clean || getActiveUsername() || 'my_shop';
    syncStorePreviewAnchors(`${window.location.origin}/${slugToUse}`);
    updateLiveBrandMockup();
}

function updateLogoPreview(url) {
    const img = document.getElementById('prof-logo-preview');
    const placeholder = document.getElementById('prof-logo-placeholder');
    const overlay = document.getElementById('prof-logo-overlay');
    const cleanUrl = (url || '').trim();
    if (!img || !placeholder) return;
    if (cleanUrl) {
        img.src = cleanUrl;
        img.onload = () => {
            img.classList.remove('hidden');
            placeholder.classList.add('hidden');
            if (overlay) overlay.classList.remove('hidden');
        };
        img.onerror = () => {
            img.classList.add('hidden');
            placeholder.classList.remove('hidden');
            if (overlay) overlay.classList.add('hidden');
        };
    } else {
        img.src = '';
        img.classList.add('hidden');
        placeholder.classList.remove('hidden');
        if (overlay) overlay.classList.add('hidden');
    }
    updateLiveBrandMockup();
}

function updateBannerPreview(url) {
    const hidden = document.getElementById('prof-banner-url-input');
    if (hidden) hidden.value = (url || '').trim();
}

function startLogoCrop(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    openCropperModal(file, 1, 'Crop Store Logo (1:1 Square)', async (croppedBlob) => {
        const res = await uploadToMediaWorker(croppedBlob, 'branding');
        const logoInput = document.getElementById('prof-logo-url-input');
        if (logoInput) logoInput.value = res.url;
        updateLogoPreview(res.url);
        showStoreToast('Store logo cropped & uploaded! Click Save to publish.', 'success');
    });
}

function renderPromotionalBanners() {
    const container = document.getElementById('promotional-banners-list');
    const emptyState = document.getElementById('banners-empty-state');
    const countBadge = document.getElementById('banner-count-badge');
    const kpiBannerCount = document.getElementById('kpi-store-banners-count');
    const addBtn = document.getElementById('btn-add-banner');

    if (!container) return;
    const banners = window._promotionalBanners || [];

    if (countBadge) countBadge.textContent = `${banners.length} / 5 Active`;
    if (kpiBannerCount) kpiBannerCount.textContent = `${banners.length} / 5 Slides`;

    if (addBtn) {
        if (banners.length >= 5) {
            addBtn.disabled = true;
            addBtn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            addBtn.disabled = false;
            addBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    if (banners.length === 0) {
        container.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        updateBannerPreview('');
        return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    updateBannerPreview(banners[0]?.image_url || '');

    const cats = window._storeLoadedCategories || [];
    const prods = window._storeLoadedProducts || [];

    let quickOptionsHtml = `<option value="">⚡ Quick-Select Store Category or Product...</option>`;
    if (cats.length > 0) {
        quickOptionsHtml += `<optgroup label="📂 Store Categories">`;
        cats.forEach(c => {
            const cName = c.name || c.category_name || '';
            if (cName) {
                quickOptionsHtml += `<option value="#category=${encodeURIComponent(cName)}">Category: ${escapeHtml(cName)}</option>`;
            }
        });
        quickOptionsHtml += `</optgroup>`;
    }
    if (prods.length > 0) {
        quickOptionsHtml += `<optgroup label="📦 Store Products">`;
        prods.forEach(p => {
            if (p.id && p.name) {
                quickOptionsHtml += `<option value="#product=${p.id}">Product: ${escapeHtml(p.name)} (₹${p.sale_price && p.sale_price < p.price ? p.sale_price : p.price})</option>`;
            }
        });
        quickOptionsHtml += `</optgroup>`;
    }

    container.innerHTML = banners.map((b, idx) => {
        const imgUrl = b.image_url || '';
        const targetLink = b.target_link || '';
        return `
        <div class="p-3.5 bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-xl flex flex-col sm:flex-row items-start sm:items-center gap-4 transition">
            <div class="relative w-full sm:w-44 aspect-video rounded-lg overflow-hidden bg-slate-950 border border-slate-700 shrink-0 group">
                <img src="${escapeHtml(imgUrl)}" alt="Banner ${idx + 1}" class="w-full h-full object-cover">
                <span class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded bg-slate-950/85 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                    Slide #${idx + 1}
                </span>
                <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px]">
                    <button type="button" onclick="openLightbox('${escapeHtml(imgUrl)}')" title="Preview Full Banner" class="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                        <i class="fa-solid fa-expand"></i>
                    </button>
                    <button type="button" onclick="handleDeleteImageSync('banner', 0, '${escapeHtml(imgUrl)}', ${idx})" title="Delete Banner" class="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="flex-1 w-full space-y-2">
                <div class="flex items-center justify-between gap-2">
                    <label class="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                        <i class="fa-solid fa-link text-indigo-400"></i> Click Destination (Category / Product / URL)
                    </label>
                    <div class="flex items-center gap-1">
                        <button type="button" onclick="movePromotionalBanner(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move Slide Up" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 flex items-center justify-center text-[10px] cursor-pointer transition">
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button type="button" onclick="movePromotionalBanner(${idx}, 1)" ${idx === banners.length - 1 ? 'disabled' : ''} title="Move Slide Down" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 flex items-center justify-center text-[10px] cursor-pointer transition">
                            <i class="fa-solid fa-arrow-down"></i>
                        </button>
                        <button type="button" onclick="handleDeleteImageSync('banner', 0, '${escapeHtml(imgUrl)}', ${idx})" class="px-2 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] font-bold transition cursor-pointer ml-1">
                            <i class="fa-solid fa-trash-can mr-1"></i>Remove
                        </button>
                    </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select onchange="handleBannerQuickSelect(${idx}, this.value)" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-indigo-300 outline-none focus:border-indigo-500 cursor-pointer">
                        ${quickOptionsHtml}
                    </select>
                    <input type="text" id="banner-target-input-${idx}" value="${escapeHtml(targetLink)}" oninput="updateBannerLink(${idx}, this.value)" placeholder="Or paste custom URL / #category=..." class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500 font-mono">
                </div>
            </div>
        </div>
        `;
    }).join('');
}

function movePromotionalBanner(idx, direction) {
    if (!Array.isArray(window._promotionalBanners)) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= window._promotionalBanners.length) return;
    const temp = window._promotionalBanners[idx];
    window._promotionalBanners[idx] = window._promotionalBanners[targetIdx];
    window._promotionalBanners[targetIdx] = temp;
    renderPromotionalBanners();
}

function addDirectBannerUrl() {
    const input = document.getElementById('direct-banner-url-input');
    const url = input ? input.value.trim() : '';
    if (!url) {
        showStoreToast('Please paste a valid banner image URL first.', 'error');
        return;
    }
    if (!window._promotionalBanners) window._promotionalBanners = [];
    if (window._promotionalBanners.length >= 5) {
        showStoreToast('Maximum 5 promotional banners allowed. Remove an existing slide first.', 'error');
        return;
    }
    window._promotionalBanners.push({
        image_url: url,
        target_link: ''
    });
    if (input) input.value = '';
    renderPromotionalBanners();
    showStoreToast('Promotional banner slide added! Click Save Store Settings to publish.', 'success');
}

function startBannerCrop(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    if ((window._promotionalBanners || []).length >= 5) {
        showStoreToast('Maximum 5 promotional banners allowed. Delete an existing banner first.', 'error');
        event.target.value = '';
        return;
    }
    openCropperModal(file, 16 / 9, 'Crop Promotional Banner (16:9 Widescreen)', async (croppedBlob) => {
        const res = await uploadToMediaWorker(croppedBlob, 'branding');
        if (!window._promotionalBanners) window._promotionalBanners = [];
        window._promotionalBanners.push({
            image_url: res.url,
            target_link: ''
        });
        renderPromotionalBanners();
        showStoreToast('16:9 Hero Banner uploaded! Click Save Store Settings to publish.', 'success');
    });
}

function updateBannerLink(index, val) {
    if (window._promotionalBanners && window._promotionalBanners[index]) {
        window._promotionalBanners[index].target_link = (val || '').trim();
    }
}

function handleBannerQuickSelect(index, selectedVal) {
    if (!selectedVal) return;
    const inputEl = document.getElementById(`banner-target-input-${index}`);
    if (inputEl) inputEl.value = selectedVal;
    updateBannerLink(index, selectedVal);
}

// ============================================================================
// GEOLOCATION & GOOGLE MAPS VERIFICATION
// ============================================================================
function updateGoogleMapsPinLink() {
    const lat = parseFloat(document.getElementById('prof-lat-input')?.value || '0');
    const lng = parseFloat(document.getElementById('prof-lng-input')?.value || '0');
    const mapLink = document.getElementById('gps-google-maps-link');
    if (!mapLink) return;
    if (lat && lng && (lat !== 0 || lng !== 0)) {
        mapLink.href = `https://www.google.com/maps?q=${lat},${lng}`;
        mapLink.classList.remove('hidden');
    } else {
        mapLink.classList.add('hidden');
    }
}

function fetchCurrentGPSLocation() {
    const badge = document.getElementById('gps-status-badge');
    const btn = document.getElementById('btn-fetch-gps');
    const latInput = document.getElementById('prof-lat-input');
    const lngInput = document.getElementById('prof-lng-input');

    if (!navigator.geolocation) {
        showStoreToast('Geolocation is not supported by your browser. You can type coordinates manually.', 'error');
        return;
    }

    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Capturing Satellites...</span>';
    }
    if (badge) {
        badge.textContent = '📡 Acquiring GPS...';
        badge.className = 'text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-lg animate-pulse';
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude.toFixed(8);
            const lng = position.coords.longitude.toFixed(8);

            if (latInput) latInput.value = lat;
            if (lngInput) lngInput.value = lng;

            if (badge) {
                badge.textContent = '✅ Exact GPS Locked';
                badge.className = 'text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-lg';
            }
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-check text-emerald-300"></i><span>GPS Location Captured</span>';
            }
            updateGoogleMapsPinLink();
            showStoreToast(`Exact GPS coordinates locked (${lat}, ${lng})!`, 'success');
        },
        (error) => {
            let errMsg = 'Failed to capture GPS location.';
            if (error.code === error.PERMISSION_DENIED) {
                errMsg = 'Location permission denied. You can also enter Latitude & Longitude manually below.';
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                errMsg = 'GPS position unavailable. Enter coordinates manually below.';
            } else if (error.code === error.TIMEOUT) {
                errMsg = 'GPS request timed out. Please try again.';
            }
            showStoreToast(errMsg, 'error');
            if (badge) {
                badge.textContent = '⚠️ Manual Entry Mode';
                badge.className = 'text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-lg';
            }
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// ============================================================================
// SUB-TAB NAVIGATION & LIVE PREVIEWS
// ============================================================================
function switchStoreSubTab(subTab) {
    const panes = ['branding', 'payments', 'delivery', 'privacy', 'domain'];
    panes.forEach(p => {
        const content = document.getElementById(`subtab-content-${p}`);
        const btn = document.getElementById(`subtab-btn-${p}`);
        if (content) content.classList.add('hidden');
        if (btn) {
            btn.className = 'px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800/60';
        }
    });

    const activeContent = document.getElementById(`subtab-content-${subTab}`);
    const activeBtn = document.getElementById(`subtab-btn-${subTab}`);
    if (activeContent) activeContent.classList.remove('hidden');
    if (activeBtn) {
        activeBtn.className = 'px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20';
    }
}

function updateStoreStatusToggleLabel(isOpen) {
    const label = document.getElementById('store-status-toggle-label');
    const heroToggle = document.getElementById('hero-store-open-toggle');
    const mainToggle = document.getElementById('prof-store-open-toggle');
    const kpiStatus = document.getElementById('kpi-store-open-status');

    if (heroToggle && heroToggle.checked !== Boolean(isOpen)) heroToggle.checked = Boolean(isOpen);
    if (mainToggle && mainToggle.checked !== Boolean(isOpen)) mainToggle.checked = Boolean(isOpen);

    if (label) {
        if (isOpen) {
            label.textContent = '🟢 Store Open (Accepting Orders)';
            label.className = 'text-[11px] font-mono text-emerald-400 font-bold';
        } else {
            label.textContent = '🔴 Store Closed (Checkout Paused)';
            label.className = 'text-[11px] font-mono text-rose-400 font-bold';
        }
    }
    if (kpiStatus) {
        kpiStatus.innerHTML = isOpen
            ? '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>Open & Live'
            : '<span class="w-2 h-2 rounded-full bg-rose-400 inline-block mr-1.5"></span>Paused / Closed';
        kpiStatus.className = isOpen
            ? 'text-sm font-black text-emerald-400 flex items-center'
            : 'text-sm font-black text-rose-400 flex items-center';
    }
}

function applyOperatingHoursPreset(hoursText) {
    const input = document.getElementById('prof-operating-hours');
    if (input) {
        input.value = hoursText;
        updateStoreKPIStrip();
        showStoreToast(`Operating hours set to "${hoursText}"`, 'info');
    }
}

function updateLiveBrandMockup() {
    const bName = document.getElementById('prof-business-name-input')?.value.trim() || getActiveUsername() || 'Your Store Name';
    const tagline = document.getElementById('prof-tagline-input')?.value.trim() || 'Fast hyperlocal delivery on WhatsApp';
    const announce = document.getElementById('prof-announcement-bar-input')?.value.trim();
    const logoUrl = document.getElementById('prof-logo-url-input')?.value.trim();
    const themeColor = document.querySelector('input[name="store-theme-color"]:checked')?.value || 'emerald';

    const mockTitle = document.getElementById('mockup-store-name');
    const mockTagline = document.getElementById('mockup-store-tagline');
    const mockAnnounce = document.getElementById('mockup-announcement-bar');
    const mockLogoImg = document.getElementById('mockup-store-logo');
    const mockLogoIcon = document.getElementById('mockup-store-logo-icon');
    const mockCtaBtn = document.getElementById('mockup-store-cta');
    const kpiThemeLabel = document.getElementById('kpi-store-theme-label');

    if (mockTitle) mockTitle.textContent = bName;
    if (mockTagline) mockTagline.textContent = tagline;

    const colorMap = {
        emerald: { bg: 'bg-emerald-500 text-slate-950', bar: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', name: 'Emerald Mint' },
        cyan: { bg: 'bg-cyan-400 text-slate-950', bar: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30', name: 'Cyber Cyan' },
        indigo: { bg: 'bg-indigo-500 text-white', bar: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30', name: 'Royal Indigo' },
        amber: { bg: 'bg-amber-400 text-slate-950', bar: 'bg-amber-500/15 text-amber-300 border-amber-500/30', name: 'Sunset Amber' },
        rose: { bg: 'bg-rose-500 text-white', bar: 'bg-rose-500/15 text-rose-300 border-rose-500/30', name: 'Rose Crimson' },
        purple: { bg: 'bg-purple-500 text-white', bar: 'bg-purple-500/15 text-purple-300 border-purple-500/30', name: 'Electric Purple' }
    };
    const palette = colorMap[themeColor] || colorMap.emerald;

    if (kpiThemeLabel) kpiThemeLabel.textContent = `Theme: ${palette.name}`;
    if (mockCtaBtn) {
        mockCtaBtn.className = `px-3 py-1.5 rounded-lg text-[11px] font-bold transition ${palette.bg}`;
    }
    if (mockAnnounce) {
        if (announce) {
            mockAnnounce.textContent = announce;
            mockAnnounce.className = `px-3 py-1.5 text-[11px] font-bold text-center border-b ${palette.bar}`;
            mockAnnounce.classList.remove('hidden');
        } else {
            mockAnnounce.classList.add('hidden');
        }
    }
    if (mockLogoImg && mockLogoIcon) {
        if (logoUrl) {
            mockLogoImg.src = logoUrl;
            mockLogoImg.classList.remove('hidden');
            mockLogoIcon.classList.add('hidden');
        } else {
            mockLogoImg.classList.add('hidden');
            mockLogoIcon.classList.remove('hidden');
        }
    }
}

// ============================================================================
// INTERACTIVE HYPERLOCAL DELIVERY FEE SIMULATOR
// ============================================================================
function simulateDeliveryFee() {
    const maxRadius = parseFloat(document.getElementById('prof-max-radius-input')?.value || '15');
    const freeRadius = parseFloat(document.getElementById('prof-free-radius-input')?.value || '3');
    const minFreeOrder = parseFloat(document.getElementById('prof-min-free-delivery-input')?.value || '499');
    const baseFee = parseFloat(document.getElementById('prof-delivery-charge-input')?.value || '40');
    const minOrderAmount = parseFloat(document.getElementById('prof-min-order-input')?.value || '0');
    const pkgCharge = parseFloat(document.getElementById('prof-packaging-charge-input')?.value || '0');

    const testDist = parseFloat(document.getElementById('sim-test-distance')?.value || '2.5');
    const testCart = parseFloat(document.getElementById('sim-test-cart')?.value || '350');

    const distLabel = document.getElementById('sim-dist-label');
    if (distLabel) distLabel.textContent = `${testDist.toFixed(1)} KM`;

    const resultBadge = document.getElementById('sim-result-badge');
    const resultDetail = document.getElementById('sim-result-detail');
    const resultTotal = document.getElementById('sim-result-total');
    if (!resultBadge || !resultDetail || !resultTotal) return;

    if (minOrderAmount > 0 && testCart < minOrderAmount) {
        resultBadge.textContent = '⚠️ Below Min Order';
        resultBadge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono';
        resultDetail.textContent = `Cart value ₹${testCart} is below minimum order value of ₹${minOrderAmount}.`;
        resultTotal.textContent = `Add ₹${(minOrderAmount - testCart).toFixed(0)} more`;
        return;
    }

    if (testDist > maxRadius) {
        resultBadge.textContent = '🚫 Out of Delivery Zone';
        resultBadge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 font-mono';
        resultDetail.textContent = `Customer is ${testDist.toFixed(1)} KM away (Max radius is ${maxRadius} KM). Store Pickup only.`;
        resultTotal.textContent = 'Not Deliverable';
        return;
    }

    let deliveryFee = baseFee;
    let reason = `Standard delivery fee (₹${baseFee})`;
    if (testDist <= freeRadius) {
        deliveryFee = 0;
        reason = `Within ${freeRadius} KM Free Radius`;
    } else if (minFreeOrder > 0 && testCart >= minFreeOrder) {
        deliveryFee = 0;
        reason = `Cart ≥ ₹${minFreeOrder} Free Delivery threshold`;
    }

    const finalPayable = testCart + deliveryFee + pkgCharge;
    if (deliveryFee === 0) {
        resultBadge.textContent = '🎉 FREE DELIVERY';
        resultBadge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono';
    } else {
        resultBadge.textContent = `🚚 +₹${deliveryFee} Delivery Fee`;
        resultBadge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono';
    }
    resultDetail.textContent = `${reason}${pkgCharge > 0 ? ` + ₹${pkgCharge} Packaging` : ''}`;
    resultTotal.textContent = `₹${finalPayable.toFixed(0)} Total`;
}

function updateStoreKPIStrip() {
    const isOpen = document.getElementById('prof-store-open-toggle')?.checked ?? true;
    const opHours = document.getElementById('prof-operating-hours')?.value.trim() || '9:00 AM - 10:00 PM';
    const maxRad = document.getElementById('prof-max-radius-input')?.value || '15';
    const delFee = document.getElementById('prof-delivery-charge-input')?.value || '40';
    const allowCod = document.getElementById('prof-allow-cod-toggle')?.checked ?? true;
    const upiVpa = document.getElementById('prof-paytm-vpa-input')?.value.trim() || '';
    const minOrder = document.getElementById('prof-min-order-input')?.value || '0';

    updateStoreStatusToggleLabel(isOpen);

    const kpiHours = document.getElementById('kpi-store-hours-label');
    if (kpiHours) kpiHours.textContent = opHours;

    const kpiDelivery = document.getElementById('kpi-store-delivery-summary');
    if (kpiDelivery) kpiDelivery.textContent = `${maxRad} KM Radius · ₹${delFee} Fee`;

    const kpiFreeRad = document.getElementById('kpi-store-free-summary');
    const freeRad = document.getElementById('prof-free-radius-input')?.value || '3';
    const minFree = document.getElementById('prof-min-free-delivery-input')?.value || '499';
    if (kpiFreeRad) kpiFreeRad.textContent = `Free ≤ ${freeRad} KM or ≥ ₹${minFree}`;

    const kpiPayments = document.getElementById('kpi-store-payment-summary');
    if (kpiPayments) {
        const methods = [];
        if (upiVpa) methods.push('UPI');
        if (allowCod) methods.push('COD');
        kpiPayments.textContent = methods.length > 0 ? `${methods.join(' + ')} Active` : 'Prepaid Only';
    }
    const kpiMinOrder = document.getElementById('kpi-store-min-order-label');
    if (kpiMinOrder) {
        kpiMinOrder.textContent = Number(minOrder) > 0 ? `Min Order: ₹${minOrder}` : 'No Minimum Order';
    }

    simulateDeliveryFee();
}

// ============================================================================
// LEGAL POLICY GENERATORS
// ============================================================================
function generateDefaultPolicy(type, silent = false) {
    const bName = document.getElementById('prof-business-name-input')?.value.trim()
        || document.getElementById('prof-display-name')?.innerText
        || getActiveUsername()
        || 'Our Store';
    const address = document.getElementById('prof-full-address-input')?.value.trim() || 'our registered store address';
    const maxRadius = document.getElementById('prof-max-radius-input')?.value || '15';
    const delFee = document.getElementById('prof-delivery-charge-input')?.value || '40';

    if (type === 'privacy') {
        const el = document.getElementById('prof-privacy-policy');
        if (el) el.value = `Privacy Policy for ${bName}:\n1. Data Collection: We collect your name, mobile number, delivery address, and GPS location pin solely to process and deliver your orders accurately.\n2. Data Security: Your contact information is strictly confidential and is never sold or rented to third-party marketers.\n3. WhatsApp Updates: By placing an order, you consent to receive automated order status notifications, invoices, and delivery alerts via WhatsApp.`;
    } else if (type === 'terms') {
        const el = document.getElementById('prof-terms-conditions');
        if (el) el.value = `Terms & Conditions for ${bName}:\n1. Pricing & Availability: All product prices are inclusive of applicable taxes unless stated otherwise. Fulfilment is subject to real-time stock availability.\n2. Order Confirmation: Orders placed via our web storefront or WhatsApp bot are confirmed once payment or COD verification is completed.\n3. Cancellation: Orders may be cancelled prior to dispatch by messaging our official support WhatsApp number.`;
    } else if (type === 'refund') {
        const el = document.getElementById('prof-refund-policy');
        if (el) el.value = `Refund & Return Policy for ${bName}:\n1. Damaged or Wrong Items: Please report any damaged, defective, or incorrect items within 24 hours of delivery with a clear photo on WhatsApp.\n2. Instant Replacement / Refund: Verified claims are eligible for an immediate free replacement or a 100% refund to your original UPI/bank account within 2-4 business days.`;
    } else if (type === 'shipping') {
        const el = document.getElementById('prof-shipping-policy');
        if (el) el.value = `Shipping & Hyperlocal Delivery Policy for ${bName} (${address}):\n1. Coverage Zone: We deliver within a ${maxRadius} KM hyperlocal radius around our store.\n2. Standard Delivery Time: Local orders are typically dispatched and delivered within 45 to 120 minutes during operating hours.\n3. Delivery Charges: Standard delivery fee is ₹${delFee} (waived for eligible free-delivery radius or minimum cart value orders).`;
    }
    if (!silent) {
        showStoreToast(`${type.toUpperCase()} policy template generated!`, 'info');
    }
}

function generateAllPolicies() {
    ['privacy', 'terms', 'refund', 'shipping'].forEach(t => generateDefaultPolicy(t, true));
    showStoreToast('All 4 legal & compliance policies generated! Click Save to publish.', 'success');
}

// ============================================================================
// CUSTOM DOMAIN & DNS VERIFICATION
// ============================================================================
function copyDNSTarget(val) {
    navigator.clipboard.writeText(val).then(() => {
        showStoreToast(`Copied DNS value: ${val}`, 'info');
    });
}

async function verifyCustomDomainDNS() {
    const input = document.getElementById('prof-custom-domain-input');
    const badge = document.getElementById('domain-status-badge');
    const btn = document.getElementById('btn-verify-domain-dns');
    const domain = input ? input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';

    if (!domain || !domain.includes('.')) {
        showStoreToast('Please enter a valid custom domain (e.g. shop.mybrand.in).', 'error');
        return;
    }
    if (input) input.value = domain;

    const origHtml = btn ? btn.innerHTML : 'Verify DNS';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Checking DNS...</span>';
    }
    if (badge) {
        badge.textContent = '⏳ Querying Global DNS...';
        badge.className = 'text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1 rounded-full font-mono';
    }

    try {
        const dnsRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
            headers: { 'Accept': 'application/dns-json' }
        });
        const dnsData = await dnsRes.json();
        const hasRecords = Array.isArray(dnsData?.Answer) && dnsData.Answer.length > 0;
        const newStatus = hasRecords ? 'verified_ssl' : 'pending_dns';

        await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: getActiveUsername(),
                custom_domain: domain,
                domain_status: newStatus
            })
        });

        if (badge) {
            if (hasRecords) {
                badge.textContent = '🟢 DNS Verified · SSL Active';
                badge.className = 'text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 rounded-full font-mono';
                showStoreToast(`Domain ${domain} DNS records verified & saved!`, 'success');
            } else {
                badge.textContent = '🟡 Pending DNS Propagation';
                badge.className = 'text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1 rounded-full font-mono';
                showStoreToast(`Domain ${domain} saved! Add the CNAME/A records below to complete propagation.`, 'info');
            }
        }
    } catch (e) {
        showStoreToast('Could not verify DNS at this moment. Please check your domain format.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}

// ============================================================================
// LOAD & SAVE STORE MANAGEMENT SETTINGS (100% REAL NEON POSTGRESQL SYNC)
// ============================================================================
async function loadStoreSettings() {
    const username = getActiveUsername();
    if (!username) return;

    try {
        const [profRes, catRes, prodRes] = await Promise.all([
            fetch(`/api/user/profile?username=${encodeURIComponent(username)}`),
            fetch(`/api/categories?username=${encodeURIComponent(username)}`),
            fetch(`/api/products?username=${encodeURIComponent(username)}`)
        ]);

        if (catRes.ok) {
            const cData = await catRes.json();
            window._storeLoadedCategories = Array.isArray(cData) ? cData : [];
        }
        if (prodRes.ok) {
            const pData = await prodRes.json();
            window._storeLoadedProducts = Array.isArray(pData) ? pData : [];
        }

        if (!profRes.ok) return;
        const data = await profRes.json();

        const storeSlug = data.store_slug || data.username || username;
        syncStorePreviewAnchors(`${window.location.origin}/${storeSlug}`);

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el && val !== undefined && val !== null) el.value = val;
        };

        setVal('prof-business-name-input', data.business_name || data.account_name || username);
        setVal('prof-business-type-select', data.business_type || 'Kirana / General Store');
        setVal('prof-store-slug-input', storeSlug);
        setVal('prof-tagline-input', data.tagline || '');
        setVal('prof-announcement-bar-input', data.announcement_bar || '');
        setVal('prof-logo-url-input', data.logo_url || '');
        updateLogoPreview(data.logo_url || '');
        setVal('prof-banner-url-input', data.banner_url || '');

        // Theme color radio
        const themeColor = data.theme_color || 'emerald';
        const radioEl = document.querySelector(`input[name="store-theme-color"][value="${themeColor}"]`);
        if (radioEl) radioEl.checked = true;

        // Social & Notification links
        setVal('prof-social-insta', data.social_instagram || '');
        setVal('prof-social-fb', data.social_facebook || '');
        setVal('prof-social-wa', data.social_whatsapp || data.phone || '');
        setVal('prof-notif-phone-input', data.notification_phone || '');

        // Checkout & Payments
        const codToggle = document.getElementById('prof-allow-cod-toggle');
        if (codToggle) codToggle.checked = data.allow_cod !== false;
        setVal('prof-paytm-vpa-input', data.paytm_vpa || '');
        setVal('prof-paytm-mid-input', data.paytm_mid || '');
        setVal('prof-min-order-input', data.min_order_amount !== undefined ? data.min_order_amount : 0);
        setVal('prof-packaging-charge-input', data.packaging_charge !== undefined ? data.packaging_charge : 0);

        // Promotional Banners
        if (Array.isArray(data.promotional_banners) && data.promotional_banners.length > 0) {
            window._promotionalBanners = data.promotional_banners;
        } else if (data.banner_url) {
            window._promotionalBanners = [{ image_url: data.banner_url, target_link: '' }];
        } else {
            window._promotionalBanners = [];
        }
        renderPromotionalBanners();

        // Location & Legal Policies
        setVal('prof-full-address-input', data.full_address || '');
        setVal('prof-local-area-input', data.local_area || '');
        setVal('prof-lat-input', data.latitude ? parseFloat(data.latitude).toFixed(8) : '');
        setVal('prof-lng-input', data.longitude ? parseFloat(data.longitude).toFixed(8) : '');
        setVal('prof-gstin-input', data.gstin_number || '');
        setVal('prof-privacy-policy', data.privacy_policy || '');
        setVal('prof-terms-conditions', data.terms_conditions || '');
        setVal('prof-refund-policy', data.refund_policy || '');
        setVal('prof-shipping-policy', data.shipping_policy || '');

        const gpsBadge = document.getElementById('gps-status-badge');
        if (gpsBadge && (data.latitude || data.longitude) && parseFloat(data.latitude) !== 0) {
            gpsBadge.textContent = '✅ Exact GPS Locked';
            gpsBadge.className = 'text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-lg';
        }
        updateGoogleMapsPinLink();

        // Hyperlocal Delivery & Operations
        setVal('prof-max-radius-input', data.max_delivery_radius_km !== undefined ? data.max_delivery_radius_km : 15.0);
        setVal('prof-free-radius-input', data.free_delivery_radius_km !== undefined ? data.free_delivery_radius_km : 3.0);
        setVal('prof-min-free-delivery-input', data.min_free_delivery_order !== undefined ? data.min_free_delivery_order : 499);
        setVal('prof-delivery-charge-input', data.delivery_charge_amount !== undefined ? data.delivery_charge_amount : 40.0);

        const reqLocToggle = document.getElementById('prof-require-location-toggle');
        if (reqLocToggle) reqLocToggle.checked = Boolean(data.require_customer_location);

        const isOpen = data.store_open_status !== undefined ? Boolean(data.store_open_status) : true;
        updateStoreStatusToggleLabel(isOpen);

        setVal('prof-operating-hours', data.operating_hours || '9:00 AM - 10:00 PM');

        const modes = Array.isArray(data.delivery_modes) ? data.delivery_modes : ['doorstep', 'pickup'];
        const mDoor = document.getElementById('mode-doorstep');
        const mPick = document.getElementById('mode-pickup');
        const mExp = document.getElementById('mode-express');
        if (mDoor) mDoor.checked = modes.includes('doorstep');
        if (mPick) mPick.checked = modes.includes('pickup');
        if (mExp) mExp.checked = modes.includes('express');

        // Custom Domain
        setVal('prof-custom-domain-input', data.custom_domain || '');
        const domBadge = document.getElementById('domain-status-badge');
        if (domBadge) {
            if (data.domain_status === 'verified_ssl' && data.custom_domain) {
                domBadge.textContent = '🟢 DNS Verified · SSL Active';
                domBadge.className = 'text-[11px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 rounded-full font-mono';
            } else if (data.custom_domain) {
                domBadge.textContent = '🟡 Pending DNS Propagation';
                domBadge.className = 'text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1 rounded-full font-mono';
            } else {
                domBadge.textContent = '⚪ Using Default Store Link';
                domBadge.className = 'text-[11px] font-bold text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1 rounded-full font-mono';
            }
        }

        updateLiveBrandMockup();
        updateStoreKPIStrip();
    } catch (e) {
        console.warn('Error loading store management settings:', e);
    }
}

async function quickToggleStoreStatus(isOpen) {
    updateStoreStatusToggleLabel(isOpen);
    try {
        const res = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: getActiveUsername(),
                store_open_status: Boolean(isOpen)
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showStoreToast(isOpen ? '🟢 Store is now OPEN and accepting orders!' : '🔴 Store is now PAUSED / CLOSED for checkout.', isOpen ? 'success' : 'info');
        }
    } catch (e) {
        console.warn('Quick store status toggle failed:', e);
    }
}

async function saveStoreSettings(event) {
    if (event && event.preventDefault) event.preventDefault();
    const username = getActiveUsername();
    const btn = document.getElementById('btn-save-store-settings');

    const business_name = document.getElementById('prof-business-name-input')?.value.trim() || '';
    const business_type = document.getElementById('prof-business-type-select')?.value.trim() || 'Kirana / General Store';
    const store_slug = document.getElementById('prof-store-slug-input')?.value.trim() || '';
    const tagline = document.getElementById('prof-tagline-input')?.value.trim() || '';
    const announcement_bar = document.getElementById('prof-announcement-bar-input')?.value.trim() || '';
    const logo_url = document.getElementById('prof-logo-url-input')?.value.trim() || '';
    const promotional_banners = window._promotionalBanners || [];
    const banner_url = promotional_banners.length > 0 ? promotional_banners[0].image_url : '';

    const themeRadio = document.querySelector('input[name="store-theme-color"]:checked');
    const theme_color = themeRadio ? themeRadio.value : 'emerald';

    const social_instagram = document.getElementById('prof-social-insta')?.value.trim() || '';
    const social_facebook = document.getElementById('prof-social-fb')?.value.trim() || '';
    const social_whatsapp = document.getElementById('prof-social-wa')?.value.trim() || '';
    const notification_phone = document.getElementById('prof-notif-phone-input')?.value.trim() || '';

    const allow_cod = document.getElementById('prof-allow-cod-toggle')?.checked ?? true;
    const paytm_vpa = document.getElementById('prof-paytm-vpa-input')?.value.trim() || '';
    const paytm_mid = document.getElementById('prof-paytm-mid-input')?.value.trim() || '';
    const min_order_amount = parseFloat(document.getElementById('prof-min-order-input')?.value) || 0;
    const packaging_charge = parseFloat(document.getElementById('prof-packaging-charge-input')?.value) || 0;

    const full_address = document.getElementById('prof-full-address-input')?.value.trim() || '';
    const local_area = document.getElementById('prof-local-area-input')?.value.trim() || '';
    const latitude = parseFloat(document.getElementById('prof-lat-input')?.value) || 0;
    const longitude = parseFloat(document.getElementById('prof-lng-input')?.value) || 0;
    const gstin_number = document.getElementById('prof-gstin-input')?.value.trim().toUpperCase() || '';
    const privacy_policy = document.getElementById('prof-privacy-policy')?.value.trim() || '';
    const terms_conditions = document.getElementById('prof-terms-conditions')?.value.trim() || '';
    const refund_policy = document.getElementById('prof-refund-policy')?.value.trim() || '';
    const shipping_policy = document.getElementById('prof-shipping-policy')?.value.trim() || '';

    const max_delivery_radius_km = parseFloat(document.getElementById('prof-max-radius-input')?.value) || 15.0;
    const free_delivery_radius_km = parseFloat(document.getElementById('prof-free-radius-input')?.value) >= 0 ? parseFloat(document.getElementById('prof-free-radius-input')?.value) : 3.0;
    const min_free_delivery_order = parseFloat(document.getElementById('prof-min-free-delivery-input')?.value) >= 0 ? parseFloat(document.getElementById('prof-min-free-delivery-input')?.value) : 0.0;
    const delivery_charge_amount = parseFloat(document.getElementById('prof-delivery-charge-input')?.value) >= 0 ? parseFloat(document.getElementById('prof-delivery-charge-input')?.value) : 40.0;
    const require_customer_location = document.getElementById('prof-require-location-toggle')?.checked || false;
    const store_open_status = document.getElementById('prof-store-open-toggle')?.checked ?? true;
    const operating_hours = document.getElementById('prof-operating-hours')?.value.trim() || '9:00 AM - 10:00 PM';

    const delivery_modes = [];
    if (document.getElementById('mode-doorstep')?.checked) delivery_modes.push('doorstep');
    if (document.getElementById('mode-pickup')?.checked) delivery_modes.push('pickup');
    if (document.getElementById('mode-express')?.checked) delivery_modes.push('express');

    const custom_domain = document.getElementById('prof-custom-domain-input')?.value.trim() || '';

    const originalHtml = btn ? btn.innerHTML : 'Save Store Management Settings';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Syncing to Cloud DB...</span>';
    }

    try {
        const res = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                business_name,
                business_type,
                notification_phone,
                store_slug,
                tagline,
                announcement_bar,
                logo_url,
                banner_url,
                promotional_banners,
                theme_color,
                social_instagram,
                social_facebook,
                social_whatsapp,
                allow_cod,
                paytm_vpa,
                paytm_mid,
                min_order_amount,
                packaging_charge,
                full_address,
                local_area,
                latitude,
                longitude,
                gstin_number,
                privacy_policy,
                terms_conditions,
                refund_policy,
                shipping_policy,
                max_delivery_radius_km,
                free_delivery_radius_km,
                min_free_delivery_order,
                delivery_charge_amount,
                require_customer_location,
                store_open_status,
                operating_hours,
                delivery_modes,
                custom_domain
            })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            if (data.store_slug) {
                const slugEl = document.getElementById('prof-store-slug-input');
                if (slugEl) slugEl.value = data.store_slug;
                syncStorePreviewAnchors(`${window.location.origin}/${data.store_slug}`);
            }
            updateLiveBrandMockup();
            updateStoreKPIStrip();
            updateGoogleMapsPinLink();
            showStoreToast('Store Management settings saved & published to your live storefront!', 'success');
            try {
                if (typeof loadUserProfile === 'function') loadUserProfile();
            } catch {}
        } else {
            showStoreToast(data.message || data.error || 'Failed to save store settings.', 'error');
        }
    } catch (err) {
        showStoreToast('Network error while saving store settings. Please try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

async function saveStoreLocation(event) {
    return saveStoreSettings(event);
}

export function getStoreManagementHTML() {
    return `                <!-- VIEW: STORE MANAGEMENT & E-COMMERCE COMMAND CENTER -->
                <div id="view-store" class="space-y-6 max-w-6xl mx-auto pb-12">

                    <!-- Non-Blocking Executive Toast Banner -->
                    <div id="store-toast-banner" class="hidden fixed bottom-6 right-6 z-50 max-w-md px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-md flex items-center gap-3 transition-all duration-200">
                        <i id="store-toast-icon" class="fa-solid fa-circle-check text-emerald-400 text-sm shrink-0"></i>
                        <span id="store-toast-text" class="text-xs font-bold leading-snug">Settings saved!</span>
                        <button type="button" onclick="document.getElementById('store-toast-banner').classList.add('hidden')" class="ml-2 text-slate-400 hover:text-white text-xs cursor-pointer">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>

                    <!-- ============================================================== -->
                    <!-- TOP COMMAND HEADER & LIVE STOREFRONT URL STUDIO -->
                    <!-- ============================================================== -->
                    <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-5">
                        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/90 pb-5">
                            <div class="flex items-start sm:items-center gap-3.5">
                                <div class="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 flex items-center justify-center text-xl shrink-0 shadow-inner">
                                    <i class="fa-solid fa-store"></i>
                                </div>
                                <div>
                                    <div class="flex flex-wrap items-center gap-2.5">
                                        <h2 class="text-lg font-black text-white tracking-tight">Storefront Command Center</h2>
                                        <span class="px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-bold uppercase tracking-wider">
                                            Live E-Commerce Engine
                                        </span>
                                    </div>
                                    <p class="text-xs text-slate-400 mt-0.5">Manage store branding, 16:9 sliding banners, UPI/COD checkout, hyperlocal delivery rules & custom domain.</p>
                                </div>
                            </div>

                            <!-- Instant Store Open/Close Master Switch + Quick Save -->
                            <div class="flex flex-wrap items-center gap-3">
                                <div class="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800">
                                    <div class="text-right">
                                        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Checkout Status</div>
                                        <div id="kpi-store-open-status" class="text-xs font-black text-emerald-400 flex items-center">
                                            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>Open & Live
                                        </div>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer shrink-0" title="Toggle Store Open / Closed">
                                        <input type="checkbox" id="hero-store-open-toggle" checked onchange="quickToggleStoreStatus(this.checked)" class="sr-only peer">
                                        <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                    </label>
                                </div>

                                <button type="button" onclick="openStoreQRModal()" class="px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold rounded-xl text-xs transition cursor-pointer flex items-center gap-2">
                                    <i class="fa-solid fa-qrcode text-cyan-400"></i>
                                    <span>Store QR</span>
                                </button>

                                <button type="button" onclick="shareStoreOnWhatsApp()" class="px-3.5 py-2.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 font-bold rounded-xl text-xs transition cursor-pointer flex items-center gap-2">
                                    <i class="fa-brands fa-whatsapp text-emerald-400 text-sm"></i>
                                    <span>Share Store</span>
                                </button>
                            </div>
                        </div>

                        <!-- Live Storefront Link Bar -->
                        <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-950/90 border border-slate-800/90">
                            <div class="flex items-center gap-2.5 min-w-0 flex-1">
                                <span class="px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-mono font-bold uppercase shrink-0">
                                    <i class="fa-solid fa-globe mr-1"></i>Public URL
                                </span>
                                <input type="text" id="prof-live-store-link-input" readonly value="https://..." class="w-full bg-transparent text-xs font-mono text-cyan-300 outline-none select-all truncate">
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <button type="button" onclick="copyStorefrontLink()" class="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 border border-slate-700">
                                    <i class="fa-regular fa-copy text-cyan-400"></i>
                                    <span id="copy-store-link-text">Copy Link</span>
                                </button>
                                <a id="store-live-preview-anchor" href="/" target="_blank" rel="noopener noreferrer" class="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 shadow-md shadow-cyan-500/15">
                                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                                    <span>Open Live Store</span>
                                </a>
                            </div>
                        </div>

                        <!-- 4 Live Store Telemetry KPI Cards -->
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-regular fa-clock"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Operating Hours</div>
                                    <div id="kpi-store-hours-label" class="text-xs font-bold text-white truncate font-mono mt-0.5">9:00 AM - 10:00 PM</div>
                                    <div class="text-[10px] text-emerald-400 font-medium">Auto-synced on storefront</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-panorama"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Hero Carousel</div>
                                    <div id="kpi-store-banners-count" class="text-xs font-bold text-white font-mono mt-0.5">0 / 5 Slides</div>
                                    <div id="kpi-store-theme-label" class="text-[10px] text-indigo-400 font-medium truncate">Theme: Emerald Mint</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-truck-fast"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Delivery Coverage</div>
                                    <div id="kpi-store-delivery-summary" class="text-xs font-bold text-white font-mono mt-0.5">15 KM Radius · ₹40 Fee</div>
                                    <div id="kpi-store-free-summary" class="text-[10px] text-cyan-400 font-medium truncate">Free ≤ 3 KM or ≥ ₹499</div>
                                </div>
                            </div>

                            <div class="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center text-base shrink-0">
                                    <i class="fa-solid fa-wallet"></i>
                                </div>
                                <div class="min-w-0">
                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">Checkout & Payment</div>
                                    <div id="kpi-store-payment-summary" class="text-xs font-bold text-white font-mono mt-0.5">COD Active</div>
                                    <div id="kpi-store-min-order-label" class="text-[10px] text-amber-400 font-medium truncate">No Minimum Order</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ============================================================== -->
                    <!-- STORE MANAGEMENT SUB-NAVIGATION TABS (5 SECTIONS) -->
                    <!-- ============================================================== -->
                    <div class="flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 p-2 rounded-2xl border border-slate-800">
                        <div class="flex flex-wrap items-center gap-1.5">
                            <button type="button" onclick="switchStoreSubTab('branding')" id="subtab-btn-branding" class="px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20">
                                <i class="fa-solid fa-paintbrush"></i>
                                <span>1. Branding & Media</span>
                            </button>
                            <button type="button" onclick="switchStoreSubTab('payments')" id="subtab-btn-payments" class="px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800/60">
                                <i class="fa-solid fa-credit-card"></i>
                                <span>2. Checkout & Payments</span>
                            </button>
                            <button type="button" onclick="switchStoreSubTab('delivery')" id="subtab-btn-delivery" class="px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800/60">
                                <i class="fa-solid fa-truck-fast"></i>
                                <span>3. Delivery & Simulator</span>
                            </button>
                            <button type="button" onclick="switchStoreSubTab('privacy')" id="subtab-btn-privacy" class="px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800/60">
                                <i class="fa-solid fa-location-dot"></i>
                                <span>4. Location, GST & Legal</span>
                            </button>
                            <button type="button" onclick="switchStoreSubTab('domain')" id="subtab-btn-domain" class="px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white hover:bg-slate-800/60">
                                <i class="fa-solid fa-globe"></i>
                                <span>5. Custom Domain & DNS</span>
                            </button>
                        </div>

                        <button type="button" onclick="saveStoreSettings(event)" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 shadow-md">
                            <i class="fa-solid fa-floppy-disk"></i>
                            <span>Save All</span>
                        </button>
                    </div>

                    <form id="form-store-settings" onsubmit="saveStoreSettings(event)" class="space-y-6">

                        <!-- ============================================================== -->
                        <!-- SUB-SECTION 1: STORE BRANDING, THEME & HERO CAROUSEL -->
                        <!-- ============================================================== -->
                        <div id="subtab-content-branding" class="store-subtab-pane space-y-6">
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center text-lg shrink-0">
                                            <i class="fa-solid fa-paintbrush"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">Store Identity, Theme & Social Channels</h3>
                                            <p class="text-xs text-slate-400">Configure store display name, category, custom URL slug, announcement ticker, and accent palette.</p>
                                        </div>
                                    </div>
                                </div>

                                <!-- Store Name, Business Category, Slug & Tagline -->
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-shop text-emerald-400"></i>
                                            <span>Store / Brand Display Name</span>
                                        </label>
                                        <input type="text" id="prof-business-name-input" oninput="updateLiveBrandMockup()" placeholder="e.g. Gopal Kirana & Supermarket" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition">
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-layer-group text-indigo-400"></i>
                                            <span>Business Category</span>
                                        </label>
                                        <select id="prof-business-type-select" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-cyan-500 cursor-pointer">
                                            <option value="Kirana / General Store">🛒 Kirana / Grocery & Supermarket</option>
                                            <option value="Restaurant / Cloud Kitchen">🍔 Restaurant / Cloud Kitchen & Cafe</option>
                                            <option value="Bakery, Sweets & Snacks">🎂 Bakery, Sweets & Confectionery</option>
                                            <option value="Pharmacy / Medical Store">💊 Pharmacy / Medical & Wellness</option>
                                            <option value="Fashion, Boutique & Apparel">👗 Fashion, Boutique & Footwear</option>
                                            <option value="Electronics & Mobile Accessories">📱 Electronics & Mobile Store</option>
                                            <option value="Cosmetics & Personal Care">✨ Cosmetics, Beauty & Salon</option>
                                            <option value="Hardware, Home & Decor">🏠 Hardware, Home & Kitchen</option>
                                            <option value="Wholesale & B2B Distributor">📦 Wholesale & B2B Distributor</option>
                                        </select>
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-signature text-cyan-400"></i>
                                            <span>Custom Store Slug (URL Path)</span>
                                        </label>
                                        <div class="flex items-center">
                                            <span class="px-3 py-2.5 bg-slate-900 border border-r-0 border-slate-800 rounded-l-xl text-xs text-slate-400 font-mono">/</span>
                                            <input type="text" id="prof-store-slug-input" oninput="updateStoreSlugPreview(this.value)" placeholder="e.g. gopal_kirana" class="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-r-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 font-mono transition">
                                        </div>
                                        <p class="text-[10px] text-slate-500">Lowercase letters, numbers, and underscores only.</p>
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-quote-left text-purple-400"></i>
                                            <span>Store Tagline / Slogan</span>
                                        </label>
                                        <input type="text" id="prof-tagline-input" oninput="updateLiveBrandMockup()" placeholder="e.g. Fresh groceries delivered in 45 minutes" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition">
                                    </div>
                                </div>

                                <!-- Top Storefront Announcement Bar -->
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-slate-300 flex items-center justify-between">
                                        <span class="flex items-center gap-1.5">
                                            <i class="fa-solid fa-bullhorn text-amber-400"></i>
                                            <span>Top Promotional Announcement Ribbon (Optional)</span>
                                        </span>
                                        <span class="text-[10px] font-mono text-slate-500">Shown at top of live storefront</span>
                                    </label>
                                    <input type="text" id="prof-announcement-bar-input" oninput="updateLiveBrandMockup()" placeholder="e.g. 🎉 Free Home Delivery on orders above ₹499! Instant WhatsApp Checkout" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500 transition">
                                </div>

                                <!-- Theme Accent Color Palette + Live Storefront Header Mockup -->
                                <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
                                    <div class="lg:col-span-7 p-4 bg-slate-950/70 rounded-xl border border-slate-800 space-y-3">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-palette text-amber-400"></i> Storefront Accent Theme Color
                                        </label>
                                        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-emerald-500 transition">
                                                <input type="radio" name="store-theme-color" value="emerald" checked onchange="updateLiveBrandMockup()" class="text-emerald-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-emerald-500 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Emerald Mint</span>
                                            </label>
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-cyan-500 transition">
                                                <input type="radio" name="store-theme-color" value="cyan" onchange="updateLiveBrandMockup()" class="text-cyan-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-cyan-400 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Cyber Cyan</span>
                                            </label>
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-indigo-500 transition">
                                                <input type="radio" name="store-theme-color" value="indigo" onchange="updateLiveBrandMockup()" class="text-indigo-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-indigo-500 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Royal Indigo</span>
                                            </label>
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-amber-500 transition">
                                                <input type="radio" name="store-theme-color" value="amber" onchange="updateLiveBrandMockup()" class="text-amber-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-amber-400 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Sunset Amber</span>
                                            </label>
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-rose-500 transition">
                                                <input type="radio" name="store-theme-color" value="rose" onchange="updateLiveBrandMockup()" class="text-rose-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-rose-500 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Rose Crimson</span>
                                            </label>
                                            <label class="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-900 border border-slate-800 cursor-pointer hover:border-purple-500 transition">
                                                <input type="radio" name="store-theme-color" value="purple" onchange="updateLiveBrandMockup()" class="text-purple-500 focus:ring-0">
                                                <span class="w-3.5 h-3.5 rounded-full bg-purple-500 inline-block shrink-0"></span>
                                                <span class="text-xs font-bold text-slate-200">Electric Purple</span>
                                            </label>
                                        </div>
                                    </div>

                                    <!-- Live Storefront Header Preview Card -->
                                    <div class="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-950 overflow-hidden flex flex-col justify-between">
                                        <div id="mockup-announcement-bar" class="hidden px-3 py-1.5 text-[11px] font-bold text-center border-b bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                                            🎉 Free Home Delivery on orders above ₹499!
                                        </div>
                                        <div class="p-4 flex items-center justify-between gap-3">
                                            <div class="flex items-center gap-3 min-w-0">
                                                <div class="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 overflow-hidden flex items-center justify-center shrink-0">
                                                    <img id="mockup-store-logo" src="" alt="Logo" class="w-full h-full object-cover hidden">
                                                    <i id="mockup-store-logo-icon" class="fa-solid fa-store text-slate-500"></i>
                                                </div>
                                                <div class="min-w-0">
                                                    <div class="text-[10px] font-mono uppercase tracking-wider text-slate-500">Live Header Preview</div>
                                                    <div id="mockup-store-name" class="text-xs font-black text-white truncate">Your Store Name</div>
                                                    <div id="mockup-store-tagline" class="text-[11px] text-slate-400 truncate">Fast hyperlocal delivery</div>
                                                </div>
                                            </div>
                                            <span id="mockup-store-cta" class="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-500 text-slate-950 shrink-0">
                                                Order Now
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <!-- Social Media & Order Notification Channels -->
                                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                                    <div class="space-y-1">
                                        <label class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
                                            <i class="fa-brands fa-whatsapp text-emerald-400"></i> Public Support WhatsApp
                                        </label>
                                        <input type="text" id="prof-social-wa" placeholder="e.g. 919876543210" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 outline-none focus:border-emerald-500 font-mono">
                                    </div>
                                    <div class="space-y-1">
                                        <label class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
                                            <i class="fa-solid fa-bell text-amber-400"></i> Order Alert WhatsApp
                                        </label>
                                        <input type="text" id="prof-notif-phone-input" placeholder="e.g. 919876543210" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 outline-none focus:border-amber-500 font-mono">
                                    </div>
                                    <div class="space-y-1">
                                        <label class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
                                            <i class="fa-brands fa-instagram text-pink-400"></i> Instagram URL
                                        </label>
                                        <input type="text" id="prof-social-insta" placeholder="https://instagram.com/your_shop" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 outline-none focus:border-pink-500 font-mono">
                                    </div>
                                    <div class="space-y-1">
                                        <label class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
                                            <i class="fa-brands fa-facebook text-blue-400"></i> Facebook Page URL
                                        </label>
                                        <input type="text" id="prof-social-fb" placeholder="https://facebook.com/your_shop" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 outline-none focus:border-blue-500 font-mono">
                                    </div>
                                </div>

                                <!-- Logo & Multi-Banner Manager Grid -->
                                <div class="space-y-5 pt-2">
                                    <!-- Store Logo Card -->
                                    <div class="p-4 bg-slate-950/70 rounded-xl border border-slate-800 space-y-3">
                                        <div class="flex items-center justify-between">
                                            <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                <i class="fa-solid fa-circle-user text-emerald-400"></i> Store Brand Logo
                                            </label>
                                            <span class="text-[10px] text-slate-400 font-mono">1:1 Square Cropper + URL Support</span>
                                        </div>
                                        <div class="flex flex-col sm:flex-row items-center gap-4">
                                            <div class="relative w-20 h-20 rounded-2xl overflow-hidden bg-slate-900 border-2 border-slate-700 shrink-0 flex items-center justify-center group">
                                                <img id="prof-logo-preview" src="" alt="Logo Preview" class="w-full h-full object-cover hidden">
                                                <div id="prof-logo-placeholder" class="text-slate-600 text-2xl">
                                                    <i class="fa-solid fa-store"></i>
                                                </div>
                                                <div id="prof-logo-overlay" class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px] hidden">
                                                    <button type="button" onclick="openLightbox(document.getElementById('prof-logo-url-input')?.value)" title="View Full Logo" class="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-eye"></i>
                                                    </button>
                                                    <button type="button" onclick="handleDeleteImageSync('logo', 0, document.getElementById('prof-logo-url-input')?.value)" title="Remove Logo" class="w-7 h-7 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-trash"></i>
                                                    </button>
                                                </div>
                                            </div>
                                            <div class="flex-1 w-full space-y-2">
                                                <input type="text" id="prof-logo-url-input" oninput="updateLogoPreview(this.value)" placeholder="Paste direct Logo Image URL or upload a file below..." class="w-full px-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-emerald-500 font-mono">
                                                <div class="flex flex-wrap items-center gap-2">
                                                    <input type="file" id="prof-logo-file" accept="image/*" onchange="startLogoCrop(event)" class="text-[11px] text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-emerald-500/15 file:text-emerald-300 hover:file:bg-emerald-500/25 cursor-pointer">
                                                    <span class="text-[10px] text-slate-500 font-mono">Opens 1:1 Interactive Cropper</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <!-- Multi-Banner Slider System -->
                                    <div class="p-4 bg-slate-950/70 rounded-xl border border-slate-800 space-y-4">
                                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                                            <div>
                                                <div class="flex items-center gap-2">
                                                    <i class="fa-solid fa-panorama text-indigo-400"></i>
                                                    <span class="text-xs font-bold text-white uppercase tracking-wider">Promotional Hero Banner Carousel</span>
                                                    <span id="banner-count-badge" class="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-[10px] font-mono font-bold">0 / 5 Active</span>
                                                </div>
                                                <p class="text-[11px] text-slate-400 mt-0.5">Upload 16:9 widescreen banners or add image URLs directly. Link any slide to a Category or Product.</p>
                                            </div>
                                            <div class="flex items-center gap-2">
                                                <input type="file" id="banner-file-picker" accept="image/*" onchange="startBannerCrop(event)" class="hidden">
                                                <button type="button" id="btn-add-banner" onclick="document.getElementById('banner-file-picker').click()" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 shadow-sm">
                                                    <i class="fa-solid fa-crop-simple text-xs"></i>
                                                    <span>Upload & Crop 16:9 Banner</span>
                                                </button>
                                            </div>
                                        </div>

                                        <!-- Quick Add Banner by URL Bar -->
                                        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                            <input type="text" id="direct-banner-url-input" placeholder="Or paste a direct 16:9 Banner Image URL (https://...) to add slide..." class="flex-1 px-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500 font-mono">
                                            <button type="button" onclick="addDirectBannerUrl()" class="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 font-bold rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0">
                                                <i class="fa-solid fa-plus"></i>
                                                <span>Add Slide via URL</span>
                                            </button>
                                        </div>

                                        <div id="promotional-banners-list" class="space-y-3">
                                            <!-- Dynamic Banners -->
                                        </div>

                                        <div id="banners-empty-state" class="p-6 rounded-xl border border-dashed border-slate-800 text-center space-y-2">
                                            <div class="w-10 h-10 rounded-xl bg-slate-900 text-slate-600 mx-auto flex items-center justify-center text-lg">
                                                <i class="fa-solid fa-images"></i>
                                            </div>
                                            <p class="text-xs text-slate-400 font-medium">No promotional banners uploaded yet.</p>
                                            <p class="text-[11px] text-slate-500">Upload up to 5 widescreen banners (16:9) to showcase festival offers and direct customers to categories or products.</p>
                                        </div>
                                        <input type="hidden" id="prof-banner-url-input" value="">
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ============================================================== -->
                        <!-- SUB-SECTION 2: CHECKOUT, UPI & PAYMENT SETTINGS -->
                        <!-- ============================================================== -->
                        <div id="subtab-content-payments" class="store-subtab-pane hidden space-y-6">
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex items-center gap-3 pb-4 border-b border-slate-800">
                                    <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-lg shrink-0">
                                        <i class="fa-solid fa-credit-card"></i>
                                    </div>
                                    <div>
                                        <h3 class="text-sm font-bold text-white">Checkout, UPI Gateway & Order Value Rules</h3>
                                        <p class="text-xs text-slate-400">Configure Cash on Delivery (COD), Merchant UPI ID for instant payments, minimum order value, and packaging fees.</p>
                                    </div>
                                </div>

                                <!-- COD Master Toggle -->
                                <div class="p-4 bg-slate-950/80 border border-slate-800 rounded-xl flex items-center justify-between gap-4">
                                    <div class="space-y-0.5">
                                        <div class="text-xs font-bold text-white flex items-center gap-2">
                                            <i class="fa-solid fa-money-bill-wave text-emerald-400"></i>
                                            <span>Allow Cash on Delivery (COD) Orders</span>
                                        </div>
                                        <p class="text-[11px] text-slate-400">When enabled, customers can place orders with Cash/Pay-on-Delivery in addition to instant UPI payment.</p>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer shrink-0">
                                        <input type="checkbox" id="prof-allow-cod-toggle" checked onchange="updateStoreKPIStrip()" class="sr-only peer">
                                        <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                    </label>
                                </div>

                                <!-- UPI VPA & Paytm MID -->
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-qrcode text-cyan-400"></i>
                                            <span>Merchant UPI ID / VPA (For Instant UPI QR & Intent)</span>
                                        </label>
                                        <input type="text" id="prof-paytm-vpa-input" oninput="updateStoreKPIStrip()" placeholder="e.g. gopalkirana@paytm or 9876543210@ybl" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-cyan-300 placeholder-slate-500 outline-none focus:border-cyan-500 font-mono">
                                        <p class="text-[10px] text-slate-500">Used to generate dynamic UPI payment links & QR codes during WhatsApp and Web checkout.</p>
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-building-columns text-indigo-400"></i>
                                            <span>Paytm Business Merchant ID (MID - Optional)</span>
                                        </label>
                                        <input type="text" id="prof-paytm-mid-input" placeholder="e.g. GOPALK1234567890" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500 font-mono">
                                        <p class="text-[10px] text-slate-500">Optional Paytm Merchant ID for automated payment status verification.</p>
                                    </div>
                                </div>

                                <!-- Minimum Order Value & Packaging Charge -->
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-basket-shopping text-amber-400"></i>
                                            <span>Minimum Order Value (₹)</span>
                                        </label>
                                        <input type="number" step="1" min="0" id="prof-min-order-input" oninput="updateStoreKPIStrip()" placeholder="0 (No minimum)" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500 font-mono">
                                        <p class="text-[10px] text-slate-500">Set to 0 to allow any cart amount, or e.g. 150 to require ₹150 minimum cart value.</p>
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-box-open text-purple-400"></i>
                                            <span>Flat Packaging / Handling Fee (₹)</span>
                                        </label>
                                        <input type="number" step="1" min="0" id="prof-packaging-charge-input" oninput="updateStoreKPIStrip()" placeholder="0" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-purple-500 font-mono">
                                        <p class="text-[10px] text-slate-500">Added automatically to the bill summary (set 0 for zero packaging fee).</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ============================================================== -->
                        <!-- SUB-SECTION 3: HYPERLOCAL DELIVERY & FEE SIMULATOR -->
                        <!-- ============================================================== -->
                        <div id="subtab-content-delivery" class="store-subtab-pane hidden space-y-6">
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-slate-800 gap-4">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center text-lg shrink-0">
                                            <i class="fa-solid fa-truck-ramp-box"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">Hyperlocal Delivery Rules & Operating Hours</h3>
                                            <p class="text-xs text-slate-400">Define maximum delivery radius, free delivery thresholds, operating hours, and test your pricing live.</p>
                                        </div>
                                    </div>
                                </div>

                                <!-- Master Store Open/Closed Toggle & Operating Hours -->
                                <div class="p-4 bg-slate-950/80 border border-slate-800 rounded-xl grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
                                    <div class="flex items-center justify-between p-3.5 bg-slate-900 rounded-xl border border-slate-800">
                                        <div>
                                            <div class="text-xs font-bold text-white flex items-center gap-1.5">
                                                <i class="fa-solid fa-power-off text-emerald-400"></i>
                                                <span>Store Operating Status</span>
                                            </div>
                                            <span id="store-status-toggle-label" class="text-[11px] font-mono text-emerald-400 font-bold">🟢 Store Open (Accepting Orders)</span>
                                        </div>
                                        <label class="relative inline-flex items-center cursor-pointer shrink-0">
                                            <input type="checkbox" id="prof-store-open-toggle" checked onchange="updateStoreStatusToggleLabel(this.checked)" class="sr-only peer">
                                            <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                        </label>
                                    </div>

                                    <div class="space-y-2">
                                        <label class="text-[11px] font-bold text-slate-300 flex items-center justify-between">
                                            <span class="flex items-center gap-1.5"><i class="fa-regular fa-clock text-cyan-400"></i> Operating Hours</span>
                                            <span class="text-[10px] text-slate-500 font-mono">Click preset or type custom</span>
                                        </label>
                                        <input type="text" id="prof-operating-hours" oninput="updateStoreKPIStrip()" placeholder="e.g. 9:00 AM - 10:00 PM (Daily)" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 font-mono">
                                        <div class="flex flex-wrap gap-1.5">
                                            <button type="button" onclick="applyOperatingHoursPreset('9:00 AM - 10:00 PM (Daily)')" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-slate-300 cursor-pointer">9 AM - 10 PM</button>
                                            <button type="button" onclick="applyOperatingHoursPreset('8:00 AM - 11:00 PM (Daily)')" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-slate-300 cursor-pointer">8 AM - 11 PM</button>
                                            <button type="button" onclick="applyOperatingHoursPreset('10:00 AM - 9:00 PM (Mon-Sat)')" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-slate-300 cursor-pointer">10 AM - 9 PM (Mon-Sat)</button>
                                            <button type="button" onclick="applyOperatingHoursPreset('Open 24x7')" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-emerald-300 cursor-pointer">24x7 Open</button>
                                        </div>
                                    </div>
                                </div>

                                <!-- Delivery Thresholds Grid -->
                                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                    <div class="space-y-1.5">
                                        <label class="text-[11px] font-bold text-slate-300 flex items-center gap-1">
                                            <i class="fa-solid fa-circle-nodes text-indigo-400"></i>
                                            <span>Max Delivery Radius (KM)</span>
                                        </label>
                                        <input type="number" step="0.1" min="0.5" id="prof-max-radius-input" oninput="updateStoreKPIStrip()" placeholder="15.0" class="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition font-mono">
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-[11px] font-bold text-slate-300 flex items-center gap-1">
                                            <i class="fa-solid fa-leaf text-emerald-400"></i>
                                            <span>Free Delivery Radius (KM)</span>
                                        </label>
                                        <input type="number" step="0.1" min="0" id="prof-free-radius-input" oninput="updateStoreKPIStrip()" placeholder="3.0" class="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition font-mono">
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-[11px] font-bold text-slate-300 flex items-center gap-1">
                                            <i class="fa-solid fa-tags text-purple-400"></i>
                                            <span>Min Order for Free Delivery (₹)</span>
                                        </label>
                                        <input type="number" step="1" min="0" id="prof-min-free-delivery-input" oninput="updateStoreKPIStrip()" placeholder="499" class="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition font-mono">
                                    </div>

                                    <div class="space-y-1.5">
                                        <label class="text-[11px] font-bold text-slate-300 flex items-center gap-1">
                                            <i class="fa-solid fa-indian-rupee-sign text-amber-400"></i>
                                            <span>Flat Delivery Fee (₹)</span>
                                        </label>
                                        <input type="number" step="1" min="0" id="prof-delivery-charge-input" oninput="updateStoreKPIStrip()" placeholder="40" class="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition font-mono">
                                    </div>
                                </div>

                                <!-- Interactive Live Delivery Fee Simulator -->
                                <div class="p-4 rounded-xl bg-slate-950 border border-cyan-500/30 space-y-3">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <div class="flex items-center gap-2">
                                            <i class="fa-solid fa-calculator text-cyan-400"></i>
                                            <span class="text-xs font-bold text-white">Interactive Delivery Fee Simulator</span>
                                        </div>
                                        <span id="sim-result-badge" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">
                                            🎉 FREE DELIVERY
                                        </span>
                                    </div>
                                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center pt-1">
                                        <div class="space-y-1">
                                            <div class="flex justify-between text-[11px] text-slate-400">
                                                <span>Sample Customer Distance</span>
                                                <span id="sim-dist-label" class="font-mono font-bold text-cyan-300">2.5 KM</span>
                                            </div>
                                            <input type="range" id="sim-test-distance" min="0.5" max="25" step="0.5" value="2.5" oninput="simulateDeliveryFee()" class="w-full accent-cyan-400 cursor-pointer">
                                        </div>
                                        <div class="space-y-1">
                                            <label class="text-[11px] text-slate-400 block">Sample Customer Cart Value (₹)</label>
                                            <input type="number" id="sim-test-cart" value="350" min="0" step="25" oninput="simulateDeliveryFee()" class="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-white font-mono outline-none focus:border-cyan-500">
                                        </div>
                                        <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
                                            <div>
                                                <div class="text-[10px] font-mono uppercase text-slate-400">Customer Pays</div>
                                                <div id="sim-result-total" class="text-sm font-black text-white font-mono">₹350 Total</div>
                                                <div id="sim-result-detail" class="text-[10px] text-slate-400 truncate max-w-[180px]">Within 3 KM Free Radius</div>
                                            </div>
                                            <i class="fa-solid fa-receipt text-cyan-400 text-lg"></i>
                                        </div>
                                    </div>
                                </div>

                                <!-- Supported Checkout Fulfillment Modes -->
                                <div class="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2.5">
                                    <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                        <i class="fa-solid fa-boxes-packing text-cyan-400"></i> Supported Fulfillment Modes
                                    </label>
                                    <div class="flex flex-wrap items-center gap-4">
                                        <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                                            <input type="checkbox" id="mode-doorstep" checked class="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0">
                                            <span>🚚 Doorstep Home Delivery</span>
                                        </label>
                                        <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                                            <input type="checkbox" id="mode-pickup" checked class="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0">
                                            <span>🛍️ Store Pickup / Self Takeaway</span>
                                        </label>
                                        <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                                            <input type="checkbox" id="mode-express" class="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-0">
                                            <span>⚡ Express 30-min Hyperlocal</span>
                                        </label>
                                    </div>
                                </div>

                                <!-- Require GPS Location Guard -->
                                <div class="p-4 bg-slate-950/80 border border-slate-800 rounded-xl flex items-center justify-between gap-4">
                                    <div class="space-y-0.5">
                                        <div class="text-xs font-bold text-white flex items-center gap-1.5">
                                            <i class="fa-solid fa-location-crosshairs text-rose-400"></i>
                                            <span>Require Exact WhatsApp Location Pin for Delivery</span>
                                        </div>
                                        <p class="text-[11px] text-slate-400 leading-normal">
                                            When enabled, the WhatsApp bot will verify the customer's live GPS location pin to calculate exact road distance before confirming checkout.
                                        </p>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer shrink-0">
                                        <input type="checkbox" id="prof-require-location-toggle" class="sr-only peer">
                                        <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <!-- ============================================================== -->
                        <!-- SUB-SECTION 4: STORE LOCATION, GPS & LEGAL POLICIES -->
                        <!-- ============================================================== -->
                        <div id="subtab-content-privacy" class="store-subtab-pane hidden space-y-6">
                            <!-- Physical Address & GPS Pin -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-slate-800 gap-4">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center text-lg shrink-0">
                                            <i class="fa-solid fa-location-dot"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">Store Physical Address & Geolocation Pin</h3>
                                            <p class="text-xs text-slate-400">Configure shop address and GPS coordinates used to calculate customer delivery distance.</p>
                                        </div>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <a id="gps-google-maps-link" href="https://maps.google.com" target="_blank" rel="noopener noreferrer" class="hidden px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-[11px] font-bold hover:bg-cyan-500/20 transition">
                                            <i class="fa-solid fa-map-location-dot mr-1"></i>View on Google Maps
                                        </a>
                                        <div id="gps-status-badge" class="text-[11px] font-bold text-slate-400 bg-slate-950 border border-slate-800 px-2.5 py-1 rounded-lg">
                                            📍 Geolocation Ready
                                        </div>
                                    </div>
                                </div>

                                <div class="space-y-4">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-store text-cyan-400"></i>
                                            <span>Full Shop / Business Address</span>
                                        </label>
                                        <textarea id="prof-full-address-input" rows="2" placeholder="e.g. Shop No. 12, Main Market Road, Near City Bank, Hazratganj, Lucknow" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition resize-none"></textarea>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div class="space-y-1.5">
                                            <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                <i class="fa-solid fa-map-pin text-amber-400"></i>
                                                <span>Local Area / City Landmark</span>
                                            </label>
                                            <input type="text" id="prof-local-area-input" placeholder="e.g. Hazratganj, Lucknow" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-500 transition">
                                        </div>

                                        <div class="space-y-1.5">
                                            <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                <i class="fa-solid fa-crosshairs text-emerald-400"></i>
                                                <span>Auto-Detect Store Coordinates</span>
                                            </label>
                                            <button type="button" onclick="fetchCurrentGPSLocation()" id="btn-fetch-gps" class="w-full px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-md">
                                                <i class="fa-solid fa-location-crosshairs text-sm"></i>
                                                <span>📍 Fetch Exact GPS Location</span>
                                            </button>
                                        </div>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                                        <div class="space-y-1.5">
                                            <label class="text-[11px] font-bold text-slate-400 flex items-center justify-between font-mono">
                                                <span>Latitude</span>
                                                <span class="text-[10px] text-slate-500">Auto-filled or type manually</span>
                                            </label>
                                            <input type="text" id="prof-lat-input" oninput="updateGoogleMapsPinLink()" placeholder="e.g. 26.84670000" class="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-cyan-300 outline-none focus:border-cyan-500">
                                        </div>

                                        <div class="space-y-1.5">
                                            <label class="text-[11px] font-bold text-slate-400 flex items-center justify-between font-mono">
                                                <span>Longitude</span>
                                                <span class="text-[10px] text-slate-500">Auto-filled or type manually</span>
                                            </label>
                                            <input type="text" id="prof-lng-input" oninput="updateGoogleMapsPinLink()" placeholder="e.g. 80.94620000" class="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-cyan-300 outline-none focus:border-cyan-500">
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Business Registration & Legal Policies Card -->
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-3">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center justify-center text-lg shrink-0">
                                            <i class="fa-solid fa-file-contract"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">Business GSTIN & Legal Compliance Policies</h3>
                                            <p class="text-xs text-slate-400">Specify tax identification and generate customer-facing store policies in 1 click.</p>
                                        </div>
                                    </div>
                                    <button type="button" onclick="generateAllPolicies()" class="px-3.5 py-2 bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shrink-0">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                        <span>Generate All 4 Policies</span>
                                    </button>
                                </div>

                                <div class="space-y-4">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-receipt text-amber-400"></i>
                                            <span>GSTIN / Business Tax Registration Number (Optional)</span>
                                        </label>
                                        <input type="text" id="prof-gstin-input" placeholder="e.g. 09AAAAA0000A1Z5" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-amber-300 outline-none focus:border-amber-500 uppercase">
                                    </div>

                                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                                        <!-- Privacy Policy -->
                                        <div class="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                                            <div class="flex items-center justify-between">
                                                <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                    <i class="fa-solid fa-shield-halved text-emerald-400"></i> Privacy Policy
                                                </label>
                                                <button type="button" onclick="generateDefaultPolicy('privacy')" class="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer">
                                                    <i class="fa-solid fa-wand-magic-sparkles text-[9px]"></i> Auto-Generate
                                                </button>
                                            </div>
                                            <textarea id="prof-privacy-policy" rows="4" placeholder="Enter customer data protection and privacy terms..." class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500 font-mono transition resize-y"></textarea>
                                        </div>

                                        <!-- Terms & Conditions -->
                                        <div class="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                                            <div class="flex items-center justify-between">
                                                <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                    <i class="fa-solid fa-gavel text-cyan-400"></i> Terms & Conditions
                                                </label>
                                                <button type="button" onclick="generateDefaultPolicy('terms')" class="px-2.5 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer">
                                                    <i class="fa-solid fa-wand-magic-sparkles text-[9px]"></i> Auto-Generate
                                                </button>
                                            </div>
                                            <textarea id="prof-terms-conditions" rows="4" placeholder="Enter order acceptance, cancellation, and general store terms..." class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-cyan-500 font-mono transition resize-y"></textarea>
                                        </div>

                                        <!-- Refund Policy -->
                                        <div class="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                                            <div class="flex items-center justify-between">
                                                <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                    <i class="fa-solid fa-rotate-left text-amber-400"></i> Refund & Return Policy
                                                </label>
                                                <button type="button" onclick="generateDefaultPolicy('refund')" class="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer">
                                                    <i class="fa-solid fa-wand-magic-sparkles text-[9px]"></i> Auto-Generate
                                                </button>
                                            </div>
                                            <textarea id="prof-refund-policy" rows="4" placeholder="Specify return eligibility timeframe and damaged item replacement policy..." class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-amber-500 font-mono transition resize-y"></textarea>
                                        </div>

                                        <!-- Shipping Policy -->
                                        <div class="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                                            <div class="flex items-center justify-between">
                                                <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                                    <i class="fa-solid fa-truck text-indigo-400"></i> Shipping & Delivery Policy
                                                </label>
                                                <button type="button" onclick="generateDefaultPolicy('shipping')" class="px-2.5 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-lg text-[10px] font-bold transition flex items-center gap-1 cursor-pointer">
                                                    <i class="fa-solid fa-wand-magic-sparkles text-[9px]"></i> Auto-Generate
                                                </button>
                                            </div>
                                            <textarea id="prof-shipping-policy" rows="4" placeholder="Detail estimated dispatch times, delivery zones, and handling fees..." class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-indigo-500 font-mono transition resize-y"></textarea>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ============================================================== -->
                        <!-- SUB-SECTION 5: CUSTOM DOMAIN MAPPING & DNS SETUP -->
                        <!-- ============================================================== -->
                        <div id="subtab-content-domain" class="store-subtab-pane hidden space-y-6">
                            <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
                                <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-slate-800 gap-4">
                                    <div class="flex items-center gap-3">
                                        <div class="w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center text-lg shrink-0">
                                            <i class="fa-solid fa-globe"></i>
                                        </div>
                                        <div>
                                            <h3 class="text-sm font-bold text-white">Custom Domain Mapping & Automatic SSL</h3>
                                            <p class="text-xs text-slate-400">Connect your own brand domain (e.g. shop.mybrand.in) with Cloudflare edge SSL.</p>
                                        </div>
                                    </div>
                                    <div id="domain-status-badge" class="text-[11px] font-bold text-slate-400 bg-slate-950 border border-slate-800 px-3 py-1 rounded-full font-mono">
                                        ⚪ Using Default Store Link
                                    </div>
                                </div>

                                <div class="space-y-4">
                                    <div class="space-y-1.5">
                                        <label class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                            <i class="fa-solid fa-link text-cyan-400"></i>
                                            <span>Custom Domain or Subdomain</span>
                                        </label>
                                        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                            <input type="text" id="prof-custom-domain-input" placeholder="e.g. shop.mybrand.in or www.gopalkirana.com" class="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-cyan-300 outline-none focus:border-cyan-500">
                                            <button type="button" onclick="verifyCustomDomainDNS()" id="btn-verify-domain-dns" class="px-4 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-1.5 shrink-0 shadow-sm">
                                                <i class="fa-solid fa-rotate text-xs"></i>
                                                <span>Verify DNS & Save</span>
                                            </button>
                                        </div>
                                        <p class="text-[10px] text-slate-500">Enter domain without http:// or https:// prefixes.</p>
                                    </div>

                                    <!-- Interactive DNS Instructions Table -->
                                    <div class="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3">
                                        <div class="flex items-center justify-between">
                                            <h4 class="text-xs font-bold text-white flex items-center gap-1.5">
                                                <i class="fa-solid fa-network-wired text-indigo-400"></i> Required DNS Records Setup Guide
                                            </h4>
                                            <span class="text-[10px] text-slate-400 font-mono">Cloudflare / GoDaddy / Namecheap / Hostinger</span>
                                        </div>
                                        <p class="text-[11px] text-slate-400">
                                            Add either the CNAME record (recommended for subdomains like <code class="text-cyan-300">shop.yourdomain.com</code>) or the A Record (for root domains) in your DNS provider:
                                        </p>

                                        <div class="overflow-x-auto rounded-xl border border-slate-800">
                                            <table class="w-full text-left border-collapse text-xs">
                                                <thead>
                                                    <tr class="bg-slate-900 text-slate-400 border-b border-slate-800 text-[10px] font-mono uppercase">
                                                        <th class="p-2.5">Type</th>
                                                        <th class="p-2.5">Host / Name</th>
                                                        <th class="p-2.5">Target / Points To</th>
                                                        <th class="p-2.5">TTL</th>
                                                        <th class="p-2.5 text-right">Action</th>
                                                    </tr>
                                                </thead>
                                                <tbody class="divide-y divide-slate-800 text-slate-300 font-mono text-[11px]">
                                                    <tr class="hover:bg-slate-900/50">
                                                        <td class="p-2.5 text-cyan-400 font-bold">CNAME</td>
                                                        <td class="p-2.5">shop / www</td>
                                                        <td class="p-2.5 text-emerald-300">cname.wamart.in</td>
                                                        <td class="p-2.5 text-slate-500">Auto / 3600</td>
                                                        <td class="p-2.5 text-right">
                                                            <button type="button" onclick="copyDNSTarget('cname.wamart.in')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[10px] font-sans font-bold cursor-pointer">Copy</button>
                                                        </td>
                                                    </tr>
                                                    <tr class="hover:bg-slate-900/50">
                                                        <td class="p-2.5 text-amber-400 font-bold">A Record</td>
                                                        <td class="p-2.5">@</td>
                                                        <td class="p-2.5 text-emerald-300">76.76.21.21</td>
                                                        <td class="p-2.5 text-slate-500">Auto / 3600</td>
                                                        <td class="p-2.5 text-right">
                                                            <button type="button" onclick="copyDNSTarget('76.76.21.21')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[10px] font-sans font-bold cursor-pointer">Copy</button>
                                                        </td>
                                                    </tr>
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ============================================================== -->
                        <!-- GLOBAL MASTER SUBMIT BAR -->
                        <!-- ============================================================== -->
                        <div class="p-4 bg-slate-900/95 border border-slate-800 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xl">
                            <div class="text-xs text-slate-400 font-mono flex items-center gap-2">
                                <i class="fa-solid fa-cloud-arrow-up text-emerald-400"></i>
                                <span>All store branding, banners, payment & delivery settings sync live to PostgreSQL</span>
                            </div>
                            <button type="submit" id="btn-save-store-settings" class="w-full sm:w-auto px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20">
                                <i class="fa-solid fa-floppy-disk"></i>
                                <span>Save Store Management Settings</span>
                            </button>
                        </div>
                    </form>

                    <!-- ============================================================== -->
                    <!-- STORE QR CODE STANDEE MODAL -->
                    <!-- ============================================================== -->
                    <div id="store-qr-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md" onclick="if(event.target === this) closeStoreQRModal()">
                        <div class="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
                            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
                                <div class="text-left">
                                    <h3 id="store-qr-modal-title" class="text-sm font-black text-white">Store QR Code</h3>
                                    <p class="text-[11px] text-slate-400">Scan with any phone camera or WhatsApp</p>
                                </div>
                                <button type="button" onclick="closeStoreQRModal()" class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center cursor-pointer">
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            </div>
                            <div class="p-4 bg-white rounded-2xl inline-block mx-auto shadow-inner">
                                <img id="store-qr-code-img" src="" alt="Storefront QR Code" class="w-56 h-56 object-contain mx-auto">
                            </div>
                            <div id="store-qr-url-label" class="text-[11px] font-mono text-cyan-300 bg-slate-950 border border-slate-800 px-3 py-2 rounded-xl truncate"></div>
                            <div class="flex items-center gap-2 pt-1">
                                <button type="button" onclick="copyStorefrontLink()" class="flex-1 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-xl text-xs cursor-pointer transition">
                                    <i class="fa-regular fa-copy mr-1"></i>Copy Link
                                </button>
                                <button type="button" onclick="shareStoreOnWhatsApp()" class="flex-1 px-3 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black rounded-xl text-xs cursor-pointer transition">
                                    <i class="fa-brands fa-whatsapp mr-1"></i>Share on WA
                                </button>
                            </div>
                        </div>
                    </div>

                </div>`;
}

export function initStoreManagement(apiBaseUrl = "") {
    Object.assign(window, {
        showStoreToast,
        copyStorefrontLink,
        openStorefrontPreview,
        shareStoreOnWhatsApp,
        openStoreQRModal,
        closeStoreQRModal,
        updateStoreSlugPreview,
        updateLogoPreview,
        updateBannerPreview,
        startLogoCrop,
        renderPromotionalBanners,
        movePromotionalBanner,
        addDirectBannerUrl,
        startBannerCrop,
        updateBannerLink,
        handleBannerQuickSelect,
        fetchCurrentGPSLocation,
        updateGoogleMapsPinLink,
        switchStoreSubTab,
        updateStoreStatusToggleLabel,
        applyOperatingHoursPreset,
        updateLiveBrandMockup,
        simulateDeliveryFee,
        updateStoreKPIStrip,
        generateDefaultPolicy,
        generateAllPolicies,
        copyDNSTarget,
        verifyCustomDomainDNS,
        quickToggleStoreStatus,
        loadStoreSettings,
        saveStoreSettings,
        saveStoreLocation
    });
    loadStoreSettings();
}

export {
    showStoreToast,
    copyStorefrontLink,
    openStorefrontPreview,
    shareStoreOnWhatsApp,
    openStoreQRModal,
    closeStoreQRModal,
    updateStoreSlugPreview,
    updateLogoPreview,
    updateBannerPreview,
    startLogoCrop,
    renderPromotionalBanners,
    movePromotionalBanner,
    addDirectBannerUrl,
    startBannerCrop,
    updateBannerLink,
    handleBannerQuickSelect,
    fetchCurrentGPSLocation,
    updateGoogleMapsPinLink,
    switchStoreSubTab,
    updateStoreStatusToggleLabel,
    applyOperatingHoursPreset,
    updateLiveBrandMockup,
    simulateDeliveryFee,
    updateStoreKPIStrip,
    generateDefaultPolicy,
    generateAllPolicies,
    copyDNSTarget,
    verifyCustomDomainDNS,
    quickToggleStoreStatus,
    loadStoreSettings,
    saveStoreSettings,
    saveStoreLocation
};

Object.assign(window, {
    showStoreToast,
    copyStorefrontLink,
    openStorefrontPreview,
    shareStoreOnWhatsApp,
    openStoreQRModal,
    closeStoreQRModal,
    updateStoreSlugPreview,
    updateLogoPreview,
    updateBannerPreview,
    startLogoCrop,
    renderPromotionalBanners,
    movePromotionalBanner,
    addDirectBannerUrl,
    startBannerCrop,
    updateBannerLink,
    handleBannerQuickSelect,
    fetchCurrentGPSLocation,
    updateGoogleMapsPinLink,
    switchStoreSubTab,
    updateStoreStatusToggleLabel,
    applyOperatingHoursPreset,
    updateLiveBrandMockup,
    simulateDeliveryFee,
    updateStoreKPIStrip,
    generateDefaultPolicy,
    generateAllPolicies,
    copyDNSTarget,
    verifyCustomDomainDNS,
    quickToggleStoreStatus,
    loadStoreSettings,
    saveStoreSettings,
    saveStoreLocation
});
