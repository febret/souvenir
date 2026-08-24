import { normalizeTagIds } from "../core/tags.js";

function normalizeDirectoryRoots(directories) {
  const roots = [];
  for (const directory of directories) {
    if (typeof directory !== "string") continue;
    const path = directory.trim();
    if (!path) continue;
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    const nestedRoots = roots.filter((root) => root.startsWith(`${path}/`));
    nestedRoots.forEach((root) => roots.splice(roots.indexOf(root), 1));
    roots.push(path);
  }
  return roots;
}

function previewUrl(api, entry) {
  if (typeof entry?.thumbnail_url === "string" && entry.thumbnail_url) {
    return entry.thumbnail_url;
  }
  return api.thumbnailUrl(entry?.path ?? "");
}

function cssUrl(value) {
  return `url(${JSON.stringify(String(value))})`;
}

function isVideoEntry(entry) {
  const mediaType = typeof entry?.media_type === "string" ? entry.media_type.toLowerCase() : "";
  if (mediaType.startsWith("video/")) return true;
  const name = typeof entry?.name === "string" ? entry.name.toLowerCase() : "";
  return /\.(mp4|webm|mov|m4v|avi|mkv|wmv|mpeg|mpg|ogv|3gp|3g2)$/i.test(name);
}

export function createTagPill(document, {
  tagId,
  label,
  className = "",
} = {}) {
  const pill = document.createElement("span");
  pill.className = ["tag-pill", className].filter(Boolean).join(" ");
  if (tagId != null) pill.dataset.tagId = String(tagId);
  pill.textContent = label ?? "";
  return pill;
}

export function applyTagPillPreview(pill, url) {
  if (!pill) return;
  if (url) {
    pill.style.setProperty("--tag-pill-image", cssUrl(url));
    pill.classList.add("tag-pill--with-preview");
  } else {
    pill.style.removeProperty("--tag-pill-image");
    pill.classList.remove("tag-pill--with-preview");
  }
}

export class TagPreviewResolver {
  constructor({ api, selectedDirectories, onUpdate } = {}) {
    this.api = api;
    this.selectedDirectories = selectedDirectories;
    this.onUpdate = onUpdate;
    this.directoryKey = "";
    this.directories = [];
    this.roots = [];
    this.previews = new Map();
    this.usedPreviewUrls = new Set();
    this.exhausted = new Set();
    this.pendingPromise = null;
    this.generation = 0;
    this.requestedTagIds = new Set();
  }

  previewFor(tagId) {
    this.#syncDirectories();
    return this.previews.get(String(tagId)) ?? "";
  }

  ensure(tagIds) {
    this.#syncDirectories();
    normalizeTagIds(tagIds).forEach((tagId) => {
      if (!this.exhausted.has(tagId)) this.requestedTagIds.add(tagId);
    });
    if (!this.directories.length || this.pendingPromise) return;
    const unresolved = [...this.requestedTagIds].some((tagId) => !this.previews.has(tagId));
    if (unresolved) this.pendingPromise = this.#scan();
  }

  invalidate() {
    this.directoryKey = "";
    this.directories = [];
    this.roots = [];
    this.previews.clear();
    this.usedPreviewUrls.clear();
    this.exhausted.clear();
    this.pendingPromise = null;
    this.requestedTagIds.clear();
    this.generation += 1;
  }

  #syncDirectories() {
    const directories = Array.isArray(this.selectedDirectories?.())
      ? this.selectedDirectories()
      : [];
    const nextKey = JSON.stringify(directories);
    if (nextKey === this.directoryKey) return;
    this.directoryKey = nextKey;
    this.directories = directories;
    this.roots = normalizeDirectoryRoots(directories);
    this.previews.clear();
    this.usedPreviewUrls.clear();
    this.exhausted.clear();
    this.pendingPromise = null;
    this.requestedTagIds.clear();
    this.generation += 1;
  }

  #resolvePreviewAssignments(tagIds, candidates) {
    const resolved = new Map();
    const taken = new Set();
    for (const tagId of tagIds) {
      const current = this.previews.get(tagId) ?? "";
      const options = candidates.get(tagId) ?? [];
      if (!current || (options.length > 0 && !options.includes(current))) continue;
      resolved.set(tagId, current);
      taken.add(current);
    }
    const pending = [...new Set(tagIds)]
      .filter((tagId) => !resolved.has(tagId))
      .sort((left, right) => {
        const leftCount = candidates.get(left)?.length ?? 0;
        const rightCount = candidates.get(right)?.length ?? 0;
        return leftCount - rightCount || left.localeCompare(right);
      });
    for (const tagId of pending) {
      const options = candidates.get(tagId) ?? [];
      const url = options.find((option) => !taken.has(option)) ?? options[0] ?? "";
      if (!url) continue;
      resolved.set(tagId, url);
      taken.add(url);
    }
    return resolved;
  }

  async #scan() {
    const generation = this.generation;
    const queue = [...this.roots];
    const visited = new Set();
    const candidates = new Map();
    try {
      while (generation === this.generation && queue.length > 0) {
        const unresolved = [...this.requestedTagIds].filter((tagId) => !this.previews.has(tagId));
        if (!unresolved.length) break;
        const path = queue.shift();
        if (!path || visited.has(path)) continue;
        visited.add(path);
        const payload = await this.api.directory(path, this.directories);
        if (generation !== this.generation) return;
        const entries = Array.isArray(payload) ? payload : payload?.entries ?? payload?.items ?? [];
        for (const entry of entries) {
          if (entry?.kind === "directory") {
            if (typeof entry.path === "string" && entry.path) queue.push(entry.path);
            continue;
          }
          if (isVideoEntry(entry)) continue;
          const entryTagIds = normalizeTagIds(entry?.tag_ids);
          if (!entryTagIds.length) continue;
          const url = previewUrl(this.api, entry);
          for (const tagId of entryTagIds) {
            if (!this.requestedTagIds.has(tagId)) continue;
            const current = candidates.get(tagId) ?? [];
            if (!current.includes(url)) current.push(url);
            candidates.set(tagId, current);
          }
        }
      }
      const resolved = this.#resolvePreviewAssignments([...this.requestedTagIds], candidates);
      this.usedPreviewUrls.clear();
      const assigned = [];
      for (const tagId of this.requestedTagIds) {
        const nextUrl = resolved.get(tagId) ?? "";
        if (!nextUrl) continue;
        this.previews.set(tagId, nextUrl);
        this.usedPreviewUrls.add(nextUrl);
        assigned.push(tagId);
      }
      if (assigned.length) this.onUpdate?.(assigned);
      for (const tagId of this.requestedTagIds) {
        if (!this.previews.has(tagId)) this.exhausted.add(tagId);
      }
    } finally {
      if (generation === this.generation) {
        this.pendingPromise = null;
        const unresolved = [...this.requestedTagIds].some((tagId) => !this.previews.has(tagId) && !this.exhausted.has(tagId));
        if (unresolved) this.pendingPromise = this.#scan();
      }
    }
  }
}
