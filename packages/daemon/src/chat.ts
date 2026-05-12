/**
 * tmux-ide chat <sub> — CLI surface for multi-agent chat threads (T078).
 *
 * Currently exposes `chat session add` so the lead pane (or an agent) can
 * register a new Session against a Thread without leaving the terminal.
 *
 * The CLI talks to the chat subsystem via the canonical packages/daemon
 * exports — no separate REST round-trip — so this command works whether
 * the daemon is running or not.
 */
import { IdeError } from "./lib/errors.ts";

type SessionRoleArg =
  | "lead"
  | "teammate"
  | "planner"
  | "validator"
  | "researcher";

const ROLES: ReadonlySet<SessionRoleArg> = new Set([
  "lead",
  "teammate",
  "planner",
  "validator",
  "researcher",
]);

export interface ChatCommandArgs {
  sub: string | undefined;
  args: string[];
  json: boolean;
  provider: string | undefined;
  role: string | undefined;
  name: string | undefined;
}

export async function chatCommand(opts: ChatCommandArgs): Promise<void> {
  if (opts.sub === "events") {
    await chatEventsSubcommand(opts);
    return;
  }
  if (opts.sub !== "session") {
    throw new IdeError(
      `Unknown chat subcommand: ${opts.sub ?? "(none)"}\n` +
        `Usage:\n` +
        `  tmux-ide chat session add <thread-id> --provider <name> --role <role>\n` +
        `  tmux-ide chat events <thread-id> [--json]`,
      { code: "USAGE", exitCode: 1 },
    );
  }
  const action = opts.args[0];
  if (action !== "add") {
    throw new IdeError(
      `Unknown chat session action: ${action ?? "(none)"}\n` +
        `Usage: tmux-ide chat session add <thread-id> --provider <name> --role <role>`,
      { code: "USAGE", exitCode: 1 },
    );
  }
  const threadId = opts.args[1];
  if (!threadId) {
    throw new IdeError(
      `chat session add requires a thread id\n` +
        `Usage: tmux-ide chat session add <thread-id> --provider <name> --role <role>`,
      { code: "USAGE", exitCode: 1 },
    );
  }
  const provider = opts.provider;
  if (!provider) {
    throw new IdeError(`chat session add requires --provider <name>`, {
      code: "USAGE",
      exitCode: 1,
    });
  }
  const role = opts.role;
  if (role && !ROLES.has(role as SessionRoleArg)) {
    throw new IdeError(
      `Unknown --role: ${role}\nKnown roles: ${[...ROLES].join(", ")}`,
      { code: "USAGE", exitCode: 1 },
    );
  }

  const { getDefaultThreadManager, getDefaultThreadStore } = await import(
    "./chat/defaults.ts"
  );
  const store = getDefaultThreadStore();
  const thread = await store.get(threadId);
  if (!thread) {
    throw new IdeError(`Chat thread "${threadId}" not found`, {
      code: "NOT_FOUND",
      exitCode: 1,
    });
  }
  const manager = getDefaultThreadManager();
  const session = manager.createSession({
    threadId,
    provider: { kind: provider as "claude-code" | "codex" },
    ...(role ? { role: role as SessionRoleArg } : {}),
    ...(opts.name ? { displayName: opts.name } : {}),
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ session }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Added session ${session.id} (${session.role ?? "unset"}) to thread ${threadId}\n`,
  );
}

/**
 * `tmux-ide chat events <thread-id> [--json]` — replay events for a
 * thread from the persistent log (T090). Observability hook for T095:
 * lets the lead pane / engineer see exactly what was persisted for a
 * given thread, in append order.
 */
async function chatEventsSubcommand(opts: ChatCommandArgs): Promise<void> {
  const threadId = opts.args[0];
  if (!threadId) {
    throw new IdeError(
      `chat events requires a thread id\n` +
        `Usage: tmux-ide chat events <thread-id> [--json]`,
      { code: "USAGE", exitCode: 1 },
    );
  }
  const { getDefaultChatEventStore } = await import(
    "./chat/defaults.ts"
  );
  const store = getDefaultChatEventStore();
  const events = store.readByStream(threadId);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ threadId, events }, null, 2)}\n`);
    return;
  }
  if (events.length === 0) {
    process.stdout.write(`No events for thread ${threadId}\n`);
    return;
  }
  for (const e of events) {
    const payload = JSON.stringify(e.event);
    process.stdout.write(
      `#${e.sequence} v${e.streamVersion} ${e.occurredAt} ${e.actorKind} ${e.eventType ?? e.event.type}\n  ${payload}\n`,
    );
  }
}
