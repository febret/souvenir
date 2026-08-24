export const ENVIRONMENT_MODES = Object.freeze({
  NORMAL: "normal",
  DARK: "dark",
  NIGHT: "night",
  UNDERWATER: "underwater",
  RED: "red",
});

export const DEFAULT_ENVIRONMENT_MODE = ENVIRONMENT_MODES.NORMAL;

export const ENVIRONMENT_MODE_LABELS = Object.freeze({
  [ENVIRONMENT_MODES.NORMAL]: "Normal",
  [ENVIRONMENT_MODES.DARK]: "Dark",
  [ENVIRONMENT_MODES.NIGHT]: "Night",
  [ENVIRONMENT_MODES.UNDERWATER]: "Underwater",
  [ENVIRONMENT_MODES.RED]: "Red",
});

export const ENVIRONMENT_MODE_CONFIG = Object.freeze({
  [ENVIRONMENT_MODES.NORMAL]: Object.freeze({ color: 0x000000, opacity: 0 }),
  [ENVIRONMENT_MODES.DARK]: Object.freeze({ color: 0x000000, opacity: 0.6 }),
  [ENVIRONMENT_MODES.NIGHT]: Object.freeze({ color: 0x07162f, opacity: 0.9 }),
  [ENVIRONMENT_MODES.UNDERWATER]: Object.freeze({
    color: 0x087eaa,
    opacity: 0.8,
    accentColor: 0x42d9e8,
    animated: true,
  }),
  [ENVIRONMENT_MODES.RED]: Object.freeze({ color: 0x75070c, opacity: 0.8 }),
});

export const ENVIRONMENT_MODE_DESCRIPTORS = Object.freeze(
  Object.values(ENVIRONMENT_MODES).map((mode) =>
    Object.freeze({
      mode,
      label: ENVIRONMENT_MODE_LABELS[mode],
      ...ENVIRONMENT_MODE_CONFIG[mode],
    }),
  ),
);

export function normalizeEnvironmentMode(value) {
  return typeof value === "string" && ENVIRONMENT_MODE_CONFIG[value]
    ? value
    : DEFAULT_ENVIRONMENT_MODE;
}
