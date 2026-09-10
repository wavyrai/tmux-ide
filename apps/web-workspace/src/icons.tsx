import {
  Activity01Icon,
  Add01Icon,
  AiMagicIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  ArrowRight01Icon as ChevronRightIcon,
  CommandIcon,
  CommandLineIcon,
  ComputerIcon,
  Delete02Icon,
  KeyboardIcon,
  LaptopIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Moon02Icon,
  PaletteIcon,
  TerminalIcon as PromptIcon,
  RefreshIcon,
  Search01Icon,
  Settings04Icon,
  SquareStackIcon,
  Sun03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";

type Props = Omit<HugeiconsIconProps, "icon">;
function icon(shape: IconSvgElement) {
  return function Icon({ size = 16, strokeWidth = 1.5, ...props }: Props) {
    return (
      <HugeiconsIcon
        aria-hidden="true"
        icon={shape}
        size={size}
        strokeWidth={strokeWidth}
        {...props}
      />
    );
  };
}
export const Terminal = icon(CommandLineIcon);
export const Prompt = icon(PromptIcon);
export const Plus = icon(Add01Icon);
export const Monitor = icon(ComputerIcon);
export const Layers = icon(SquareStackIcon);
export const Palette = icon(PaletteIcon);
export const Command = icon(CommandIcon);
export const ArrowUpRight = icon(ArrowUpRight01Icon);
export const Columns2 = icon(LayoutTwoColumnIcon);
export const Rows2 = icon(LayoutTwoRowIcon);
export const Search = icon(Search01Icon);
export const X = icon(Cancel01Icon);
export const Check = icon(Tick02Icon);
export const Sun = icon(Sun03Icon);
export const Moon = icon(Moon02Icon);
export const Laptop = icon(LaptopIcon);
export const ArrowRight = icon(ArrowRight01Icon);
export const RotateCcw = icon(RefreshIcon);
export const Trash2 = icon(Delete02Icon);
export const Keyboard = icon(KeyboardIcon);
export const SlidersHorizontal = icon(Settings04Icon);
export const ChevronRight = icon(ChevronRightIcon);
export const ChevronUp = icon(ArrowUp01Icon);
export const ChevronDown = icon(ArrowDown01Icon);
export const Activity = icon(Activity01Icon);
export const Sparkles = icon(AiMagicIcon);
