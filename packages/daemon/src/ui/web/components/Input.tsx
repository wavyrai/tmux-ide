import type { JSX } from "solid-js";
import { rgbaToCSS } from "../utils/color.ts";
import type { InputProps } from "../../types.ts";

export function Input(props: InputProps) {
  const style = (): JSX.CSSProperties => ({
    "font-family": "inherit",
    "font-size": "inherit",
    "line-height": "inherit",
    background: props.focusedBackgroundColor
      ? rgbaToCSS(props.focusedBackgroundColor)
      : "rgb(25,25,35)",
    color: props.focusedTextColor ? rgbaToCSS(props.focusedTextColor) : "inherit",
    border: "none",
    outline: "none",
    padding: "0 1ch",
    width: "100%",
    "caret-color": props.cursorColor ? rgbaToCSS(props.cursorColor) : "inherit",
  });

  return (
    <input
      type="text"
      value={props.value ?? ""}
      placeholder={props.placeholder}
      style={style()}
      onInput={(e) => props.onInput?.(e.currentTarget.value)}
      onMouseDown={props.onMouseDown}
      ref={props.ref}
    />
  );
}
