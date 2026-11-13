import {
  SCOPE,
  loadFiles,
  kind,
  selectFiles,
  fileURL
} from "./drive.js";

const $ = (id) => document.getElementById(id);

const labels = {
  all: "الكل",
  pdf: "PDF",
  docs: "مستندات",
  images: "صور",
  folders: "مجلدات",
  other: "أخرى"
};

let token = "";
let expiry = 0;
let files = [];
let filter = "all";
let limit = 60;
let controller;
let authGeneration = 0;
let expiryTimer;

function message(text) {
  $("status").textContent = text;
}

function storageGet() {
  try {
    return (
      localStorage.getItem("mostanadati.search.clientId") || ""
    );
  } catch {
    return "";
  }
}

$("clientId").value = storageGet();

function reset() {
  authGeneration++;
  clearTimeout(expiryTimer);

  controller?.abort();
  controller = undefined;

  token = "";
  expiry = 0;
  files = [];
  limit = 60;

  $("refreshBtn").disabled = false;
  $("connectBtn").textContent = "ربط Google Drive";

  render();

  message("اربط حسابك للمتابعة.");
}

function render() {
  const shown = selectFiles(
    files,
    $("searchInput").value,
    filter
  );

  $("count").textContent =
    `${shown.length.toLocaleString("ar")} ملف`;

  $("resultsTitle").textContent =
    $("searchInput").value.trim()
      ? "نتائج البحث"
      : "ملفاتك";

  const fragment = document.createDocumentFragment();

  for (const file of shown.slice(0, limit)) {
    const link = document.createElement("a");

    link.className = "file";
    link.href = fileURL(file);
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const icon = document.createElement("span");

    icon.className = "file-icon";
    icon.textContent = labels[kind(file)];

    const info = document.createElement("div");
    info.className = "file-info";

    const title = document.createElement("h3");
    title.textContent = file.name || "بلا اسم";

    const subtitle = document.createElement("p");
    const date = new Date(file.modifiedTime);

    const formattedDate = Number.isNaN(date.getTime())
      ? "Google Drive"
      : date.toLocaleDateString("ar-SA");

    subtitle.textContent =
      `${labels[kind(file)]} · ${formattedDate}`;

    info.append(title, subtitle);

    const arrow = document.createElement("span");

    arrow.className = "arrow";
    arrow.textContent = "↖";

    link.append(icon, info, arrow);
    fragment.append(link);
  }

  $("results").replaceChildren(fragment);

  $("moreBtn").hidden = shown.length <= limit;

  if (token && !controller) {
    message(
      shown.length
        ? "تُعرض أسماء الملفات المحمّلة من Drive. استخدم «تحديث» لجلب آخر التغييرات."
        : "لا توجد ملفات مطابقة. جرّب جزءًا آخر من الاسم أو غيّر نوع الملف."
    );
  }
}

async function refresh() {
  if (!token || Date.now() >= expiry) {
    reset();
    message("انتهت الجلسة. اضغط ربط Google Drive مجددًا.");
    return;
  }

  controller?.abort();

  const current = new AbortController();
  controller = current;

  $("refreshBtn").disabled = true;

  message("جارٍ قراءة أسماء الملفات من Google Drive…");

  try {
    const loaded = await loadFiles(
      token,
      current.signal,
      (count) => {
        if (controller !== current) {
          return;
        }

        message(
          `جارٍ القراءة… ${count.toLocaleString("ar")} ملف. ` +
          "انتظر اكتمال جميع الصفحات."
        );
      }
    );

    if (controller !== current) {
      return;
    }

    files = loaded;
    limit = 60;
    controller = undefined;

    render();

    message(
      `اكتمل تحديث ${files.length.toLocaleString("ar")} ملف. ` +
      "البحث فوري بالاسم في هذه القائمة. " +
      `آخر تحديث: ${new Date().toLocaleTimeString("ar-SA")}`
    );
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    if (controller !== current) {
      return;
    }

    if (error.status === 401) {
      reset();

      message(
        "انتهت صلاحية الدخول إلى Google. اضغط ربط Google Drive مجددًا."
      );

      return;
    }

    const details = error.message || String(error);

    message(
      "سبب تعذر القراءة من Google: " +
      details +
      (files.length
        ? "\nالنتائج الحالية من آخر تحديث ناجح."
        : "")
    );
  } finally {
    if (controller === current) {
      controller = undefined;
    }

    if (!controller) {
      $("refreshBtn").disabled = false;
    }
  }
}

