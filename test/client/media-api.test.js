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
