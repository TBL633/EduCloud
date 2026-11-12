import { getActiveUsername } from "./auth-guard.js";
// Shared Cloudflare R2 Media Uploader, Cropper.js Modal & Lightbox Engine
        function blobToDataURL(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        async function uploadToMediaWorker(file, folder = 'products') {
            if (!file) return { url: '' };
            const username = getActiveUsername() || 'default';
            const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) 
                ? crypto.randomUUID() 
                : (Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9));
            
            // Clean extension
            let ext = 'jpg';
            if (file.name && file.name.includes('.')) {
                ext = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
            } else if (file.type && file.type.includes('/')) {
                ext = file.type.split('/')[1].toLowerCase().replace(/[^a-z0-9]/g, '');
            }
            if (!ext || ext === 'jpeg') ext = 'jpg';

            const cleanFolder = (folder === 'branding' || folder === 'brand') ? 'branding' : 'products';
            const uploadPath = `${username}/${cleanFolder}/${uuid}.${ext}`;
            const workerUrl = `https://wamart-cloudflare.rkmtech633.workers.dev/upload?path=${encodeURIComponent(uploadPath)}`;

            try {
                const res = await fetch(workerUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': file.type || 'application/octet-stream'
                    },
                    body: file
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data && (data.success || data.url)) {
                        return { url: data.url };
                    }
                }
            } catch (workerErr) {
                console.warn('Cloudflare R2 worker unreachable, falling back to inline data URL:', workerErr);
            }

            // Fallback: encode optimized cropped blob as data URL so upload never fails
            const fallbackDataUrl = await blobToDataURL(file);
            return { url: fallbackDataUrl };
        }

        window.currentCropper = null;
        window._cropperCallback = null;

        function openCropperModal(file, aspectRatio, title, callback) {
            if (!file) return;
            const modal = document.getElementById('image-cropper-modal');
            const targetImg = document.getElementById('cropper-image-target');
            const titleEl = document.getElementById('cropper-modal-title');
            const ratioBadge = document.getElementById('cropper-ratio-badge');
            const applyBtn = document.getElementById('btn-apply-crop');

            if (!modal || !targetImg) return;

            if (titleEl) titleEl.innerText = title || 'Crop & Optimize Image';
            if (ratioBadge) {
                if (Math.abs(aspectRatio - 1) < 0.01) {
                    ratioBadge.innerText = '1:1 Square Enforced';
                } else if (Math.abs(aspectRatio - (16 / 9)) < 0.05) {
                    ratioBadge.innerText = '16:9 Landscape Enforced';
                } else {
                    ratioBadge.innerText = `${aspectRatio.toFixed(2)} Aspect Ratio`;
                }
            }

            if (applyBtn) {
                applyBtn.disabled = false;
                applyBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>Apply & Upload</span>';
            }

            window._cropperCallback = callback;

            const reader = new FileReader();
            reader.onload = function(e) {
                targetImg.src = e.target.result;
                modal.classList.remove('hidden');

                if (window.currentCropper) {
                    window.currentCropper.destroy();
                    window.currentCropper = null;
                }

                // Initialize CropperJS once modal is visible
                setTimeout(() => {
                    if (typeof Cropper !== 'undefined') {
                        window.currentCropper = new Cropper(targetImg, {
                            aspectRatio: aspectRatio,
                            viewMode: 1,
                            autoCropArea: 0.95,
                            responsive: true,
                            restore: false,
                            guides: true,
                            center: true,
                            highlight: false,
                            cropBoxMovable: true,
                            cropBoxResizable: true,
                            toggleDragModeOnDblclick: false,
                            background: false
                        });
                    } else {
                        console.warn('CropperJS library not loaded, using uncropped image');
                    }
                }, 100);
            };
            reader.readAsDataURL(file);
        }

        function closeCropperModal() {
            const modal = document.getElementById('image-cropper-modal');
            if (modal) modal.classList.add('hidden');
            if (window.currentCropper) {
                window.currentCropper.destroy();
                window.currentCropper = null;
            }
            window._cropperCallback = null;

            // Reset file inputs so re-selecting the same file fires onchange
            const prodFileInput = document.getElementById('product-image-file');
            if (prodFileInput) prodFileInput.value = '';
            const logoFileInput = document.getElementById('prof-logo-file');
            if (logoFileInput) logoFileInput.value = '';
            const bannerFileInput = document.getElementById('banner-file-picker');
            if (bannerFileInput) bannerFileInput.value = '';
        }

        async function applyCroppedImage() {
            const applyBtn = document.getElementById('btn-apply-crop');
            if (!window.currentCropper) {
                closeCropperModal();
                return;
            }

            if (applyBtn) {
                applyBtn.disabled = true;
                applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span> Processing & Uploading...</span>';
            }

            try {
                const canvas = window.currentCropper.getCroppedCanvas({
                    maxWidth: 1920,
                    maxHeight: 1920,
                    imageSmoothingQuality: 'high'
                });

                canvas.toBlob(async (blob) => {
                    if (!blob) {
                        alert('Could not generate cropped image.');
                        closeCropperModal();
                        return;
                    }
                    if (window._cropperCallback) {
                        try {
                            await window._cropperCallback(blob);
                        } catch (err) {
                            alert('Upload error: ' + (err.message || err));
                        }
                    }
                    closeCropperModal();
                }, 'image/jpeg', 0.90);
            } catch (err) {
                alert('Crop failed: ' + err.message);
                closeCropperModal();
            }
        }

        // LIGHTBOX PREVIEW MODAL
        function openLightbox(url) {
            url = (url || '').trim();
            if (!url) return;
            const modal = document.getElementById('image-lightbox-modal');
            const target = document.getElementById('lightbox-image-target');
            const link = document.getElementById('lightbox-open-link');

            if (target) target.src = url;
            if (link) link.href = url;
            if (modal) modal.classList.remove('hidden');
        }

        function closeLightbox() {
            const modal = document.getElementById('image-lightbox-modal');
            const target = document.getElementById('lightbox-image-target');
            if (modal) modal.classList.add('hidden');
            if (target) target.src = '';
        }

        // FULL-STACK IMAGE DELETION SYNC
        function extractStoragePath(imageUrl, typeFallback) {
            if (!imageUrl) return '';
            try {
                // If full URL with query or origin
                const parsed = new URL(imageUrl, window.location.origin);
                let p = parsed.pathname.replace(/^\/+/, '');
                // Check if path starts with username or includes products/branding
                if (p.includes('/products/') || p.includes('/branding/')) {
                    return p;
                }
            } catch (e) {}

            const username = getActiveUsername() || 'admin';
            const cleanUrl = imageUrl.split('?')[0];
            const filename = cleanUrl.split('/').pop();
            const folder = (typeFallback === 'product' || typeFallback === 'products') ? 'products' : 'branding';
            return `${username}/${folder}/${filename}`;
        }

        async function handleDeleteImageSync(type, identifier, imageUrl, bannerIndex) {
            if (!imageUrl && type !== 'banner') return;

            const username = getActiveUsername() || 'admin';
            const storagePath = extractStoragePath(imageUrl, type);

            // Step 1: Send DELETE to Cloudflare Worker media proxy
            if (storagePath && !String(imageUrl).startsWith('data:')) {
                try {
                    const cfDeleteUrl = `https://wamart-cloudflare.rkmtech633.workers.dev/delete?path=${encodeURIComponent(storagePath)}`;
                    await fetch(cfDeleteUrl, { method: 'DELETE' });
                } catch (cfErr) {
                    console.warn('Cloudflare Worker delete warning:', cfErr);
                }
            }

            // Step 2: Send DELETE to backend to clear DB reference
            try {
                const res = await fetch('/api/media/image', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: type,
                        id: parseInt(identifier || '0', 10),
                        username: username,
                        index: typeof bannerIndex === 'number' ? bannerIndex : 0
                    })
                });
                const data = await res.json();
                console.log('Image cleared from DB:', data);
            } catch (apiErr) {
                console.warn('Backend image clear warning:', apiErr);
            }

            // Step 3: Synchronize UI
            if (type === 'logo') {
                const logoInput = document.getElementById('prof-logo-url-input');
                if (logoInput) logoInput.value = '';
                if (typeof window.updateLogoPreview === 'function') window.updateLogoPreview('');
                if (typeof window.showStoreToast === 'function') window.showStoreToast('Store logo removed and synced with database.', 'info');
            } else if (type === 'banner') {
                if (typeof bannerIndex === 'number' && Array.isArray(window._promotionalBanners)) {
                    window._promotionalBanners.splice(bannerIndex, 1);
                    if (typeof window.renderPromotionalBanners === 'function') window.renderPromotionalBanners();
                    if (typeof window.showStoreToast === 'function') window.showStoreToast(`Promotional Banner #${bannerIndex + 1} removed.`, 'info');
                }
            } else if (type === 'product') {
                const hiddenUrl = document.getElementById('product-image-url-hidden');
                const textUrl = document.getElementById('product-image-url-text');
                const previewBar = document.getElementById('product-image-preview-bar');
                if (hiddenUrl) hiddenUrl.value = '';
                if (textUrl) textUrl.value = '';
                if (previewBar) previewBar.classList.add('hidden');
            }
        }

