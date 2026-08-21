import {
  ActionContractsZ,
  type ActionInput,
  type ActionName,
  type ActionResult,
} from "@tmux-ide/contracts";

export interface OwnerActionClientOptions<Name extends ActionName> {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly name: Name;
  readonly input: ActionInput<Name>;
  readonly operationId?: string | null;
  /** Stable renderer principal for generation-scoped multi-client handoffs. */
  readonly hostClientId?: string | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class DaemonActionInvocationError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(error: { code: string; message: string; details?: unknown }) {
    super(error.message);
    this.name = "DaemonActionInvocationError";
    this.code = error.code;
    this.details = error.details ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Dispatch one owner-authorized daemon action without importing daemon runtime
 * code. A stable operation ID permits one retry after an ambiguous transport
 * failure; the daemon remains the idempotency authority.
 */
export async function dispatchOwnerAction<Name extends ActionName>(
  options: OwnerActionClientOptions<Name>,
): Promise<ActionResult<Name> | null> {
  const request = options.fetch ?? fetch;
  const contract = ActionContractsZ[options.name];
  const input = contract.input.parse(options.input);
  const operationId = options.operationId ?? null;
  const maximumAttempts = operationId ? 2 : 1;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let body: unknown;
    try {
      const response = await request(
        `${options.baseUrl}/api/v2/action/${encodeURIComponent(options.name)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.ownerToken}`,
            ...(operationId ? { "X-Tmux-Ide-Operation-Id": operationId } : {}),
            ...(options.hostClientId ? { "X-Tmux-Ide-Host-Client-Id": options.hostClientId } : {}),
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
        },
      );
      body = await response.json();
    } catch {
      continue;
    }

    if (isRecord(body) && body.ok === false && isRecord(body.error)) {
      const code = body.error.code;
      const message = body.error.message;
      if (typeof code === "string" && typeof message === "string") {
        throw new DaemonActionInvocationError({
          code,
          message,
          ...(body.error.details !== undefined ? { details: body.error.details } : {}),
        });
      }
    }
    if (isRecord(body) && body.ok === true && "result" in body) {
      const parsed = contract.result.safeParse(body.result);
      if (parsed.success) return parsed.data as ActionResult<Name>;
    }
  }
  return null;
}
