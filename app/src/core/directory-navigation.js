export function normalizeDirectoryPath(path) {
  return String(path ?? "").split("/").filter(Boolean).join("/");
}

export function parentDirectoryPath(path) {
  const parts = normalizeDirectoryPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function isDirectoryVisible(path, selectedDirectories = []) {
  const normalized = normalizeDirectoryPath(path);
  const selected = selectedDirectories.map(normalizeDirectoryPath).filter(Boolean);
  if (!selected.length || normalized === "") return true;
  return selected.some((enabled) =>
    normalized === enabled
    || normalized.startsWith(`${enabled}/`)
    || enabled.startsWith(`${normalized}/`));
}

export function constrainDirectory(path, selectedDirectories = []) {
  const normalized = normalizeDirectoryPath(path);
  if (isDirectoryVisible(normalized, selectedDirectories)) return normalized;
  return normalizeDirectoryPath(selectedDirectories[0]);
}

export function adjacentSubdirectory(
  workingDirectory,
  viewedDirectory,
  subdirectories,
  direction,
) {
  const cwd = normalizeDirectoryPath(workingDirectory);
  const viewed = normalizeDirectoryPath(viewedDirectory);
  const paths = (Array.isArray(subdirectories) ? subdirectories : [])
    .map((entry) => normalizeDirectoryPath(entry?.path ?? entry))
    .filter(Boolean);
  if (!paths.length) return cwd;
  if (viewed === cwd || !paths.includes(viewed)) {
    return direction < 0 ? paths.at(-1) : paths[0];
  }
  const index = paths.indexOf(viewed);
  return paths[(index + (direction < 0 ? -1 : 1) + paths.length) % paths.length];
}
