// ============================================================================
// تطبيق «مستنداتي» - المحرك الرئيسي المحدّث والنهائي
// ============================================================================

const DB_NAME = 'MostanadatiDB';
const DB_VERSION = 1;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const APP_FOLDER_NAME = 'مستنداتي - Mostanadati';
const INDEX_FILE_NAME = 'mostanadati_index.json';

const DEFAULT_CATEGORIES = [
  { id: 'cat_id', name: 'الهوية والوثائق الرسمية', icon: 'id-card', updatedAt: 1 },
  { id: 'cat_fin', name: 'المستندات المالية والبنكية', icon: 'landmark', updatedAt: 1 },
  { id: 'cat_prop', name: 'العقارات والأملاك', icon: 'building-2', updatedAt: 1 },
  { id: 'cat_car', name: 'السيارات', icon: 'car', updatedAt: 1 },
  { id: 'cat_edu', name: 'الشهادات والتعليم', icon: 'graduation-cap', updatedAt: 1 },
  { id: 'cat_med', name: 'المستندات الطبية', icon: 'heart-pulse', updatedAt: 1 },
  { id: 'cat_contract', name: 'العقود والاتفاقيات', icon: 'file-signature', updatedAt: 1 },
  { id: 'cat_other', name: 'مستندات أخرى', icon: 'folder', updatedAt: 1 }
];

const state = {
  accessToken: null,
  tokenExpiry: 0,
  tokenClient: null,
  isSyncing: false,
  activeCategory: 'all',
  searchQuery: '',
  selectedFile: null,
  addMode: 'upload',
  indexData: {
    version: 1,
    lastSyncedAt: null,
    categories: [],
    documents: [],
    deletedIds: []
  }
};

// ============================================================================
// 1. إدارة قاعدة البيانات المحلية (IndexedDB)
// ============================================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'localId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const req = key !== undefined ? os.put(value, key) : os.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// 2. المصادقة عبر Google Identity Services (OAuth 2.0)
// ============================================================================
function getClientId() {
  return localStorage.getItem('mostanadati_client_id') || '';
}

function initGoogleAuth() {
  const clientId = getClientId();
  if (!clientId || !window.google?.accounts?.oauth2) return;

  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: async (resp) => {
      if (resp.error) {
        updateAuthUI(false);
        showToast(`خطأ في الدخول: ${resp.error}`);
        return;
      }
      state.accessToken = resp.access_token;
      state.tokenExpiry = Date.now() + (Number(resp.expires_in || 3500) * 1000);
      updateAuthUI(true);
      document.getElementById('syncStatusText').textContent = 'متصل بحساب Drive';
      showToast('تم الاتصال بحساب Google Drive بنجاح');
      await processOutboxQueue();
      await syncWithGoogleDrive();
    }
  });
}

function ensureValidToken(interactive = true) {
  return new Promise((resolve, reject) => {
    if (state.accessToken && Date.now() < state.tokenExpiry - 60000) {
      resolve(state.accessToken);
      return;
    }
    if (!getClientId()) {
      showToast('يرجى إدخال OAuth Client ID في الإعدادات أولاً');
      switchView('viewSettings');
      reject(new Error('MISSING_CLIENT_ID'));
      return;
    }
    if (!state.tokenClient) initGoogleAuth();
    if (!state.tokenClient) {
      showToast('مكتبة Google لم تكتمل بعد، أعد المحاولة');
      reject(new Error('GIS_NOT_READY'));
      return;
    }

    const originalCallback = state.tokenClient.callback;
    state.tokenClient.callback = async (resp) => {
      state.tokenClient.callback = originalCallback;
      if (resp.error) {
        updateAuthUI(false);
        reject(new Error(resp.error));
        return;
      }
      state.accessToken = resp.access_token;
      state.tokenExpiry = Date.now() + (Number(resp.expires_in || 3500) * 1000);
      updateAuthUI(true);
      resolve(state.accessToken);
    };

    state.tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

// ============================================================================
// 3. عمليات Google Drive API v3
// ============================================================================
async function driveFetch(url, options = {}) {
  const token = await ensureValidToken(true);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    state.accessToken = null;
    updateAuthUI(false);
    throw new Error('انتهت جلسة الدخول، اضغط على زر متصل لتجديدها');
  }
  if (!res.ok) {
    let errMsg = `خطأ (${res.status})`;
    try {
      const errJson = await res.json();
      errMsg = errJson.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }
  return res;
}

async function getOrCreateAppFolder() {
  let folderId = localStorage.getItem('mostanadati_folder_id');
  if (folderId) {
    try {
      const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,trashed`);
      const data = await check.json();
      if (data.id && !data.trashed) {
        document.getElementById('driveFolderInfo').textContent = `مجلد التطبيق متصل ومؤمّن (${APP_FOLDER_NAME})`;
        return folderId;
      }
    } catch (_) {
      localStorage.removeItem('mostanadati_folder_id');
      folderId = null;
    }
  }

  const q = encodeURIComponent(`name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  const searchData = await searchRes.json();

  if (searchData.files && searchData.files.length > 0) {
    folderId = searchData.files[0].id;
  } else {
    const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: APP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder'
      })
    });
    const created = await createRes.json();
    folderId = created.id;
  }

  localStorage.setItem('mostanadati_folder_id', folderId);
  document.getElementById('driveFolderInfo').textContent = `مجلد التطبيق متصل ومؤمّن (${APP_FOLDER_NAME})`;
  return folderId;
}

async function uploadBinaryFileToDrive(fileBlob, fileName, mimeType, folderId) {
  const metadata = {
    name: fileName,
    parents: [folderId]
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileBlob, fileName);

  const res = await driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,mimeType,size',
    { method: 'POST', body: form }
  );
  return await res.json();
}

