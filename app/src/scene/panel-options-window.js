import { computeSignature } from "./panel-options/signature.js";
import { computePanelControlState } from "./panel-options/control-states.js";
import {
  AMBIENT_INTENSITY_STEPS,
  COLOR_SWATCHES,
  DEPTH_EFFECT_BUTTONS,
  LIGHT_DIRECTIONS,
  OPTIONS_ROW,
  SAVE_MODE_DEFINITIONS,
  SLIDESHOW_MODE_DEFINITIONS,
  clampOptionsScale,
} from "./panel-options/constants.js";

const BASE_CLASS = "scene-options-window";
const DEPTH_MIN = 0;
const DEPTH_MAX = 3;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

/**
 * 2D overlay window used in Desktop Preview to replace the in-scene OPTIONS
 * chrome for the focused panel. It mirrors the same sections, actions, and
 * control states as `PanelOptionsView` but renders as a draggable DOM window
 * that always floats above the WebGL canvas and 3D media panels.
 */
export class PanelOptionsWindow {
  constructor({ panelId, host, onAction, onAdmSetting }) {
    this.panelId = panelId;
    this.host = host ?? null;
    this.onAction = onAction ?? null;
    this.onAdmSetting = onAdmSetting ?? null;
    this.signature = "";
    this.controlState = null;
    this.position = null;
    this.scale = 1;
    this.depthInput = null;
    this.depthOutput = null;

    const root = document.createElement("div");
    root.className = BASE_CLASS;
    root.dataset.panelId = panelId;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Panel options");
    root.hidden = true;
    this.element = root;

    const titlebar = document.createElement("div");
    titlebar.className = `${BASE_CLASS}__titlebar`;
    const title = document.createElement("span");
    title.className = `${BASE_CLASS}__title`;
    title.textContent = "OPTIONS";
    const close = document.createElement("button");
    close.type = "button";
    close.className = `${BASE_CLASS}__close`;
    close.setAttribute("aria-label", "Close options");
    close.dataset.action = "toggle-options";
    close.textContent = "\u2715";
    titlebar.append(title, close);
    this.titlebar = titlebar;
    root.append(titlebar);

    this.slideshowModeRow = document.createElement("div");
    this.slideshowModeRow.className = `${BASE_CLASS}__slideshow-mode`;
    root.append(this.slideshowModeRow);

    this.body = document.createElement("div");
    this.body.className = `${BASE_CLASS}__body`;
    root.append(this.body);

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button || !root.contains(button)) return;
      this.onAction?.(button.dataset.action);
    });

    if (this.host) this.host.append(root);
    this.#attachDrag();
    this.#attachResize();
  }

  #attachDrag() {
    const handle = this.titlebar;
    const root = this.element;
    let drag = null;

    const hostRect = () => this.host?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const currentLeft = () => {
      const px = parseFloat(root.style.left);
      if (Number.isFinite(px)) return px;
      return root.getBoundingClientRect().left - hostRect().left;
    };
    const currentTop = () => {
      const px = parseFloat(root.style.top);
      if (Number.isFinite(px)) return px;
      return root.getBoundingClientRect().top - hostRect().top;
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: currentLeft(),
        originY: currentTop(),
      };
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = hostRect();
      const width = root.offsetWidth || 320;
      const height = root.offsetHeight || 240;
      const x = clampNumber(
        drag.originX + event.clientX - drag.startX,
        8,
        Math.max(8, rect.width - width - 8),
      );
      const y = clampNumber(
        drag.originY + event.clientY - drag.startY,
        8,
        Math.max(8, rect.height - height - 8),
      );
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      this.position = { x, y };
    });

    handle.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
    });

    handle.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== drag?.pointerId) return;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
    });
  }

  #attachResize() {
    const root = this.element;
    root.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.scale = clampOptionsScale(this.scale * Math.exp(-event.deltaY * 0.001));
        root.style.transform = `scale(${this.scale})`;
      },
      { passive: false },
    );
  }

  setVisible(visible) {
    this.element.hidden = !visible;
  }

  setPosition({ x, y }) {
    this.position = { x, y };
    this.element.style.left = `${Math.round(x)}px`;
    this.element.style.top = `${Math.round(y)}px`;
  }

  setPositionIfUnset(position) {
    if (this.position) return;
    if (position) {
      this.setPosition(position);
    } else {
      this.position = { x: null, y: null };
    }
  }

  getPosition() {
    return this.position ? { ...this.position } : null;
  }

  sync({
    saveMode,
    slideshowMode,
    tagDefinitions,
    mediaTagIds,
    tagListExpanded,
    depthIntensity,
    admSettings,
  }) {
    const settings = admSettings ?? {};
    const definitions = Array.isArray(tagDefinitions) ? tagDefinitions : [];
    const selectedIds = Array.isArray(mediaTagIds) ? mediaTagIds : [];
    const expanded = Boolean(tagListExpanded);
    const signature = computeSignature({
      saveMode,
      slideshowMode,
      tagDefinitions: definitions,
      mediaTagIds: selectedIds,
      tagListExpanded: expanded,
      admSettings: settings,
    });
    if (signature !== this.signature) {
      this.signature = signature;
      this.#rebuild({
        saveMode,
        slideshowMode,
        definitions,
        selectedIds,
        expanded,
        settings,
      });
    }
    this.#syncSlideshowMode(slideshowMode);
    this.#syncDepthValue(depthIntensity);
  }

  updateControlStates(state) {
    this.controlState = { ...state };
    this.#applyControlClasses();
  }

  #rebuild({ saveMode, slideshowMode, definitions, selectedIds, expanded, settings }) {
    this.body.replaceChildren();

    this.body.append(
      this.#makeRow(OPTIONS_ROW, (label, action) => this.#makeButton(label, action)),
    );

    this.body.append(this.#makeSectionLabel("Panel save mode"));
    this.body.append(this.#makeRow(
      SAVE_MODE_DEFINITIONS,
      (label, value) => this.#makeButton(label, `set-save-mode:${value}`, { active: saveMode === value }),
    ));
    this.body.append(this.#makeSectionLabel("Depth intensity"));
    this.body.append(this.#makeDepthControl());
    this.body.append(this.#makeRow(
      DEPTH_EFFECT_BUTTONS,
      (label, action) => this.#makeButton(label, action),
    ));
    this.body.append(this.#makeRow(
      [["Delete depth", "delete-depth-mask"]],
      (label, action) => this.#makeButton(label, action),
      { cols: 1 },
    ));

    this.#appendLightingSection(settings);

    this.body.append(this.#makeRow(
      [[expanded ? "Tags \u25be" : "Tags \u25b8", "toggle-tag-list"]],
      (label, action) => this.#makeButton(label, action, { active: expanded }),
    ));
    if (expanded) {
      const grid = document.createElement("div");
      grid.className = `${BASE_CLASS}__tag-grid`;
      for (const definition of definitions) {
        const selected = selectedIds.includes(definition.id);
        const button = this.#makeButton(
          `${selected ? "\u2713 " : ""}${definition.name}`,
          `toggle-media-tag:${definition.id}`,
          { active: selected },
        );
        grid.append(button);
      }
      this.body.append(grid);
    }

    this.#applyControlClasses();
  }

  #appendLightingSection(settings) {
    this.body.append(this.#makeSectionLabel("Lighting"));
    this.body.append(this.#makeRow(
      [["Light FX", "toggle-light-fx"]],
      (label, action) => this.#makeButton(label, action, { active: Boolean(settings.lightFxEnabled) }),
    ));

    this.body.append(this.#makeRow(
      LIGHT_DIRECTIONS,
      (label, value) => this.#makeButton(
        label,
        `set-light-direction:${value}`,
        { active: settings.lightDirection === value },
      ),
    ));

    this.#appendSwatchRow("Light color", "set-light-color", settings.lightColor ?? "white");
    this.#appendSwatchRow("Ambient color", "set-ambient-color", settings.ambientColor ?? "white");

    this.body.append(this.#makeSectionLabel("Ambient intensity"));
    const currentIntensity = settings.ambientIntensity ?? 0.5;
    this.body.append(this.#makeRow(
      AMBIENT_INTENSITY_STEPS,
      (label, value) => this.#makeButton(
        label,
        `set-ambient-intensity:${value}`,
        { active: Math.round(Number(value) * 100) === Math.round(Number(currentIntensity) * 100) },
      ),
      { cols: AMBIENT_INTENSITY_STEPS.length },
    ));
  }

  #syncSlideshowMode(slideshowMode) {
    this.slideshowModeRow.replaceChildren(
      this.#makeSectionLabel("Slideshow mode"),
      this.#makeRow(
        SLIDESHOW_MODE_DEFINITIONS,
        (label, value) => this.#makeButton(
          label,
          `set-slideshow-mode:${value}`,
          { active: slideshowMode === value },
        ),
        { cols: 2 },
      ),
    );
  }

  #appendSwatchRow(labelText, actionPrefix, selectedValue) {
    this.body.append(this.#makeSectionLabel(labelText));
    const row = document.createElement("div");
    row.className = `${BASE_CLASS}__row`;
    row.style.gridTemplateColumns = `repeat(${COLOR_SWATCHES.length}, minmax(0, 1fr))`;
    for (const [value, hex] of COLOR_SWATCHES) {
      const button = this.#makeButton(
        "",
        `${actionPrefix}:${value}`,
        { active: selectedValue === value },
      );
      button.classList.add(`${BASE_CLASS}__swatch`);
      button.style.background = hex;
      button.setAttribute("aria-label", `${labelText}: ${value}`);
      row.append(button);
    }
    this.body.append(row);
  }

  #makeButton(label, action, { active = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${BASE_CLASS}__btn`;
    button.dataset.action = action;
    button.textContent = label;
    if (active) button.classList.add("is-active");
    return button;
  }

  #makeSectionLabel(text) {
    const label = document.createElement("div");
    label.className = `${BASE_CLASS}__label`;
    label.textContent = text;
    return label;
  }

  #makeRow(items, make, { cols = 3 } = {}) {
    const row = document.createElement("div");
    row.className = `${BASE_CLASS}__row`;
    row.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    for (const item of items) row.append(make(...item));
    return row;
  }

  #makeDepthControl() {
    const wrap = document.createElement("div");
    wrap.className = `${BASE_CLASS}__slider`;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(DEPTH_MIN);
    input.max = String(DEPTH_MAX);
    input.step = "0.05";
    input.className = `${BASE_CLASS}__range`;

    const output = document.createElement("output");
    output.className = `${BASE_CLASS}__range-value`;

    const onInput = () => {
      const value = clampNumber(Number(input.value), DEPTH_MIN, DEPTH_MAX);
      output.textContent = `${value.toFixed(2)}x`;
      this.onAdmSetting?.("depthIntensity", value);
    };
    input.addEventListener("input", onInput);

    wrap.append(input, output);
    this.depthInput = input;
    this.depthOutput = output;
    return wrap;
  }

  #syncDepthValue(depthIntensity) {
    if (!this.depthInput) return;
    const value = clampNumber(depthIntensity, DEPTH_MIN, DEPTH_MAX);
    this.depthInput.value = String(value);
    if (this.depthOutput) this.depthOutput.textContent = `${value.toFixed(2)}x`;
  }

  #applyControlClasses() {
    if (!this.controlState) return;
    const state = this.controlState;
    for (const button of this.element.querySelectorAll("[data-action]")) {
      const action = button.dataset.action;
      const { active, inactive } = computePanelControlState(action, state);
      button.classList.toggle("is-active", Boolean(active) && !inactive);
      button.classList.toggle("is-inactive", Boolean(inactive));
    }
    if (this.depthInput) {
      this.depthInput.classList.toggle(
        "is-inactive",
        state.depthInteractive === false,
      );
    }
  }

  dispose() {
    this.element?.remove();
    this.element = null;
  }
}