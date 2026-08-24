import { describe, expect, it, vi } from "vitest";

import { applyTagPillPreview, createTagPill, TagPreviewResolver } from "../../app/src/ui/tag-pill.js";

function createFakeElement() {
  const classes = new Set();
  const styles = new Map();
  return {
    className: "",
    dataset: {},
    textContent: "",
    style: {
      setProperty(name, value) {
        styles.set(name, value);
      },
      removeProperty(name) {
        styles.delete(name);
      },
      getPropertyValue(name) {
        return styles.get(name) ?? "";
      },
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
}

const fakeDocument = {
  createElement() {
    return createFakeElement();
  },
};

describe("tag pills", () => {
  it("applies and clears preview backgrounds", () => {
    const pill = createTagPill(fakeDocument, { tagId: "blue", label: "Blue" });

    applyTagPillPreview(pill, "/api/thumbnail?path=albums%2Fbeach.jpg");
    expect(pill.style.getPropertyValue("--tag-pill-image"))
      .toContain("/api/thumbnail?path=albums%2Fbeach.jpg");
    expect(pill.classList.contains("tag-pill--with-preview")).toBe(true);

    applyTagPillPreview(pill, "");
    expect(pill.style.getPropertyValue("--tag-pill-image")).toBe("");
    expect(pill.classList.contains("tag-pill--with-preview")).toBe(false);
  });

  it("ignores videos when finding a background for a tag", async () => {
    const api = {
      directory: vi.fn(async () => ({
        entries: [
          { kind: "file", path: "albums/clip.webm", name: "clip.webm", media_type: "video/webm", tag_ids: ["blue"] },
          { kind: "file", path: "albums/beach.jpg", name: "beach.jpg", media_type: "image/jpeg", tag_ids: ["blue"] },
        ],
      })),
      thumbnailUrl: vi.fn((path) => `/thumb/${encodeURIComponent(path)}`),
    };
    const resolver = new TagPreviewResolver({
      api,
      selectedDirectories: () => ["albums"],
    });

    resolver.ensure(["blue"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolver.previewFor("blue")).toBe("/thumb/albums%2Fbeach.jpg");
  });

  it("prefers different media for different tags when possible", async () => {
    const api = {
      directory: vi.fn(async (path) => ({
        entries: path === "albums"
          ? [
            { kind: "file", path: "albums/portrait.jpg", name: "portrait.jpg", media_type: "image/jpeg", tag_ids: ["blue", "horse"] },
            { kind: "file", path: "albums/beach.jpg", name: "beach.jpg", media_type: "image/jpeg", tag_ids: ["horse"] },
            { kind: "file", path: "albums/forest.jpg", name: "forest.jpg", media_type: "image/jpeg", tag_ids: ["blue"] },
          ]
          : [],
      })),
      thumbnailUrl: vi.fn((path) => `/thumb/${encodeURIComponent(path)}`),
    };
    const resolver = new TagPreviewResolver({
      api,
      selectedDirectories: () => ["albums"],
    });

    resolver.ensure(["blue", "horse"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blue = resolver.previewFor("blue");
    const horse = resolver.previewFor("horse");
    expect(new Set([blue, horse]).size).toBe(2);
    expect([
      "/thumb/albums%2Fportrait.jpg",
      "/thumb/albums%2Fbeach.jpg",
      "/thumb/albums%2Fforest.jpg",
    ]).toContain(blue);
    expect([
      "/thumb/albums%2Fportrait.jpg",
      "/thumb/albums%2Fbeach.jpg",
      "/thumb/albums%2Fforest.jpg",
    ]).toContain(horse);
  });
});

describe("tag preview resolver", () => {
  it("finds the first tagged media in the selected directories", async () => {
    const calls = [];
    const api = {
      directory: vi.fn(async (path) => {
        calls.push(path);
        if (path === "albums") {
          return {
            entries: [
              { kind: "directory", path: "albums/trips" },
              { kind: "file", path: "albums/beach.jpg", tag_ids: ["horse", "blue"] },
              { kind: "file", path: "albums/forest.jpg", tag_ids: ["horse"] },
            ],
          };
        }
        if (path === "albums/trips") {
          return {
            entries: [
              { kind: "file", path: "albums/trips/road.jpg", tag_ids: ["green"] },
            ],
          };
        }
        return { entries: [] };
      }),
      thumbnailUrl: vi.fn((path) => `/thumb/${encodeURIComponent(path)}`),
    };
    const updates = [];
    const resolver = new TagPreviewResolver({
      api,
      selectedDirectories: () => ["albums", "albums/trips"],
      onUpdate: (tagIds) => updates.push(...tagIds),
    });

    resolver.ensure(["blue", "horse", "green"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["albums", "albums/trips"]);
    expect(resolver.previewFor("blue")).toMatch(/\/thumb\/albums%2F(?:beach|forest)\.jpg/);
    expect(resolver.previewFor("horse")).not.toBe(resolver.previewFor("blue"));
    expect(resolver.previewFor("green")).toBe("/thumb/albums%2Ftrips%2Froad.jpg");
    expect(updates).toEqual(expect.arrayContaining(["blue", "horse", "green"]));
  });

  it("restarts after invalidation when media tags change", async () => {
    let includePortrait = false;
    const api = {
      directory: vi.fn(async () => ({
        entries: includePortrait
          ? [{ kind: "file", path: "albums/portrait.jpg", tag_ids: ["portrait"] }]
          : [],
      })),
      thumbnailUrl: vi.fn((path) => `/thumb/${encodeURIComponent(path)}`),
    };
    const resolver = new TagPreviewResolver({
      api,
      selectedDirectories: () => ["albums"],
    });

    resolver.ensure(["portrait"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver.previewFor("portrait")).toBe("");

    includePortrait = true;
    resolver.invalidate();
    resolver.ensure(["portrait"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver.previewFor("portrait")).toBe("/thumb/albums%2Fportrait.jpg");
  });
});