// ============================================================================
// 4. مزامنة الفهرس السحابية (دمج ذكي غير مدمر مع أولوية الملفات المرفوعة)
// ============================================================================
async function syncWithGoogleDrive() {
  if (state.isSyncing) return;
  if (!navigator.onLine) {
    showToast('أنت غير متصل بالإنترنت حالياً');
    return;
  }

  state.isSyncing = true;
  const syncBtn = document.getElementById('syncBtn');
  syncBtn.classList.add('spinning');
  document.getElementById('syncStatusText').textContent = 'جاري المزامنة...';

  try {
    const folderId = await getOrCreateAppFolder();
    const q = encodeURIComponent(`name='${INDEX_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
    const listRes = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)`);
    const listData = await listRes.json();

    let remoteFileId = listData.files?.[0]?.id || null;
    let remoteIndex = null;

    if (remoteFileId) {
      const contentRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${remoteFileId}?alt=media`);
      remoteIndex = await contentRes.json();
    }

    if (remoteIndex && Array.isArray(remoteIndex.documents)) {
      state.indexData = mergeIndexes(state.indexData, remoteIndex);
    }

    state.indexData.lastSyncedAt = new Date().toISOString();
    await saveLocalIndex();

    const jsonBlob = new Blob([JSON.stringify(state.indexData, null, 2)], { type: 'application/json' });
    if (remoteFileId) {
      await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${remoteFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBlob
      });
    } else {
      await uploadBinaryFileToDrive(jsonBlob, INDEX_FILE_NAME, 'application/json', folderId);
    }

    renderAll();
    updateSyncStatusUI();
    showToast('تمت مزامنة الفهرس بنجاح');
  } catch (err) {
    console.error('Sync Error:', err);
    document.getElementById('syncStatusText').textContent = `تعذرت المزامنة: ${err.message}`;
    showToast(`تعذرت المزامنة: ${err.message}`);
  } finally {
    state.isSyncing = false;
    syncBtn.classList.remove('spinning');
  }
}

function mergeIndexes(local, remote) {
  const deletedSet = new Set([...(local.deletedIds || []), ...(remote.deletedIds || [])]);

  const catMap = new Map();
  [...(remote.categories || []), ...(local.categories || [])].forEach((c) => {
    const existing = catMap.get(c.id);
    if (!existing || (c.updatedAt || 0) >= (existing.updatedAt || 0)) {
      catMap.set(c.id, c);
    }
  });

  const docMap = new Map();
  [...(remote.documents || []), ...(local.documents || [])].forEach((d) => {
    if (deletedSet.has(d.id)) return;
    const existing = docMap.get(d.id);
    if (!existing) {
      docMap.set(d.id, d);
      return;
    }
    // الأولوية دائماً للنسخة المرفوعة فعلياً على Drive
    if (existing.pendingUpload && !d.pendingUpload) {
      docMap.set(d.id, d);
    } else if (!existing.pendingUpload && d.pendingUpload) {
      // نحتفظ بالنسخة المرفوعة
    } else if ((d.updatedAt || 0) >= (existing.updatedAt || 0)) {
      docMap.set(d.id, d);
    }
  });

  return {
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    categories: Array.from(catMap.values()),
    documents: Array.from(docMap.values()).sort((a, b) => b.createdAt - a.createdAt),
    deletedIds: Array.from(deletedSet)
  };
}

// ============================================================================
// 5. قائمة الانتظار للعمل دون إنترنت (Offline Outbox Queue)
// ============================================================================
async function processOutboxQueue() {
  const queue = await dbGetAll('outbox');
  updateQueueBanner(queue.length);
  if (!queue.length || !navigator.onLine) return;

  try {
    document.getElementById('syncStatusText').textContent = 'جاري رفع المستندات المعلقة...';
    const folderId = await getOrCreateAppFolder();
    for (const item of queue) {
      const uploaded = await uploadBinaryFileToDrive(item.fileBlob, item.fileName, item.mimeType, folderId);
      const docIndex = state.indexData.documents.findIndex((d) => d.id === item.docId);
      if (docIndex !== -1) {
        state.indexData.documents[docIndex].driveFileId = uploaded.id;
        state.indexData.documents[docIndex].webViewLink = `https://drive.google.com/file/d/${uploaded.id}/view`;
        state.indexData.documents[docIndex].pendingUpload = false;
        state.indexData.documents[docIndex].updatedAt = Date.now();
      }
      await dbDelete('outbox', item.localId);
    }
    await saveLocalIndex();
    renderAll();
    updateQueueBanner(0);
    showToast('تم رفع المستندات المعلقة إلى Google Drive بنجاح');
    await syncWithGoogleDrive();
  } catch (err) {
    console.error('Outbox sync error:', err);
    document.getElementById('syncStatusText').textContent = `تعذر الرفع: ${err.message}`;
    showToast(`تعذر الرفع: ${err.message}`);
  }
}

