import { z } from "zod";

/** Platform-neutral names. Apple symbol names and image bytes live only in the host. */
export const SEMANTIC_ICON_NAMES = [
  "Home",
  "Terminal",
  "Prompt",
  "Plus",
  "Monitor",
  "Layers",
  "Palette",
  "Command",
  "ArrowUpRight",
  "Columns2",
  "Rows2",
  "Search",
  "X",
  "Check",
  "Sun",
  "Moon",
  "Laptop",
  "ArrowRight",
  "RotateCcw",
  "Trash2",
  "Keyboard",
  "SlidersHorizontal",
  "ChevronRight",
  "ChevronUp",
  "ChevronDown",
  "Activity",
  "Sparkles",
] as const;
export type SemanticIconName = (typeof SEMANTIC_ICON_NAMES)[number];
const IconPngSchemaZ = z
  .string()
  .max(65536)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u);
export const DesktopIconCatalogSchemaZ = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("open") }).strict(),
  z
    .object({
      provider: z.literal("sf-symbols"),
      icons: z.partialRecord(z.enum(SEMANTIC_ICON_NAMES), IconPngSchemaZ),
    })
    .strict(),
]);
export type DesktopIconCatalog = z.infer<typeof DesktopIconCatalogSchemaZ>;
