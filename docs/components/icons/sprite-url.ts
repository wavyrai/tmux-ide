import sprite from "./sprite.svg";

/** The content-hashed URL of the icon sprite; safe in server and client modules. */
export const SPRITE: string = typeof sprite === "string" ? sprite : (sprite as { src: string }).src;