// ============================================================================
// 6. إضافة، فتح، تعديل، وبحث المستندات
// ============================================================================
function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function handleAddDocument(e) {
  e.preventDefault();
  const title = document.getElementById('docTitleInput').value.trim();
  const categoryId = document.getElementById('docCategorySelect').value;
  const keywords = document.getElementById('docKeywordsInput').value.trim();
  const submitBtn = document.getElementById('submitDocBtn');

  if (!title) return;

  const docId = 'doc_' + crypto.randomUUID();
  const now = Date.now();

  if (state.addMode === 'link') {
    const rawUrl = document.getElementById('manualDriveUrl').value.trim();
    const fileId = extractDriveFileId(rawUrl);
    if (!fileId) {
      showToast('رابط Google Drive غير صالح');
      return;
    }

    state.indexData.documents.unshift({
      id: docId,
      title,
      categoryId,
      keywords,
      extractedText: '',
      driveFileId: fileId,
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
      mimeType: 'application/vnd.google-apps.file',
      pendingUpload: false,
      createdAt: now,
      updatedAt: now
    });

    await saveLocalIndex();
    renderAll();
    closeModal('addDocModal');
    showToast('تمت إضافة المستند إلى الفهرس');
    if (navigator.onLine && state.accessToken) syncWithGoogleDrive();
    return;
  }

  const file = state.selectedFile;
  if (!file) {
    showToast('يرجى اختيار ملف أو التقاط صورة أولاً');
    return;
  }

  submitBtn.disabled = true;
  const progressBox = document.getElementById('uploadProgressBox');
  const progressFill = document.getElementById('uploadProgressFill');
  progressBox.classList.remove('hidden');
  progressFill.style.width = '35%';

  const ext = file.name && file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
  const safeDriveName = `${title}.${ext}`;

  if (!navigator.onLine || !getClientId()) {
    await queueOfflineDocument(docId, title, categoryId, keywords, file, safeDriveName, now);
    submitBtn.disabled = false;
    progressBox.classList.add('hidden');
    closeModal('addDocModal');
    return;
  }

  try {
    const folderId = await getOrCreateAppFolder();
    progressFill.style.width = '70%';
    const uploaded = await uploadBinaryFileToDrive(file, safeDriveName, file.type || 'application/octet-stream', folderId);
    progressFill.style.width = '100%';

    state.indexData.documents.unshift({
      id: docId,
      title,
      categoryId,
      keywords,
      extractedText: '',
      driveFileId: uploaded.id,
      webViewLink: `https://drive.google.com/file/d/${uploaded.id}/view`,
      mimeType: file.type,
      pendingUpload: false,
      createdAt: now,
      updatedAt: now
    });

    await saveLocalIndex();
    renderAll();
    closeModal('addDocModal');
    showToast('تم رفع المستند وحفظه في الفهرس بنجاح');
    await syncWithGoogleDrive();
  } catch (err) {
    console.warn('Upload failed, queuing offline:', err);
    showToast(`حُفظ محلياً مؤقتاً: ${err.message}`);
    await queueOfflineDocument(docId, title, categoryId, keywords, file, safeDriveName, now);
    closeModal('addDocModal');
  } finally {
    submitBtn.disabled = false;
    progressBox.classList.add('hidden');
    progressFill.style.width = '0%';
  }
}

