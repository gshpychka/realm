/** An entity's full-size Home Assistant history chart. */
export function openEntityHistory(opener, entityId) {
  opener.dispatchEvent(new CustomEvent("hass-more-info", {
    detail: { entityId, view: "history", large: true },
    bubbles: true,
    composed: true,
  }));
}