function connect() {
  const clientId = $("clientId").value.trim();

  if (
    !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)
  ) {
    $("settings").hidden = false;
    $("clientId").focus();

    message(
      "أدخل معرّف عميل OAuth الذي ينتهي بـ .apps.googleusercontent.com"
    );

    return;
  }

  if (!window.google?.accounts?.oauth2) {
    message(
      "مكتبة Google لم تُحمّل بعد. تحقق من الإنترنت ثم أعد تحميل الصفحة."
    );

    return;
  }

  reset();

  const generation = authGeneration;

  message("أكمل اختيار الحساب والموافقة في نافذة Google.");

  try {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      include_granted_scopes: false,

      callback: (response) => {
        if (generation !== authGeneration) {
          return;
        }

        if (response.error) {
          message(
            "تعذر الربط مع Google: " +
            response.error +
            (response.error_description
              ? " — " + response.error_description
              : "")
          );

          return;
        }

        const granted =
          window.google.accounts.oauth2.hasGrantedAllScopes(
            response,
            SCOPE
          );

        if (!granted) {
          message(
            "لم تُمنح صلاحية قراءة بيانات الملفات. أعد الربط ووافق على الصلاحية."
          );

          return;
        }

        if (!response.access_token) {
          message("لم يصل رمز الدخول من Google. أعد الربط.");
          return;
        }

        const expiresIn = Number(response.expires_in);

        if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
          message("تعذر تحديد صلاحية جلسة Google. أعد الربط.");
          return;
        }

        token = response.access_token;
        expiry = Date.now() + expiresIn * 1000;

        expiryTimer = setTimeout(() => {
          reset();

          message(
            "انتهت الجلسة. اضغط ربط Google Drive مجددًا."
          );
        }, Math.max(0, expiry - Date.now() - 10000));

        $("connectBtn").textContent =
          "إعادة ربط / تغيير الحساب";

        $("settings").hidden = true;

        refresh();
      },

      error_callback: (error) => {
        if (generation !== authGeneration) {
          return;
        }

        if (error.type === "popup_closed") {
          message(
            "أُغلقت نافذة الربط. اضغط ربط Google Drive للمحاولة مجددًا."
          );
        } else if (error.type === "popup_failed_to_open") {
          message(
            "تعذر فتح نافذة Google. اسمح بالنوافذ المنبثقة لهذا الموقع."
          );
        } else {
          message(
            "تعذر فتح تسجيل الدخول: " +
            (error.type || "خطأ غير معروف")
          );
        }
      }
    });

    client.requestAccessToken({
      prompt: "select_account"
    });
  } catch (error) {
    message(
      "تعذر بدء الاتصال مع Google: " +
      (error.message || String(error))
    );
  }
}

for (const [value, label] of Object.entries(labels)) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = label;

  button.classList.toggle(
    "active",
    value === filter
  );

  button.setAttribute(
    "aria-pressed",
    String(value === filter)
  );

  button.onclick = () => {
    filter = value;
    limit = 60;

    for (const child of $("filters").children) {
      const active = child === button;

      child.classList.toggle("active", active);

      child.setAttribute(
        "aria-pressed",
        String(active)
      );
    }

    render();
  };

  $("filters").append(button);
}

$("connectBtn").onclick = connect;

$("refreshBtn").onclick = () => {
  if (token) {
    refresh();
  } else {
    connect();
  }
};

$("disconnectBtn").onclick = () => {
  reset();

  message(
    "تم تسجيل الخروج من التطبيق ومسح نتائج هذه الجلسة من الذاكرة."
  );
};

$("saveBtn").onclick = () => {
  const clientId = $("clientId").value.trim();

  if (
    !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)
  ) {
    message(
      "تأكد أن معرّف العميل ينتهي بـ .apps.googleusercontent.com"
    );

    $("clientId").focus();
    return;
  }

  try {
    localStorage.setItem(
      "mostanadati.search.clientId",
      clientId
    );

    reset();

    message(
      "تم حفظ المعرّف. اضغط ربط Google Drive."
    );
  } catch {
    reset();

    message(
      "المتصفح يمنع حفظ المعرّف محليًا. يمكنك الآن الضغط على ربط Google Drive دون حفظ."
    );
  }
};

$("settingsBtn").onclick = () => {
  $("settings").hidden = !$("settings").hidden;
};

$("homeBtn").onclick = () => {
  $("settings").hidden = true;
  $("searchInput").focus();
};

$("searchInput").oninput = () => {
  limit = 60;
  render();
};

$("moreBtn").onclick = () => {
  limit += 60;
  render();
};

window.addEventListener("offline", () => {
  message(
    "لا يوجد اتصال بالإنترنت. النتائج الحالية من هذه الجلسة؛ فتح الملفات والتحديث يتطلبان اتصالًا."
  );
});

window.addEventListener("online", () => {
  message(
    "عاد الاتصال. اضغط تحديث لجلب آخر تغييرات Drive."
  );
});

render();