export function getMediaModalsHTML() {
    return `    <!-- ============================================================== -->
    <!-- IMAGE CROPPER MODAL (ENFORCES 1:1 FOR LOGO/PRODUCT, 16:9 FOR BANNER) -->
    <!-- ============================================================== -->
    <div id="image-cropper-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/85 backdrop-blur-md">
        <div class="relative w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            <!-- Header -->
            <div class="px-5 py-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center text-sm">
                        <i class="fa-solid fa-crop-simple"></i>
                    </div>
                    <div>
                        <h3 id="cropper-modal-title" class="text-sm font-bold text-white">Crop & Optimize Image</h3>
                        <span id="cropper-ratio-badge" class="text-[10px] font-mono text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">1:1 Aspect Ratio</span>
                    </div>
                </div>
                <button type="button" onclick="closeCropperModal()" class="w-8 h-8 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center text-sm transition cursor-pointer">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Canvas / Image Container -->
            <div class="relative flex-1 min-h-[300px] max-h-[460px] bg-slate-950 overflow-hidden flex items-center justify-center p-2">
                <img id="cropper-image-target" src="" alt="To Crop" class="max-w-full max-h-full block">
            </div>

            <!-- Cropper Controls Toolbar -->
            <div class="px-5 py-3 bg-slate-950/90 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 shrink-0">
                <div class="flex items-center gap-1.5 text-xs text-slate-300">
                    <button type="button" onclick="if(currentCropper) currentCropper.zoom(0.1)" title="Zoom In" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition cursor-pointer">
                        <i class="fa-solid fa-magnifying-glass-plus"></i>
                    </button>
                    <button type="button" onclick="if(currentCropper) currentCropper.zoom(-0.1)" title="Zoom Out" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition cursor-pointer">
                        <i class="fa-solid fa-magnifying-glass-minus"></i>
                    </button>
                    <button type="button" onclick="if(currentCropper) currentCropper.rotate(-90)" title="Rotate Left" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition cursor-pointer">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                    <button type="button" onclick="if(currentCropper) currentCropper.rotate(90)" title="Rotate Right" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition cursor-pointer">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                    <button type="button" onclick="if(currentCropper) currentCropper.reset()" title="Reset Crop" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition cursor-pointer">
                        <i class="fa-solid fa-arrows-rotate"></i>
                    </button>
                </div>

                <div class="flex items-center gap-2">
                    <button type="button" onclick="closeCropperModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer">
                        Cancel
                    </button>
                    <button type="button" id="btn-apply-crop" onclick="applyCroppedImage()" class="px-5 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 shadow-md">
                        <i class="fa-solid fa-check"></i>
                        <span>Apply & Upload</span>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- ============================================================== -->
    <!-- FULLSCREEN LIGHTBOX PREVIEW MODAL -->
    <!-- ============================================================== -->
    <div id="image-lightbox-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md" onclick="if(event.target === this) closeLightbox()">
        <div class="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
            <button type="button" onclick="closeLightbox()" class="absolute -top-10 right-0 text-slate-400 hover:text-white text-xl cursor-pointer">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <img id="lightbox-image-target" src="" class="max-w-full max-h-[82vh] object-contain rounded-2xl shadow-2xl border border-slate-800">
            <div class="mt-3 flex items-center gap-3">
                <a id="lightbox-open-link" href="#" target="_blank" class="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition flex items-center gap-1.5">
                    <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i> Open Original
                </a>
                <button type="button" onclick="closeLightbox()" class="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition cursor-pointer">
                    Close
                </button>
            </div>
        </div>
    </div>`;
}

export function initMediaCropper(apiBaseUrl = "") {
    Object.assign(window, { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync });
}

export { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync };
Object.assign(window, { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync });
