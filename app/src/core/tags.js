export function normalizeTagIds(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((id) => typeof id === "string" || typeof id === "number")
      .map((id) => String(id).trim())
      .filter(Boolean),
  )];
}

export function normalizeTagDefinitions(definitions) {
  const seen = new Set();
  return (Array.isArray(definitions) ? definitions : [])
    .map((definition) => ({
      id: String(definition?.id ?? "").trim(),
      name: String(
        definition?.name
        ?? definition?.label
        ?? definition?.id
        ?? "",
      ).trim(),
    }))
    .filter((definition) =>
      definition.id
      && !seen.has(definition.id)
      && seen.add(definition.id));
}

export function matchesTagFilter(entry, tagFilter) {
  const assigned = new Set(normalizeTagIds(entry?.tag_ids));
  return normalizeTagIds(tagFilter).every((tagId) => assigned.has(tagId));
}
