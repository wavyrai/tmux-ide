import { z } from "zod";

const text = (limit: number) =>
  z
    .string()
    .max(limit)
    // Intentionally reject control characters in display text and navigation input.
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const identity = {
  version: z.literal(1),
  instance: z.uuid(),
  pane: z
    .string()
    .regex(/^%[0-9]+$/u)
    .max(32),
  tab: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
/** Display state is not authority: every command echoes the exact browser revision. */
export const NativeBrowserStateSchemaZ = z
  .object({
    ...identity,
    enabled: z.boolean(),
    url: text(16_384),
    title: text(512),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
  })
  .strict();
export const NativeBrowserCommandSchemaZ = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.enum(["back", "forward", "reload", "stop"]) }).strict(),
  z
    .object({
      ...identity,
      action: z.literal("navigate"),
      text: text(16_384).refine((value) => value.trim().length > 0),
    })
    .strict(),
]);
export type NativeBrowserState = z.infer<typeof NativeBrowserStateSchemaZ>;
export type NativeBrowserCommand = z.infer<typeof NativeBrowserCommandSchemaZ>;