async function queueOfflineDocument(docId, title, categoryId, keywords, file, safeDriveName, now) {
  await dbPut('outbox', {
    localId: 'q_' + crypto.randomUUID(),
    docId,
    fileName: safeDriveName,
    mimeType: file.type || 'application/octet-stream',
    fileBlob: file,
    createdAt: now
  });

  state.indexData.documents.unshift({
    id: docId,
    title,
    categoryId,
    keywords,
    extractedText: '',
    driveFileId: null,
    webViewLink: null,
    mimeType: file.type,
    pendingUpload: true,
    createdAt: now,
    updatedAt: now
  });

  await saveLocalIndex();
  const queue = await dbGetAll('outbox');
  updateQueueBanner(queue.length);
  renderAll();
}

function openDocumentInDrive(doc) {
  if (doc.pendingUpload || !doc.driveFileId) {
    showToast('هذا المستند بانتظار الرفع إلى Google Drive');
    return;
  }
  const url = `https://drive.google.com/file/d/${doc.driveFileId}/view`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ============================================================================
// 7. العرض والواجهة التفاعلية
// ============================================================================
async function saveLocalIndex() {
  await dbPut('meta', state.indexData, 'index');
}

function renderAll() {
  renderCategories();
  renderDocuments();
  renderCategoriesManager();
  populateCategorySelects();
  if (window.lucide) lucide.createIcons();
}

function renderCategories() {
  const grid = document.getElementById('categoriesGrid');
  const docs = state.indexData.documents;

  const allCard = `
    <button class="cat-card ${state.activeCategory === 'all' ? 'active' : ''}" data-cat="all">
      <div class="cat-icon"><i data-lucide="layout-grid"></i></div>
      <div class="cat-meta">
        <span class="cat-name">الكل</span>
        <span class="cat-count">${docs.length} مستند</span>
      </div>
    </button>
  `;

  const cards = state.indexData.categories.map((cat) => {
    const count = docs.filter((d) => d.categoryId === cat.id).length;
    return `
      <button class="cat-card ${state.activeCategory === cat.id ? 'active' : ''}" data-cat="${cat.id}">
        <div class="cat-icon"><i data-lucide="${cat.icon || 'folder'}"></i></div>
        <div class="cat-meta">
          <span class="cat-name">${escapeHtml(cat.name)}</span>
          <span class="cat-count">${count} مستند</span>
        </div>
      </button>
    `;
  }).join('');

  grid.innerHTML = allCard + cards;
  grid.querySelectorAll('.cat-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeCategory = btn.dataset.cat;
      renderAll();
    });
  });
}

