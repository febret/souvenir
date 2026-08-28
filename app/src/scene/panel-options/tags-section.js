import { makeButton, setButtonState } from "../canvas-ui.js";

import { ROW_GAP, TAG_COLUMNS } from "./constants.js";

/**
 * Renders the collapsible tag toggle plus the tag grid. Returns the lowest
 * rendered Y so the caller can size the backdrop.
 */
export function addTagsSection(content, widgets, {
  tagsStartY,
  cellHeight,
  tagDefinitions,
  selectedIds,
  expandedTags,
}) {
  const tagColumnShiftX = expandedTags ? 0.54 : 0;
  const toggle = widgets.button(expandedTags ? "Tags ▾" : "Tags ▸", "toggle-tag-list", {
    x: tagColumnShiftX,
    y: tagsStartY,
    width: expandedTags ? 0.18 : 0.38,
    height: 0.05,
  });
  setButtonState(toggle, { active: expandedTags });
  content.add(toggle);

  let minY = tagsStartY - 0.028;
  if (!expandedTags) return minY;

  for (const [index, definition] of tagDefinitions.entries()) {
    const selected = selectedIds.includes(definition.id);
    const button = makeButton(
      `${selected ? "\u2713 " : ""}${definition.name}`,
      `toggle-media-tag:${definition.id}`,
      {
        width: 0.24,
        height: cellHeight,
        textureWidth: 560,
        textureHeight: 150,
        font: "700 52px system-ui, sans-serif",
        padding: 8,
        background: selected ? "#294c38" : "#17211f",
        border: selected ? "#8ce8af" : "#40534d",
      },
    );
    const row = Math.floor(index / TAG_COLUMNS);
    const y = tagsStartY - row * (cellHeight + ROW_GAP) - 0.075;
    button.position.set(
      tagColumnShiftX + ((index % TAG_COLUMNS) - 1) * 0.255,
      y,
      0.004,
    );
    content.add(button);
    minY = Math.min(minY, y - cellHeight / 2);
  }
  return minY;
}
