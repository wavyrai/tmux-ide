import { z } from "zod";

export const RichCardToneSchemaZ = z.enum(["neutral", "info", "success", "warning", "danger"]);

export const RichCardItemSchemaZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(8_000) }).strict(),
  z
    .object({
      type: z.literal("badge"),
      text: z.string().min(1).max(120),
      tone: RichCardToneSchemaZ.default("neutral"),
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      label: z.string().max(160).optional(),
      value: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("code"),
      code: z.string().max(32_000),
      language: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("button"),
      label: z.string().min(1).max(120),
      /** Bytes written to the owning pane after an explicit user click. */
      input: z.string().min(1).max(2_000),
      submit: z.boolean().default(true),
      tone: RichCardToneSchemaZ.default("neutral"),
    })
    .strict(),
]);
export type RichCardItem = z.infer<typeof RichCardItemSchemaZ>;

export const RichCardWidgetArgsSchemaZ = z
  .object({
    title: z.string().min(1).max(200),
    subtitle: z.string().max(500).optional(),
    items: z.array(RichCardItemSchemaZ).max(128),
  })
  .strict();
export type RichCardWidgetArgs = z.infer<typeof RichCardWidgetArgsSchemaZ>;

/** Plain semantic fallback for renderers that do not have rich card chrome. */
export function richCardTextFallback(card: RichCardWidgetArgs): string {
  const lines = [card.title];
  if (card.subtitle) lines.push(card.subtitle);
  for (const item of card.items) {
    switch (item.type) {
      case "text":
      case "badge":
        lines.push(item.text);
        break;
      case "progress":
        lines.push(`${item.label ? `${item.label}: ` : ""}${Math.round(item.value)}%`);
        break;
      case "code":
        lines.push(item.code);
        break;
      case "button":
        lines.push(`[${item.label}]`);
        break;
    }
  }
  return lines.join("\n");
}
