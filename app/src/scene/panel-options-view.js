import * as THREE from "three";

import { disposeObject } from "./canvas-ui.js";

import {
  OPTIONS_SCALE_MAX,
  OPTIONS_SCALE_MIN,
  PANEL_WIDTH,
  clampOptionsScale,
  optionsWidth,
} from "./panel-options/constants.js";
import { computeSignature } from "./panel-options/signature.js";
import { computeLayout, computeBounds } from "./panel-options/layout.js";
import {
  createWidgetFactory,
  addTitle,
  addOptionsRow,
  addSaveModeSection,
  addSlideshowModeSection,
  addDepthSection,
  addLightingSection,
} from "./panel-options/widgets.js";
import { addTagsSection } from "./panel-options/tags-section.js";
import { addBackdrop } from "./panel-options/backdrop.js";
import { applyControlStates } from "./panel-options/control-states.js";

/**
 * Owns the dynamic options chrome for one panel. The group is rebuilt only when
 * layout, save mode, tag definitions, or tag selection changes.
 *
 * The window is a child of its panel, so panel movement carries it along, and
 * it is dragged with the same absolute ray gesture the main toolbar uses. The
 * chrome is billboarded to face the viewer and its depth belongs to the panel's
 * UI depth offset, so a gesture only slides and rescales it.
 */
export class PanelOptionsView extends THREE.Group {
  constructor(panelId) {
    super();
    this.panelId = panelId;
    this.signature = "";
    this.name = "panel-options";
    this.visible = false;
    this.interactionTarget = {
      type: "panel-options",
      onGesture: (gesture) => this.applyGesture(gesture),
    };
    this.userData.gestureTarget = this.interactionTarget;
    this.userData.manipulation = {
      type: "options",
      scalable: true,
      scaleLimits: { min: OPTIONS_SCALE_MIN, max: OPTIONS_SCALE_MAX },
    };
    this.content = new THREE.Group();
    this.add(this.content);
    this.depthControl = null;
    this.layout = {
      width: PANEL_WIDTH,
      height: 0.5,
    };
  }

  /**
   * Slides and rescales the window in the panel's local space. The absolute pose
   * keeps the grabbed point under the hand ray, so the window tracks the ray
   * instead of accumulating frame-to-frame deltas.
   */
  applyGesture(gesture) {
    const position = gesture?.absolutePose?.position;
    if (position) {
      if (Number.isFinite(position.x)) this.position.x = position.x;
      if (Number.isFinite(position.y)) this.position.y = position.y;
      const requested = gesture.absoluteObjectScale ?? gesture.scaleFactor;
      const absolute = typeof requested === "number" ? requested : requested?.x;
      if (Number.isFinite(absolute) && absolute > 0) this.scale.setScalar(clampOptionsScale(absolute));
      return;
    }
    if (gesture?.hands === 2 && Number.isFinite(gesture?.scale)) {
      this.scale.setScalar(clampOptionsScale(this.scale.x * gesture.scale));
      return;
    }
    if (gesture?.hands !== 1) return;
    const translation = gesture.translation ?? {};
    if (Number.isFinite(translation.x)) this.position.x += translation.x;
    if (Number.isFinite(translation.y)) this.position.y += translation.y;
  }

  setDepthControl(control) {
    if (this.depthControl === control) return;
    if (this.depthControl?.parent === this) this.remove(this.depthControl);
    this.depthControl = control ?? null;
    if (this.depthControl) this.add(this.depthControl);
  }

  update({
    saveMode,
    slideshowMode,
    slideshowShuffle = false,
    slideshowRepeat = "all",
    tagDefinitions,
    mediaTagIds,
    tagListExpanded = false,
    depthOffset,
    admSettings,
  }) {
    const settings = admSettings ?? {};
    const definitions = Array.isArray(tagDefinitions) ? tagDefinitions : [];
    const selectedIds = Array.isArray(mediaTagIds) ? mediaTagIds : [];
    const expandedTags = Boolean(tagListExpanded);
    const signature = computeSignature({
      saveMode,
      slideshowMode,
      slideshowShuffle,
      slideshowRepeat,
      tagDefinitions: definitions,
      mediaTagIds: selectedIds,
      tagListExpanded: expandedTags,
      admSettings: settings,
    });
    if (signature === this.signature) {
      this.position.z = depthOffset;
      return false;
    }
    this.signature = signature;
    disposeObject(this.content);
    this.content.clear();

    const widgets = createWidgetFactory({ panelId: this.panelId });
    const layout = computeLayout({ tagCount: definitions.length, expandedTags });

    addTitle(this.content, layout.topY);
    addOptionsRow(this.content, widgets, layout.optionsY);
    addSaveModeSection(this.content, widgets, {
      labelY: layout.saveLabelY,
      rowY: layout.saveRowY,
      saveMode,
    });
    addSlideshowModeSection(this.content, widgets, {
      labelY: layout.slideshowLabelY,
      rowY: layout.slideshowRowY,
      row2Y: layout.slideshowRow2Y,
      slideshowMode,
      slideshowShuffle,
      slideshowRepeat,
    });
    addDepthSection(this.content, widgets, {
      labelY: layout.depthLabelY,
      effectButtonY: layout.effectButtonY,
      deleteDepthButtonY: layout.deleteDepthButtonY,
      settings,
    });

    if (this.depthControl) {
      this.depthControl.position.set(0, layout.depthSliderY, 0.004);
      this.depthControl.visible = true;
    }

    addLightingSection(this.content, widgets, layout, settings);

    const tagsMinY = addTagsSection(this.content, widgets, {
      tagsStartY: layout.tagsStartY,
      cellHeight: layout.cellHeight,
      tagDefinitions: definitions,
      selectedIds,
      expandedTags,
    });

    const bounds = computeBounds({
      topY: layout.topY,
      tagsStartY: layout.tagsStartY,
      cellHeight: layout.cellHeight,
      tagsMinY,
      expandedTags,
    });
    addBackdrop(this.content, bounds, { expandedTags });

    this.layout = { width: optionsWidth(expandedTags), height: bounds.height };
    this.position.z = depthOffset;
    return true;
  }

  updateControlStates({
    maskAvailable,
    mediaLoaded,
    mediaType,
    maskEnabled,
    admEnabled,
    admPromptVisible,
    softDepthEnabled,
    fadeDepthEnabled,
    focusBlurEnabled,
    lightFxEnabled,
    lightDirection,
    lightColor,
    ambientColor,
    ambientIntensity,
    slideshowMode,
    slideshowShuffle = false,
    slideshowRepeat = "all",
    depthAvailable,
  }) {
    applyControlStates(this.content, {
      maskAvailable,
      mediaLoaded,
      mediaType,
      maskEnabled,
      admEnabled,
      admPromptVisible,
      softDepthEnabled,
      fadeDepthEnabled,
      focusBlurEnabled,
      lightFxEnabled,
      lightDirection,
      lightColor,
      ambientColor,
      ambientIntensity,
      slideshowMode,
      slideshowShuffle,
      slideshowRepeat,
      depthAvailable,
    });
  }
}
