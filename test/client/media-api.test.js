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
});
