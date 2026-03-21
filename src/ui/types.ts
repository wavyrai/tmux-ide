export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export namespace RGBA {
  export function fromInts(
    r: number,
    g: number,
    b: number,
    a?: number,
  ): RGBA {
    return { r, g, b, a: a ?? 255 };
  }
}

export const TextAttributes = {
  NONE: 0,
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  STRIKETHROUGH: 128,
} as const;

export interface BoxProps {
  id?: string;
  flexDirection?: "row" | "column";
  flexGrow?: number;
  flexShrink?: number;
  gap?: number;
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  position?: "relative" | "absolute";
  overflow?: "visible" | "hidden";
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  padding?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  backgroundColor?: RGBA;
  border?: string[];
  borderColor?: RGBA;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  // Mouse events
  onMouseDown?: (e: any) => void;
  onMouseUp?: (e: any) => void;
  onMouseMove?: (e: any) => void;
  onMouseOver?: (e: any) => void;
  // Children
  children?: any;
  ref?: (el: any) => void;
}

export interface TextProps {
  fg?: RGBA;
  bg?: RGBA;
  attributes?: number;
  wrapMode?: "none" | "word" | "char";
  flexGrow?: number;
  flexShrink?: number;
  // Mouse events
  onMouseUp?: (e: any) => void;
  children?: any;
}

export interface ScrollBoxProps extends BoxProps {
  verticalScrollbarOptions?: any;
  stickyScroll?: boolean;
  stickyStart?: "bottom" | "top";
}

export interface InputProps {
  value?: string;
  placeholder?: string;
  onInput?: (value: string) => void;
  focusedBackgroundColor?: RGBA;
  cursorColor?: RGBA;
  focusedTextColor?: RGBA;
  ref?: (el: any) => void;
}
