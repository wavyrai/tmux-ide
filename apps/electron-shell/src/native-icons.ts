import type { DesktopIconCatalog, SemanticIconName } from "@tmux-ide/contracts";

/** Names only: no Apple fonts, exports, or image assets are packaged. */
const SYMBOLS: Record<SemanticIconName, string> = {
  Home: "house",
  Terminal: "terminal",
  Prompt: "chevron.right",
  Plus: "plus",
  Monitor: "display",
  Layers: "square.stack",
  Palette: "paintpalette",
  Command: "command",
  ArrowUpRight: "arrow.up.right",
  Columns2: "rectangle.split.2x1",
  Rows2: "rectangle.split.1x2",
  Search: "magnifyingglass",
  X: "xmark",
  Check: "checkmark",
  Sun: "sun.max",
  Moon: "moon",
  Laptop: "laptopcomputer",
  ArrowRight: "arrow.right",
  RotateCcw: "arrow.counterclockwise",
  Trash2: "trash",
  Keyboard: "keyboard",
  SlidersHorizontal: "slider.horizontal.3",
  ChevronRight: "chevron.right",
  ChevronUp: "chevron.up",
  ChevronDown: "chevron.down",
  Activity: "waveform.path.ecg",
  Sparkles: "sparkles",
};
interface NativeImageFactory {
  createFromNamedImage(
    name: string,
    options: { pointSize: number; weight: "regular" },
  ): {
    isEmpty(): boolean;
    toDataURL(): string;
  };
}

/** Lazily resolves a fixed catalog once, using the installed OS on macOS only. */
export function createNativeIconCatalog(
  platform: string,
  factory: NativeImageFactory,
): () => DesktopIconCatalog {
  let cached: DesktopIconCatalog | undefined;
  return () => {
    if (cached) return cached;
    if (platform !== "darwin") return (cached = { provider: "open" });
    const icons: Partial<Record<SemanticIconName, string>> = {};
    for (const [semantic, symbol] of Object.entries(SYMBOLS)) {
      try {
        const image = factory.createFromNamedImage(symbol, { pointSize: 32, weight: "regular" });
        if (!image.isEmpty()) icons[semantic as SemanticIconName] = image.toDataURL();
      } catch {
        // Older macOS versions may lack individual symbols. Keep the open fallback.
      }
    }
    return (cached = { provider: "sf-symbols", icons });
  };
}
