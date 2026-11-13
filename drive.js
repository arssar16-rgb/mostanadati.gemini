export const SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly";

const rootsByList = new WeakMap();
const indexes = new WeakMap();

let currentList;
let selectedFolder = "";
let visibleSyncPending = false;
let FuseClass;

// قراءة بيانات الملفات والمجلدات الرئيسية.
export async function loadFiles(
  token,
  signal,
  progress = () => {},
  request = fetch
) {
  async function get(path, params) {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/${path}`
    );

    url.search = new URLSearchParams(params);

    const response = await request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));

      const error = new Error(
        body.error?.message ||
        `Drive HTTP ${response.status}`
      );

      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  const files = new Map();

  async function collect(extra) {
    const collected = [];
    let pageToken = "";

    do {
      const data = await get("files", {
        q: "trashed = false",
        spaces: "drive",
        pageSize: "1000",
        fields:
          "nextPageToken,incompleteSearch," +
          "files(id,name,mimeType,webViewLink," +
          "modifiedTime,resourceKey,parents)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...extra,
        ...(pageToken ? { pageToken } : {})
      });

      if (data.incompleteSearch) {
        throw new Error(
          "البحث غير مكتمل من Google. أعد التحديث."
        );
      }

      for (const file of data.files || []) {
        files.set(file.id, file);
        collected.push(file);
      }

      progress(files.size);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return collected;
  }

  await collect({
    corpora: "allDrives"
  });

  // مجلدات المستوى الأول داخل «ملفاتي» فقط.
  const roots = await collect({
    corpora: "user",
    q:
      "trashed = false " +
      "and mimeType = 'application/vnd.google-apps.folder' " +
      "and 'root' in parents"
  });

  const list = [...files.values()];

  rootsByList.set(list, roots);

  return list;
}

// نوع الملف.
export function kind(file) {
  const mime = file.mimeType || "";

  if (mime === "application/vnd.google-apps.folder") {
    return "folders";
  }

  if (mime === "application/pdf") {
    return "pdf";
  }

  if (mime.startsWith("image/")) {
    return "images";
  }

  if (/document|spreadsheet|presentation|text\//.test(mime)) {
    return "docs";
  }

  return "other";
}

// معالجة الاسم العربي.
export function normalizeName(value) {
  return String(value || "")
    .normalize("NFC")
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .trim();
}

// البحث: لا نتائج دون كتابة.
export function selectFiles(files, query, filter) {
  syncFolders(files);
  scheduleVisibility();

  const q = normalizeName(query);

  if (!q) {
    return [];
  }

  const allowed = allowedFiles(files);

  const byDate = (a, b) => {
    return (
      (b.modifiedTime || "").localeCompare(
        a.modifiedTime || ""
      ) ||
      (a.name || "").localeCompare(b.name || "", "ar")
    );
  };

  const candidates = files.filter((file) => {
    return (
      allowed.has(file.id) &&
      (filter === "all" || kind(file) === filter)
    );
  });

  const exact = candidates.filter((file) => {
    return normalizeName(file.name).includes(q);
  });

  if (exact.length || !FuseClass || q.length < 3) {
    return exact.sort(byDate);
  }

  let index = indexes.get(files);

  if (!index) {
    index = new FuseClass(
      files.map((file) => ({
        file,
        name: normalizeName(file.name)
      })),
      {
        keys: ["name"],
        threshold: 0.32,
        ignoreLocation: true,
        includeScore: true,
        minMatchCharLength: 2
      }
    );

    indexes.set(files, index);
  }

  return index
    .search(q)
    .map((result) => result.item.file)
    .filter((file) => {
      return (
        allowed.has(file.id) &&
        (filter === "all" || kind(file) === filter)
      );
    });
}

// رابط فتح الملف.
export function fileURL(file) {
  try {
    const url = new URL(file.webViewLink);

    const allowedHosts = [
      "drive.google.com",
      "docs.google.com",
      "sheets.google.com",
      "slides.google.com"
    ];

    if (
      url.protocol === "https:" &&
      allowedHosts.includes(url.hostname)
    ) {
      return url.href;
    }
  } catch {
    // استخدام رابط بديل.
  }

  const id = encodeURIComponent(file.id);

  const url = new URL(
    file.mimeType === "application/vnd.google-apps.folder"
      ? `https://drive.google.com/drive/folders/${id}`
      : `https://drive.google.com/file/d/${id}/view`
  );

  if (file.resourceKey) {
    url.searchParams.set(
      "resourcekey",
      file.resourceKey
    );
  }

  return url.href;
}

