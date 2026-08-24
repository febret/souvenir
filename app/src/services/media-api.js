export class MediaApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "MediaApiError";
    this.status = status;
  }
}

async function readJson(response) {
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const body = JSON.parse(text);
      detail = body.detail ?? body.message ?? "";
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new MediaApiError(
      detail || `The media server returned ${response.status}.`,
      response.status,
    );
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function addPath(url, path) {
  if (path) {
    url.searchParams.set("path", path);
  }
  return url;
}

function noStore(options = {}) {
  return { ...options, cache: "no-store" };
}

function maskUrl(baseUrl, endpoint, path, blur) {
  const url = addPath(new URL(`${baseUrl}${endpoint}`, window.location.origin), path);
  if (blur != null) url.searchParams.set("blur", String(blur));
  return url;
}

export class MediaApi {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  async health() {
    return readJson(await fetch(`${this.baseUrl}/api/health`));
  }

  async libraryStatus() {
    return readJson(await fetch(`${this.baseUrl}/api/library-status`));
  }

  async tree() {
    return readJson(await fetch(`${this.baseUrl}/api/tree`));
  }

  async directory(path = "", includedDirectories = []) {
    const url = addPath(new URL(`${this.baseUrl}/api/media`, window.location.origin), path);
    for (const directory of includedDirectories) {
      url.searchParams.append("included_dirs", directory);
    }
    return readJson(await fetch(url));
  }

  async tags() {
    return readJson(await fetch(`${this.baseUrl}/api/tags`, noStore()));
  }

  async commentary() {
    return readJson(await fetch(`${this.baseUrl}/api/commentary`, noStore()));
  }

  commentaryFileUrl(path) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/commentary/file`, window.location.origin),
      path,
    );
    return url.toString();
  }

  async commentaryTags(path) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/commentary-tags`, window.location.origin),
      path,
    );
    return readJson(await fetch(url, noStore()));
  }

  async saveCommentaryTags(path, tagIds) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/commentary-tags`, window.location.origin),
      path,
    );
    return readJson(await fetch(url, noStore({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: tagIds }),
    })));
  }

  async saveCommentaryCaption(path, caption) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/commentary-caption`, window.location.origin),
      path,
    );
    return readJson(await fetch(url, noStore({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption }),
    })));
  }

  async saveCommentaryVolume(path, volume) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/commentary-volume`, window.location.origin),
      path,
    );
    return readJson(await fetch(url, noStore({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume }),
    })));
  }

  async createTag(name) {
    return readJson(await fetch(`${this.baseUrl}/api/tags`, noStore({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })));
  }

  async renameTag(id, name) {
    return readJson(await fetch(
      `${this.baseUrl}/api/tags/${encodeURIComponent(String(id))}`,
      noStore({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    ));
  }

  async deleteTag(id) {
    return readJson(await fetch(
      `${this.baseUrl}/api/tags/${encodeURIComponent(String(id))}`,
      noStore({ method: "DELETE" }),
    ));
  }

  async mediaTags(path) {
    const url = new URL(`${this.baseUrl}/api/media-tags`, window.location.origin);
    url.searchParams.set("path", path ?? "");
    return readJson(await fetch(url, noStore()));
  }

  async saveMediaTags(path, tagIds) {
    const url = new URL(`${this.baseUrl}/api/media-tags`, window.location.origin);
    url.searchParams.set("path", path ?? "");
    return readJson(await fetch(url, noStore({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: tagIds }),
    })));
  }

  async saveMediaTagsBulk(assignments) {
    return readJson(await fetch(`${this.baseUrl}/api/media-tags/bulk`, noStore({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments }),
    })));
  }

  thumbnailUrl(path) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/thumbnail`, window.location.origin),
      path,
    );
    return url.toString();
  }

  fileUrl(path) {
    const url = addPath(
      new URL(`${this.baseUrl}/api/file`, window.location.origin),
      path,
    );
    return url.toString();
  }

  async maskInfo(path) {
    const url = maskUrl(this.baseUrl, "/api/mask-info", path);
    return readJson(await fetch(url, noStore()));
  }

  async loadMask(path) {
    const url = maskUrl(this.baseUrl, "/api/mask", path);
    const response = await fetch(url, noStore());
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.detail ?? body.message ?? "";
      } catch {
        detail = await response.text();
      }
      throw new MediaApiError(
        detail || `The media server returned ${response.status}.`,
        response.status,
      );
    }
    return response.blob();
  }

  async saveMask(path, png, blur = 0) {
    const safeBlur = Math.min(64, Math.max(0, Math.round(Number(blur) || 0)));
    const url = maskUrl(this.baseUrl, "/api/mask", path, safeBlur);
    return readJson(await fetch(url, noStore({
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    })));
  }

  async deleteMask(path) {
    const url = maskUrl(this.baseUrl, "/api/mask", path);
    return readJson(await fetch(url, noStore({ method: "DELETE" })));
  }
}

export function flattenDirectoryTree(payload) {
  const roots = Array.isArray(payload)
    ? payload
    : payload.directories ?? payload.children ?? (payload.root ? [payload.root] : []);
  const result = [];

  function visit(node, depth) {
    if (!node || typeof node !== "object") {
      return;
    }
    const path = node.path ?? node.relative_path ?? "";
    const name = node.name ?? (path ? path.split("/").at(-1) : "Media home");
    result.push({ name, path, depth });
    for (const child of node.children ?? node.directories ?? []) {
      visit(child, depth + 1);
    }
  }

  for (const root of roots) {
    visit(root, 0);
  }
  return result;
}
