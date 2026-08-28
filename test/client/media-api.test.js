import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaApi, MediaApiError } from "../../app/src/services/media-api.js";

describe("MediaApi errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("MediaApi bulk media tags", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("calls scene endpoints with no-store semantics", async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ scenes: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ id: "scene-1", name: "Trip" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ id: "scene-1", shots: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ id: "scene-1", loop: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      vi.stubGlobal("fetch", fetch);
      const api = new MediaApi();
      const payload = {
        loop: true,
        default_duration_sec: 8,
        current_shot_id: null,
        shots: [],
      };

      await expect(api.scenes()).resolves.toEqual({ scenes: [] });
      await expect(api.createScene("Trip")).resolves.toEqual({ id: "scene-1", name: "Trip" });
      await expect(api.scene("scene-1")).resolves.toEqual({ id: "scene-1", shots: [] });
      await expect(api.saveScene("scene-1", payload)).resolves.toEqual({ id: "scene-1", loop: true });

      expect(fetch).toHaveBeenNthCalledWith(1, "/api/scenes", expect.objectContaining({ cache: "no-store" }));
      expect(fetch).toHaveBeenNthCalledWith(2, "/api/scenes", expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ name: "Trip" }),
      }));
      expect(fetch).toHaveBeenNthCalledWith(3, "/api/scenes/scene-1", expect.objectContaining({ cache: "no-store" }));
      expect(fetch).toHaveBeenNthCalledWith(4, "/api/scenes/scene-1", expect.objectContaining({
        method: "PUT",
        cache: "no-store",
        body: JSON.stringify(payload),
      }));
    });

    it("sends the exact bulk assignment payload", async () => {
      const fetch = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ assignments: [{ path: "a.jpg", tag_ids: ["blue"] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
      vi.stubGlobal("fetch", fetch);
      const assignments = [{ path: "a.jpg", tag_ids: ["blue"] }];

      await expect(new MediaApi().saveMediaTagsBulk(assignments)).resolves.toEqual({
        assignments,
      });
      expect(fetch).toHaveBeenCalledWith("/api/media-tags/bulk", expect.objectContaining({
        method: "PUT",
        cache: "no-store",
        body: JSON.stringify({ assignments }),
      }));
    });

    it("passes the configured resolution to auto mask and ADM generation", async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ status: "queued" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ))
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ status: "queued" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("window", { location: { origin: "https://souvenir.test" } });

      await new MediaApi().requestAutoMask("albums/photo.jpg", 256);
      await new MediaApi().requestAdm("albums/photo.jpg", 192);

      const [maskUrl, maskOptions] = fetch.mock.calls[0];
      expect(maskUrl).toBeInstanceOf(URL);
      expect(maskUrl.pathname).toBe("/api/mask/auto");
      expect(maskUrl.searchParams.get("path")).toBe("albums/photo.jpg");
      expect(maskUrl.searchParams.get("max_resolution")).toBe("256");
      expect(maskOptions).toEqual(expect.objectContaining({ method: "POST", cache: "no-store" }));

      const [admUrl, admOptions] = fetch.mock.calls[1];
      expect(admUrl).toBeInstanceOf(URL);
      expect(admUrl.pathname).toBe("/api/adm/auto");
      expect(admUrl.searchParams.get("path")).toBe("albums/photo.jpg");
      expect(admUrl.searchParams.get("max_resolution")).toBe("192");
      expect(admOptions).toEqual(expect.objectContaining({ method: "POST", cache: "no-store" }));
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

  it("surfaces plain-text errors after a failed JSON parse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("Gateway unavailable.", { status: 502 }),
    ));

    const request = new MediaApi().tags();
    await expect(request).rejects.toBeInstanceOf(MediaApiError);
    await expect(request).rejects.toMatchObject({
      message: "Gateway unavailable.",
      status: 502,
    });
  });
});