// تحديد الملفات التابعة للمجلد المختار.
export function allowedFiles(files) {
  const roots = rootsByList.get(files) || [];

  if (!selectedFolder) {
    const rootIds = new Set(
      roots.map((folder) => folder.id)
    );

    return new Set(
      files
        .filter((file) => {
          return (
            kind(file) !== "folders" ||
            rootIds.has(file.id)
          );
        })
        .map((file) => file.id)
    );
  }

  const children = new Map();

  for (const file of files) {
    for (const parent of file.parents || []) {
      if (!children.has(parent)) {
        children.set(parent, []);
      }

      children.get(parent).push(file);
    }
  }

  const visited = new Set([selectedFolder]);
  const pending = [selectedFolder];
  const allowed = new Set();

  while (pending.length) {
    const parent = pending.pop();

    for (const file of children.get(parent) || []) {
      if (visited.has(file.id)) {
        continue;
      }

      visited.add(file.id);

      if (kind(file) === "folders") {
        pending.push(file.id);
      } else {
        allowed.add(file.id);
      }
    }
  }

  return allowed;
}

// بناء قائمة المجلدات الرئيسية.
function syncFolders(files) {
  if (files === currentList) {
    return;
  }

  const previousRoots =
    rootsByList.get(currentList) || [];

  const roots = rootsByList.get(files) || [];

  const existedBefore = previousRoots.some(
    (folder) => folder.id === selectedFolder
  );

  const existsNow = roots.some(
    (folder) => folder.id === selectedFolder
  );

  if (!existedBefore || !existsNow) {
    selectedFolder = "";
  }

  currentList = files;

  if (typeof document === "undefined") {
    return;
  }

  let panel = document.getElementById("mainFolders");

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "mainFolders";

    panel.setAttribute(
      "aria-label",
      "مجلدات ملفاتي الرئيسية"
    );

    const filters = document.getElementById("filters");

    if (!filters) {
      return;
    }

    filters.after(panel);
  }

  panel.replaceChildren();
  panel.hidden = !roots.length;

  if (!roots.length) {
    return;
  }

  const heading = document.createElement("p");

  heading.className = "folder-heading";
  heading.textContent = "مجلدات ملفاتي الرئيسية";

  const buttons = document.createElement("div");
  buttons.className = "root-folder-buttons";

  const sorted = [...roots].sort((a, b) => {
    return a.name.localeCompare(b.name, "ar");
  });

  const folders = [
    { id: "", name: "جميع الملفات" },
    ...sorted
  ];

  for (const folder of folders) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = folder.name;
    button.dataset.folderId = folder.id;

    button.classList.toggle(
      "active",
      folder.id === selectedFolder
    );

    button.setAttribute(
      "aria-pressed",
      String(folder.id === selectedFolder)
    );

    button.onclick = () => {
      selectedFolder = folder.id;

      for (const item of buttons.children) {
        const active = item === button;

        item.classList.toggle("active", active);

        item.setAttribute(
          "aria-pressed",
          String(active)
        );
      }

      // تطبيق البحث داخل المجلد مع عرض جميع أنواع الملفات.
      document
        .querySelector("#filters button")
        ?.click();

      scheduleVisibility();
    };

    buttons.append(button);
  }

  panel.append(heading, buttons);
}

