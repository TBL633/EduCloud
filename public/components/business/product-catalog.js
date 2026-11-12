import { getActiveUsername, escapeHtml, checkBusinessAuth, checkNeonStatus } from "../shared/auth-guard.js";
import { uploadToMediaWorker, openCropperModal, closeCropperModal, applyCroppedImage, openLightbox, closeLightbox, extractStoragePath, handleDeleteImageSync } from "../shared/media-cropper.js";

// ==============================================================
// BUSINESS PORTAL: ENTERPRISE INVENTORY & PRODUCT CATALOG TOOL
// ==============================================================

window._activeInventorySubtab = 'products';
window._loadedCategories = [];
window._loadedProducts = [];
window._productFormSlotImages = ['', '', ''];
window._activeUploadSlotIndex = 0;
window._productCatalogViewMode = 'grid';
window._activeProductUnitType = 'weight';
window._productVariantsList = [];

const UNIT_PRESETS_MAP = {
    weight: ['100g', '250g', '500g', '1 KG', '2 KG', '5 KG', '10 KG'],
    liquid: ['100ml', '250ml', '500ml', '750ml', '1 Litre', '2 Litre', '5 Litre'],
    pieces: ['1 Pc', '2 Pcs', '4 Pcs Pack', '6 Pcs Pack', '10 Pcs Box', '12 Pcs (Dozen)'],
    size: ['Small (S)', 'Medium (M)', 'Large (L)', 'XL', 'XXL', 'Half Plate', 'Full Plate'],
    custom: ['Standard', 'Regular Pack', 'Family Pack', 'Combo Pack', 'Monthly Plan']
};

function showCatalogToast(message, type = 'success') {
    const existing = document.getElementById('catalog-toast-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'catalog-toast-banner';
    const colorClass = type === 'error'
        ? 'bg-rose-950/95 border-rose-500/50 text-rose-200'
        : 'bg-emerald-950/95 border-emerald-500/50 text-emerald-200';
    const iconClass = type === 'error' ? 'fa-circle-exclamation text-rose-400' : 'fa-circle-check text-emerald-400';

    banner.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-2xl border shadow-2xl flex items-center gap-2.5 text-xs font-bold backdrop-blur-md transition-all duration-300 ${colorClass}`;
    banner.innerHTML = `<i class="fa-solid ${iconClass} text-sm"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(banner);

    setTimeout(() => {
        if (banner && banner.parentNode) banner.remove();
    }, 3500);
}

// 0B. CATALOG ITEM CLASSIFICATION (PRODUCT VS SERVICE TOGGLE)
function setCatalogType(type) {
    const input = document.getElementById('item-type-input');
    const badge = document.getElementById('item-type-badge');
    const prodBtn = document.getElementById('type-prod-btn');
    const servBtn = document.getElementById('type-serv-btn');
    const lblName = document.getElementById('lbl-item-name');
    const lblPrice = document.getElementById('lbl-item-price');
    const lblDesc = document.getElementById('lbl-item-desc');
    const btnAddItemText = document.getElementById('btn-add-item-text');
    const btnAddItem = document.getElementById('btn-add-item');
    const stockFieldsWrap = document.getElementById('product-stock-qty-fields-wrap');

    if (input) input.value = type;

    if (type === 'service') {
        if (badge) {
            badge.innerText = 'Service Mode';
            badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/30';
        }
        if (servBtn) {
            servBtn.className = 'p-2.5 rounded-xl border border-indigo-500 bg-indigo-500/10 text-indigo-300 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer shadow-sm';
        }
        if (prodBtn) {
            prodBtn.className = 'p-2.5 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-white text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer';
        }
        if (lblName) lblName.innerText = 'Service / Offering Name *';
        if (lblPrice) lblPrice.innerText = 'Base Service Fee / Rate (₹) *';
        if (lblDesc) lblDesc.innerText = 'Service Scope, Deliverables & Highlights';
        if (btnAddItemText && document.getElementById('product-id-hidden')?.value === '0') {
            btnAddItemText.innerText = 'Save Service';
        }
        if (btnAddItem) {
            btnAddItem.className = 'px-6 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-md';
        }
        if (stockFieldsWrap) stockFieldsWrap.classList.remove('hidden');
    } else {
        if (badge) {
            badge.innerText = 'Product Mode';
            badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
        }
        if (prodBtn) {
            prodBtn.className = 'p-2.5 rounded-xl border border-emerald-500 bg-emerald-500/10 text-emerald-300 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer shadow-sm';
        }
        if (servBtn) {
            servBtn.className = 'p-2.5 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-white text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer';
        }
        if (lblName) lblName.innerText = 'Product Name *';
        if (lblPrice) lblPrice.innerText = 'Base Selling Price (₹) *';
        if (lblDesc) lblDesc.innerText = 'Product Description / Highlights';
        if (btnAddItemText && document.getElementById('product-id-hidden')?.value === '0') {
            btnAddItemText.innerText = 'Save Product';
        }
        if (btnAddItem) {
            btnAddItem.className = 'px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-md';
        }
        if (stockFieldsWrap) stockFieldsWrap.classList.remove('hidden');
    }
}

async function handleCategoryImageSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const hiddenUrlInput = document.getElementById('category-image-url-hidden');
        const directUrlInput = document.getElementById('category-image-url-direct');
        const previewBar = document.getElementById('category-image-preview-bar');
        const thumb = document.getElementById('category-image-preview-thumb');
        const urlTxt = document.getElementById('category-image-preview-url');

        if (previewBar) previewBar.classList.remove('hidden');
        if (urlTxt) urlTxt.innerText = 'Uploading to Cloudflare Media Worker...';

        const res = await uploadToMediaWorker(file, 'branding');
        const url = res.url || res;
        if (hiddenUrlInput) hiddenUrlInput.value = url;
        if (directUrlInput) directUrlInput.value = url;
        if (thumb) thumb.src = url;
        if (urlTxt) urlTxt.innerText = url;
        showCatalogToast('Category image uploaded!');
    } catch (err) {
        showCatalogToast('Category Image upload failed: ' + err.message, 'error');
    }
}

function applyCategoryDirectImageUrl(urlVal) {
    const cleanUrl = (urlVal || '').trim();
    const hiddenUrlInput = document.getElementById('category-image-url-hidden');
    const previewBar = document.getElementById('category-image-preview-bar');
    const thumb = document.getElementById('category-image-preview-thumb');
    const urlTxt = document.getElementById('category-image-preview-url');

    if (hiddenUrlInput) hiddenUrlInput.value = cleanUrl;
    if (cleanUrl) {
        if (previewBar) previewBar.classList.remove('hidden');
        if (thumb) thumb.src = cleanUrl;
        if (urlTxt) urlTxt.innerText = cleanUrl;
    } else {
        if (previewBar) previewBar.classList.add('hidden');
    }
}

// ==============================================================
// ADVANCED IMAGE CROPPER, LIGHTBOX & FULL-STACK DELETION ENGINE
// ==============================================================
function updateProductImagePreview(url) {
    url = (url || '').trim();
    const hiddenUrlInput = document.getElementById('product-image-url-hidden');
    const urlTextInput = document.getElementById('product-image-url-text');
    const previewBar = document.getElementById('product-image-preview-bar');
    const thumb = document.getElementById('product-image-preview-thumb');
    const urlTxt = document.getElementById('product-image-preview-url');

    if (hiddenUrlInput) hiddenUrlInput.value = url;
    if (urlTextInput && urlTextInput.value !== url) urlTextInput.value = url;

    if (url) {
        if (previewBar) previewBar.classList.remove('hidden');
        if (thumb) thumb.src = url;
        if (urlTxt) urlTxt.innerText = url;
    } else {
        if (previewBar) previewBar.classList.add('hidden');
    }
}

async function handleProductImageSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    openCropperModal(file, 1, 'Crop Product Image (1:1 Square)', async (croppedBlob) => {
        const hiddenUrlInput = document.getElementById('product-image-url-hidden');
        const urlTextInput = document.getElementById('product-image-url-text');
        const previewBar = document.getElementById('product-image-preview-bar');
        const thumb = document.getElementById('product-image-preview-thumb');
        const urlTxt = document.getElementById('product-image-preview-url');

        if (previewBar) previewBar.classList.remove('hidden');
        if (urlTxt) urlTxt.innerText = 'Uploading cropped product image to Cloudflare Media Worker...';

        const uploadFile = new File([croppedBlob], `prod_${Date.now()}.jpg`, { type: 'image/jpeg' });
        const res = await uploadToMediaWorker(uploadFile, 'products');
        const origUrl = res.url || res;

        if (hiddenUrlInput) hiddenUrlInput.value = origUrl;
        if (urlTextInput) urlTextInput.value = origUrl;
        if (thumb) thumb.src = origUrl || '';
        if (urlTxt) urlTxt.innerText = origUrl;
    });
}

async function removeProductImage() {
    const hiddenId = document.getElementById('product-id-hidden');
    const hiddenUrl = document.getElementById('product-image-url-hidden');
    const prodId = hiddenId ? parseInt(hiddenId.value || '0', 10) : 0;
    const url = hiddenUrl ? hiddenUrl.value.trim() : '';
    await handleDeleteImageSync('product', prodId, url, 0);
}

// ==============================================================
// INVENTORY MANAGEMENT SUITE - SUBTAB SWITCHING
// ==============================================================
function switchInventorySubtab(subtab) {
    window._activeInventorySubtab = subtab;
    const btnProds = document.getElementById('btn-inv-subtab-products');
    const btnCats = document.getElementById('btn-inv-subtab-categories');
    const viewProds = document.getElementById('inv-subtab-products-view');
    const viewCats = document.getElementById('inv-subtab-categories-view');

    if (subtab === 'products') {
        if (btnProds) btnProds.className = 'px-4 py-2 rounded-xl text-xs font-black transition cursor-pointer flex items-center gap-2 bg-emerald-500 text-slate-950 shadow-md';
        if (btnCats) btnCats.className = 'px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-2 text-slate-400 hover:text-white hover:bg-slate-900';
        if (viewProds) viewProds.classList.remove('hidden');
        if (viewCats) viewCats.classList.add('hidden');
    } else {
        if (btnProds) btnProds.className = 'px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-2 text-slate-400 hover:text-white hover:bg-slate-900';
        if (btnCats) btnCats.className = 'px-4 py-2 rounded-xl text-xs font-black transition cursor-pointer flex items-center gap-2 bg-amber-500 text-slate-950 shadow-md';
        if (viewProds) viewProds.classList.add('hidden');
        if (viewCats) viewCats.classList.remove('hidden');
    }
}

// ==============================================================
// CATEGORY & SUB-CATEGORY HIERARCHY LOGIC
// ==============================================================
function toggleCategoryParentSelect(levelVal) {
    const dropdownWrap = document.getElementById('parent-category-dropdown-wrap');
    if (dropdownWrap) {
        if (levelVal === 'sub') {
            dropdownWrap.classList.remove('hidden');
        } else {
            dropdownWrap.classList.add('hidden');
        }
    }
}

function onProductCategoryChanged(categoryName, selectedSubCategory = '') {
    const subSelect = document.getElementById('product-subcategory-select');
    if (!subSelect) return;

    const categories = window._loadedCategories || [];
    const parentObj = categories.find(c =>
        (!c.parent_id || c.parent_id === 0) &&
        (!c.parent_name || c.parent_name.trim() === '') &&
        (c.category_name || '').toLowerCase() === (categoryName || '').toLowerCase()
    );

    const matchingSubs = categories.filter(c => {
        if (!categoryName) return false;
        const pNameMatch = (c.parent_name || '').toLowerCase() === categoryName.toLowerCase();
        const pIdMatch = parentObj && c.parent_id === parentObj.id;
        return pNameMatch || pIdMatch;
    });

    if (matchingSubs.length === 0) {
        subSelect.innerHTML = `<option value="">-- No Sub-Categories (Optional) --</option>`;
        subSelect.value = '';
        return;
    }

    subSelect.innerHTML = `<option value="">-- Select Sub-Category (Optional) --</option>` +
        matchingSubs.map(s => `<option value="${escapeHtml(s.category_name)}" data-id="${s.id}">${escapeHtml(s.category_name)}</option>`).join('');

    if (selectedSubCategory) {
        subSelect.value = selectedSubCategory;
    }
}

