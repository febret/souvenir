import * as THREE from "three";

import { disposeObject } from "./canvas-ui.js";

import { PANEL_WIDTH } from "./panel-options/constants.js";
import { computeSignature } from "./panel-options/signature.js";
import { computeLayout, computeBounds } from "./panel-options/layout.js";
import {
  createWidgetFactory,
  addTitle,
  addOptionsRow,
  addSaveModeSection,
  addDepthSection,
  addLightingSection,
} from "./panel-options/widgets.js";
import { addTagsSection } from "./panel-options/tags-section.js";
import { addBackdrop } from "./panel-options/backdrop.js";
import { applyControlStates } from "./panel-options/control-states.js";

/**
 * Owns the dynamic options chrome for one panel. The group is rebuilt only when
 * layout, save mode, tag definitions, or tag selection changes.
 */
export class PanelOptionsView extends THREE.Group {
  constructor(panelId, { onDrag = null } = {}) {
    super();
    this.panelId = panelId;
    this.signature = "";
    this.name = "panel-options";
    this.visible = false;
    this.onDrag = onDrag;
    this.content = new THREE.Group();
    this.add(this.content);
    this.depthControl = null;
    this.dragTarget = {
      onGesture: (gesture) => this.onDrag?.(gesture),
    };
    this.layout = {
      width: PANEL_WIDTH,
      height: 0.5,
    };
  }

  setDepthControl(control) {
    if (this.depthControl === control) return;
    if (this.depthControl?.parent === this) this.remove(this.depthControl);
    this.depthControl = control ?? null;
    if (this.depthControl) this.add(this.depthControl);
  }

  update({
    saveMode,
    tagDefinitions,
    mediaTagIds,
    tagListExpanded = true,
    depthOffset,
    admSettings,
  }) {
    const settings = admSettings ?? {};
    const definitions = Array.isArray(tagDefinitions) ? tagDefinitions : [];
    const selectedIds = Array.isArray(mediaTagIds) ? mediaTagIds : [];
    const expandedTags = Boolean(tagListExpanded);
    const signature = computeSignature({
      saveMode,
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
    addBackdrop(this.content, bounds, { dragTarget: this.dragTarget, expandedTags });

    this.layout = { width: PANEL_WIDTH, height: bounds.height };
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
      depthAvailable,
    });
  }
}
