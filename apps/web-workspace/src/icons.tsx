import { useId } from "react";
import type { SemanticIconName } from "@tmux-ide/contracts";
import { useNativeIcon } from "./icon-provider";
import {
  Activity01Icon,
  Home01Icon,
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
function icon(name: SemanticIconName, shape: IconSvgElement) {
  return function Icon({ size = 16, strokeWidth = 1.5, ...props }: Props) {
    const native = useNativeIcon(name);
    const maskId = useId();
    if (native) {
      return (
        <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" {...props}>
          <defs>
            <mask id={maskId} style={{ maskType: "alpha" }}>
              <image href={native} width="24" height="24" preserveAspectRatio="xMidYMid meet" />
            </mask>
          </defs>
          <rect width="24" height="24" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
      );
    }
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
export const Home = icon("Home", Home01Icon);
export const Terminal = icon("Terminal", CommandLineIcon);
export const Prompt = icon("Prompt", PromptIcon);
export const Plus = icon("Plus", Add01Icon);
export const Monitor = icon("Monitor", ComputerIcon);
export const Layers = icon("Layers", SquareStackIcon);
export const Palette = icon("Palette", PaletteIcon);
export const Command = icon("Command", CommandIcon);
export const ArrowUpRight = icon("ArrowUpRight", ArrowUpRight01Icon);
export const Columns2 = icon("Columns2", LayoutTwoColumnIcon);
export const Rows2 = icon("Rows2", LayoutTwoRowIcon);
export const Search = icon("Search", Search01Icon);
export const X = icon("X", Cancel01Icon);
export const Check = icon("Check", Tick02Icon);
export const Sun = icon("Sun", Sun03Icon);
export const Moon = icon("Moon", Moon02Icon);
export const Laptop = icon("Laptop", LaptopIcon);
export const ArrowRight = icon("ArrowRight", ArrowRight01Icon);
export const RotateCcw = icon("RotateCcw", RefreshIcon);
export const Trash2 = icon("Trash2", Delete02Icon);
export const Keyboard = icon("Keyboard", KeyboardIcon);
export const SlidersHorizontal = icon("SlidersHorizontal", Settings04Icon);
export const ChevronRight = icon("ChevronRight", ChevronRightIcon);
export const ChevronUp = icon("ChevronUp", ArrowUp01Icon);
export const ChevronDown = icon("ChevronDown", ArrowDown01Icon);
export const Activity = icon("Activity", Activity01Icon);
export const Sparkles = icon("Sparkles", AiMagicIcon);
