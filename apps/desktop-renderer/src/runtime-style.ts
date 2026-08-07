export type RuntimeStyleValue = string | number | null | undefined;
export type RuntimeStyleProperties = Readonly<Record<string, RuntimeStyleValue>>;

export interface RuntimeStyleBinding {
  readonly key: string;
  update(properties: RuntimeStyleProperties): void;
  dispose(): void;
}

const MARKER_SELECTOR = ".tmi-runtime-style-registry";
const ATTRIBUTE = "data-tmi-runtime-style";
let nextKey = 0;

function runtimeSheet(document: Document): CSSStyleSheet | null {
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === MARKER_SELECTOR) return sheet;
      }
    } catch {
      // Cross-origin sheets are intentionally opaque and cannot be our same-origin registry.
    }
  }
  return null;
}

function deleteRule(sheet: CSSStyleSheet, target: CSSStyleRule): void {
  for (let index = 0; index < sheet.cssRules.length; index += 1) {
    if (sheet.cssRules[index] === target) {
      sheet.deleteRule(index);
      return;
    }
  }
}

/**
 * Binds reactive values through an authorized external stylesheet. Updating the
 * rule cannot create a style attribute, inject a style element, or remount the
 * owning element, which keeps native terminal surfaces stable under geometry
 * changes while satisfying `style-src 'self'`.
 */
export function createRuntimeStyleBinding(element: HTMLElement): RuntimeStyleBinding {
  const key = `tmi-${++nextKey}`;
  const selector = `[${ATTRIBUTE}="${key}"]`;
  let properties: RuntimeStyleProperties = {};
  let rule: CSSStyleRule | null = null;
  let sheet: CSSStyleSheet | null = null;
  let disposed = false;
  let retryScheduled = false;
  let retriesRemaining = 1;
  const applied = new Set<string>();
  element.setAttribute(ATTRIBUTE, key);

  const ensureRule = (): CSSStyleRule | null => {
    if (rule) return rule;
    sheet = runtimeSheet(element.ownerDocument);
    if (!sheet) return null;
    const index = sheet.insertRule(`${selector} {}`, sheet.cssRules.length);
    const inserted = sheet.cssRules[index];
    if (!(inserted instanceof CSSStyleRule)) {
      sheet.deleteRule(index);
      return null;
    }
    rule = inserted;
    return rule;
  };

  const apply = (): void => {
    const activeRule = ensureRule();
    if (!activeRule) {
      if (!retryScheduled && retriesRemaining > 0) {
        retriesRemaining -= 1;
        retryScheduled = true;
        queueMicrotask(() => {
          retryScheduled = false;
          if (!disposed) apply();
        });
      }
      return;
    }
    const next = new Set<string>();
    for (const [name, rawValue] of Object.entries(properties)) {
      if (rawValue === undefined || rawValue === null) continue;
      activeRule.style.setProperty(name, String(rawValue));
      next.add(name);
    }
    for (const name of applied) {
      if (!next.has(name)) activeRule.style.removeProperty(name);
    }
    applied.clear();
    for (const name of next) applied.add(name);
  };

  return {
    key,
    update(next) {
      if (disposed) return;
      properties = next;
      retriesRemaining = 1;
      apply();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retryScheduled = false;
      element.removeAttribute(ATTRIBUTE);
      if (sheet && rule) deleteRule(sheet, rule);
      rule = null;
      sheet = null;
      applied.clear();
    },
  };
}
