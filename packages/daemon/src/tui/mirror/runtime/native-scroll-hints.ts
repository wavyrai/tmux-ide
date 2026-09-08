/** Optional renderer extension; stock builds do not register a handler. */
export interface NativeScrollHintContext {
  rendererPtr?: number;
  frameId?: number;
}

export type NativeScrollHintHandler = (
  context: NativeScrollHintContext,
  x: number,
  y: number,
  width: number,
  height: number,
) => void;

let active: { handler: NativeScrollHintHandler } | undefined;

/** Replaces the current extension. Disposal only removes this registration. */
export function registerNativeScrollHint(handler: NativeScrollHintHandler): () => void {
  const registration = { handler };
  active = registration;
  return () => {
    if (active === registration) active = undefined;
  };
}

/** Content bounds in renderer cells; validation/capabilities belong to the extension. */
export function queueNativeScrollHint(
  context: NativeScrollHintContext,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  active?.handler(context, x, y, width, height);
}
