import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaApi } from "../../app/src/services/media-api.js";

describe("MediaApi errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads selected images through multipart form data", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [{ path: "uploads/new.jpg" }] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const file = new File([new Uint8Array([1, 2, 3])], "new.jpg", { type: "image/jpeg" });

    await expect(new MediaApi().uploadImages([file])).resolves.toEqual({
      entries: [{ path: "uploads/new.jpg" }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/uploads");
    expect(options).toEqual(expect.objectContaining({ method: "POST", cache: "no-store" }));
    expect(options.body).toBeInstanceOf(FormData);
  });

  it("includes auto-generation query params when options set", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [{ path: "uploads/new.jpg" }], auto: { depth: [], mask: [] } }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const file = new File([new Uint8Array([1, 2, 3])], "new.jpg", { type: "image/jpeg" });

    await new MediaApi().uploadImages([file], { autoDepth: true, autoMask: true, maxResolution: 1024 });

    const [url] = fetch.mock.calls[0];
    const query = new URL(url, "http://localhost").searchParams;
    expect(query.get("auto_depth")).toBe("1");
    expect(query.get("auto_mask")).toBe("1");
    expect(query.get("max_resolution")).toBe("1024");
  });

  it("omits query params when auto-generation options are off", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [], auto: { depth: [], mask: [] } }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);

    const file = new File([new Uint8Array([1, 2, 3])], "new.jpg", { type: "image/jpeg" });
    await new MediaApi().uploadImages([file], { autoDepth: false, autoMask: false });

    const [url] = fetch.mock.calls[0];
    expect(url).toBe("/api/uploads");
  });

  it("surfaces JSON API details without losing the response status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "Tags are unavailable." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    await expect(new MediaApi().tags()).rejects.toEqual(
      expect.objectContaining({
        name: "MediaApiError",
        message: "Tags are unavailable.",
        status: 503,
      }),
    );
  });

  it("sends a DELETE request with a path query parameter", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ path: "albums/photo.jpg", trashed: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });

    const result = await new MediaApi().deleteMedia("albums/photo.jpg");

    expect(result).toEqual({ path: "albums/photo.jpg", trashed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.toString()).toBe("http://localhost/api/media?path=albums%2Fphoto.jpg");
    expect(options).toEqual(expect.objectContaining({ method: "DELETE", cache: "no-store" }));
  });
});

describe("MediaApi paging and posters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes sort/limit/offset through to directory listings", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [], total: 0, limit: 2, offset: 4, has_more: false }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });

    await new MediaApi().directory("albums", [], { sort: "mtime", limit: 2, offset: 4 });

    const [url] = fetch.mock.calls[0];
    const query = new URL(url.toString()).searchParams;
    expect(query.get("path")).toBe("albums");
    expect(query.get("sort")).toBe("mtime");
    expect(query.get("limit")).toBe("2");
    expect(query.get("offset")).toBe("4");
  });

  it("appends poster_time to thumbnail URLs only when finite", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    const api = new MediaApi();
    expect(new URL(api.thumbnailUrl("a/b.mp4", { posterTime: 5 })).searchParams.get("poster_time")).toBe("5");
    expect(new URL(api.thumbnailUrl("a/b.mp4")).searchParams.get("poster_time")).toBeNull();
  });

  it("uploadMedia accepts videos and uploadImages stays compatible", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ entries: [{ path: "uploads/clip.mp4" }] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("fetch", fetch);
    const file = new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" });

    await expect(new MediaApi().uploadMedia([file])).resolves.toEqual({
      entries: [{ path: "uploads/clip.mp4" }],
    });
    await expect(new MediaApi().uploadImages([file])).resolves.toEqual({
      entries: [{ path: "uploads/clip.mp4" }],
    });
    await expect(new MediaApi().uploadMedia([])).rejects.toMatchObject({ name: "MediaApiError" });
  });
});

describe("MediaApi commentary TTS helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a TTS request and uploads trimmed audio with tags", async () => {
    const ttsFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "ab".repeat(16), status: "queued" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", ttsFetch);

    await new MediaApi().requestTts("Hello.", "en-US-Ava", 5, -15);

    const [url, options] = ttsFetch.mock.calls[0];
    expect(url).toBe("/api/commentary/tts");
    expect(JSON.parse(options.body)).toEqual({ text: "Hello.", voice: "en-US-Ava", pitch: 5, rate: -15 });

    const created = { name: "commentary-clip.wav", tag_ids: [7] };
    const saveFetch = vi.fn(async () => new Response(
      JSON.stringify(created),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", saveFetch);
    const file = new File([new Uint8Array([1, 2, 3])], "commentary.mp3", { type: "audio/mpeg" });

    await expect(new MediaApi().saveCommentaryAudio(file, [7])).resolves.toEqual(created);
    const [, saveOptions] = saveFetch.mock.calls[0];
    expect(saveOptions.body.get("tags")).toBe("[7]");
  });
});