// إخفاء منطقة النتائج عندما يكون البحث فارغًا.
function scheduleVisibility() {
  if (
    typeof document === "undefined" ||
    visibleSyncPending
  ) {
    return;
  }

  visibleSyncPending = true;

  queueMicrotask(() => {
    visibleSyncPending = false;

    const input = document.getElementById("searchInput");

    const searching = Boolean(
      input?.value.trim()
    );

    const results = document.getElementById("results");

    if (results) {
      results.hidden = !searching;
    }

    document
      .querySelectorAll(
        ".results-bar, .results-heading"
      )
      .forEach((element) => {
        element.hidden = !searching;
      });

    if (!searching) {
      const more = document.getElementById("moreBtn");

      if (more) {
        more.hidden = true;
      }

      const status = document.getElementById("status");

      if (
        status &&
        /^(لا توجد ملفات|تُعرض|اكتمل تحديث)/.test(
          status.textContent.trim()
        )
      ) {
        status.textContent =
          "جاهز للبحث. اكتب جزءًا من اسم الملف لعرض النتائج.";
      }
    } else {
      const title = document.getElementById(
        "resultsTitle"
      );

      const folder = (
        rootsByList.get(currentList) || []
      ).find((item) => {
        return item.id === selectedFolder;
      });

      if (title) {
        title.textContent = folder
          ? "نتائج البحث — " + folder.name
          : "نتائج البحث في جميع الملفات";
      }
    }
  });
}

