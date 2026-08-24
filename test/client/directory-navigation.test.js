import { describe, expect, it } from "vitest";

import {
  adjacentSubdirectory,
  constrainDirectory,
  isDirectoryVisible,
  normalizeDirectoryPath,
  parentDirectoryPath,
} from "../../app/src/core/directory-navigation.js";

describe("directory navigation", () => {
  it("normalizes paths and walks to the parent without escaping media home", () => {
    expect(normalizeDirectoryPath("/albums//trips/")).toBe("albums/trips");
    expect(parentDirectoryPath("albums/trips")).toBe("albums");
    expect(parentDirectoryPath("albums")).toBe("");
    expect(parentDirectoryPath("")).toBe("");
  });

  it("allows only enabled directories and the ancestors needed to reach them", () => {
    const enabled = ["albums/trips", "albums/trips/2026"];
    expect(isDirectoryVisible("", enabled)).toBe(true);
    expect(isDirectoryVisible("albums", enabled)).toBe(true);
    expect(isDirectoryVisible("albums/trips", enabled)).toBe(true);
    expect(isDirectoryVisible("albums/trips/2026", enabled)).toBe(true);
    expect(isDirectoryVisible("archive", enabled)).toBe(false);
    expect(constrainDirectory("archive", enabled)).toBe("albums/trips");
    expect(constrainDirectory("albums", enabled)).toBe("albums");
  });

  it("enters the last or first child from cwd and wraps between siblings", () => {
    const children = [
      { path: "albums/favorites" },
      { path: "albums/trips" },
    ];
    expect(adjacentSubdirectory("albums", "albums", children, -1))
      .toBe("albums/trips");
    expect(adjacentSubdirectory("albums", "albums", children, 1))
      .toBe("albums/favorites");
    expect(adjacentSubdirectory("albums", "albums/favorites", children, -1))
      .toBe("albums/trips");
    expect(adjacentSubdirectory("albums", "albums/trips", children, 1))
      .toBe("albums/favorites");
    expect(adjacentSubdirectory("albums", "albums/trips", [], 1))
      .toBe("albums");
  });
});
