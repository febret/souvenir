import { describe, expect, it } from "vitest";

import {
  matchesTagFilter,
  normalizeTagDefinitions,
  normalizeTagIds,
} from "../../app/src/core/tags.js";

describe("tag normalization", () => {
  it("normalizes IDs and definitions without duplicate identities", () => {
    expect(normalizeTagIds([" blue ", 4, "blue", null, ""])).toEqual(["blue", "4"]);
    expect(normalizeTagDefinitions([
      { id: "blue", name: "Blue" },
      { id: "blue", name: "Duplicate" },
      { id: 4, label: "Portrait" },
      { id: "", name: "Missing" },
    ])).toEqual([
      { id: "blue", name: "Blue" },
      { id: "4", name: "Portrait" },
    ]);
  });

  it("applies AND matching to normalized media assignments", () => {
    const entry = { tag_ids: ["blue", 4] };
    expect(matchesTagFilter(entry, ["blue", "4"])).toBe(true);
    expect(matchesTagFilter(entry, ["blue", "horse"])).toBe(false);
    expect(matchesTagFilter(entry, [])).toBe(true);
  });
});