async function loadCategories() {
    const username = getActiveUsername();
    const parentSelect = document.getElementById('category-parent-select');
    const prodCatSelect = document.getElementById('product-category-select');
    const hierarchyContainer = document.getElementById('category-hierarchy-container');

    try {
        const res = await fetch(`/api/categories?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        const categories = data.categories || [];

        window._loadedCategories = categories;

        // Separate Parent vs Sub categories
        const parentCategories = categories.filter(c => (!c.parent_id || c.parent_id === 0) && (!c.parent_name || c.parent_name.trim() === ''));
        const subCategories = categories.filter(c => (c.parent_id && c.parent_id > 0) || (c.parent_name && c.parent_name.trim() !== ''));

        // Update KPI badge if present
        const kpiCatsEl = document.getElementById('inv-kpi-categories-count');
        if (kpiCatsEl) {
            kpiCatsEl.innerText = `${parentCategories.length} Main / ${subCategories.length} Sub`;
        }

        // Populate Parent Select dropdown for Sub-Category form
        if (parentSelect) {
            const currVal = parentSelect.value;
            parentSelect.innerHTML = `<option value="">-- Choose Parent Category --</option>` +
                parentCategories.map(c => `<option value="${escapeHtml(c.category_name)}" data-id="${c.id}">${escapeHtml(c.category_name)}</option>`).join('');
            if (currVal) parentSelect.value = currVal;
        }

        // Populate Product Form Category Select
        if (prodCatSelect) {
            const currVal = prodCatSelect.value;
            // Include any categories used on products even if not yet created in categories table
            const prodCats = (window._loadedProducts || []).map(p => p.category || p.category_name).filter(Boolean);
            const allParentNames = Array.from(new Set([...parentCategories.map(c => c.category_name), ...prodCats]));
            prodCatSelect.innerHTML = `<option value="">-- Select Category --</option>` +
                allParentNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
            if (currVal) {
                prodCatSelect.value = currVal;
                onProductCategoryChanged(currVal, document.getElementById('product-subcategory-select')?.value || '');
            }
        }

        // Render Hierarchy Cards
        if (hierarchyContainer) {
            if (parentCategories.length === 0 && subCategories.length === 0) {
                hierarchyContainer.innerHTML = `
                    <div class="p-6 rounded-2xl bg-slate-950 border border-slate-800 text-slate-500 text-xs text-center">
                        <i class="fa-solid fa-sitemap text-2xl text-slate-600 mb-2"></i>
                        <p class="font-bold text-slate-400">No Categories Created Yet</p>
                        <p class="text-[11px] text-slate-600 mt-1">Create main categories above to organize your inventory.</p>
                    </div>
                `;
                return;
            }

            hierarchyContainer.innerHTML = parentCategories.map(parent => {
                const subs = subCategories.filter(s => s.parent_id === parent.id || (s.parent_name || '').toLowerCase() === (parent.category_name || '').toLowerCase());

                return `
                    <div class="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3 hover:border-amber-500/40 transition">
                        <div class="flex items-center justify-between border-b border-slate-900 pb-2.5">
                            <div class="flex items-center gap-3">
                                ${parent.category_image_url ? `<img src="${escapeHtml(parent.category_image_url)}" class="w-10 h-10 object-cover rounded-xl border border-slate-700 cursor-pointer" onclick="openLightbox('${escapeHtml(parent.category_image_url)}')">` : `<div class="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 font-black text-sm"><i class="fa-solid fa-folder-open"></i></div>`}
                                <div>
                                    <h4 class="text-sm font-bold text-white flex items-center gap-2">
                                        ${escapeHtml(parent.category_name)}
                                        <span class="px-2 py-0.5 rounded-full bg-slate-900 text-slate-400 font-mono text-[10px] font-semibold border border-slate-800">${parent.product_count || 0} items</span>
                                    </h4>
                                    <span class="text-[10px] text-slate-500 font-mono">Main Parent Category (ID #${parent.id})</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <button type="button" onclick="openQuickSubcategoryForm('${escapeHtml(parent.category_name)}', ${parent.id})" class="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold transition cursor-pointer flex items-center gap-1" title="Add Sub-Category under ${escapeHtml(parent.category_name)}">
                                    <i class="fa-solid fa-plus"></i> Add Sub
                                </button>
                                <button type="button" onclick="editCategory(${parent.id})" class="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs transition cursor-pointer" title="Edit Category">
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                                <button type="button" onclick="deleteCategory(${parent.id})" class="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs transition cursor-pointer" title="Delete Parent Category">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>

                        <!-- Nested Sub-Categories Pills -->
                        <div>
                            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Nested Sub-Categories (${subs.length}):</span>
                            ${subs.length > 0 ? `
                                <div class="flex flex-wrap items-center gap-2">
                                    ${subs.map(sub => `
                                        <div class="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-semibold text-amber-300 flex items-center gap-2 group hover:border-amber-500/40 transition">
                                            <i class="fa-solid fa-angle-right text-[10px] text-amber-500"></i>
                                            <span>${escapeHtml(sub.category_name)}</span>
                                            <span class="text-[9px] font-mono text-slate-500">(${sub.product_count || 0})</span>
                                            <button type="button" onclick="editCategory(${sub.id})" class="text-amber-400/80 hover:text-amber-300 text-[10px] cursor-pointer ml-1" title="Edit Sub-Category">
                                                <i class="fa-solid fa-pen"></i>
                                            </button>
                                            <button type="button" onclick="deleteCategory(${sub.id})" class="text-rose-400/80 hover:text-rose-400 text-[10px] cursor-pointer" title="Delete Sub-Category">
                                                <i class="fa-solid fa-xmark"></i>
                                            </button>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : `
                                <div class="text-[11px] text-slate-600 italic">No sub-categories created under ${escapeHtml(parent.category_name)} yet. Click "+ Add Sub" to create one.</div>
                            `}
                        </div>
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('Error loading categories:', err);
    }
}

function openQuickSubcategoryForm(parentName, parentId) {
    switchInventorySubtab('categories');
    const levelSelect = document.getElementById('category-level-select');
    const parentSelect = document.getElementById('category-parent-select');
    const nameInput = document.getElementById('category-name-input');

    if (levelSelect) {
        levelSelect.value = 'sub';
        toggleCategoryParentSelect('sub');
    }
    if (parentSelect) {
        parentSelect.value = parentName;
    }
    if (nameInput) {
        nameInput.focus();
    }
}

function editCategory(categoryId) {
    const categories = window._loadedCategories || [];
    const cat = categories.find(c => c.id === categoryId);
    if (!cat) return;

    switchInventorySubtab('categories');
    const idHidden = document.getElementById('category-id-hidden');
    const nameInput = document.getElementById('category-name-input');
    const hiddenUrl = document.getElementById('category-image-url-hidden');
    const directUrl = document.getElementById('category-image-url-direct');
    const levelSelect = document.getElementById('category-level-select');
    const parentSelect = document.getElementById('category-parent-select');
    const btnText = document.getElementById('btn-save-category-text');
    const cancelBtn = document.getElementById('btn-cancel-category-edit');

    if (idHidden) idHidden.value = String(cat.id);
    if (nameInput) nameInput.value = cat.category_name || '';
    if (hiddenUrl) hiddenUrl.value = cat.category_image_url || '';
    if (directUrl) directUrl.value = cat.category_image_url || '';
    applyCategoryDirectImageUrl(cat.category_image_url || '');

    const isSub = (cat.parent_id && cat.parent_id > 0) || (cat.parent_name && cat.parent_name.trim() !== '');
    if (levelSelect) {
        levelSelect.value = isSub ? 'sub' : 'parent';
        toggleCategoryParentSelect(isSub ? 'sub' : 'parent');
    }
    if (isSub && parentSelect) {
        parentSelect.value = cat.parent_name || '';
    }
    if (btnText) btnText.innerText = `Update Category #${cat.id}`;
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    if (nameInput) nameInput.focus();
}

function cancelCategoryEdit() {
    const idHidden = document.getElementById('category-id-hidden');
    const nameInput = document.getElementById('category-name-input');
    const hiddenUrl = document.getElementById('category-image-url-hidden');
    const directUrl = document.getElementById('category-image-url-direct');
    const fileInput = document.getElementById('category-image-file');
    const levelSelect = document.getElementById('category-level-select');
    const previewBar = document.getElementById('category-image-preview-bar');
    const btnText = document.getElementById('btn-save-category-text');
    const cancelBtn = document.getElementById('btn-cancel-category-edit');

    if (idHidden) idHidden.value = '0';
    if (nameInput) nameInput.value = '';
    if (hiddenUrl) hiddenUrl.value = '';
    if (directUrl) directUrl.value = '';
    if (fileInput) fileInput.value = '';
    if (levelSelect) {
        levelSelect.value = 'parent';
        toggleCategoryParentSelect('parent');
    }
    if (previewBar) previewBar.classList.add('hidden');
    if (btnText) btnText.innerText = 'Save Category';
    if (cancelBtn) cancelBtn.classList.add('hidden');
}

async function saveCategory() {
    const idHidden = document.getElementById('category-id-hidden');
    const nameInput = document.getElementById('category-name-input');
    const hiddenUrl = document.getElementById('category-image-url-hidden');
    const directUrl = document.getElementById('category-image-url-direct');
    const levelSelect = document.getElementById('category-level-select');
    const parentSelect = document.getElementById('category-parent-select');

    const catId = idHidden ? parseInt(idHidden.value || '0', 10) : 0;
    const categoryName = nameInput ? nameInput.value.trim() : '';
    const categoryImageUrl = (hiddenUrl?.value || directUrl?.value || '').trim();
    const level = levelSelect ? levelSelect.value : 'parent';

    if (!categoryName) {
        showCatalogToast('Category Name is required.', 'error');
        return;
    }

    let parentId = 0;
    let parentName = '';

    if (level === 'sub') {
        if (!parentSelect || !parentSelect.value) {
            showCatalogToast('Please select a Parent Category for this sub-category.', 'error');
            return;
        }
        parentName = parentSelect.value;
        const opt = parentSelect.options[parentSelect.selectedIndex];
        parentId = opt ? parseInt(opt.getAttribute('data-id') || '0', 10) : 0;
    }

    const username = getActiveUsername();
    const btn = document.getElementById('btn-save-category');
    if (btn) btn.disabled = true;

    try {
        const payload = {
            username,
            category_name: categoryName,
            category_image_url: categoryImageUrl,
            parent_id: parentId,
            parent_name: parentName
        };
        if (catId > 0) payload.id = catId;

        const res = await fetch('/api/categories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            cancelCategoryEdit();
            await loadCategories();
            await loadProductCatalog();
            showCatalogToast(catId > 0 ? 'Category updated!' : 'Category saved to Neon DB!');
        } else {
            showCatalogToast(data.message || data.error || 'Failed to save category', 'error');
        }
    } catch (err) {
        showCatalogToast('Server error saving category', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteCategory(id) {
    if (!confirm('Are you sure you want to delete this category? Products under this category will remain in your catalog.')) return;
    const username = getActiveUsername();
    try {
        const res = await fetch(`/api/categories?id=${id}&username=${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'success') {
            await loadCategories();
            await loadProductCatalog();
            showCatalogToast('Category deleted');
        } else {
            showCatalogToast('Failed to delete category', 'error');
        }
    } catch (err) {
        showCatalogToast('Server error deleting category', 'error');
    }
}

// ==============================================================
// MULTI-VARIANT BUILDER & PRESET UNIT ENGINE
// ==============================================================
function selectProductUnitType(unitType) {
    window._activeProductUnitType = unitType || 'weight';
    const unitTypes = ['weight', 'liquid', 'pieces', 'size', 'custom'];

    unitTypes.forEach(t => {
        const btn = document.getElementById(`btn-unit-${t}`);
        if (!btn) return;
        if (t === window._activeProductUnitType) {
            btn.className = 'p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-sm';
        } else {
            btn.className = 'p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-slate-900 border-slate-800 text-slate-400 hover:text-white';
        }
    });

    const pillsContainer = document.getElementById('unit-preset-pills');
    if (pillsContainer) {
        const presets = UNIT_PRESETS_MAP[window._activeProductUnitType] || UNIT_PRESETS_MAP.custom;
        pillsContainer.innerHTML = presets.map(label => {
            const exists = (window._productVariantsList || []).some(v => (v.variant || v.label || '').toLowerCase() === label.toLowerCase());
            return `
                <button type="button" onclick="addPresetVariant('${escapeHtml(label)}')" class="px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer flex items-center gap-1.5 ${exists ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300' : 'bg-slate-900 hover:bg-slate-800 border-slate-800 text-slate-300 hover:border-emerald-500/40'}">
                    <i class="fa-solid ${exists ? 'fa-check text-emerald-400' : 'fa-plus text-emerald-400'} text-[10px]"></i>
                    <span>${escapeHtml(label)}</span>
                </button>
            `;
        }).join('');
    }
}

function addPresetVariant(label) {
    if (!Array.isArray(window._productVariantsList)) {
        window._productVariantsList = [];
    }
    const existingIdx = window._productVariantsList.findIndex(v => (v.variant || v.label || '').toLowerCase() === label.toLowerCase());
    if (existingIdx !== -1) {
        showCatalogToast(`Variant "${label}" is already added below.`);
        return;
    }

    const baseMrp = parseFloat(document.getElementById('product-mrp')?.value || '0') || 0;
    const baseSale = parseFloat(document.getElementById('product-sale-price')?.value || '0') || 0;

    window._productVariantsList.push({
        variant: label,
        mrp: baseMrp > 0 ? baseMrp : '',
        price: baseSale > 0 ? baseSale : '',
        stock: 25
    });

    selectProductUnitType(window._activeProductUnitType);
    renderVariantRows();
}

function addCustomVariantRow(variantObj = null) {
    if (!Array.isArray(window._productVariantsList)) {
        window._productVariantsList = [];
    }
    const baseMrp = parseFloat(document.getElementById('product-mrp')?.value || '0') || 0;
    const baseSale = parseFloat(document.getElementById('product-sale-price')?.value || '0') || 0;

    window._productVariantsList.push(variantObj || {
        variant: '',
        mrp: baseMrp > 0 ? baseMrp : '',
        price: baseSale > 0 ? baseSale : '',
        stock: 25
    });
    renderVariantRows();
}

function updateVariantField(idx, field, value) {
    if (!window._productVariantsList || !window._productVariantsList[idx]) return;
    if (field === 'mrp' || field === 'price') {
        window._productVariantsList[idx][field] = value === '' ? '' : (parseFloat(value) || 0);
    } else if (field === 'stock') {
        window._productVariantsList[idx][field] = value === '' ? 0 : Math.max(0, parseInt(value, 10) || 0);
    } else {
        window._productVariantsList[idx][field] = value;
    }
}

function removeVariantRow(idx) {
    if (!Array.isArray(window._productVariantsList)) return;
    window._productVariantsList.splice(idx, 1);
    selectProductUnitType(window._activeProductUnitType);
    renderVariantRows();
}

function renderVariantRows() {
    const container = document.getElementById('product-variants-rows-container');
    if (!container) return;

    const list = window._productVariantsList || [];
    if (list.length === 0) {
        container.innerHTML = `
            <div class="p-3 rounded-xl bg-slate-950/70 border border-dashed border-slate-800 text-center text-[11px] text-slate-500">
                No unit variants added yet. Click any preset size pill above (e.g., 250g, 500g, 1 KG) or click "+ Add Custom Variant Row".
            </div>
        `;
        return;
    }

    container.innerHTML = list.map((v, idx) => {
        const labelVal = v.variant ?? v.label ?? v.size ?? '';
        const mrpVal = v.mrp ?? '';
        const priceVal = v.price ?? v.sale_price ?? '';
        const stockVal = v.stock ?? 25;

        return `
            <div class="grid grid-cols-12 gap-2 items-center p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-emerald-500/30 transition">
                <div class="col-span-4 sm:col-span-4">
                    <label class="block text-[9px] font-bold text-slate-500 uppercase mb-0.5">Variety / Size</label>
                    <input type="text" value="${escapeHtml(String(labelVal))}" oninput="updateVariantField(${idx}, 'variant', this.value)" placeholder="e.g. 500g / Large" class="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-white font-semibold outline-none focus:border-emerald-500">
                </div>
                <div class="col-span-3 sm:col-span-3">
                    <label class="block text-[9px] font-bold text-slate-500 uppercase mb-0.5">MRP (₹)</label>
                    <input type="number" step="0.01" value="${mrpVal}" oninput="updateVariantField(${idx}, 'mrp', this.value)" placeholder="199" class="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 outline-none focus:border-emerald-500">
                </div>
                <div class="col-span-3 sm:col-span-3">
                    <label class="block text-[9px] font-bold text-emerald-400 uppercase mb-0.5">Sale Price (₹)</label>
                    <input type="number" step="0.01" value="${priceVal}" oninput="updateVariantField(${idx}, 'price', this.value)" placeholder="149" class="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-emerald-400 font-bold outline-none focus:border-emerald-500">
                </div>
                <div class="col-span-2 sm:col-span-2 flex items-end justify-end gap-1 pt-3.5">
                    <button type="button" onclick="removeVariantRow(${idx})" class="p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs transition cursor-pointer" title="Remove Variant">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function generateProductSKU() {
    const cat = (document.getElementById('product-category-select')?.value || 'GEN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'GEN';
    const name = (document.getElementById('product-name')?.value || 'ITEM').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || 'ITEM';
    const rand = Math.floor(100 + Math.random() * 900);
    const skuInput = document.getElementById('product-sku');
    if (skuInput) {
        skuInput.value = `${cat}-${name}-${rand}`;
    }
}

// ==============================================================
// PRODUCT CATALOG & 3-SLOT MULTI-IMAGE MANAGEMENT LOGIC
// ==============================================================
function toggleProductFormDrawer(show) {
    const container = document.getElementById('product-form-container');
    const btnText = document.getElementById('btn-toggle-product-text');
    if (!container) return;

    const isCurrentlyHidden = container.classList.contains('hidden');
    const shouldShow = show !== undefined ? show : isCurrentlyHidden;

    if (shouldShow) {
        container.classList.remove('hidden');
        if (btnText) btnText.innerText = 'Hide Product Form';
        selectProductUnitType(window._activeProductUnitType || 'weight');
        renderVariantRows();
        const nameInput = document.getElementById('product-name');
        if (nameInput) nameInput.focus();
    } else {
        container.classList.add('hidden');
        if (btnText) btnText.innerText = 'Add New Product';
        resetProductForm();
    }
}

function triggerProductSlotUpload(slotIdx) {
    window._activeUploadSlotIndex = slotIdx;
    const fileInput = document.getElementById('product-slot-file-input');
    if (fileInput) {
        fileInput.value = '';
        fileInput.click();
    }
}

async function handleProductSlotFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const slotIdx = window._activeUploadSlotIndex || 0;
    openCropperModal(file, 1, `Crop Image Slot ${slotIdx + 1} (1:1 Square)`, async (croppedBlob) => {
        const uploadFile = new File([croppedBlob], `prod_slot_${slotIdx}_${Date.now()}.jpg`, { type: 'image/jpeg' });
        const res = await uploadToMediaWorker(uploadFile, 'products');
        const uploadedUrl = res.url || res;
        if (uploadedUrl) {
            window._productFormSlotImages[slotIdx] = uploadedUrl;
            renderProductFormSlots();
            showCatalogToast(`Slot ${slotIdx + 1} image uploaded!`);
        }
    });
}

function applyDirectSlotImageUrl() {
    const urlInput = document.getElementById('product-direct-image-url-input');
    const slotSelect = document.getElementById('product-direct-image-slot-select');
    const rawUrl = (urlInput?.value || '').trim();
    if (!rawUrl) {
        showCatalogToast('Please paste a valid image URL first', 'error');
        return;
    }
    const slotIdx = slotSelect ? (parseInt(slotSelect.value, 10) || 0) : 0;
    window._productFormSlotImages[slotIdx] = rawUrl;
    renderProductFormSlots();
    if (urlInput) urlInput.value = '';
    showCatalogToast(`Image URL assigned to Slot ${slotIdx + 1}`);
}

function getProductSlotUrl(slotIdx) {
    return (window._productFormSlotImages && window._productFormSlotImages[slotIdx]) || '';
}

async function clearProductSlotImage(slotIdx) {
    const url = getProductSlotUrl(slotIdx);
    if (!url) return;
    if (!confirm(`Are you sure you want to remove Image Slot ${slotIdx + 1}?`)) return;

    const storagePath = extractStoragePath(url, 'product');
    if (storagePath) {
        try {
            await fetch(`https://wamart-cloudflare.rkmtech633.workers.dev/delete?path=${encodeURIComponent(storagePath)}`, { method: 'DELETE' });
        } catch (e) {
            console.warn('Worker delete warning:', e);
        }
    }

    window._productFormSlotImages[slotIdx] = '';
    renderProductFormSlots();
}

function renderProductFormSlots() {
    for (let i = 0; i < 3; i++) {
        const slotNum = i + 1;
        const previewEl = document.getElementById(`product-slot-${slotNum}-preview`);
        const placeholderEl = document.getElementById(`product-slot-${slotNum}-placeholder`);
        const imgEl = document.getElementById(`product-slot-${slotNum}-img`);
        const url = window._productFormSlotImages[i] || '';

        if (url) {
            if (previewEl) previewEl.classList.remove('hidden');
            if (placeholderEl) placeholderEl.classList.add('hidden');
            if (imgEl) imgEl.src = url;
        } else {
            if (previewEl) previewEl.classList.add('hidden');
            if (placeholderEl) placeholderEl.classList.remove('hidden');
            if (imgEl) imgEl.src = '';
        }
    }
}

function setProductCatalogViewMode(mode) {
    window._productCatalogViewMode = mode;
    const btnGrid = document.getElementById('btn-view-grid');
    const btnTable = document.getElementById('btn-view-table');

    if (mode === 'grid') {
        if (btnGrid) btnGrid.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 bg-emerald-500 text-slate-950 cursor-pointer';
        if (btnTable) btnTable.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer';
    } else {
        if (btnGrid) btnGrid.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer';
        if (btnTable) btnTable.className = 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 bg-emerald-500 text-slate-950 cursor-pointer';
    }
    renderProductCatalogDisplay();
}

function filterProductsCatalog() {
    renderProductCatalogDisplay();
}

async function addProduct() {
    const productId = parseInt(document.getElementById('product-id-hidden')?.value || '0', 10);
    const name = document.getElementById('product-name')?.value.trim() || '';
    const sku = document.getElementById('product-sku')?.value.trim() || '';
    const itemType = document.getElementById('item-type-input')?.value || 'product';
    const categorySelect = document.getElementById('product-category-select');
    const categoryName = categorySelect ? categorySelect.value.trim() : '';
    const subCategorySelect = document.getElementById('product-subcategory-select');
    const subCategoryName = subCategorySelect ? subCategorySelect.value.trim() : '';
    const description = document.getElementById('product-desc')?.value.trim() || '';
    const mrp = parseFloat(document.getElementById('product-mrp')?.value || '0') || 0;
    const salePrice = parseFloat(document.getElementById('product-sale-price')?.value || '0') || 0;
    const stockQuantity = Math.max(0, parseInt(document.getElementById('product-stock-qty')?.value || '50', 10) || 0);
    const lowStockThreshold = Math.max(0, parseInt(document.getElementById('product-low-stock')?.value || '5', 10) || 5);
    const whatsappUrl = document.getElementById('product-whatsapp-url')?.value.trim() || '';
    const inStock = document.getElementById('product-in-stock')?.checked ?? true;

    if (!name) {
        showCatalogToast('Product Name is required!', 'error');
        return;
    }
    if (!categoryName) {
        showCatalogToast('Please select or create a Primary Category first!', 'error');
        return;
    }
    if (!salePrice || salePrice <= 0) {
        showCatalogToast('Please enter a valid Base Selling Price!', 'error');
        return;
    }

    const validImages = (window._productFormSlotImages || []).filter(u => u && u.trim() !== '');
    const cleanVariants = (window._productVariantsList || [])
        .filter(v => (v.variant || v.label || '').toString().trim() !== '')
        .map(v => ({
            variant: String(v.variant || v.label || '').trim(),
            mrp: parseFloat(v.mrp) || mrp || 0,
            price: parseFloat(v.price) || salePrice || 0,
            stock: v.stock !== undefined ? (parseInt(v.stock, 10) || 0) : 25
        }));

    const username = getActiveUsername();
    const btn = document.getElementById('btn-add-item');
    if (btn) btn.disabled = true;

    try {
        const payload = {
            username,
            category: categoryName,
            category_name: categoryName,
            sub_category: subCategoryName,
            name,
            sku,
            description,
            item_type: itemType,
            unit_type: window._activeProductUnitType || 'weight',
            variants: cleanVariants,
            mrp,
            sale_price: salePrice,
            stock_quantity: stockQuantity,
            low_stock_threshold: lowStockThreshold,
            images: validImages,
            product_image_url: validImages[0] || '',
            image_url: validImages[0] || '',
            whatsapp_url: whatsappUrl,
            whatsapp_catalog_link: whatsappUrl,
            in_stock: inStock,
            price: `₹${salePrice}`
        };
        if (productId > 0) {
            payload.id = productId;
        }

        const res = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            resetProductForm();
            toggleProductFormDrawer(false);
            await loadProductCatalog();
            await loadCategories();
            showCatalogToast(productId > 0 ? 'Product updated in Neon DB!' : 'New item added to inventory!');
        } else {
            showCatalogToast(data.message || data.error || 'Failed to save product', 'error');
        }
    } catch (err) {
        showCatalogToast('Server error saving product', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function editProduct(productId) {
    const products = window._loadedProducts || [];
    const item = products.find(p => p.id === productId);
    if (!item) {
        showCatalogToast('Product details not found.', 'error');
        return;
    }

    toggleProductFormDrawer(true);

    const titleEl = document.getElementById('form-drawer-title');
    if (titleEl) titleEl.innerText = `Edit Item #${item.id}: ${item.name}`;

    const idHidden = document.getElementById('product-id-hidden');
    if (idHidden) idHidden.value = item.id;

    setCatalogType(item.item_type || 'product');

    const nameInput = document.getElementById('product-name');
    if (nameInput) nameInput.value = item.name || '';

    const skuInput = document.getElementById('product-sku');
    if (skuInput) skuInput.value = item.sku || `SKU-${String(item.id).padStart(4, '0')}`;

    const categorySelect = document.getElementById('product-category-select');
    const catName = item.category || item.category_name || '';
    if (categorySelect && catName) {
        if (!Array.from(categorySelect.options).some(o => o.value === catName)) {
            const opt = document.createElement('option');
            opt.value = catName;
            opt.textContent = catName;
            categorySelect.appendChild(opt);
        }
        categorySelect.value = catName;
    }
    onProductCategoryChanged(catName, item.sub_category || '');

    const descInput = document.getElementById('product-desc');
    if (descInput) descInput.value = item.description || item.details || '';

    const mrpInput = document.getElementById('product-mrp');
    if (mrpInput) mrpInput.value = item.mrp || '';

    const salePriceInput = document.getElementById('product-sale-price');
    const calculatedSalePrice = item.sale_price || parseFloat(String(item.price || '').replace(/[^\d.]/g, '')) || '';
    if (salePriceInput) salePriceInput.value = calculatedSalePrice;

    const stockQtyInput = document.getElementById('product-stock-qty');
    if (stockQtyInput) stockQtyInput.value = item.stock_quantity !== undefined ? item.stock_quantity : 50;

    const lowStockInput = document.getElementById('product-low-stock');
    if (lowStockInput) lowStockInput.value = item.low_stock_threshold !== undefined ? item.low_stock_threshold : 5;

    const whatsappInput = document.getElementById('product-whatsapp-url');
    if (whatsappInput) whatsappInput.value = item.whatsapp_catalog_link || item.whatsapp_url || '';

    window._activeProductUnitType = item.unit_type || 'weight';
    window._productVariantsList = Array.isArray(item.variants)
        ? item.variants.map(v => ({
            variant: v.variant || v.label || v.size || '',
            mrp: v.mrp ?? '',
            price: v.price ?? v.sale_price ?? '',
            stock: v.stock ?? 25
        }))
        : [];
    selectProductUnitType(window._activeProductUnitType);
    renderVariantRows();

    const itemImages = item.images || [];
    window._productFormSlotImages = [
        itemImages[0] || item.product_image_url || item.image_url || '',
        itemImages[1] || '',
        itemImages[2] || ''
    ];
    renderProductFormSlots();

    const inStockCheck = document.getElementById('product-in-stock');
    const inStock = item.in_stock ?? true;
    if (inStockCheck) {
        inStockCheck.checked = inStock;
        const stockLabel = document.getElementById('stock-toggle-label');
        if (stockLabel) {
            stockLabel.innerText = inStock ? 'In Stock' : 'Out of Stock';
            stockLabel.className = inStock ? 'ml-2 text-xs font-bold text-emerald-400 font-mono' : 'ml-2 text-xs font-bold text-rose-400 font-mono';
        }
    }

    const btnText = document.getElementById('btn-add-item-text');
    if (btnText) btnText.innerText = 'Update Item Details';

    const formEl = document.getElementById('product-form');
    if (formEl) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function duplicateProduct(productId) {
    const products = window._loadedProducts || [];
    const item = products.find(p => p.id === productId);
    if (!item) return;

    const username = getActiveUsername();
    try {
        const payload = {
            username,
            category: item.category || item.category_name || 'General',
            category_name: item.category || item.category_name || 'General',
            sub_category: item.sub_category || '',
            name: `${item.name} (Copy)`,
            sku: item.sku ? `${item.sku}-COPY` : '',
            description: item.description || item.details || '',
            item_type: item.item_type || 'product',
            unit_type: item.unit_type || 'weight',
            variants: Array.isArray(item.variants) ? item.variants : [],
            mrp: item.mrp || 0,
            sale_price: item.sale_price || parseFloat(String(item.price || '').replace(/[^\d.]/g, '')) || 0,
            stock_quantity: item.stock_quantity ?? 50,
            low_stock_threshold: item.low_stock_threshold ?? 5,
            images: Array.isArray(item.images) ? item.images : (item.product_image_url ? [item.product_image_url] : []),
            product_image_url: item.product_image_url || item.image_url || '',
            image_url: item.product_image_url || item.image_url || '',
            whatsapp_url: item.whatsapp_catalog_link || item.whatsapp_url || '',
            in_stock: item.in_stock ?? true
        };

        const res = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadProductCatalog();
            await loadCategories();
            showCatalogToast(`Cloned "${item.name}"!`);
        }
    } catch (err) {
        showCatalogToast('Failed to duplicate item', 'error');
    }
}

function resetProductForm() {
    const titleEl = document.getElementById('form-drawer-title');
    if (titleEl) titleEl.innerText = 'Add New Product / Service';

    const idHidden = document.getElementById('product-id-hidden');
    if (idHidden) idHidden.value = '0';

    setCatalogType('product');

    const nameInput = document.getElementById('product-name');
    if (nameInput) nameInput.value = '';

    const skuInput = document.getElementById('product-sku');
    if (skuInput) skuInput.value = '';

    const subCatSelect = document.getElementById('product-subcategory-select');
    if (subCatSelect) subCatSelect.innerHTML = `<option value="">-- Select Sub-Category (Optional) --</option>`;

    const descInput = document.getElementById('product-desc');
    if (descInput) descInput.value = '';

    const mrpInput = document.getElementById('product-mrp');
    if (mrpInput) mrpInput.value = '';

    const salePriceInput = document.getElementById('product-sale-price');
    if (salePriceInput) salePriceInput.value = '';

    const stockQtyInput = document.getElementById('product-stock-qty');
    if (stockQtyInput) stockQtyInput.value = '50';

    const lowStockInput = document.getElementById('product-low-stock');
    if (lowStockInput) lowStockInput.value = '5';

    const whatsappInput = document.getElementById('product-whatsapp-url');
    if (whatsappInput) whatsappInput.value = '';

    window._activeProductUnitType = 'weight';
    window._productVariantsList = [];
    selectProductUnitType('weight');
    renderVariantRows();

    window._productFormSlotImages = ['', '', ''];
    renderProductFormSlots();

    const inStockCheck = document.getElementById('product-in-stock');
    if (inStockCheck) {
        inStockCheck.checked = true;
        const stockLabel = document.getElementById('stock-toggle-label');
        if (stockLabel) {
            stockLabel.innerText = 'In Stock';
            stockLabel.className = 'ml-2 text-xs font-bold text-emerald-400 font-mono';
        }
    }

    const btnText = document.getElementById('btn-add-item-text');
    if (btnText) btnText.innerText = 'Save Product';
}

async function toggleStockStatus(productId, currentInStock) {
    const newStock = !currentInStock;
    const username = getActiveUsername();
    try {
        const res = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: productId,
                username,
                in_stock: newStock
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadProductCatalog();
            showCatalogToast(newStock ? 'Marked In Stock' : 'Marked Out of Stock');
        }
    } catch (err) {
        console.error('Failed to toggle stock status:', err);
    }
}

async function adjustProductStockQty(productId, delta) {
    const username = getActiveUsername();
    try {
        const res = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: productId,
                username,
                stock_delta: delta
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            await loadProductCatalog();
        }
    } catch (err) {
        console.error('Failed to adjust stock quantity:', err);
    }
}

async function deleteProduct(productId) {
    if (!confirm('Are you sure you want to permanently delete this item and purge its images from cloud storage?')) return;
    const username = getActiveUsername();
    try {
        const res = await fetch(`/api/products?id=${productId}&username=${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'success') {
            const deletedImages = data.deleted_images || [];
            for (const imgUrl of deletedImages) {
                const path = extractStoragePath(imgUrl, 'product');
                if (path) {
                    try {
                        await fetch(`https://wamart-cloudflare.rkmtech633.workers.dev/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
                    } catch (cfErr) {
                        console.warn('Worker delete warning:', cfErr);
                    }
                }
            }
            await loadProductCatalog();
            await loadCategories();
            showCatalogToast('Product deleted from catalog');
        } else {
            showCatalogToast('Failed to delete product', 'error');
        }
    } catch (err) {
        showCatalogToast('Server error deleting product', 'error');
    }
}

function updateInventoryKpiStats(products) {
    const list = Array.isArray(products) ? products : [];
    const totalItems = list.length;
    const inStockItems = list.filter(p => p.in_stock !== false && (p.stock_quantity ?? 50) > 0).length;
    const totalUnits = list.reduce((acc, p) => acc + (p.in_stock === false ? 0 : (Number(p.stock_quantity ?? 50) || 0)), 0);
    const lowOrOutItems = list.filter(p => {
        const qty = Number(p.stock_quantity ?? 50);
        const thresh = Number(p.low_stock_threshold ?? 5);
        return p.in_stock === false || qty <= thresh;
    }).length;
    const totalValue = list.reduce((acc, p) => {
        const price = Number(p.sale_price) || parseFloat(String(p.price || '').replace(/[^\d.]/g, '')) || 0;
        const qty = p.in_stock === false ? 0 : (Number(p.stock_quantity ?? 50) || 0);
        return acc + price * qty;
    }, 0);

    const elTotal = document.getElementById('inv-kpi-total-items');
    const elInStock = document.getElementById('inv-kpi-instock-items');
    const elUnits = document.getElementById('inv-kpi-total-units');
    const elAlerts = document.getElementById('inv-kpi-lowstock-alerts');
    const elValue = document.getElementById('inv-kpi-total-value');

    if (elTotal) elTotal.innerText = String(totalItems);
    if (elInStock) elInStock.innerText = `${inStockItems} Active`;
    if (elUnits) elUnits.innerText = `${totalUnits.toLocaleString('en-IN')} Units`;
    if (elAlerts) elAlerts.innerText = String(lowOrOutItems);
    if (elValue) elValue.innerText = `₹${Math.round(totalValue).toLocaleString('en-IN')}`;
}

function exportInventoryCSV() {
    const products = window._loadedProducts || [];
    if (products.length === 0) {
        showCatalogToast('No inventory items to export', 'error');
        return;
    }

    const headers = ['ID', 'SKU', 'Name', 'Type', 'Category', 'Sub-Category', 'MRP', 'Sale Price', 'Stock Qty', 'Low Stock Threshold', 'In Stock', 'Unit Type', 'Variants', 'Primary Image URL'];
    const rows = products.map(p => {
        const variantsText = Array.isArray(p.variants)
            ? p.variants.map(v => `${v.variant || v.label || ''}:Rs.${v.price || 0}`).join(' | ')
            : '';
        return [
            p.id,
            p.sku || `SKU-${String(p.id).padStart(4, '0')}`,
            p.name || '',
            p.item_type || 'product',
            p.category || p.category_name || '',
            p.sub_category || '',
            p.mrp || 0,
            p.sale_price || parseFloat(String(p.price || '').replace(/[^\d.]/g, '')) || 0,
            p.stock_quantity ?? 50,
            p.low_stock_threshold ?? 5,
            p.in_stock !== false ? 'Yes' : 'No',
            p.unit_type || 'custom',
            variantsText,
            p.product_image_url || p.image_url || ''
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory_${getActiveUsername()}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showCatalogToast('Inventory CSV exported!');
}

async function loadProductCatalog() {
    const username = getActiveUsername();
    try {
        const res = await fetch(`/api/business/products?username=${encodeURIComponent(username)}`);
        if (!res.ok) return;
        const data = await res.json();
        const products = data.products || [];

        window._loadedProducts = products;
        updateInventoryKpiStats(products);

        const catFilterSelect = document.getElementById('product-category-filter');
        if (catFilterSelect) {
            const uniqueCats = Array.from(new Set(products.map(p => p.category || p.category_name).filter(Boolean)));
            const currVal = catFilterSelect.value;
            catFilterSelect.innerHTML = `<option value="">All Categories (${products.length})</option>` +
                uniqueCats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
            if (currVal) catFilterSelect.value = currVal;
        }

        renderProductCatalogDisplay();
    } catch (err) {
        console.error('Catalog fetch error:', err);
        renderProductCatalogDisplay();
    }
}

function renderProductCatalogDisplay() {
    const grid = document.getElementById('catalog-grid');
    const tableWrapper = document.getElementById('catalog-table-wrapper');
    const tableBody = document.getElementById('catalog-table-body');
    if (!grid) return;

    const allProducts = window._loadedProducts || [];
    const searchTxt = (document.getElementById('product-search-input')?.value || '').toLowerCase().trim();
    const catFilter = (document.getElementById('product-category-filter')?.value || '').trim();
    const stockFilter = (document.getElementById('product-stock-filter')?.value || 'all').trim();
    const sortBy = (document.getElementById('product-sort-select')?.value || 'newest').trim();

    const filtered = allProducts.filter(p => {
        const name = (p.name || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const cat = (p.category || p.category_name || '').toLowerCase();
        const subCat = (p.sub_category || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();

        const matchesSearch = !searchTxt || name.includes(searchTxt) || sku.includes(searchTxt) || cat.includes(searchTxt) || subCat.includes(searchTxt) || desc.includes(searchTxt);
        const matchesCat = !catFilter || (p.category || p.category_name) === catFilter;

        const qty = Number(p.stock_quantity ?? 50);
        const thresh = Number(p.low_stock_threshold ?? 5);
        const inStock = p.in_stock !== false && qty > 0;
        const isLowStock = inStock && qty <= thresh;

        let matchesStock = true;
        if (stockFilter === 'in_stock') matchesStock = inStock;
        else if (stockFilter === 'low_stock') matchesStock = isLowStock;
        else if (stockFilter === 'out_of_stock') matchesStock = !inStock;

        return matchesSearch && matchesCat && matchesStock;
    });

    filtered.sort((a, b) => {
        const priceA = Number(a.sale_price) || parseFloat(String(a.price || '').replace(/[^\d.]/g, '')) || 0;
        const priceB = Number(b.sale_price) || parseFloat(String(b.price || '').replace(/[^\d.]/g, '')) || 0;
        const stockA = Number(a.stock_quantity ?? 50);
        const stockB = Number(b.stock_quantity ?? 50);

        if (sortBy === 'name_asc') return (a.name || '').localeCompare(b.name || '');
        if (sortBy === 'price_asc') return priceA - priceB;
        if (sortBy === 'price_desc') return priceB - priceA;
        if (sortBy === 'stock_asc') return stockA - stockB;
        return (b.id || 0) - (a.id || 0);
    });

    if (filtered.length === 0) {
        const emptyHtml = `
            <div class="col-span-full py-12 text-center text-slate-500 border border-dashed border-slate-800 rounded-2xl bg-slate-950/50">
                <i class="fa-solid fa-boxes-stacked text-3xl mb-2 text-slate-600"></i>
                <p class="text-xs font-bold text-slate-400">No Inventory Items Match Your Filters</p>
                <p class="text-[11px] text-slate-600 mt-1">Try clearing search/stock filters or click "Add New Product" above.</p>
            </div>
        `;
        grid.innerHTML = emptyHtml;
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="7">${emptyHtml}</td></tr>`;
        return;
    }

    const isGrid = window._productCatalogViewMode !== 'table';
    if (isGrid) {
        if (grid) grid.classList.remove('hidden');
        if (tableWrapper) tableWrapper.classList.add('hidden');
    } else {
        if (grid) grid.classList.add('hidden');
        if (tableWrapper) tableWrapper.classList.remove('hidden');
    }

    // Render Grid
    grid.innerHTML = filtered.map(item => {
        const catName = item.category || item.category_name || 'General';
        const subCatName = item.sub_category || '';
        const skuCode = item.sku || `SKU-${String(item.id).padStart(4, '0')}`;
        const images = item.images && item.images.length > 0 ? item.images : (item.product_image_url ? [item.product_image_url] : []);
        const primaryImg = images[0] || item.product_image_url || item.image_url || '';
        const mrp = Number(item.mrp) || 0;
        const salePrice = Number(item.sale_price) || parseFloat(String(item.price || '').replace(/[^\d.]/g, '')) || 0;
        const discountPct = mrp > salePrice && mrp > 0 ? Math.round(((mrp - salePrice) / mrp) * 100) : 0;
        const stockQty = Number(item.stock_quantity ?? 50);
        const lowThresh = Number(item.low_stock_threshold ?? 5);
        const inStock = item.in_stock !== false && stockQty > 0;
        const isLowStock = inStock && stockQty <= lowThresh;

        const stockLabel = !inStock ? 'Out of Stock' : (isLowStock ? `Low Stock (${stockQty})` : `In Stock (${stockQty})`);
        const stockClass = !inStock
            ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
            : (isLowStock ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30');

        const variants = Array.isArray(item.variants) ? item.variants : [];

        return `
            <div class="glass-card rounded-2xl border border-slate-800 p-4 flex flex-col justify-between hover:border-slate-700 transition space-y-3 relative group">
                <div class="space-y-3">
                    ${primaryImg ? `
                        <div class="relative w-full h-44 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
                            <img src="${escapeHtml(primaryImg)}" alt="${escapeHtml(item.name)}" class="w-full h-full object-cover transition duration-300 group-hover:scale-105" onerror="this.onerror=null; this.parentElement.style.display='none';">
                            <button type="button" onclick="openLightbox('${escapeHtml(primaryImg)}')" class="absolute top-2 right-2 w-7 h-7 rounded-lg bg-slate-950/80 hover:bg-emerald-500 text-white hover:text-slate-950 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition shadow cursor-pointer">
                                <i class="fa-solid fa-eye"></i>
                            </button>
                            ${discountPct > 0 ? `
                                <span class="absolute top-2 left-2 px-2 py-0.5 rounded-lg bg-emerald-500 text-slate-950 text-[10px] font-black shadow">
                                    ${discountPct}% OFF
                                </span>
                            ` : ''}
                            ${images.length > 1 ? `
                                <span class="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-950/80 backdrop-blur-md text-[10px] font-mono text-emerald-400 border border-slate-700 font-bold flex items-center gap-1">
                                    <i class="fa-solid fa-images"></i> ${images.length} photos
                                </span>
                            ` : ''}
                        </div>
                    ` : `
                        <div class="w-full h-36 rounded-xl border border-slate-800 bg-slate-900/60 flex flex-col items-center justify-center text-slate-600 gap-1">
                            <i class="fa-solid ${item.item_type === 'service' ? 'fa-screwdriver-wrench text-indigo-400/50' : 'fa-box-open text-slate-600'} text-2xl"></i>
                            <span class="text-[10px] font-mono text-slate-500">${escapeHtml(skuCode)}</span>
                        </div>
                    `}

                    <div class="flex items-center justify-between gap-1.5 flex-wrap">
                        <div class="flex items-center gap-1 flex-wrap min-w-0">
                            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30 truncate">
                                ${escapeHtml(catName)}
                            </span>
                            ${subCatName ? `
                                <span class="px-2 py-0.5 rounded text-[9px] font-mono font-semibold bg-slate-900 text-slate-300 border border-slate-700 truncate">
                                    ${escapeHtml(subCatName)}
                                </span>
                            ` : ''}
                        </div>
                        <button type="button" onclick="toggleStockStatus(${item.id}, ${inStock})" class="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold border transition cursor-pointer flex items-center gap-1 shrink-0 ${stockClass}">
                            <span class="w-1.5 h-1.5 rounded-full ${!inStock ? 'bg-rose-400' : (isLowStock ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400')}"></span>
                            <span>${stockLabel}</span>
                        </button>
                    </div>

                    <div>
                        <div class="flex items-center justify-between gap-2">
                            <h4 class="text-sm font-bold text-white line-clamp-1">${escapeHtml(item.name)}</h4>
                            <span class="text-[9px] font-mono text-slate-500 shrink-0">${escapeHtml(skuCode)}</span>
                        </div>
                        <p class="text-[11px] text-slate-400 leading-relaxed mt-1 line-clamp-2">${escapeHtml(item.description || item.details || 'No description provided.')}</p>
                    </div>

                    ${variants.length > 0 ? `
                        <div class="flex flex-wrap gap-1.5 pt-0.5">
                            ${variants.slice(0, 4).map(v => `
                                <span class="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-300">
                                    ${escapeHtml(v.variant || v.label || '')}: <strong class="text-emerald-400">₹${v.price ?? v.sale_price ?? salePrice}</strong>
                                </span>
                            `).join('')}
                            ${variants.length > 4 ? `<span class="text-[10px] font-mono text-slate-500">+${variants.length - 4} more</span>` : ''}
                        </div>
                    ` : ''}

                    <div class="flex items-center justify-between pt-1">
                        <div class="flex items-baseline gap-2 font-mono">
                            ${mrp > salePrice ? `<span class="line-through text-slate-500 text-xs">₹${mrp}</span>` : ''}
                            <span class="text-emerald-400 font-black text-base">₹${salePrice}</span>
                        </div>

                        <!-- Quick Stock Qty Stepper -->
                        <div class="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-xl p-1">
                            <button type="button" onclick="adjustProductStockQty(${item.id}, -1)" class="w-6 h-6 rounded-lg bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 text-xs font-bold flex items-center justify-center transition cursor-pointer" title="Decrease Stock (-1)">-</button>
                            <span class="px-2 text-[11px] font-mono font-bold ${isLowStock ? 'text-amber-300' : 'text-white'}" title="Current Stock Units">${stockQty}</span>
                            <button type="button" onclick="adjustProductStockQty(${item.id}, 1)" class="w-6 h-6 rounded-lg bg-slate-900 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-300 text-xs font-bold flex items-center justify-center transition cursor-pointer" title="Increase Stock (+1)">+</button>
                        </div>
                    </div>
                </div>

                <div class="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                    <span class="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                        <i class="fa-solid fa-database text-emerald-400 text-[10px]"></i> #${item.id}
                    </span>
                    <div class="flex items-center gap-1.5">
                        <button type="button" onclick="duplicateProduct(${item.id})" class="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-bold transition cursor-pointer flex items-center gap-1" title="Duplicate Item">
                            <i class="fa-solid fa-copy text-[10px]"></i>
                        </button>
                        <button type="button" onclick="editProduct(${item.id})" class="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold transition cursor-pointer flex items-center gap-1">
                            <i class="fa-solid fa-pen-to-square text-[10px]"></i> Edit
                        </button>
                        <button type="button" onclick="deleteProduct(${item.id})" class="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold transition cursor-pointer flex items-center gap-1">
                            <i class="fa-solid fa-trash-can text-[10px]"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Render Table
    if (tableBody) {
        tableBody.innerHTML = filtered.map(item => {
            const catName = item.category || item.category_name || 'General';
            const subCatName = item.sub_category || '';
            const skuCode = item.sku || `SKU-${String(item.id).padStart(4, '0')}`;
            const images = item.images && item.images.length > 0 ? item.images : (item.product_image_url ? [item.product_image_url] : []);
            const primaryImg = images[0] || item.product_image_url || item.image_url || '';
            const mrp = Number(item.mrp) || 0;
            const salePrice = Number(item.sale_price) || parseFloat(String(item.price || '').replace(/[^\d.]/g, '')) || 0;
            const stockQty = Number(item.stock_quantity ?? 50);
            const lowThresh = Number(item.low_stock_threshold ?? 5);
            const inStock = item.in_stock !== false && stockQty > 0;
            const isLowStock = inStock && stockQty <= lowThresh;
            const variants = Array.isArray(item.variants) ? item.variants : [];

            return `
                <tr class="hover:bg-slate-900/50 transition">
                    <td class="p-3.5">
                        <div class="flex items-center gap-3">
                            ${primaryImg ? `
                                <div class="relative w-10 h-10 rounded-xl overflow-hidden border border-slate-700 bg-slate-900 shrink-0 cursor-pointer" onclick="openLightbox('${escapeHtml(primaryImg)}')">
                                    <img src="${escapeHtml(primaryImg)}" class="w-full h-full object-cover">
                                </div>
                            ` : `
                                <div class="w-10 h-10 rounded-xl border border-slate-800 bg-slate-900 flex items-center justify-center text-slate-600 shrink-0">
                                    <i class="fa-solid fa-box"></i>
                                </div>
                            `}
                            <div class="min-w-0">
                                <h5 class="font-bold text-white truncate max-w-xs">${escapeHtml(item.name)}</h5>
                                <span class="text-[10px] text-slate-500 font-mono block truncate">${escapeHtml(skuCode)} • ${images.length} photo(s)</span>
                            </div>
                        </div>
                    </td>
                    <td class="p-3.5">
                        <div class="flex flex-col gap-1 items-start">
                            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30">
                                ${escapeHtml(catName)}
                            </span>
                            ${subCatName ? `<span class="text-[10px] font-mono text-slate-400">↳ ${escapeHtml(subCatName)}</span>` : ''}
                        </div>
                    </td>
                    <td class="p-3.5">
                        ${variants.length > 0 ? `
                            <div class="flex flex-wrap gap-1 max-w-xs">
                                ${variants.map(v => `<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-300">${escapeHtml(v.variant || v.label || '')}: ₹${v.price ?? salePrice}</span>`).join('')}
                            </div>
                        ` : `<span class="text-[10px] text-slate-500 font-mono">Standard (${escapeHtml(item.unit_type || 'unit')})</span>`}
                    </td>
                    <td class="p-3.5 font-mono">
                        <div class="flex items-baseline gap-1.5">
                            ${mrp > salePrice ? `<span class="line-through text-slate-500 text-[10px]">₹${mrp}</span>` : ''}
                            <span class="text-emerald-400 font-bold text-xs">₹${salePrice}</span>
                        </div>
                    </td>
                    <td class="p-3.5">
                        <div class="flex items-center gap-1.5">
                            <button type="button" onclick="adjustProductStockQty(${item.id}, -1)" class="w-6 h-6 rounded-lg bg-slate-900 hover:bg-rose-500/20 border border-slate-800 text-slate-300 text-xs font-bold cursor-pointer">-</button>
                            <span class="font-mono font-bold text-xs px-1.5 ${isLowStock ? 'text-amber-300' : 'text-white'}">${stockQty}</span>
                            <button type="button" onclick="adjustProductStockQty(${item.id}, 1)" class="w-6 h-6 rounded-lg bg-slate-900 hover:bg-emerald-500/20 border border-slate-800 text-slate-300 text-xs font-bold cursor-pointer">+</button>
                        </div>
                    </td>
                    <td class="p-3.5">
                        <button type="button" onclick="toggleStockStatus(${item.id}, ${inStock})" class="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border transition cursor-pointer flex items-center gap-1 ${!inStock ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' : (isLowStock ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30')}">
                            <span class="w-1.5 h-1.5 rounded-full ${!inStock ? 'bg-rose-400' : (isLowStock ? 'bg-amber-400' : 'bg-emerald-400')}"></span>
                            <span>${!inStock ? 'Out of Stock' : (isLowStock ? 'Low Stock' : 'In Stock')}</span>
                        </button>
                    </td>
                    <td class="p-3.5 text-right">
                        <div class="flex items-center justify-end gap-1.5">
                            <button type="button" onclick="duplicateProduct(${item.id})" class="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition cursor-pointer" title="Duplicate">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                            <button type="button" onclick="editProduct(${item.id})" class="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition cursor-pointer" title="Edit">
                                <i class="fa-solid fa-pen-to-square"></i>
                            </button>
                            <button type="button" onclick="deleteProduct(${item.id})" class="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition cursor-pointer" title="Delete">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }
}

export function getProductCatalogHTML() {
    return `                <div id="view-catalog" class="biz-tab-content max-w-6xl mx-auto space-y-6">
                    
                    <!-- Sub-Nav Tab Bar for Inventory Suite -->
                    <div class="flex flex-wrap items-center justify-between gap-3 bg-slate-950 p-2.5 rounded-2xl border border-slate-800 shadow-lg">
                        <div class="flex items-center gap-2">
                            <button type="button" id="btn-inv-subtab-products" onclick="switchInventorySubtab('products')" class="min-h-11 px-4 py-2 rounded-xl text-xs font-black transition cursor-pointer flex items-center gap-2 bg-emerald-500 text-slate-950 shadow-md">
                                <i class="fa-solid fa-boxes-stacked"></i> Products & Stock Inventory
                            </button>
                            <button type="button" id="btn-inv-subtab-categories" onclick="switchInventorySubtab('categories')" class="min-h-11 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-2 text-slate-400 hover:text-white hover:bg-slate-900">
                                <i class="fa-solid fa-sitemap"></i> Categories & Sub-Categories
                            </button>
                        </div>
                        <div class="flex items-center gap-2 pr-1">
                            <button type="button" onclick="exportInventoryCSV()" class="min-h-11 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-bold transition cursor-pointer flex items-center gap-1.5" title="Export Full Inventory to CSV">
                                <i class="fa-solid fa-file-csv text-emerald-400"></i> Export CSV
                            </button>
                            <span class="text-[10px] font-mono font-bold text-slate-500 hidden sm:inline-block">
                                <i class="fa-solid fa-database text-emerald-400"></i> Neon DB Live
                            </span>
                        </div>
                    </div>

                    <!-- INVENTORY LIVE KPI SUMMARY STRIP (Responsive 1 -> 2 -> 4 Grid) -->
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
                        <div class="glass-card p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                            <div>
                                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Total Catalog SKUs</span>
                                <h4 id="inv-kpi-total-items" class="text-xl font-black text-white font-mono mt-0.5"><span class="inline-block h-6 w-12 bg-slate-800 rounded animate-pulse"></span></h4>
                                <span id="inv-kpi-categories-count" class="text-[10px] font-mono text-amber-400">0 Categories</span>
                            </div>
                            <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 text-sm">
                                <i class="fa-solid fa-cubes"></i>
                            </div>
                        </div>

                        <div class="glass-card p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                            <div>
                                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Available Stock</span>
                                <h4 id="inv-kpi-instock-items" class="text-xl font-black text-emerald-400 font-mono mt-0.5"><span class="inline-block h-6 w-20 bg-slate-800 rounded animate-pulse"></span></h4>
                                <span id="inv-kpi-total-units" class="text-[10px] font-mono text-slate-400">0 Units</span>
                            </div>
                            <div class="w-11 h-11 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400 text-sm">
                                <i class="fa-solid fa-boxes-packing"></i>
                            </div>
                        </div>

                        <div class="glass-card p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                            <div>
                                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Low / Out of Stock</span>
                                <h4 id="inv-kpi-lowstock-alerts" class="text-xl font-black text-amber-400 font-mono mt-0.5"><span class="inline-block h-6 w-12 bg-slate-800 rounded animate-pulse"></span></h4>
                                <span class="text-[10px] font-mono text-rose-400">Restock Alerts</span>
                            </div>
                            <div class="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 text-sm">
                                <i class="fa-solid fa-triangle-exclamation"></i>
                            </div>
                        </div>

                        <div class="glass-card p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
                            <div>
                                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Inventory Stock Value</span>
                                <h4 id="inv-kpi-total-value" class="text-xl font-black text-white font-mono mt-0.5"><span class="inline-block h-6 w-20 bg-slate-800 rounded animate-pulse"></span></h4>
                                <span class="text-[10px] font-mono text-emerald-400">Retail Valuation</span>
                            </div>
                            <div class="w-11 h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 text-sm">
                                <i class="fa-solid fa-indian-rupee-sign"></i>
                            </div>
                        </div>
                    </div>

                    <!-- SUBTAB 1: CATEGORIES & SUB-CATEGORIES HIERARCHY -->
                    <div id="inv-subtab-categories-view" class="hidden glass-card p-5 sm:p-6 rounded-3xl border border-slate-800 space-y-5">
                        <div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
                            <div>
                                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                                    <i class="fa-solid fa-sitemap text-amber-400"></i> Category & Sub-Category Hierarchy
                                </h3>
                                <p class="text-xs text-slate-400 mt-0.5">Create parent categories (e.g. Grocery, Apparel) and nested sub-categories (e.g. Spices, T-Shirts) for clean store navigation.</p>
                            </div>
                            <button type="button" onclick="loadCategories()" class="text-xs text-amber-400 hover:underline cursor-pointer flex items-center gap-1">
                                <i class="fa-solid fa-rotate"></i> Refresh
                            </button>
                        </div>

                        <!-- Add / Edit Category & Sub-Category Form -->
                        <form id="category-form" onsubmit="event.preventDefault(); saveCategory();" class="p-4 rounded-2xl bg-slate-950/70 border border-slate-800/90 space-y-4">
                            <input type="hidden" id="category-id-hidden" value="0">
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                    <label class="block text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-1">Category Level *</label>
                                    <select id="category-level-select" onchange="toggleCategoryParentSelect(this.value)" class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-amber-500 font-semibold">
                                        <option value="parent">Main / Parent Category</option>
                                        <option value="sub">Sub-Category (Nested Under Parent)</option>
                                    </select>
                                </div>
                                <div id="parent-category-dropdown-wrap" class="hidden">
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Select Parent Category *</label>
                                    <select id="category-parent-select" class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-amber-500 font-semibold">
                                        <option value="">-- Choose Parent Category --</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold text-white uppercase tracking-wider mb-1">Category Name *</label>
                                    <input type="text" id="category-name-input" placeholder="e.g. Cooking Oils, Men T-Shirts, Beverages" required class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:border-amber-500 placeholder-slate-600 font-semibold">
                                </div>
                            </div>

                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                                <div>
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Upload Category Image OR Paste Image URL</label>
                                    <div class="flex flex-col sm:flex-row gap-2">
                                        <input type="file" id="category-image-file" accept="image/*" onchange="handleCategoryImageSelect(event)" class="text-xs text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-amber-500/10 file:text-amber-400 hover:file:bg-amber-500/20 cursor-pointer">
                                        <input type="url" id="category-image-url-direct" oninput="applyCategoryDirectImageUrl(this.value)" placeholder="Or paste https:// image URL..." class="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-amber-500">
                                    </div>
                                </div>
                                <div id="category-image-preview-bar" class="hidden p-2 rounded-xl bg-slate-900 border border-amber-500/30 flex items-center gap-3">
                                    <img id="category-image-preview-thumb" src="" class="w-10 h-10 object-cover rounded-lg border border-slate-700">
                                    <div class="flex-1 min-w-0">
                                        <span id="category-image-preview-url" class="text-[10px] font-mono text-amber-300 truncate block"></span>
                                        <span class="text-[9px] text-emerald-400 font-bold">Category Image Ready</span>
                                    </div>
                                </div>
                                <input type="hidden" id="category-image-url-hidden" value="">
                            </div>

                            <div class="flex justify-end gap-2 pt-1">
                                <button type="button" id="btn-cancel-category-edit" onclick="cancelCategoryEdit()" class="hidden px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer">
                                    Cancel Edit
                                </button>
                                <button type="submit" id="btn-save-category" class="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center gap-1.5 shadow-md">
                                    <i class="fa-solid fa-plus text-slate-950"></i>
                                    <span id="btn-save-category-text">Save Category</span>
                                </button>
                            </div>
                        </form>

                        <!-- Categories & Sub-Categories Hierarchy Display -->
                        <div class="space-y-3">
                            <h4 class="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                                <i class="fa-solid fa-layer-group text-amber-400"></i> Active Category Hierarchy
                            </h4>
                            <div id="category-hierarchy-container" class="space-y-3">
                                <div class="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-500 text-xs text-center">
                                    Loading categories hierarchy...
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- SUBTAB 2: PRODUCT & STOCK INVENTORY MANAGEMENT -->
                    <div id="inv-subtab-products-view" class="glass-card p-5 sm:p-6 rounded-3xl border border-slate-800 space-y-6">
                        <!-- Top Header & Action Bar -->
                        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                            <div>
                                <h3 class="text-base font-black text-white flex items-center gap-2">
                                    <i class="fa-solid fa-boxes-stacked text-emerald-400"></i> Product & Stock Inventory Manager
                                </h3>
                                <p class="text-xs text-slate-400 mt-0.5">Manage SKUs, stock quantities, low-stock alerts, multi-unit variants & 3-slot product photography.</p>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <button type="button" onclick="switchInventorySubtab('categories')" class="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-amber-400 text-xs font-bold transition cursor-pointer flex items-center gap-1.5" title="Manage Categories">
                                    <i class="fa-solid fa-sitemap"></i> <span class="hidden sm:inline">Categories</span>
                                </button>
                                <button type="button" onclick="loadProductCatalog()" class="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-bold transition cursor-pointer flex items-center gap-1.5" title="Refresh Catalog">
                                    <i class="fa-solid fa-rotate text-emerald-400"></i> <span class="hidden sm:inline">Refresh</span>
                                </button>
                                <button type="button" onclick="toggleProductFormDrawer()" id="btn-toggle-product-drawer" class="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black text-xs transition cursor-pointer flex items-center gap-2 shadow-lg shadow-emerald-500/10">
                                    <i class="fa-solid fa-plus text-slate-950"></i>
                                    <span id="btn-toggle-product-text">Add New Product</span>
                                </button>
                            </div>
                        </div>

                        <!-- ADD / EDIT PRODUCT DRAWER FORM -->
                        <div id="product-form-container" class="hidden">
                            <form id="product-form" onsubmit="event.preventDefault(); addProduct();" class="p-5 sm:p-6 rounded-2xl bg-slate-950/90 border border-emerald-500/30 space-y-5 shadow-2xl relative">
                                <input type="hidden" id="product-id-hidden" value="0">
                                <input type="hidden" id="item-type-input" value="product">
                                
                                <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                                    <div class="flex items-center gap-2.5">
                                        <span class="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                                            <i class="fa-solid fa-pen-to-square text-emerald-400" id="form-drawer-icon"></i> 
                                            <span id="form-drawer-title">Add New Product</span>
                                        </span>
                                        <span id="item-type-badge" class="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">Product Mode</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <button type="button" id="type-prod-btn" onclick="setCatalogType('product')" class="p-2 rounded-xl border border-emerald-500 bg-emerald-500/10 text-emerald-300 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer">
                                            <i class="fa-solid fa-box"></i> Physical Product
                                        </button>
                                        <button type="button" id="type-serv-btn" onclick="setCatalogType('service')" class="p-2 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer">
                                            <i class="fa-solid fa-screwdriver-wrench"></i> Service
                                        </button>
                                        <button type="button" onclick="toggleProductFormDrawer(false)" class="ml-2 text-slate-400 hover:text-white text-xs font-bold transition cursor-pointer flex items-center gap-1">
                                            <i class="fa-solid fa-xmark text-sm"></i> Close
                                        </button>
                                    </div>
                                </div>

                                <!-- Basic Info Grid (Category, Sub-Category, Name & SKU) -->
                                <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
                                    <div>
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Primary Category *</label>
                                        <select id="product-category-select" onchange="onProductCategoryChanged(this.value)" required class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-emerald-500 font-semibold">
                                            <option value="">-- Select Category --</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Sub-Category (Optional)</label>
                                        <select id="product-subcategory-select" class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-emerald-500 font-semibold">
                                            <option value="">-- Select Sub-Category --</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label id="lbl-item-name" class="block text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-1">Product Name *</label>
                                        <input type="text" id="product-name" placeholder="e.g. Fortune Mustard Oil, Garam Masala" required class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-emerald-500 font-semibold placeholder-slate-600">
                                    </div>
                                    <div>
                                        <div class="flex items-center justify-between mb-1">
                                            <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">SKU / Barcode</label>
                                            <button type="button" onclick="generateProductSKU()" class="text-[9px] font-bold text-emerald-400 hover:underline cursor-pointer">Auto-Generate</button>
                                        </div>
                                        <input type="text" id="product-sku" placeholder="e.g. GRO-OIL-101" class="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-amber-300 outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600">
                                    </div>
                                </div>

                                <!-- Description -->
                                <div>
                                    <label id="lbl-item-desc" class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Product Description / Highlights</label>
                                    <textarea id="product-desc" rows="2" placeholder="Detail key features, brand specifications, or notes for AI customer inquiries..." class="w-full p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-emerald-500 placeholder-slate-600"></textarea>
                                </div>

                                <!-- Base Pricing, Stock Quantity, Low Stock Threshold & Availability -->
                                <div id="product-stock-qty-fields-wrap" class="grid grid-cols-1 sm:grid-cols-5 gap-4 p-4 rounded-xl bg-slate-900/60 border border-slate-800">
                                    <div>
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Base MRP (₹)</label>
                                        <div class="relative">
                                            <span class="absolute left-3 top-2.5 text-slate-500 font-bold text-xs">₹</span>
                                            <input type="number" step="0.01" id="product-mrp" placeholder="199" class="w-full pl-7 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 outline-none focus:border-emerald-500">
                                        </div>
                                    </div>
                                    <div>
                                        <label id="lbl-item-price" class="block text-[10px] font-bold text-emerald-400 uppercase mb-1">Base Selling Price (₹) *</label>
                                        <div class="relative">
                                            <span class="absolute left-3 top-2.5 text-emerald-400 font-bold text-xs">₹</span>
                                            <input type="number" step="0.01" id="product-sale-price" placeholder="149" required class="w-full pl-7 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-emerald-400 font-bold outline-none focus:border-emerald-500">
                                        </div>
                                    </div>
                                    <div>
                                        <label class="block text-[10px] font-bold text-white uppercase mb-1">Available Stock Qty</label>
                                        <input type="number" id="product-stock-qty" value="50" min="0" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white font-bold outline-none focus:border-emerald-500">
                                    </div>
                                    <div>
                                        <label class="block text-[10px] font-bold text-amber-400 uppercase mb-1">Low Stock Alert At</label>
                                        <input type="number" id="product-low-stock" value="5" min="0" class="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-amber-300 outline-none focus:border-emerald-500">
                                    </div>
                                    <div>
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Store Availability</label>
                                        <div class="pt-1.5 flex items-center justify-between">
                                            <label class="relative inline-flex items-center cursor-pointer">
                                                <input type="checkbox" id="product-in-stock" checked onchange="document.getElementById('stock-toggle-label').innerText = this.checked ? 'In Stock' : 'Out of Stock'; document.getElementById('stock-toggle-label').className = this.checked ? 'ml-2 text-xs font-bold text-emerald-400 font-mono' : 'ml-2 text-xs font-bold text-rose-400 font-mono';" class="sr-only peer">
                                                <div class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                                <span id="stock-toggle-label" class="ml-2 text-xs font-bold text-emerald-400 font-mono">In Stock</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <!-- PRODUCT VARIETY & UNIT VARIANTS BUILDER -->
                                <div class="p-4 rounded-2xl bg-slate-900/80 border border-emerald-500/30 space-y-4">
                                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
                                        <div>
                                            <label class="block text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                                                <i class="fa-solid fa-cubes text-emerald-400"></i> Product Variety & Unit Variants (KG, Litre, Pieces, Sizes)
                                            </label>
                                            <p class="text-[11px] text-slate-400 mt-0.5">Define quantity sizes and custom pricing for each variant option.</p>
                                        </div>
                                        <span class="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">Multi-Variant Pricing</span>
                                    </div>

                                    <!-- Unit Type Selection Buttons -->
                                    <div class="space-y-2">
                                        <label class="block text-[10px] font-bold text-slate-400 uppercase">Select Unit Measurement Type:</label>
                                        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
                                            <button type="button" onclick="selectProductUnitType('weight')" id="btn-unit-weight" class="p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-emerald-500/20 border-emerald-500 text-emerald-300">
                                                <i class="fa-solid fa-weight-hanging text-sm"></i>
                                                <span>Weight (KG/g)</span>
                                            </button>
                                            <button type="button" onclick="selectProductUnitType('liquid')" id="btn-unit-liquid" class="p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-slate-900 border-slate-800 text-slate-400 hover:text-white">
                                                <i class="fa-solid fa-bottle-droplet text-sm"></i>
                                                <span>Volume (Litre/ml)</span>
                                            </button>
                                            <button type="button" onclick="selectProductUnitType('pieces')" id="btn-unit-pieces" class="p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-slate-900 border-slate-800 text-slate-400 hover:text-white">
                                                <i class="fa-solid fa-box text-sm"></i>
                                                <span>Count (Pieces/Packs)</span>
                                            </button>
                                            <button type="button" onclick="selectProductUnitType('size')" id="btn-unit-size" class="p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-slate-900 border-slate-800 text-slate-400 hover:text-white">
                                                <i class="fa-solid fa-ruler text-sm"></i>
                                                <span>Size / Portion</span>
                                            </button>
                                            <button type="button" onclick="selectProductUnitType('custom')" id="btn-unit-custom" class="p-2.5 rounded-xl border text-xs font-bold transition cursor-pointer flex flex-col items-center gap-1 bg-slate-900 border-slate-800 text-slate-400 hover:text-white">
                                                <i class="fa-solid fa-gear text-sm"></i>
                                                <span>Custom Unit</span>
                                            </button>
                                        </div>
                                    </div>

                                    <!-- Quick Preset Variant Buttons -->
                                    <div id="unit-presets-container" class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Quick Add Preset Variety Sizes:</span>
                                        <div id="unit-preset-pills" class="flex flex-wrap items-center gap-2"></div>
                                    </div>

                                    <!-- Active Variants Table/List -->
                                    <div class="space-y-2">
                                        <div class="flex items-center justify-between">
                                            <span class="text-[10px] font-bold text-white uppercase tracking-wider">Configured Variants & Prices:</span>
                                            <button type="button" onclick="addCustomVariantRow()" class="text-[11px] font-bold text-emerald-400 hover:underline cursor-pointer flex items-center gap-1">
                                                <i class="fa-solid fa-plus-circle"></i> + Add Custom Variant Row
                                            </button>
                                        </div>
                                        <div id="product-variants-rows-container" class="space-y-2 max-h-60 overflow-y-auto pr-1"></div>
                                    </div>
                                </div>

                                <!-- WhatsApp Catalog Link (Optional) -->
                                <div>
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">WhatsApp Catalog Deep-Link (Optional)</label>
                                    <input type="url" id="product-whatsapp-url" placeholder="https://wa.me/p/123456789" class="w-full px-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-emerald-300 outline-none focus:border-emerald-500 placeholder-slate-600">
                                </div>

                                <!-- MULTI-IMAGE MEDIA MANAGER (UP TO 3 IMAGES) -->
                                <div class="space-y-3">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <label class="block text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                                            <i class="fa-solid fa-images text-emerald-400"></i> Product Media Gallery (Max 3 Images)
                                        </label>
                                        <span class="text-[10px] font-mono text-slate-400">1:1 Square Crop Upload OR Direct Image URL</span>
                                    </div>

                                    <div class="grid grid-cols-3 gap-3">
                                        <!-- Slot 1: Primary Thumbnail -->
                                        <div class="relative rounded-2xl bg-slate-900 border border-slate-800 p-2 flex flex-col items-center justify-center aspect-square overflow-hidden group hover:border-emerald-500/50 transition">
                                            <div id="product-slot-1-preview" class="hidden absolute inset-0 bg-slate-950">
                                                <img id="product-slot-1-img" src="" class="w-full h-full object-cover">
                                                <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px]">
                                                    <button type="button" onclick="openLightbox(getProductSlotUrl(0))" title="View Image" class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-eye"></i>
                                                    </button>
                                                    <button type="button" onclick="triggerProductSlotUpload(0)" title="Change Image" class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-pen"></i>
                                                    </button>
                                                    <button type="button" onclick="clearProductSlotImage(0)" title="Remove Image" class="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-trash"></i>
                                                    </button>
                                                </div>
                                                <span class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded bg-emerald-500 text-slate-950 text-[9px] font-black uppercase tracking-wider shadow">Primary</span>
                                            </div>
                                            <div id="product-slot-1-placeholder" class="text-center space-y-1.5 cursor-pointer p-2" onclick="triggerProductSlotUpload(0)">
                                                <div class="w-9 h-9 rounded-xl bg-slate-800/80 border border-slate-700/80 text-emerald-400 flex items-center justify-center mx-auto text-sm group-hover:scale-110 transition">
                                                    <i class="fa-solid fa-camera"></i>
                                                </div>
                                                <span class="text-[10px] font-bold text-slate-300 block">Slot 1 (Main)</span>
                                                <span class="text-[9px] text-emerald-400/80 font-mono block">+ Upload Photo</span>
                                            </div>
                                        </div>

                                        <!-- Slot 2: Gallery Image 2 -->
                                        <div class="relative rounded-2xl bg-slate-900 border border-slate-800 p-2 flex flex-col items-center justify-center aspect-square overflow-hidden group hover:border-emerald-500/50 transition">
                                            <div id="product-slot-2-preview" class="hidden absolute inset-0 bg-slate-950">
                                                <img id="product-slot-2-img" src="" class="w-full h-full object-cover">
                                                <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px]">
                                                    <button type="button" onclick="openLightbox(getProductSlotUrl(1))" title="View Image" class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-eye"></i>
                                                    </button>
                                                    <button type="button" onclick="triggerProductSlotUpload(1)" title="Change Image" class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-pen"></i>
                                                    </button>
                                                    <button type="button" onclick="clearProductSlotImage(1)" title="Remove Image" class="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-trash"></i>
                                                    </button>
                                                </div>
                                                <span class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[9px] font-bold uppercase">Image 2</span>
                                            </div>
                                            <div id="product-slot-2-placeholder" class="text-center space-y-1.5 cursor-pointer p-2" onclick="triggerProductSlotUpload(1)">
                                                <div class="w-9 h-9 rounded-xl bg-slate-800/80 border border-slate-700/80 text-slate-400 flex items-center justify-center mx-auto text-sm group-hover:scale-110 transition">
                                                    <i class="fa-solid fa-plus"></i>
                                                </div>
                                                <span class="text-[10px] font-bold text-slate-400 block">Slot 2</span>
                                                <span class="text-[9px] text-slate-500 font-mono block">Optional</span>
                                            </div>
                                        </div>

                                        <!-- Slot 3: Gallery Image 3 -->
                                        <div class="relative rounded-2xl bg-slate-900 border border-slate-800 p-2 flex flex-col items-center justify-center aspect-square overflow-hidden group hover:border-emerald-500/50 transition">
                                            <div id="product-slot-3-preview" class="hidden absolute inset-0 bg-slate-950">
                                                <img id="product-slot-3-img" src="" class="w-full h-full object-cover">
                                                <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px]">
                                                    <button type="button" onclick="openLightbox(getProductSlotUrl(2))" title="View Image" class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-eye"></i>
                                                    </button>
                                                    <button type="button" onclick="triggerProductSlotUpload(2)" title="Change Image" class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500 hover:text-slate-950 flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-pen"></i>
                                                    </button>
                                                    <button type="button" onclick="clearProductSlotImage(2)" title="Remove Image" class="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white flex items-center justify-center text-xs cursor-pointer transition">
                                                        <i class="fa-solid fa-trash"></i>
                                                    </button>
                                                </div>
                                                <span class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[9px] font-bold uppercase">Image 3</span>
                                            </div>
                                            <div id="product-slot-3-placeholder" class="text-center space-y-1.5 cursor-pointer p-2" onclick="triggerProductSlotUpload(2)">
                                                <div class="w-9 h-9 rounded-xl bg-slate-800/80 border border-slate-700/80 text-slate-400 flex items-center justify-center mx-auto text-sm group-hover:scale-110 transition">
                                                    <i class="fa-solid fa-plus"></i>
                                                </div>
                                                <span class="text-[10px] font-bold text-slate-400 block">Slot 3</span>
                                                <span class="text-[9px] text-slate-500 font-mono block">Optional</span>
                                            </div>
                                        </div>
                                    </div>
                                    <input type="file" id="product-slot-file-input" accept="image/*" class="hidden" onchange="handleProductSlotFileSelected(event)">

                                    <!-- Direct Image URL Assignment Bar -->
                                    <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                                        <select id="product-direct-image-slot-select" class="px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500 font-semibold">
                                            <option value="0">Slot 1 (Primary)</option>
                                            <option value="1">Slot 2</option>
                                            <option value="2">Slot 3</option>
                                        </select>
                                        <input type="url" id="product-direct-image-url-input" placeholder="Or paste direct image URL (https://...) to assign to selected slot" class="flex-1 px-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500">
                                        <button type="button" onclick="applyDirectSlotImageUrl()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-emerald-400 font-bold rounded-xl text-xs transition cursor-pointer shrink-0">
                                            Assign Image URL
                                        </button>
                                    </div>
                                </div>

                                <div class="flex items-center justify-between gap-3 pt-3 border-t border-slate-800">
                                    <span class="text-[11px] text-slate-500 flex items-center gap-1.5">
                                        <i class="fa-solid fa-shield-halved text-emerald-400"></i> Syncs with Neon DB & AI Storefront
                                    </span>
                                    <div class="flex items-center gap-2">
                                        <button type="button" onclick="toggleProductFormDrawer(false)" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer">
                                            Cancel
                                        </button>
                                        <button type="submit" id="btn-add-item" class="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black rounded-xl text-xs transition cursor-pointer flex items-center justify-center gap-2 shadow-md">
                                            <i class="fa-solid fa-check text-slate-950" id="btn-add-item-icon"></i>
                                            <span id="btn-add-item-text">Save Product</span>
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>

                        <!-- SEARCH, CATEGORY FILTER, STOCK FILTER, SORT & VIEW TOGGLE TOOLBAR -->
                        <div class="grid grid-cols-1 md:grid-cols-12 gap-3 bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800 items-center">
                            <!-- Search Bar -->
                            <div class="relative md:col-span-4">
                                <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-500 text-xs"></i>
                                <input type="text" id="product-search-input" oninput="filterProductsCatalog()" placeholder="Search name, SKU, category..." class="w-full pl-9 pr-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 outline-none focus:border-emerald-500">
                            </div>

                            <!-- Category Filter Dropdown -->
                            <div class="md:col-span-3">
                                <select id="product-category-filter" onchange="filterProductsCatalog()" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500 font-semibold">
                                    <option value="">All Categories</option>
                                </select>
                            </div>

                            <!-- Stock Filter Dropdown -->
                            <div class="md:col-span-2">
                                <select id="product-stock-filter" onchange="filterProductsCatalog()" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500 font-semibold">
                                    <option value="all">All Stock Status</option>
                                    <option value="in_stock">In Stock Only</option>
                                    <option value="low_stock">Low Stock Alerts</option>
                                    <option value="out_of_stock">Out of Stock</option>
                                </select>
                            </div>

                            <!-- Sort By Dropdown -->
                            <div class="md:col-span-2">
                                <select id="product-sort-select" onchange="filterProductsCatalog()" class="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-300 outline-none focus:border-emerald-500 font-semibold">
                                    <option value="newest">Sort: Newest</option>
                                    <option value="name_asc">Name: A to Z</option>
                                    <option value="price_asc">Price: Low to High</option>
                                    <option value="price_desc">Price: High to Low</option>
                                    <option value="stock_asc">Stock: Low to High</option>
                                </select>
                            </div>

                            <!-- View Switcher Toggle (Grid vs Table) -->
                            <div class="md:col-span-1 flex items-center justify-end gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
                                <button type="button" id="btn-view-grid" onclick="setProductCatalogViewMode('grid')" class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 bg-emerald-500 text-slate-950 cursor-pointer" title="Grid View">
                                    <i class="fa-solid fa-grip"></i>
                                </button>
                                <button type="button" id="btn-view-table" onclick="setProductCatalogViewMode('table')" class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer" title="Table View">
                                    <i class="fa-solid fa-table-list"></i>
                                </button>
                            </div>
                        </div>

                        <!-- PRODUCT CATALOG DISPLAY CONTAINER (GRID & TABLE MODES) -->
                        <div>
                            <div id="catalog-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div class="rounded-2xl bg-slate-950/80 border border-slate-800 p-4 space-y-3 animate-pulse">
                                    <div class="h-40 w-full bg-slate-800 rounded-xl"></div>
                                    <div class="h-4 w-3/4 bg-slate-800 rounded"></div>
                                    <div class="h-3 w-1/2 bg-slate-800/70 rounded"></div>
                                    <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
                                </div>
                                <div class="rounded-2xl bg-slate-950/80 border border-slate-800 p-4 space-y-3 animate-pulse">
                                    <div class="h-40 w-full bg-slate-800 rounded-xl"></div>
                                    <div class="h-4 w-3/4 bg-slate-800 rounded"></div>
                                    <div class="h-3 w-1/2 bg-slate-800/70 rounded"></div>
                                    <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
                                </div>
                                <div class="rounded-2xl bg-slate-950/80 border border-slate-800 p-4 space-y-3 animate-pulse hidden md:block">
                                    <div class="h-40 w-full bg-slate-800 rounded-xl"></div>
                                    <div class="h-4 w-3/4 bg-slate-800 rounded"></div>
                                    <div class="h-3 w-1/2 bg-slate-800/70 rounded"></div>
                                    <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
                                </div>
                                <div class="rounded-2xl bg-slate-950/80 border border-slate-800 p-4 space-y-3 animate-pulse hidden lg:block">
                                    <div class="h-40 w-full bg-slate-800 rounded-xl"></div>
                                    <div class="h-4 w-3/4 bg-slate-800 rounded"></div>
                                    <div class="h-3 w-1/2 bg-slate-800/70 rounded"></div>
                                    <div class="h-10 w-full bg-slate-800 rounded-xl"></div>
                                </div>
                            </div>
                            <div id="catalog-table-wrapper" class="hidden overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/70">
                                <table class="w-full text-left border-collapse">
                                    <thead>
                                        <tr class="border-b border-slate-800 bg-slate-900/80 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                                            <th class="p-3.5">Product & SKU</th>
                                            <th class="p-3.5">Category</th>
                                            <th class="p-3.5">Variants</th>
                                            <th class="p-3.5">Pricing</th>
                                            <th class="p-3.5">Stock Qty</th>
                                            <th class="p-3.5">Status</th>
                                            <th class="p-3.5 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody id="catalog-table-body" class="divide-y divide-slate-800/60 text-xs"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>`;
}

const exportedFunctions = {
    setCatalogType,
    handleCategoryImageSelect,
    applyCategoryDirectImageUrl,
    updateProductImagePreview,
    handleProductImageSelect,
    removeProductImage,
    switchInventorySubtab,
    toggleCategoryParentSelect,
    onProductCategoryChanged,
    loadCategories,
    openQuickSubcategoryForm,
    editCategory,
    cancelCategoryEdit,
    saveCategory,
    deleteCategory,
    selectProductUnitType,
    addPresetVariant,
    addCustomVariantRow,
    updateVariantField,
    removeVariantRow,
    renderVariantRows,
    generateProductSKU,
    toggleProductFormDrawer,
    triggerProductSlotUpload,
    handleProductSlotFileSelected,
    applyDirectSlotImageUrl,
    getProductSlotUrl,
    clearProductSlotImage,
    renderProductFormSlots,
    setProductCatalogViewMode,
    filterProductsCatalog,
    addProduct,
    editProduct,
    duplicateProduct,
    resetProductForm,
    toggleStockStatus,
    adjustProductStockQty,
    deleteProduct,
    exportInventoryCSV,
    loadProductCatalog,
    renderProductCatalogDisplay
};

export function initProductCatalog(apiBaseUrl = "") {
    Object.assign(window, exportedFunctions);
    selectProductUnitType('weight');
    renderVariantRows();
    loadCategories();
    loadProductCatalog();
}

export {
    setCatalogType,
    handleCategoryImageSelect,
    applyCategoryDirectImageUrl,
    updateProductImagePreview,
    handleProductImageSelect,
    removeProductImage,
    switchInventorySubtab,
    toggleCategoryParentSelect,
    onProductCategoryChanged,
    loadCategories,
    openQuickSubcategoryForm,
    editCategory,
    cancelCategoryEdit,
    saveCategory,
    deleteCategory,
    selectProductUnitType,
    addPresetVariant,
    addCustomVariantRow,
    updateVariantField,
    removeVariantRow,
    renderVariantRows,
    generateProductSKU,
    toggleProductFormDrawer,
    triggerProductSlotUpload,
    handleProductSlotFileSelected,
    applyDirectSlotImageUrl,
    getProductSlotUrl,
    clearProductSlotImage,
    renderProductFormSlots,
    setProductCatalogViewMode,
    filterProductsCatalog,
    addProduct,
    editProduct,
    duplicateProduct,
    resetProductForm,
    toggleStockStatus,
    adjustProductStockQty,
    deleteProduct,
    exportInventoryCSV,
    loadProductCatalog,
    renderProductCatalogDisplay
};

Object.assign(window, exportedFunctions);
