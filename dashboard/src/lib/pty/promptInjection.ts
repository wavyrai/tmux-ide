/**
 * Bracketed-paste payload helper (G20-P1).
 *
 * Multiline payloads are wrapped in `ESC [200~ … ESC [201~` so the
 * receiving terminal treats them atomically — no auto-indent, no
 * per-newline command interpretation. Claude has its own paste
 * handling, so we pass through plain text for that provider.
 */

export interface PromptInjectionArgs {
  providerId: string | undefined;
  text: string;
}

export function buildPromptInjectionPayload(args: PromptInjectionArgs): string {
  const trimmed = args.text.trim();
  const isMultiline = trimmed.includes("\n");
  const wrap = args.providerId !== "claude" && isMultiline;
  if (!wrap) return trimmed;
  return `\x1b[200~${trimmed}\x1b[201~`;
}

type SendInput = (data: string) => Promise<unknown> | void;

export async function pastePromptInjection(
  args: PromptInjectionArgs & { sendInput: SendInput },
): Promise<void> {
  const payload = buildPromptInjectionPayload({
    providerId: args.providerId,
    text: args.text,
  });
  if (!payload) return;
  await args.sendInput(payload);
}
