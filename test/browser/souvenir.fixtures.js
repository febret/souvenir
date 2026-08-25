import { expect } from "@playwright/test";

function imageFixture(width, height, color) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`,
  );
}

const IMAGE_FIXTURES = Object.freeze({
  "albums/beach.jpg": imageFixture(1600, 900, "#4d9ccc"),
  "albums/forest.jpg": imageFixture(1200, 1600, "#39734c"),
});
const DEFAULT_IMAGE_FIXTURE = imageFixture(800, 600, "#888888");
const DEFAULT_LIBRARY_ID = "/g/media";
const MASK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8////fwYGBgYmEAHCAD34BABm6tHAAAAAAElFTkSuQmCC",
  "base64",
);
const DEPTH_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR4nGNsYGBiYAAAApIAhPd8o1gAAAAASUVORK5CYII=",
  "base64",
);

function wavFixture() {
  const dataLength = 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

const WAV_FIXTURE = wavFixture();

const DIRECTORY_PATHS = [
  "albums",
  "albums/trips",
  "albums/trips/2025",
  "albums/trips/2026",
  "albums/trips/2026/summer",
  "albums/favorites",
  "archive",
  "archive/scans",
];

const ALBUM_PATHS = DIRECTORY_PATHS.filter(
  (path) => path === "albums" || path.startsWith("albums/"),
);

const directoryTree = {
  name: "media",
  path: "",
  kind: "directory",
  children: [
    {
      name: "albums",
      path: "albums",
      kind: "directory",
      children: [
        {
          name: "trips",
          path: "albums/trips",
          kind: "directory",
          children: [
            {
              name: "2025",
              path: "albums/trips/2025",
              kind: "directory",
              children: [],
            },
            {
              name: "2026",
              path: "albums/trips/2026",
              kind: "directory",
              children: [
                {
                  name: "summer",
                  path: "albums/trips/2026/summer",
                  kind: "directory",
                  children: [],
                },
              ],
            },
          ],
        },
        {
          name: "favorites",
          path: "albums/favorites",
          kind: "directory",
          children: [],
        },
      ],
    },
    {
      name: "archive",
      path: "archive",
      kind: "directory",
      children: [
        {
          name: "scans",
          path: "archive/scans",
          kind: "directory",
          children: [],
        },
      ],
    },
  ],
};

const entries = {
  "": [
    {
      name: "albums",
      path: "albums",
      kind: "directory",
      media_type: null,
      size: null,
      mtime: "2026-01-01T00:00:00Z",
    },
    {
      name: "root.jpg",
      path: "root.jpg",
      kind: "file",
      media_type: "image/jpeg",
      size: 70,
      mtime: "2026-01-02T00:00:00Z",
      tag_ids: ["horse"],
      url: "/api/file?path=root.jpg",
      thumbnail_url: "/api/thumbnail?path=root.jpg",
    },
  ],
  albums: [
    {
      name: "favorites",
      path: "albums/favorites",
      kind: "directory",
      media_type: null,
      size: null,
      mtime: "2026-01-01T00:00:00Z",
    },
    {
      name: "trips",
      path: "albums/trips",
      kind: "directory",
      media_type: null,
      size: null,
      mtime: "2026-01-01T00:00:00Z",
    },
    {
      name: "beach.jpg",
      path: "albums/beach.jpg",
      kind: "file",
      media_type: "image/jpeg",
      size: 80,
      mtime: "2026-02-01T00:00:00Z",
      tag_ids: ["horse", "blue"],
      url: "/api/file?path=albums%2Fbeach.jpg",
      thumbnail_url: "/api/thumbnail?path=albums%2Fbeach.jpg",
    },
    {
      name: "forest.jpg",
      path: "albums/forest.jpg",
      kind: "file",
      media_type: "image/jpeg",
      size: 60,
      mtime: "2026-03-01T00:00:00Z",
      tag_ids: ["horse"],
      url: "/api/file?path=albums%2Fforest.jpg",
      thumbnail_url: "/api/thumbnail?path=albums%2Fforest.jpg",
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      name: `photo-${index + 1}.jpg`,
      path: `albums/photo-${index + 1}.jpg`,
      kind: "file",
      media_type: "image/jpeg",
      size: 90 + index,
      mtime: `2026-03-${String(index + 2).padStart(2, "0")}T00:00:00Z`,
      url: `/api/file?path=albums%2Fphoto-${index + 1}.jpg`,
      thumbnail_url: `/api/thumbnail?path=albums%2Fphoto-${index + 1}.jpg`,
    })),
  ],
  "albums/favorites": [{
    name: "portrait.jpg",
    path: "albums/favorites/portrait.jpg",
    kind: "file",
    media_type: "image/jpeg",
    size: 75,
    mtime: "2026-04-01T00:00:00Z",
    url: "/api/file?path=albums%2Ffavorites%2Fportrait.jpg",
    thumbnail_url: "/api/thumbnail?path=albums%2Ffavorites%2Fportrait.jpg",
  }],
  "albums/trips": [
    {
      name: "2026",
      path: "albums/trips/2026",
      kind: "directory",
      media_type: null,
      size: null,
      mtime: "2026-01-01T00:00:00Z",
    },
    {
      name: "road.jpg",
      path: "albums/trips/road.jpg",
      kind: "file",
      media_type: "image/jpeg",
      size: 82,
      mtime: "2026-04-02T00:00:00Z",
      url: "/api/file?path=albums%2Ftrips%2Froad.jpg",
      thumbnail_url: "/api/thumbnail?path=albums%2Ftrips%2Froad.jpg",
    },
  ],
  "albums/trips/2026": [{
    name: "summer",
    path: "albums/trips/2026/summer",
    kind: "directory",
    media_type: null,
    size: null,
    mtime: "2026-01-01T00:00:00Z",
  }],
};

async function mockServer(
  page,
  {
    libraryStatuses = [
      {
        status: "ready",
        scanned_files: 12,
        media_files: 11,
        directories: DIRECTORY_PATHS.length,
        current_path: "",
        message: "",
        started_at: "2026-03-01T00:00:00Z",
        completed_at: "2026-03-01T00:00:01Z",
      },
    ],
    imageDelays = {},
    libraryId = DEFAULT_LIBRARY_ID,
    maskServer = { masks: new Map(), requests: [] },
    autoMaskServer = { jobs: new Map(), requests: [], autoComplete: true, device: "cuda" },
    depthServer = { maps: new Map(), requests: [] },
    autoDepthServer = { jobs: new Map(), requests: [], autoComplete: true, device: "cuda" },
    admServer = { settings: new Map(), requests: [] },
    tagServer = { tags: [], assignments: new Map(), requests: [], nextId: 1 },
    sceneServer = { scenes: new Map(), requests: [], nextId: 1 },
    commentaryServer = {
      available: false,
      entries: [],
      assignments: new Map(),
      captions: new Map(),
      volumes: new Map(),
      requests: [],
      failuresRemaining: 0,
    },
    commentaryResponse = null,
    beforeSaveMediaTags = null,
    directoryResponse = null,
    extraEntries = {},
    mediaEntries = entries,
    tree = directoryTree,
    videoFixtures = {},
  } = {},
) {
  let statusIndex = 0;
  sceneServer.scenes ??= new Map();
  sceneServer.requests ??= [];
  sceneServer.nextId ??= 1;
  commentaryServer.captions ??= new Map();
  commentaryServer.volumes ??= new Map();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/library-status") {
      const status = {
        ...libraryStatuses[Math.min(statusIndex, libraryStatuses.length - 1)],
        library_id: libraryId,
      };
      statusIndex += 1;
      return route.fulfill({ json: status });
    }
    if (url.pathname === "/api/health") {
      return route.fulfill({ json: { status: "ok", library_id: libraryId } });
    }
    if (url.pathname === "/api/scenes") {
      const method = route.request().method();
      sceneServer.requests.push({ method, path: url.pathname });
      if (method === "GET") {
        return route.fulfill({
          json: {
            scenes: [...sceneServer.scenes.values()].map((scene) => ({
              id: scene.id,
              name: scene.name,
              loop: scene.loop,
              default_duration_sec: scene.default_duration_sec,
              shot_count: scene.shots.length,
              updated_at: scene.updated_at,
            })),
          },
        });
      }
      if (method === "POST") {
        const body = route.request().postDataJSON() ?? {};
        const scene = {
          id: `scene-${sceneServer.nextId++}`,
          name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New scene",
          loop: true,
          default_duration_sec: 8,
          current_shot_id: null,
          shots: [],
          updated_at: "2026-03-01T00:00:00Z",
        };
        sceneServer.scenes.set(scene.id, scene);
        return route.fulfill({ status: 201, json: scene });
      }
    }
    if (url.pathname.startsWith("/api/scenes/")) {
      const method = route.request().method();
      const sceneId = decodeURIComponent(url.pathname.slice("/api/scenes/".length));
      sceneServer.requests.push({ method, path: url.pathname });
      if (method === "GET" || method === "PUT") {
        const scene = sceneServer.scenes.get(sceneId);
        if (!scene) return route.fulfill({ status: 404, json: { detail: "Scene not found." } });
        if (method === "PUT") {
          const body = route.request().postDataJSON() ?? {};
          const saved = {
            ...scene,
            ...body,
            id: scene.id,
            name: scene.name,
            updated_at: "2026-03-01T00:00:01Z",
          };
          sceneServer.scenes.set(sceneId, saved);
          return route.fulfill({ json: saved });
        }
        return route.fulfill({ json: scene });
      }
    }
    if (url.pathname === "/api/tree") {
      return route.fulfill({
        json: tree,
      });
    }
    if (url.pathname === "/api/media") {
      const path = url.searchParams.get("path") ?? "";
      const withTags = (entry) => ({
        ...entry,
        tag_ids: [...(tagServer.assignments.get(entry.path) ?? entry.tag_ids ?? [])],
        adm: admServer.settings.get(entry.path) ?? entry.adm ?? {
          configured: false,
          enabled: false,
          depth_intensity: 0.35,
        },
      });
      const listedEntries = [...(mediaEntries[path] ?? []), ...(extraEntries[path] ?? [])]
        .map(withTags);
      const resolvedEntries = directoryResponse
        ? await directoryResponse({ path, entries: listedEntries })
        : listedEntries;
      return route.fulfill({
        json: {
          path,
          entries: resolvedEntries,
          directories: [],
          files: [],
        },
      });
    }
    if (url.pathname === "/api/commentary") {
      if (commentaryServer.failuresRemaining > 0) {
        commentaryServer.failuresRemaining -= 1;
        return route.fulfill({ status: 503, json: { detail: "Commentary temporarily unavailable." } });
      }
      const entries = commentaryServer.entries.map((entry) => ({
        ...entry,
        tag_ids: [...(commentaryServer.assignments.get(entry.path) ?? entry.tag_ids ?? [])],
        caption: commentaryServer.captions.get(entry.path) ?? entry.caption ?? "",
        volume: commentaryServer.volumes.get(entry.path) ?? entry.volume ?? 1,
      }));
      const response = commentaryResponse
        ? await commentaryResponse({ available: commentaryServer.available, entries })
        : { available: commentaryServer.available, entries };
      if (response?.status) {
        return route.fulfill({ status: response.status, json: response.json ?? {} });
      }
      return route.fulfill({ json: response });
    }
    if (url.pathname === "/api/commentary/file") {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: WAV_FIXTURE });
    }
    if (url.pathname === "/api/commentary-tags") {
      const path = url.searchParams.get("path") ?? "";
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: { path, tag_ids: commentaryServer.assignments.get(path) ?? [] },
        });
      }
      if (route.request().method() === "PUT") {
        const tagIds = route.request().postDataJSON()?.tag_ids ?? [];
        const known = new Set(tagServer.tags.map((tag) => tag.id));
        const saved = [...new Set(tagIds.map(String))].filter((tagId) => known.has(tagId));
        commentaryServer.assignments.set(path, saved);
        commentaryServer.requests.push({ method: "PUT", path, tagIds: saved });
        return route.fulfill({ json: { path, tag_ids: saved } });
      }
    }
    if (url.pathname === "/api/commentary-caption") {
      const path = url.searchParams.get("path") ?? "";
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: { path, caption: commentaryServer.captions.get(path) ?? "" },
        });
      }
      if (route.request().method() === "PUT") {
        const caption = String(route.request().postDataJSON()?.caption ?? "").trim();
        if (caption) commentaryServer.captions.set(path, caption);
        else commentaryServer.captions.delete(path);
        commentaryServer.requests.push({ method: "PUT", path, caption });
        return route.fulfill({ json: { path, caption } });
      }
    }
    if (url.pathname === "/api/commentary-volume") {
      const path = url.searchParams.get("path") ?? "";
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: { path, volume: commentaryServer.volumes.get(path) ?? 1 },
        });
      }
      if (route.request().method() === "PUT") {
        const volume = Number(route.request().postDataJSON()?.volume);
        if (volume === 1) commentaryServer.volumes.delete(path);
        else commentaryServer.volumes.set(path, volume);
        commentaryServer.requests.push({ method: "PUT", path, volume });
        return route.fulfill({ json: { path, volume } });
      }
    }
    if (url.pathname === "/api/tags") {
      const method = route.request().method();
      if (method === "GET") return route.fulfill({ json: { tags: tagServer.tags } });
      if (method === "POST") {
        const { name } = route.request().postDataJSON();
        const normalized = String(name ?? "").trim();
        if (tagServer.tags.some((tag) => tag.name.toLowerCase() === normalized.toLowerCase())) {
          return route.fulfill({ status: 409, json: { detail: "A tag with that name already exists." } });
        }
        const tag = { id: `tag-${tagServer.nextId++}`, name: normalized };
        tagServer.tags.push(tag);
        tagServer.requests.push({ method, tag });
        return route.fulfill({ status: 201, json: tag });
      }
    }
    if (url.pathname.startsWith("/api/tags/")) {
      const method = route.request().method();
      const id = decodeURIComponent(url.pathname.slice("/api/tags/".length));
      const index = tagServer.tags.findIndex((tag) => tag.id === id);
      if (index < 0) return route.fulfill({ status: 404, json: { detail: "Tag not found." } });
      if (method === "PATCH") {
        const { name } = route.request().postDataJSON();
        const normalized = String(name ?? "").trim();
        if (tagServer.tags.some((tag) => tag.id !== id && tag.name.toLowerCase() === normalized.toLowerCase())) {
          return route.fulfill({ status: 409, json: { detail: "A tag with that name already exists." } });
        }
        tagServer.tags[index] = { ...tagServer.tags[index], name: normalized };
        tagServer.requests.push({ method, id, name: normalized });
        return route.fulfill({ json: tagServer.tags[index] });
      }
      if (method === "DELETE") {
        tagServer.tags.splice(index, 1);
        for (const [path, tagIds] of tagServer.assignments) {
          tagServer.assignments.set(path, tagIds.filter((tagId) => tagId !== id));
        }
        for (const [path, tagIds] of commentaryServer.assignments) {
          commentaryServer.assignments.set(path, tagIds.filter((tagId) => tagId !== id));
        }
        tagServer.requests.push({ method, id });
        return route.fulfill({ status: 204, body: "" });
      }
    }
    if (url.pathname === "/api/media-tags") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({ json: { path, tag_ids: tagServer.assignments.get(path) ?? [] } });
      }
      if (method === "PUT") {
        const body = route.request().postDataJSON();
        const tagIds = body.tag_ids ?? body.tagIds ?? [];
        const tagIdsSet = new Set(tagServer.tags.map((tag) => tag.id));
        const saved = [...new Set(tagIds.map(String))].filter((tagId) => tagIdsSet.has(tagId));
        tagServer.requests.push({ method, path, tagIds: saved });
        await beforeSaveMediaTags?.({ path, tagIds: saved });
        tagServer.assignments.set(path, saved);
        return route.fulfill({ json: { path, tag_ids: saved } });
      }
    }
    if (url.pathname === "/api/media-tags/bulk") {
      const body = route.request().postDataJSON();
      const assignments = body.assignments ?? [];
      const tagIdsSet = new Set(tagServer.tags.map((tag) => tag.id));
      const saved = assignments.map((assignment) => ({
        path: assignment.path,
        tag_ids: [...new Set((assignment.tag_ids ?? []).map(String))]
          .filter((tagId) => tagIdsSet.has(tagId)),
      }));
      for (const assignment of saved) {
        tagServer.assignments.set(assignment.path, assignment.tag_ids);
        tagServer.requests.push({
          method: "PUT_BULK",
          path: assignment.path,
          tagIds: assignment.tag_ids,
        });
      }
      return route.fulfill({ json: { assignments: saved } });
    }
    if (url.pathname === "/api/media-adm") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      if (method === "GET") {
        const setting = admServer.settings.get(path) ?? {
          configured: false,
          enabled: false,
          depth_intensity: 0.35,
        };
        return route.fulfill({ json: { path, ...setting } });
      }
      if (method === "PUT") {
        const body = route.request().postDataJSON() ?? {};
        const setting = {
          configured: true,
          enabled: Boolean(body.enabled),
          depth_intensity: Number.isFinite(body.depth_intensity) ? body.depth_intensity : 0.35,
        };
        admServer.settings.set(path, setting);
        admServer.requests.push({ method, path, setting });
        return route.fulfill({ json: { path, ...setting } });
      }
    }
    if (url.pathname === "/api/thumbnail" || url.pathname === "/api/file") {
      const path = url.searchParams.get("path") ?? "";
      const delay = imageDelays[path] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const video = videoFixtures[path];
      if (video) {
        return route.fulfill({
          status: 200,
          contentType: "video/webm",
          body: video,
        });
      }
      const image = IMAGE_FIXTURES[path] ?? DEFAULT_IMAGE_FIXTURE;
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: image,
      });
    }
    if (url.pathname === "/api/mask-info") {
      const path = url.searchParams.get("path") ?? "";
      const mask = maskServer.masks.get(path);
      return route.fulfill({
        json: {
          exists: Boolean(mask),
          path,
          blur: mask?.blur ?? 0,
          updated_at: mask?.updatedAt ?? null,
          url: mask ? `/api/mask?path=${encodeURIComponent(path)}` : null,
        },
      });
    }
    if (url.pathname === "/api/mask") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      if (method === "GET") {
        const mask = maskServer.masks.get(path);
        if (!mask) return route.fulfill({ status: 404 });
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: mask.png,
        });
      }
      if (method === "PUT") {
        const blur = Number(url.searchParams.get("blur") ?? 0);
        const png = route.request().postDataBuffer() ?? MASK_PNG;
        const mask = {
          png,
          blur,
          updatedAt: "2026-08-23T00:00:00Z",
        };
        maskServer.masks.set(path, mask);
        maskServer.requests.push({ method, path, blur, png });
        return route.fulfill({
          json: {
            exists: true,
            path,
            blur,
            updated_at: mask.updatedAt,
            url: `/api/mask?path=${encodeURIComponent(path)}`,
          },
        });
      }
      if (method === "DELETE") {
        maskServer.masks.delete(path);
        maskServer.requests.push({ method, path });
        return route.fulfill({
          json: { exists: false, path, blur: 0, updated_at: null, url: null },
        });
      }
    }
    if (url.pathname === "/api/mask/auto") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      const now = "2026-08-24T00:00:00Z";
      const current = autoMaskServer.jobs.get(path);
      const toResponse = (state) => ({
        path,
        status: state?.status ?? "idle",
        requested_at: state?.requested_at ?? null,
        started_at: state?.started_at ?? null,
        completed_at: state?.completed_at ?? null,
        updated_at: state?.updated_at ?? null,
        error: state?.error ?? null,
        device: state?.device ?? null,
        mask: {
          exists: Boolean(maskServer.masks.get(path)),
          path,
          blur: maskServer.masks.get(path)?.blur ?? 0,
          updated_at: maskServer.masks.get(path)?.updatedAt ?? null,
          url: maskServer.masks.get(path) ? `/api/mask?path=${encodeURIComponent(path)}` : null,
        },
      });
      if (method === "POST") {
        const job = current?.status === "queued" || current?.status === "running"
          ? current
          : {
            status: "queued",
            requested_at: now,
            started_at: null,
            completed_at: null,
            updated_at: now,
            error: null,
            device: null,
            polls: 0,
          };
        autoMaskServer.jobs.set(path, job);
        autoMaskServer.requests.push({ method, path });
        return route.fulfill({ json: toResponse(job) });
      }
      if (method === "GET") {
        if (current && autoMaskServer.autoComplete && (current.status === "queued" || current.status === "running")) {
          current.polls = (current.polls ?? 0) + 1;
          if (current.polls === 1) {
            current.status = "running";
            current.started_at = now;
            current.updated_at = now;
            current.device = autoMaskServer.device ?? "cuda";
          } else {
            current.status = "completed";
            current.completed_at = now;
            current.updated_at = now;
            current.device = autoMaskServer.device ?? "cuda";
            maskServer.masks.set(path, {
              png: maskServer.masks.get(path)?.png ?? MASK_PNG,
              blur: 0,
              updatedAt: now,
            });
          }
        }
        return route.fulfill({ json: toResponse(autoMaskServer.jobs.get(path)) });
      }
      if (method === "DELETE") {
        if (current && (current.status === "queued" || current.status === "running")) {
          current.status = "cancelled";
          current.completed_at = now;
          current.updated_at = now;
        }
        autoMaskServer.requests.push({ method, path });
        return route.fulfill({ json: toResponse(autoMaskServer.jobs.get(path)) });
      }
    }
    if (url.pathname === "/api/depth-info") {
      const path = url.searchParams.get("path") ?? "";
      const depth = depthServer.maps.get(path);
      return route.fulfill({
        json: {
          exists: Boolean(depth),
          path,
          updated_at: depth?.updatedAt ?? null,
          url: depth ? `/api/depth?path=${encodeURIComponent(path)}` : null,
        },
      });
    }
    if (url.pathname === "/api/depth") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      if (method === "GET") {
        const depth = depthServer.maps.get(path);
        if (!depth) return route.fulfill({ status: 404 });
        return route.fulfill({ status: 200, contentType: "image/png", body: depth.png });
      }
      if (method === "PUT") {
        const png = route.request().postDataBuffer() ?? DEPTH_PNG;
        const depth = { png, updatedAt: "2026-08-24T00:00:00Z" };
        depthServer.maps.set(path, depth);
        depthServer.requests.push({ method, path, png });
        return route.fulfill({
          json: {
            exists: true,
            path,
            updated_at: depth.updatedAt,
            url: `/api/depth?path=${encodeURIComponent(path)}`,
          },
        });
      }
      if (method === "DELETE") {
        depthServer.maps.delete(path);
        depthServer.requests.push({ method, path });
        return route.fulfill({ json: { exists: false, path, updated_at: null, url: null } });
      }
    }
    if (url.pathname === "/api/depth/auto") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      const now = "2026-08-24T00:00:00Z";
      const current = autoDepthServer.jobs.get(path);
      const toResponse = (state) => ({
        path,
        status: state?.status ?? "idle",
        requested_at: state?.requested_at ?? null,
        started_at: state?.started_at ?? null,
        completed_at: state?.completed_at ?? null,
        updated_at: state?.updated_at ?? null,
        error: state?.error ?? null,
        device: state?.device ?? null,
        depth: {
          exists: Boolean(depthServer.maps.get(path)),
          path,
          updated_at: depthServer.maps.get(path)?.updatedAt ?? null,
          url: depthServer.maps.get(path) ? `/api/depth?path=${encodeURIComponent(path)}` : null,
        },
      });
      if (method === "POST") {
        const job = current?.status === "queued" || current?.status === "running"
          ? current
          : {
            status: "queued",
            requested_at: now,
            started_at: null,
            completed_at: null,
            updated_at: now,
            error: null,
            device: null,
            polls: 0,
          };
        autoDepthServer.jobs.set(path, job);
        autoDepthServer.requests.push({ method, path });
        return route.fulfill({ json: toResponse(job) });
      }
      if (method === "GET") {
        if (current && autoDepthServer.autoComplete && (current.status === "queued" || current.status === "running")) {
          current.polls = (current.polls ?? 0) + 1;
          if (current.polls === 1) {
            current.status = "running";
            current.started_at = now;
            current.updated_at = now;
            current.device = autoDepthServer.device ?? "cuda";
          } else {
            current.status = "completed";
            current.completed_at = now;
            current.updated_at = now;
            current.device = autoDepthServer.device ?? "cuda";
            depthServer.maps.set(path, {
              png: depthServer.maps.get(path)?.png ?? DEPTH_PNG,
              updatedAt: now,
            });
          }
        }
        return route.fulfill({ json: toResponse(autoDepthServer.jobs.get(path)) });
      }
      if (method === "DELETE") {
        if (current && (current.status === "queued" || current.status === "running")) {
          current.status = "cancelled";
          current.completed_at = now;
          current.updated_at = now;
        }
        autoDepthServer.requests.push({ method, path });
        return route.fulfill({ json: toResponse(autoDepthServer.jobs.get(path)) });
      }
    }
    if (url.pathname === "/api/adm/auto") {
      const path = url.searchParams.get("path") ?? "";
      const method = route.request().method();
      if (method === "POST") {
        if (!maskServer.masks.has(path)) {
          autoMaskServer.jobs.set(path, {
            status: "queued",
            requested_at: "2026-08-24T00:00:00Z",
            started_at: null,
            completed_at: null,
            updated_at: "2026-08-24T00:00:00Z",
            error: null,
            device: null,
            polls: 0,
          });
        }
        if (!depthServer.maps.has(path)) {
          autoDepthServer.jobs.set(path, {
            status: "queued",
            requested_at: "2026-08-24T00:00:00Z",
            started_at: null,
            completed_at: null,
            updated_at: "2026-08-24T00:00:00Z",
            error: null,
            device: null,
            polls: 0,
          });
        }
      }
      if (method === "DELETE") {
        const mask = autoMaskServer.jobs.get(path);
        const depth = autoDepthServer.jobs.get(path);
        if (mask) mask.status = "cancelled";
        if (depth) depth.status = "cancelled";
      }
      if (method === "GET") {
        const mask = autoMaskServer.jobs.get(path);
        if (mask && autoMaskServer.autoComplete && (mask.status === "queued" || mask.status === "running")) {
          mask.polls = (mask.polls ?? 0) + 1;
          if (mask.polls === 1) {
            mask.status = "running";
          } else {
            mask.status = "completed";
            maskServer.masks.set(path, {
              png: maskServer.masks.get(path)?.png ?? MASK_PNG,
              blur: 0,
              updatedAt: "2026-08-24T00:00:00Z",
            });
          }
        }
        const depth = autoDepthServer.jobs.get(path);
        if (depth && autoDepthServer.autoComplete && (depth.status === "queued" || depth.status === "running")) {
          depth.polls = (depth.polls ?? 0) + 1;
          if (depth.polls === 1) {
            depth.status = "running";
          } else {
            depth.status = "completed";
            depthServer.maps.set(path, {
              png: depthServer.maps.get(path)?.png ?? DEPTH_PNG,
              updatedAt: "2026-08-24T00:00:00Z",
            });
          }
        }
      }
      const maskStatus = autoMaskServer.jobs.get(path)?.status ?? (maskServer.masks.has(path) ? "completed" : "idle");
      const depthStatus = autoDepthServer.jobs.get(path)?.status ?? (depthServer.maps.has(path) ? "completed" : "idle");
      const status = [maskStatus, depthStatus].includes("running")
        ? "running"
        : [maskStatus, depthStatus].includes("queued")
          ? "queued"
          : [maskStatus, depthStatus].includes("failed")
            ? "failed"
            : [maskStatus, depthStatus].includes("cancelled")
              ? "cancelled"
              : (maskServer.masks.has(path) && depthServer.maps.has(path) ? "completed" : "idle");
      return route.fulfill({
        json: {
          path,
          status,
          mask: {
            path,
            status: maskStatus,
            mask: {
              exists: Boolean(maskServer.masks.get(path)),
            },
          },
          depth: {
            path,
            status: depthStatus,
            depth: {
              exists: Boolean(depthServer.maps.get(path)),
            },
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { detail: "Not found" } });
  });
  return { maskServer, depthServer, tagServer, admServer };
}

function directoryRow(page, path) {
  return page.locator(`.directory-row[data-path="${path}"]`);
}

function directoryCheckbox(page, path) {
  return directoryRow(page, path).getByRole("checkbox");
}

function disclosureButton(page, action, name) {
  return page.getByRole("button", { name: `${action} ${name}`, exact: true });
}

async function expectVisibleDirectoryPaths(page, paths) {
  await expect
    .poll(() =>
      page.locator("#directory-tree .directory-row:visible").evaluateAll((rows) =>
        rows.map((row) => row.dataset.path),
      ),
    )
    .toEqual(paths);
}

async function expandDirectory(page, name) {
  const disclosure = disclosureButton(page, "Expand", name);
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(disclosureButton(page, "Collapse", name)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
}

async function expandAllDirectories(page) {
  await expandDirectory(page, "albums");
  await expandDirectory(page, "trips");
  await expandDirectory(page, "2026");
  await expandDirectory(page, "archive");
}

async function clickSceneObject(page, matcher, localPoint = null) {
  let point = null;
  await expect
    .poll(async () => {
      point = await sceneObjectScreenPoint(page, matcher, localPoint);
      return Boolean(point);
    }, { message: `Expected scene object ${JSON.stringify(matcher)}` })
    .toBe(true);
  await page.mouse.click(point.x, point.y);
}

async function doubleTapSceneObject(page, matcher, localPoint = null) {
  const point = await sceneObjectScreenPoint(page, matcher, localPoint);
  expect(point, `Expected scene object ${JSON.stringify(matcher)}`).not.toBeNull();
  await page.mouse.dblclick(point.x, point.y, { delay: 0 });
}

async function sceneObjectScreenPoint(page, matcher, localPoint = null) {
  return page.evaluate(
    ({ matcher, localPoint }) => {
      const app = window.__souvenirApp;
      let target = null;
      app.scene.traverse((object) => {
        if (target) return;
        const data = object.userData;
        if (
          Object.entries(matcher).every(([key, value]) => {
            if (key === "entryPath") return data.entry?.path === value;
            return data[key] === value;
          })
        ) {
          target = object;
        }
      });
      if (!target) return null;
      app.scene.updateMatrixWorld(true);
      const vector = target.position.clone();
      if (localPoint) {
        vector.set(localPoint.x ?? 0, localPoint.y ?? 0, localPoint.z ?? 0);
        target.localToWorld(vector);
      } else {
        target.getWorldPosition(vector);
      }
      vector.project(app.camera);
      const rect = app.canvas.getBoundingClientRect();
      return {
        x: rect.left + ((vector.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - vector.y) / 2) * rect.height,
      };
    },
    { matcher, localPoint },
  );
}

async function dragSceneObject(page, matcher, localPoint) {
  const point = await sceneObjectScreenPoint(page, matcher, localPoint);
  expect(point, `Expected scene object ${JSON.stringify(matcher)}`).not.toBeNull();
  const canvasRect = await page.locator("canvas").boundingBox();
  expect(canvasRect, "Expected the spatial canvas to be visible").not.toBeNull();
  const horizontalDelta =
    point.x + 96 < canvasRect.x + canvasRect.width - 12 ? 96 : -96;
  const verticalDelta =
    point.y - 64 > canvasRect.y + 12 ? -64 : 64;
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + horizontalDelta, point.y + verticalDelta, {
    steps: 8,
  });
  await page.mouse.up();
}

async function paintAcrossPanelSurface(page, panelId) {
  const start = await sceneObjectScreenPoint(
    page,
    { kind: "panel-surface", panelId },
    { x: -0.3, y: 0, z: 0 },
  );
  const end = await sceneObjectScreenPoint(
    page,
    { kind: "panel-surface", panelId },
    { x: 0.3, y: 0, z: 0 },
  );
  expect(start, "Expected the panel surface drawing start point").not.toBeNull();
  expect(end, "Expected the panel surface drawing end point").not.toBeNull();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function selectBeachImage(page, panelId) {
  await clickSceneObject(page, { action: "browse", panelId });
  await expect.poll(() => page.evaluate(() => window.__souvenirApp.browser?.visible)).toBe(true);
  await clickSceneObject(page, {
    kind: "browser-entry",
    entryPath: "albums/beach.jpg",
  });
  if (await page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
  panelId) !== "albums/beach.jpg") {
    await clickSceneObject(page, {
      kind: "browser-entry",
      entryPath: "albums/beach.jpg",
    });
  }
  if (await page.evaluate((id) =>
    window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
  panelId) !== "albums/beach.jpg") {
    await page.evaluate(async () => {
      const entry = window.__souvenirApp.browser.entries.find(
        (item) => item.path === "albums/beach.jpg",
      );
      if (!entry) throw new Error("The beach media entry is unavailable.");
      await window.__souvenirApp.browser.activateEntry(entry);
    });
  }
  await expect.poll(() =>
    page.evaluate((id) =>
      window.__souvenirApp.store.getState().panels.find((panel) => panel.id === id)?.media.selectedId,
    panelId),
  ).toBe("albums/beach.jpg");
}

async function createTinyWebm(page) {
  const bytes = await page.evaluate(async () => {
    if (!globalThis.MediaRecorder) return null;
    const mimeType = ["video/webm;codecs=vp8", "video/webm"]
      .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext("2d").fillStyle = "#7cd7a1";
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    if (!canvas.captureStream) return null;
    const stream = canvas.captureStream(10);
    const chunks = [];
    const blob = await new Promise((resolve, reject) => {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 100_000 });
      recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
      recorder.addEventListener("error", () => reject(new Error("MediaRecorder failed.")), { once: true });
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: mimeType })), { once: true });
      recorder.start();
      setTimeout(() => recorder.stop(), 200);
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  expect(bytes, "Chromium must support a generated WebM fixture").not.toBeNull();
  return Buffer.from(bytes);
}

async function createMaskPng(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 2, 2);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}


export {
  imageFixture,
  IMAGE_FIXTURES,
  DEFAULT_IMAGE_FIXTURE,
  DEFAULT_LIBRARY_ID,
  MASK_PNG,
  DEPTH_PNG,
  wavFixture,
  WAV_FIXTURE,
  DIRECTORY_PATHS,
  ALBUM_PATHS,
  directoryTree,
  entries,
  mockServer,
  directoryRow,
  directoryCheckbox,
  disclosureButton,
  expectVisibleDirectoryPaths,
  expandDirectory,
  expandAllDirectories,
  clickSceneObject,
  doubleTapSceneObject,
  sceneObjectScreenPoint,
  dragSceneObject,
  paintAcrossPanelSurface,
  selectBeachImage,
  createTinyWebm,
  createMaskPng,
};
