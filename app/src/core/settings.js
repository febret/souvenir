export const SETTINGS_VERSION = 4;
export const SETTINGS_STORAGE_KEY = "souvenir.settings";
export const TAG_SORT_ORDERS = Object.freeze({
  ALPHA_ASC: "alpha-asc",
  ALPHA_DESC: "alpha-desc",
});

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  mediaDirectories: [],
  autoplayVideos: false,
  slideshowIntervalMs: 5000,
  tagSortOrder: TAG_SORT_ORDERS.ALPHA_ASC,
  captionSize: 1,
  captionTransparency: 0.1,
  captionDistance: 1.2,
  admDefaultDepthIntensity: 0.35,
  admMaxResolution: 512,
});

const MIN_SLIDESHOW_INTERVAL_MS = 1000;
const MAX_SLIDESHOW_INTERVAL_MS = 60 * 60 * 1000;
const CAPTION_RANGES = Object.freeze({
  captionSize: [0.5, 2],
  captionTransparency: [0, 0.8],
  captionDistance: [0.5, 3],
});
const ADM_RANGES = Object.freeze({
  admDefaultDepthIntensity: [0, 3],
  admMaxResolution: [64, 512],
});

function cloneDefaults() {
  return { ...DEFAULT_SETTINGS, mediaDirectories: [] };
}

function isDirectory(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates an untrusted settings value without mutating it.
 * @returns {{valid: boolean, errors: string[], value: object}}
 */
export function validateSettings(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["Settings must be an object."], value: cloneDefaults() };
  }

  if (value.version !== undefined && (!Number.isInteger(value.version) || value.version < 1)) {
    errors.push("version must be a positive integer.");
  }
  if (value.mediaDirectories !== undefined && (!Array.isArray(value.mediaDirectories) || !value.mediaDirectories.every(isDirectory))) {
    errors.push("mediaDirectories must contain non-empty strings.");
  }
  if (value.autoplayVideos !== undefined && typeof value.autoplayVideos !== "boolean") {
    errors.push("autoplayVideos must be a boolean.");
  }
  if (value.slideshowIntervalMs !== undefined
    && (!Number.isFinite(value.slideshowIntervalMs)
      || value.slideshowIntervalMs < MIN_SLIDESHOW_INTERVAL_MS
      || value.slideshowIntervalMs > MAX_SLIDESHOW_INTERVAL_MS)) {
    errors.push(`slideshowIntervalMs must be between ${MIN_SLIDESHOW_INTERVAL_MS} and ${MAX_SLIDESHOW_INTERVAL_MS}.`);
  }
  if (value.tagSortOrder !== undefined && !Object.values(TAG_SORT_ORDERS).includes(value.tagSortOrder)) {
    errors.push(`tagSortOrder must be one of: ${Object.values(TAG_SORT_ORDERS).join(", ")}.`);
  }
  for (const [key, [minimum, maximum]] of Object.entries(CAPTION_RANGES)) {
    if (value[key] !== undefined
      && (!Number.isFinite(value[key]) || value[key] < minimum || value[key] > maximum)) {
      errors.push(`${key} must be between ${minimum} and ${maximum}.`);
    }
  }
  for (const [key, [minimum, maximum]] of Object.entries(ADM_RANGES)) {
    if (value[key] !== undefined
      && (!Number.isFinite(value[key]) || value[key] < minimum || value[key] > maximum)) {
      errors.push(`${key} must be between ${minimum} and ${maximum}.`);
    }
  }
  if (value.admMaxResolution !== undefined && !Number.isInteger(value.admMaxResolution)) {
    errors.push("admMaxResolution must be an integer.");
  }

  return { valid: errors.length === 0, errors, value: reconcileSettings(value) };
}

export function reconcileSettings(value, availableDirectories) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const directories = Array.isArray(source.mediaDirectories)
    ? source.mediaDirectories.filter(isDirectory).map((directory) => directory.trim())
    : [];
  const uniqueDirectories = [...new Set(directories)];
  const allowed = Array.isArray(availableDirectories) ? new Set(availableDirectories) : null;
  const slideshowIntervalMs = Number.isFinite(source.slideshowIntervalMs)
    ? Math.min(MAX_SLIDESHOW_INTERVAL_MS, Math.max(MIN_SLIDESHOW_INTERVAL_MS, source.slideshowIntervalMs))
    : DEFAULT_SETTINGS.slideshowIntervalMs;
  const captionSetting = (key) => {
    const [minimum, maximum] = CAPTION_RANGES[key];
    return Number.isFinite(source[key])
      ? Math.min(maximum, Math.max(minimum, source[key]))
      : DEFAULT_SETTINGS[key];
  };
  const admSetting = (key) => {
    const [minimum, maximum] = ADM_RANGES[key];
    const value = Number.isFinite(source[key]) ? source[key] : DEFAULT_SETTINGS[key];
    return Math.min(maximum, Math.max(minimum, value));
  };

  return {
    version: SETTINGS_VERSION,
    mediaDirectories: allowed ? uniqueDirectories.filter((directory) => allowed.has(directory)) : uniqueDirectories,
    autoplayVideos: typeof source.autoplayVideos === "boolean" ? source.autoplayVideos : DEFAULT_SETTINGS.autoplayVideos,
    slideshowIntervalMs,
    tagSortOrder: Object.values(TAG_SORT_ORDERS).includes(source.tagSortOrder)
      ? source.tagSortOrder
      : DEFAULT_SETTINGS.tagSortOrder,
    captionSize: captionSetting("captionSize"),
    captionTransparency: captionSetting("captionTransparency"),
    captionDistance: captionSetting("captionDistance"),
    admDefaultDepthIntensity: Math.round(admSetting("admDefaultDepthIntensity") * 100) / 100,
    admMaxResolution: Math.round(admSetting("admMaxResolution")),
  };
}

/**
 * Removes selected directories that are not present in the current media tree.
 * `treePaths` may be an array or any iterable of directory path strings.
 */
export function reconcileSelectedDirectories(settings, treePaths) {
  const paths = treePaths == null ? undefined : Array.from(treePaths);
  return reconcileSettings(settings, paths);
}

function browserStorage() {
  return typeof globalThis !== "undefined" ? globalThis.localStorage : undefined;
}

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new TypeError("A Storage-compatible object is required.");
  }
  return storage;
}

/**
 * Loads versioned settings from a Storage-compatible object.
 * Invalid or corrupt stored content resolves to a fresh defaults object.
 */
export function loadSettings(storage = browserStorage()) {
  const source = requireStorage(storage);
  try {
    const raw = source.getItem(SETTINGS_STORAGE_KEY);
    return raw === null ? cloneDefaults() : reconcileSettings(JSON.parse(raw));
  } catch {
    return cloneDefaults();
  }
}

/**
 * Validates and persists settings, returning the canonical saved value.
 */
export function saveSettings(storage = browserStorage(), settings) {
  const source = requireStorage(storage);
  const result = validateSettings(settings);
  if (!result.valid) {
    throw new TypeError(`Invalid settings: ${result.errors.join(" ")}`);
  }
  const reconciled = reconcileSettings(settings);
  source.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(reconciled));
  return reconciled;
}