function renderDocuments() {
  const list = document.getElementById('documentsList');
  const q = state.searchQuery.toLowerCase().trim();

  const filtered = state.indexData.documents.filter((doc) => {
    const matchesCat = state.activeCategory === 'all' || doc.categoryId === state.activeCategory;
    if (!matchesCat) return false;
    if (!q) return true;

    const catName = state.indexData.categories.find((c) => c.id === doc.categoryId)?.name || '';
    const searchable = `${doc.title} ${doc.keywords || ''} ${doc.extractedText || ''} ${catName}`.toLowerCase();
    return searchable.includes(q);
  });

  document.getElementById('docsCountBadge').textContent = filtered.length;
  document.getElementById('docsSectionTitle').textContent = q ? 'نتائج البحث' : 'المستندات المحفوظة';

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <p>لا توجد مستندات مطابقة حالياً</p>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((doc) => {
    const cat = state.indexData.categories.find((c) => c.id === doc.categoryId);
    const isPdf = (doc.mimeType || '').includes('pdf');
    const dateStr = new Date(doc.createdAt).toLocaleDateString('ar-SA');

    return `
      <article class="doc-card">
        <div class="doc-main" data-open-id="${doc.id}">
          <div class="doc-type-badge">
            <i data-lucide="${isPdf ? 'file-text' : 'image'}"></i>
          </div>
          <div class="doc-info">
            <div class="doc-title">${escapeHtml(doc.title)}</div>
            <div class="doc-sub">
              <span class="tag-pill">${escapeHtml(cat?.name || 'عام')}</span>
              <span>${dateStr}</span>
              ${doc.pendingUpload ? '<span class="pending-pill">بانتظار الرفع</span>' : ''}
            </div>
          </div>
        </div>
        <div class="doc-actions">
          <button class="doc-action-btn" data-edit-id="${doc.id}" aria-label="تعديل">
            <i data-lucide="more-vertical"></i>
          </button>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('[data-open-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const doc = state.indexData.documents.find((d) => d.id === el.dataset.openId);
      if (doc) openDocumentInDrive(doc);
    });
  });

  list.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(btn.dataset.editId);
    });
  });
}

function renderCategoriesManager() {
  const container = document.getElementById('categoriesManageList');
  container.innerHTML = state.indexData.categories.map((cat) => `
    <div class="manage-item row-between">
      <div>
        <strong>${escapeHtml(cat.name)}</strong>
      </div>
      <div class="btn-group">
        <button class="btn-secondary btn-sm" data-rename-cat="${cat.id}">إعادة تسمية</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-rename-cat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cat = state.indexData.categories.find((c) => c.id === btn.dataset.renameCat);
      if (!cat) return;
      const newName = prompt('أدخل الاسم الجديد للتصنيف:', cat.name);
      if (newName && newName.trim()) {
        cat.name = newName.trim();
        cat.updatedAt = Date.now();
        await saveLocalIndex();
        renderAll();
        if (navigator.onLine && state.accessToken) syncWithGoogleDrive();
      }
    });
  });
}

function populateCategorySelects() {
  const options = state.indexData.categories
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('');
  document.getElementById('docCategorySelect').innerHTML = options;
  document.getElementById('editDocCategory').innerHTML = options;
}

function openEditModal(docId) {
  const doc = state.indexData.documents.find((d) => d.id === docId);
  if (!doc) return;
  document.getElementById('editDocId').value = doc.id;
  document.getElementById('editDocTitle').value = doc.title;
  document.getElementById('editDocCategory').value = doc.categoryId;
  document.getElementById('editDocKeywords').value = doc.keywords || '';
  document.getElementById('editDocModal').classList.remove('hidden');
}

// ============================================================================
// 8. قفل التطبيق (PIN) والتهيئة العامة
// ============================================================================
function setupPinLock() {
  const savedPin = localStorage.getItem('mostanadati_pin');
  const lockScreen = document.getElementById('lockScreen');
  if (!savedPin) return;

  lockScreen.classList.remove('hidden');
  let entered = '';
  const dots = document.querySelectorAll('#pinDots span');

  document.querySelectorAll('.pin-keypad button[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (key === 'del') {
        entered = entered.slice(0, -1);
      } else if (entered.length < 4) {
        entered += key;
      }

      dots.forEach((d, idx) => d.classList.toggle('filled', idx < entered.length));

      if (entered.length === 4) {
        if (entered === savedPin) {
          lockScreen.classList.add('hidden');
        } else {
          document.getElementById('lockMessage').textContent = 'رمز غير صحيح، حاول مجدداً';
          entered = '';
          dots.forEach((d) => d.classList.remove('filled'));
        }
      }
    });
  });
}

function updateAuthUI(connected) {
  const pill = document.getElementById('authStatusBtn');
  const label = document.getElementById('authBtnLabel');
  pill.classList.toggle('connected', connected);
  label.textContent = connected ? 'متصل
