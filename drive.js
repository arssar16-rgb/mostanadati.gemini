export const SCOPE =
  "https://www.googleapis.com/auth/drive.metadata.readonly";

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
        body.error?.message || `Drive HTTP ${response.status}`
      );

      error.status = response.status;
      throw error;
    }

    const data = await response.json();

    if (data.incompleteSearch) {
      throw new Error(
        "أبلغ Google أن البحث لم يشمل جميع مساحات Drive. " +
        "لم تُعتمد النتائج الناقصة. أعد التحديث."
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

export function selectFiles(files, query, filter) {
  const normalizedQuery = query
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("ar");

  return files
    .filter((file) => {
      const matchesType =
        filter === "all" || kind(file) === filter;

      const matchesName = (file.name || "")
        .normalize("NFC")
        .toLocaleLowerCase("ar")
        .includes(normalizedQuery);

      return matchesType && matchesName;
    })
    .sort((a, b) => {
      return (
        (b.modifiedTime || "").localeCompare(
          a.modifiedTime || ""
        ) ||
        (a.name || "").localeCompare(b.name || "", "ar")
      );
    });
}

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
    // استخدام رابط Drive بديل عند غياب رابط صالح.
  }

  const id = encodeURIComponent(file.id);

  const url = new URL(
    file.mimeType === "application/vnd.google-apps.folder"
      ? `https://drive.google.com/drive/folders/${id}`
      : `https://drive.google.com/file/d/${id}/view`
  );

  if (file.resourceKey) {
    url.searchParams.set("resourcekey", file.resourceKey);
  }

  return url.href;
}
