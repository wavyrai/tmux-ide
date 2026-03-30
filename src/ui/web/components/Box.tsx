import type { JSX, ParentProps } from "solid-js";
import { rgbaToCSS } from "../utils/color.ts";
import type { BoxProps } from "../../types.ts";

export function Box(props: ParentProps<BoxProps>) {
  const style = (): JSX.CSSProperties => ({
    display: "flex",
    "flex-direction": props.flexDirection ?? "column",
    "flex-grow": props.flexGrow,
    "flex-shrink": props.flexShrink,
    gap: props.gap !== undefined ? `${props.gap}ch` : undefined,
    "justify-content": props.justifyContent,
    "align-items": props.alignItems,
    position: props.position ?? "relative",
    overflow: props.overflow,
    width: typeof props.width === "number" ? `${props.width}ch` : props.width,
    height:
      typeof props.height === "number"
        ? `calc(${props.height} * var(--line-height))`
        : props.height,
    "max-width": typeof props.maxWidth === "number" ? `${props.maxWidth}ch` : props.maxWidth,
    "max-height":
      typeof props.maxHeight === "number"
        ? `calc(${props.maxHeight} * var(--line-height))`
        : props.maxHeight,
    padding:
      props.padding !== undefined
        ? `calc(${props.padding} * var(--line-height)) ${props.padding}ch`
        : undefined,
    "padding-left": props.paddingLeft !== undefined ? `${props.paddingLeft}ch` : undefined,
    "padding-right": props.paddingRight !== undefined ? `${props.paddingRight}ch` : undefined,
    "padding-top":
      props.paddingTop !== undefined ? `calc(${props.paddingTop} * var(--line-height))` : undefined,
    "padding-bottom":
      props.paddingBottom !== undefined
        ? `calc(${props.paddingBottom} * var(--line-height))`
        : undefined,
    background: props.backgroundColor ? rgbaToCSS(props.backgroundColor) : undefined,
    "border-color": props.borderColor ? rgbaToCSS(props.borderColor) : undefined,
    top: props.top !== undefined ? `calc(${props.top} * var(--line-height))` : undefined,
    left: props.left !== undefined ? `${props.left}ch` : undefined,
    right: props.right !== undefined ? `${props.right}ch` : undefined,
    bottom: props.bottom !== undefined ? `calc(${props.bottom} * var(--line-height))` : undefined,
  });

  return (
    <div
      id={props.id}
      style={style()}
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onMouseUp}
      onMouseMove={props.onMouseMove}
      onMouseOver={props.onMouseOver}
      ref={props.ref}
    >
      {props.children}
    </div>
  );
}
