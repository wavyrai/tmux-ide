import type { ParentProps, JSX } from "solid-js";
import { rgbaToCSS, attributesToStyle } from "../utils/color.ts";
import type { TextProps } from "../../types.ts";

export function Text(props: ParentProps<TextProps>) {
  const style = (): JSX.CSSProperties => ({
    color: props.fg ? rgbaToCSS(props.fg) : undefined,
    background: props.bg ? rgbaToCSS(props.bg) : undefined,
    "white-space":
      props.wrapMode === "none"
        ? "nowrap"
        : props.wrapMode === "word"
          ? "pre-wrap"
          : undefined,
    overflow: props.wrapMode === "none" ? "hidden" : undefined,
    "word-break":
      props.wrapMode === "word" ? "break-word" : undefined,
    "flex-grow": props.flexGrow,
    "flex-shrink": props.flexShrink,
    ...attributesToStyle(props.attributes ?? 0),
  });

  return (
    <span style={style()} onMouseUp={props.onMouseUp}>
      {props.children}
    </span>
  );
}
