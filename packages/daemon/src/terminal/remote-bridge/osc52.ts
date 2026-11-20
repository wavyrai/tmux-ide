import { REMOTE_CLIPBOARD_MAX_BYTES } from "@tmux-ide/contracts";

/** The OSC number programs use to set (or query) the terminal clipboard. */
export const OSC_CLIPBOARD = 52;

/**
 * One OSC 52 sequence's data, after the parser removed `ESC ] 52 ;` and the
 * terminator: `<selections>;<base64 | ?>`.
 *
 * - `query`: the program asked to read the clipboard. Nothing ever answers it.
 * - `ignored`: not for the clipboard (primary, secondary, cut buffers), a clear,
 *   or empty text.
 * - `invalid`: not base64, or not UTF-8 text.
 * - `too-large`: more than {@link REMOTE_CLIPBOARD_MAX_BYTES} decoded bytes,
 *   judged from the payload length before decoding.
 */
export type Osc52Parse =
  | { readonly kind: "text"; readonly text: string; readonly bytes: number }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "query" }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

const SELECTION = /^[cpqs0-7]*$/;
const BASE64 = /^[A-Za-z0-9+/]*$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function parseOsc52(data: string): Osc52Parse {
  const separator = data.indexOf(";");
  if (separator < 0) return { kind: "ignored" };
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (payload === "?") return { kind: "query" };
  if (!SELECTION.test(selection)) return { kind: "ignored" };
  if (selection !== "" && !selection.includes("c")) return { kind: "ignored" };

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const body = payload.length - padding;
  // Whole groups give 3 bytes; a trailing group of 2 or 3 characters gives 1 or 2.
  const bytes = Math.floor(body / 4) * 3 + Math.max(0, (body % 4) - 1);
  if (bytes > REMOTE_CLIPBOARD_MAX_BYTES) return { kind: "too-large", bytes };
  if (body % 4 === 1) return { kind: "invalid" };
  if (padding > 0 && payload.length % 4 !== 0) return { kind: "invalid" };
  if (!BASE64.test(payload.slice(0, body))) return { kind: "invalid" };

  let text: string;
  try {
    text = UTF8.decode(Buffer.from(payload, "base64"));
  } catch {
    return { kind: "invalid" };
  }
  text = text.replaceAll("\0", "");
  if (text === "") return { kind: "ignored" };
  return { kind: "text", text, bytes: Buffer.byteLength(text, "utf8") };
}