// تحميل مكتبة البحث التقريبي.
if (typeof document !== "undefined") {
  import(
    "https://cdn.jsdelivr.net/npm/fuse.js@7.5.0/dist/fuse.mjs"
  )
    .then((module) => {
      FuseClass = module.default;

      const input = document.getElementById(
        "searchInput"
      );

      if (input?.value) {
        input.dispatchEvent(
          new Event("input", { bubbles: true })
        );
      }
    })
    .catch(() => {
      console.warn(
        "البحث التقريبي غير متاح؛ البحث العادي يعمل."
      );
    });

  // أيقونات التصنيفات والملفات.
  function installIcons() {
    if (!window.lucide?.createIcons) {
      return;
    }

    const style = document.createElement("style");

    style.textContent = `
      .file-icon svg {
        width: 23px;
        height: 23px;
      }

      #filters button.has-addon-icon::before {
        display: none;
      }

      .addon-symbol {
        display: inline-flex;
        vertical-align: middle;
        margin-inline-end: 10px;
      }

      .addon-symbol svg {
        width: 19px;
        height: 19px;
      }

      @media (max-width: 800px) {
        #filters button.has-addon-icon .addon-symbol {
          display: flex;
          justify-content: center;
          margin: 0 0 5px;
        }
      }
    `;

    document.head.append(style);

    const results = document.getElementById(
      "results"
    );

    const iconNames = {
      PDF: "file-text",
      مستندات: "files",
      صور: "image",
      مجلدات: "folder",
      أخرى: "file"
    };

    const filterIcons = [
      "layout-grid",
      "file-text",
      "files",
      "image",
      "folder",
      "file"
    ];

    const observer = new MutationObserver(draw);

    function draw() {
      observer.disconnect();

      try {
        document
          .querySelectorAll(
            ".file-icon:not([data-addon-icon])"
          )
          .forEach((element) => {
            const label = element.textContent.trim();

            element.dataset.addonIcon = "true";
            element.title = label;

            element.setAttribute(
              "aria-label",
              label
            );

            const icon = document.createElement("i");

            icon.setAttribute(
              "data-lucide",
              iconNames[label] || "file"
            );

            element.replaceChildren(icon);
          });

        document
          .querySelectorAll(
            "#filters button:not(.has-addon-icon)"
          )
          .forEach((button, index) => {
            const wrapper =
              document.createElement("span");

            wrapper.className = "addon-symbol";

            wrapper.setAttribute(
              "aria-hidden",
              "true"
            );

            const icon = document.createElement("i");

            icon.setAttribute(
              "data-lucide",
              filterIcons[index] || "file"
            );

            wrapper.append(icon);
            button.prepend(wrapper);

            button.classList.add(
              "has-addon-icon"
            );
          });

        window.lucide.createIcons();
      } finally {
        if (results) {
          observer.observe(results, {
            childList: true,
            subtree: true
          });
        }
      }
    }

    draw();
  }

  function startIcons() {
    if (window.lucide?.createIcons) {
      installIcons();
      return;
    }

    const script = document.createElement("script");

    script.src =
      "https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js";

    script.onload = installIcons;

    script.onerror = () => {
      console.warn(
        "الأيقونات الإضافية غير متاحة؛ يستمر العرض العادي."
      );
    };

    document.head.append(script);
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      startIcons,
      { once: true }
    );
  } else {
    startIcons();
  }

  // تنسيق قائمة المجلدات على الكمبيوتر والآيفون.
  const style = document.createElement("style");

  style.textContent = `
    aside {
      overflow-y: auto;
    }

    #mainFolders {
      margin-top: 20px;
      min-height: 0;
    }

    .folder-heading {
      font-size: 11px;
      color: #c1d1c4;
      padding: 0 12px;
    }

    .root-folder-buttons {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .root-folder-buttons button {
      border: 0;
      background: transparent;
      color: #d0ded0;
      text-align: right;
      padding: 10px 14px;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .root-folder-buttons button::before {
      content: "▱";
      margin-inline-end: 9px;
    }

    .root-folder-buttons button.active {
      background: #dce9b9;
      color: #153e3b;
    }

    @media (max-width: 800px) {
      aside {
        overflow: visible;
      }

      #mainFolders {
        margin-top: 5px;
        border-top: 1px solid #e0e5da;
        padding-top: 6px;
      }

      .folder-heading {
        display: none;
      }

      .root-folder-buttons {
        flex-direction: row;
        overflow-x: auto;
        scrollbar-width: none;
      }

      .root-folder-buttons button {
        flex-shrink: 0;
        white-space: nowrap;
        padding: 7px 12px;
        font-size: 11px;
        color: #526a4c;
        background: #f3f5ef;
      }

      main {
        padding-bottom: 165px !important;
      }
    }
  `;

  document.head.append(style);

  const setup = () => {
    document
      .getElementById("searchInput")
      ?.addEventListener(
        "input",
        scheduleVisibility
      );

    scheduleVisibility();
  };

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      setup,
      { once: true }
    );
  } else {
    setup();
  }
}
// إصلاح البحث العام وتداخل القائمة الجانبية.
if (typeof document !== "undefined") {
  const repairStyle = document.createElement("style");

  repairStyle.textContent = `
    @media (min-width: 801px) {
      aside {
        display: block !important;
        height: 100dvh;
        overflow-y: auto !important;
        overflow-x: hidden;
      }

      #mainFolders {
        min-height: auto !important;
        margin-top: 24px;
      }

      .root-folder-buttons {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      .root-folder-buttons button {
        display: block;
        flex-shrink: 0;
        width: 100%;
        height: auto;
        min-height: 42px;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.8;
        padding: 10px 14px;
        text-align: right;
      }

      .folder-heading {
        line-height: 1.8;
        margin-bottom: 12px;
      }

      .side-bottom {
        margin-top: 28px !important;
        padding-top: 18px;
        padding-bottom: 20px;
        clear: both;
      }

      .side-bottom button {
        white-space: normal;
        line-height: 1.8;
      }

      .side-note {
        line-height: 2;
        overflow-wrap: anywhere;
      }
    }

    @media (max-width: 800px) {
      aside {
        display: flex !important;
        flex-direction: column;
        height: auto !important;
        max-height: 35dvh;
        overflow-y: auto !important;
        overflow-x: hidden;
      }

      #filters,
      #mainFolders {
        width: 100%;
        flex-shrink: 0;
      }

      .root-folder-buttons {
        flex-direction: row;
        overflow-x: auto;
        gap: 6px;
        padding-bottom: 3px;
      }

      .root-folder-buttons button {
        flex-shrink: 0;
        width: auto;
        white-space: nowrap;
        line-height: 1.8;
      }

      main {
        padding-bottom:
          calc(165px + env(safe-area-inset-bottom)) !important;
      }
    }
  `;

  document.head.append(repairStyle);

  const enableGlobalSearch = () => {
    const input = document.getElementById("searchInput");

    if (!input) {
      return;
    }

    input.addEventListener("input", () => {
      // الكتابة تعيد البحث إلى جميع الملفات.
      selectedFolder = "";

      document.querySelectorAll(
        "#mainFolders button[data-folder-id]"
      ).forEach((button) => {
        const active = button.dataset.folderId === "";

        button.classList.toggle("active", active);

        button.setAttribute(
          "aria-pressed",
          String(active)
        );
      });

      const allFiles = document.querySelector(
        "#filters button"
      );

      if (
        allFiles &&
        allFiles.getAttribute("aria-pressed") !== "true"
      ) {
        allFiles.click();
      }

      scheduleVisibility();
    }, true);
  };

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      enableGlobalSearch,
      { once: true }
    );
  } else {
    enableGlobalSearch();
  }
}
