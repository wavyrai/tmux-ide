import { z } from "zod";
import {
  captureRecent as bridgeCaptureRecent,
  capturePane as bridgeCapturePane,
  sendKeys as bridgeSendKeys,
} from "@tmux-ide/tmux-bridge";
import { listSessionPanes, type PaneInfo } from "../../widgets/lib/pane-comms.ts";
import { resolvePane } from "../../send.ts";

const TargetSchema = z
  .string()
  .min(1)
  .describe("Pane target: pane id (%N), @ide_name, exact title, role, or partial title match.");

export const SendToPaneInputSchema = z.object({
  target: TargetSchema,
  text: z.string().describe("Literal text to type into the pane."),
  enter: z
    .boolean()
    .optional()
    .describe("Append an Enter keystroke after the text. Defaults to true."),
});

export const ReadPaneInputSchema = z.object({
  target: TargetSchema,
  lines: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Number of recent lines to return. Defaults to 50."),
});

export const CapturePaneInputSchema = z.object({
  target: TargetSchema,
  scrollback: z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .describe("Scrollback depth in lines. Defaults to 5000."),
});

export type SendToPaneInput = z.infer<typeof SendToPaneInputSchema>;
export type ReadPaneInput = z.infer<typeof ReadPaneInputSchema>;
export type CapturePaneInput = z.infer<typeof CapturePaneInputSchema>;

export type ToolResult<T> = { ok: true; output: T } | { ok: false; error: string };

export interface SendToPaneOutput {
  paneId: string;
  title: string;
  bytes: number;
  enter: boolean;
}

export interface ReadPaneOutput {
  paneId: string;
  title: string;
  lines: number;
  content: string;
}

export interface CapturePaneOutput {
  paneId: string;
  title: string;
  scrollback: number;
  content: string;
}

export interface TmuxToolDeps {
  listPanes?: (session: string) => PaneInfo[];
  sendKeys?: (target: string, text: string, opts: { enter: boolean }) => void;
  captureRecent?: (target: string, lines: number) => string;
  capturePane?: (target: string, opts: { scrollback: number }) => string;
}

function resolveOrFail(
  session: string,
  target: string,
  listPanes: NonNullable<TmuxToolDeps["listPanes"]>,
): PaneInfo {
  const panes = listPanes(session);
  if (panes.length === 0) {
    throw new Error(`tmux session "${session}" has no panes (is the session running?)`);
  }
  const pane = resolvePane(panes, target);
  if (!pane) {
    const available = panes
      .map((p) => `${p.id} ${p.name ?? p.title}${p.role ? ` (${p.role})` : ""}`)
      .join(", ");
    throw new Error(`Pane "${target}" not found. Available: ${available}`);
  }
  return pane;
}

async function safe<T>(fn: () => Promise<T> | T): Promise<ToolResult<T>> {
  try {
    return { ok: true, output: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface TmuxTool<TIn, TOut> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TIn>;
  jsonSchema: Record<string, unknown>;
  handler: (input: TIn) => Promise<ToolResult<TOut>>;
}

export function createTmuxTools(
  session: string,
  deps: TmuxToolDeps = {},
): {
  send_to_pane: TmuxTool<SendToPaneInput, SendToPaneOutput>;
  read_pane: TmuxTool<ReadPaneInput, ReadPaneOutput>;
  capture_pane: TmuxTool<CapturePaneInput, CapturePaneOutput>;
} {
  const listPanes = deps.listPanes ?? listSessionPanes;
  const sendKeys =
    deps.sendKeys ?? ((target, text, opts) => bridgeSendKeys(target, text, { enter: opts.enter }));
  const captureRecent =
    deps.captureRecent ?? ((target, lines) => bridgeCaptureRecent(target, lines));
  const capturePane =
    deps.capturePane ??
    ((target, opts) => bridgeCapturePane(target, { scrollback: opts.scrollback }));

  return {
    send_to_pane: {
      name: "send_to_pane",
      description:
        "Send literal text to a tmux pane. Resolves the target by pane id (%N), @ide_name, title, role, or partial title match. Appends Enter unless `enter: false`.",
      inputSchema: SendToPaneInputSchema,
      jsonSchema: zodToJsonSchema(SendToPaneInputSchema, "send_to_pane"),
      async handler(input) {
        return safe(() => {
          const parsed = SendToPaneInputSchema.parse(input);
          const enter = parsed.enter ?? true;
          const pane = resolveOrFail(session, parsed.target, listPanes);
          sendKeys(pane.id, parsed.text, { enter });
          return {
            paneId: pane.id,
            title: pane.title,
            bytes: Buffer.byteLength(parsed.text, "utf8"),
            enter,
          } satisfies SendToPaneOutput;
        });
      },
    },
    read_pane: {
      name: "read_pane",
      description:
        "Read the last N lines from a tmux pane (default 50). Resolves the target by pane id (%N), @ide_name, title, role, or partial title match.",
      inputSchema: ReadPaneInputSchema,
      jsonSchema: zodToJsonSchema(ReadPaneInputSchema, "read_pane"),
      async handler(input) {
        return safe(() => {
          const parsed = ReadPaneInputSchema.parse(input);
          const lines = parsed.lines ?? 50;
          const pane = resolveOrFail(session, parsed.target, listPanes);
          const content = captureRecent(pane.id, lines);
          return {
            paneId: pane.id,
            title: pane.title,
            lines,
            content,
          } satisfies ReadPaneOutput;
        });
      },
    },
    capture_pane: {
      name: "capture_pane",
      description:
        "Capture the scrollback buffer of a tmux pane (default 5000 lines). Resolves the target by pane id (%N), @ide_name, title, role, or partial title match.",
      inputSchema: CapturePaneInputSchema,
      jsonSchema: zodToJsonSchema(CapturePaneInputSchema, "capture_pane"),
      async handler(input) {
        return safe(() => {
          const parsed = CapturePaneInputSchema.parse(input);
          const scrollback = parsed.scrollback ?? 5000;
          const pane = resolveOrFail(session, parsed.target, listPanes);
          const content = capturePane(pane.id, { scrollback });
          return {
            paneId: pane.id,
            title: pane.title,
            scrollback,
            content,
          } satisfies CapturePaneOutput;
        });
      },
    },
  };
}

/**
 * Convert a Zod schema to a JSON Schema document for ACP tool advertisement.
 * Uses Zod 4's built-in converter so we faithfully expose `optional`, `min`,
 * `max`, `int`, etc. without re-implementing the internals.
 */
function zodToJsonSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  name: string,
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return { title: name, additionalProperties: false, ...json };
}
