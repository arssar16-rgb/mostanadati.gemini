export const SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly";

// قراءة بيانات الملفات من Google Drive.
export async function loadFiles(
  token,
  signal,
  progress = () => {},
  request = fetch
) {
  const files = new Map();
  let pageToken = "";

  do {
    const url = new URL(
      "https://www.googleapis.com/drive/v3/files"
    );

    url.search = new URLSearchParams({
      q: "trashed = false",
      spaces: "drive",
      corpora: "allDrives",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      fields:
        "nextPageToken,incompleteSearch," +
        "files(id,name,mimeType,webViewLink,modifiedTime,resourceKey)",
      ...(pageToken ? { pageToken } : {})
    });

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

    const data = await response.json();

    if (data.incompleteSearch) {
      throw new Error(
        "أبلغ Google أن البحث لم يشمل جميع مساحات Drive. أعد التحديث."
      );
    }

    for (const file of data.files || []) {
      files.set(file.id, file);
    }

    progress(files.size);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return [...files.values()];
}

// تصنيف الملف حسب نوعه.
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

// البحث العربي والتقريبي.
let FuseClass;

const indexes = new WeakMap();

export function normalizeName(value) {
  return String(value || "")
    .normalize("NFC")
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .trim();
}

export function selectFiles(files, query, filter) {
  const q = normalizeName(query);

  const byDate = (a, b) => {
    return (
      (b.modifiedTime || "").localeCompare(
        a.modifiedTime || ""
      ) ||
      (a.name || "").localeCompare(b.name || "", "ar")
    );
  };

  const candidates = files.filter((file) => {
    return filter === "all" || kind(file) === filter;
  });

  if (!q) {
    return candidates.sort(byDate);
  }

  const exact = candidates.filter((file) => {
    return normalizeName(file.name).includes(q);
  });

  // إعطاء الأولوية للمطابقة المباشرة.
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
      return filter === "all" || kind(file) === filter;
    });
}

// فتح الملف في Google Drive.
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
    // استخدام رابط بديل عند غياب رابط صالح.
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

// تحميل الإضافات دون تعطيل البحث إذا تعذر تحميلها.
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
}
