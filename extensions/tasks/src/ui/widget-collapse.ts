/**
 * Coordinated collapse toggle for above-editor widgets (tasks + agents).
 *
 * Whichever extension loads first owns the shortcut; later loaders see
 * `probe.owned === true` from the owner's synchronous claim listener.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Chosen after collision check: no Pi built-in, user keybindings, or extension default uses it. */
export const WIDGET_COLLAPSE_KEY = "alt+w" as const;

const CLAIM = "ui:widget-collapse:claim";
const CHANGED = "ui:widget-collapse:changed";

export type WidgetCollapseChanged = { collapsed: boolean };

/** Dim hint appended to collapsed widget headers. */
export function widgetCollapseHint(theme: { fg(color: string, text: string): string }, collapsed = true): string {
  return theme.fg("dim", ` (${WIDGET_COLLAPSE_KEY} to ${collapsed ? "expand" : "collapse"})`);
}

/**
 * Wire collapse sync for this extension instance.
 * Returns dispose (unsubscribe all listeners).
 */
export function wireWidgetCollapse(
  pi: ExtensionAPI,
  onChanged: (collapsed: boolean) => void,
): () => void {
  const unsubs: (() => void)[] = [];

  const probe = { owned: false, collapsed: false };
  pi.events.emit(CLAIM, probe);
  let collapsed = probe.collapsed;
  onChanged(collapsed);

  unsubs.push(
    pi.events.on(CHANGED, (data) => {
      if (typeof data === "object" && data !== null && "collapsed" in data && typeof data.collapsed === "boolean") {
        collapsed = data.collapsed;
        onChanged(data.collapsed);
      }
    }),
  );

  if (!probe.owned) {
    unsubs.push(
      pi.events.on(CLAIM, (data) => {
        if (typeof data === "object" && data !== null && "owned" in data && typeof data.owned === "boolean") {
          data.owned = true;
          if ("collapsed" in data) data.collapsed = collapsed;
        }
      }),
    );
    pi.registerShortcut(WIDGET_COLLAPSE_KEY, {
      description: "Collapse or expand task/agent panels",
      handler: () => {
        collapsed = !collapsed;
        pi.events.emit(CHANGED, { collapsed });
      },
    });
  }

  return () => {
    for (const u of unsubs) u();
  };
}
