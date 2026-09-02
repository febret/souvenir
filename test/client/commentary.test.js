import { describe, expect, it } from "vitest";

import {
  aggregateEntryTagCounts,
  aggregatePanelTagCounts,
  normalizeTagFrequency,
  normalizeCommentaryVolume,
  scoreCommentary,
  suggestCommentaryTags,
  selectCommentary,
} from "../../app/src/core/commentary.js";

describe("commentary selection", () => {
  it("normalizes per-sound playback volume", () => {
    expect(normalizeCommentaryVolume(0.45)).toBe(0.45);
    expect(normalizeCommentaryVolume(-1)).toBe(0);
    expect(normalizeCommentaryVolume(1.75)).toBe(1.75);
    expect(normalizeCommentaryVolume(3)).toBe(3);
    expect(normalizeCommentaryVolume(5)).toBe(4);
    expect(normalizeCommentaryVolume("invalid")).toBe(1);
  });

  it("counts each open panel's current media once per unique tag", () => {
    const panels = [
      { media: { selectedId: "albums/beach.jpg" } },
      { media: { selectedId: "albums/beach.jpg" } },
      { media: { selectedId: "albums/forest.jpg" } },
      { media: { selectedId: "missing.jpg" } },
    ];
    const tags = new Map([
      ["albums/beach.jpg", [" horse ", "horse", { id: "blue" }, "", null]],
      ["albums/forest.jpg", [{ id: "horse" }, { id: "green" }, { id: "green" }]],
    ]);

    expect(aggregatePanelTagCounts(panels, tags)).toEqual({
      horse: 3,
      blue: 2,
      green: 1,
    });
  });

  it("sums matching tag counts and ranks ties deterministically", () => {
    const scored = scoreCommentary(
      [
        { path: "z.wav", name: "Z", tag_ids: ["horse", "blue", "horse", null] },
        { path: "b.wav", name: "B", tags: [{ id: "horse" }] },
        { path: "a.wav", name: "A", tagIds: ["horse"] },
      ],
      { horse: 2, blue: 3 },
    );

    expect(scored.map(({ path, score }) => ({ path, score }))).toEqual([
      { path: "z.wav", score: 5 },
      { path: "a.wav", score: 2 },
      { path: "b.wav", score: 2 },
    ]);
  });

  it("uses weighted boundaries, then uniformly falls back for zero scores", () => {
    const weighted = [
      { path: "first.wav", tag_ids: ["first"] },
      { path: "second.wav", tag_ids: ["second"] },
      { path: "third.wav", tag_ids: ["third"] },
    ];
    const counts = { first: 3, second: 1, third: 1 };

    expect(selectCommentary(weighted, counts, { random: () => 0.5999 }).path).toBe("first.wav");
    expect(selectCommentary(weighted, counts, { random: () => 0.6 }).path).toBe("second.wav");
    expect(selectCommentary(weighted, counts, { random: () => 0.8 }).path).toBe("third.wav");

    const zero = [{ path: "a.wav" }, { path: "b.wav" }, { path: "c.wav" }];
    expect(selectCommentary(zero, {}, { random: () => 0 }).path).toBe("a.wav");
    expect(selectCommentary(zero, {}, { random: () => 0.5 }).path).toBe("b.wav");
    expect(selectCommentary(zero, {}, { random: () => 0.99999 }).path).toBe("c.wav");
  });

  it("aggregates and normalizes entry tags for distribution comparisons", () => {
    const counts = aggregateEntryTagCounts([
      { tag_ids: ["animal", "night", "animal"] },
      { tagIds: ["night", "story"] },
      { tags: [{ id: "story" }, { id: "night" }] },
      { tags: [null, "", "story"] },
    ]);
    expect(counts).toEqual({ animal: 1, night: 3, story: 3 });
    expect(normalizeTagFrequency(counts)).toEqual({
      animal: 1 / 7,
      night: 3 / 7,
      story: 3 / 7,
    });
  });

  it("suggests top positive-gap tags with deterministic ordering and capping", () => {
    const suggestions = suggestCommentaryTags(
      { beach: 10, travel: 7, city: 3, food: 1, river: 1, birds: 1 },
      { beach: 2, city: 3, river: 1 },
      { limit: 5 },
    );
    expect(suggestions.map((entry) => entry.tag)).toEqual([
      "travel",
      "beach",
      "birds",
      "food",
    ]);
    expect(suggestCommentaryTags({ one: 1 }, { one: 1 }, { limit: 5 })).toEqual([]);
  });
});
