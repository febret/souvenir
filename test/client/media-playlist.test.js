import { describe, expect, it } from "vitest";
import {
  SORT_MODES,
  createPersistentRandomSeed,
  normalizeMediaEntry,
  sortMedia,
} from "../../app/src/core/media.js";
import { hitZoneForPoint, nextMedia, previousMedia } from "../../app/src/core/playlist.js";

const media = [
  { id: "z", name: "zebra.jpg", mtimeMs: 10, size: 1 },
  { id: "a", name: "Album 12.jpg", mtimeMs: 20, size: 3 },
  { id: "b", name: "Album 2.jpg", mtimeMs: 15, size: 2 },
];

describe("media sorting and playlist navigation", () => {
  it("sorts name, newest modified time, size, and stable seeded random orders", () => {
    expect(sortMedia(media, { mode: SORT_MODES.NAME }).map((item) => item.id)).toEqual(["b", "a", "z"]);
    expect(sortMedia(media, { mode: SORT_MODES.MTIME }).map((item) => item.id)).toEqual(["a", "b", "z"]);
    expect(sortMedia(media, { mode: SORT_MODES.SIZE }).map((item) => item.id)).toEqual(["z", "b", "a"]);
    expect(sortMedia(media, { mode: SORT_MODES.RANDOM, seed: "fixed" }))
      .toEqual(sortMedia(media, { mode: SORT_MODES.RANDOM, seed: "fixed" }));
  });

  it("persists one generated random seed", () => {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const first = createPersistentRandomSeed({ storage, random: () => 0.1 });
    expect(createPersistentRandomSeed({ storage, random: () => 0.2 })).toBe(first);
  });

  it("normalizes transport media once before it enters scene state", () => {
    const normalized = normalizeMediaEntry({
      path: "albums/photo.jpg",
      media_type: "image/jpeg",
      mtime: "2026-08-23T12:00:00Z",
      tag_ids: [" blue ", "blue", 4],
    });
    expect(normalized).toMatchObject({
      id: "albums/photo.jpg",
      path: "albums/photo.jpg",
      directory: "albums",
      type: "image/jpeg",
      mimeType: "image/jpeg",
      tag_ids: ["blue", "4"],
    });
    expect(normalizeMediaEntry(normalized).mtime).toBe(normalized.mtime);
  });

  it("wraps previous and next navigation and identifies side hit zones", () => {
    expect(nextMedia(media, "b").id).toBe("z");
    expect(nextMedia(media, "z").id).toBe("a");
    expect(previousMedia(media, "a").id).toBe("z");
    expect(hitZoneForPoint(25, 100)).toBe("previous");
    expect(hitZoneForPoint(50, 100)).toBeNull();
    expect(hitZoneForPoint(75, 100)).toBe("next");
  });
});
