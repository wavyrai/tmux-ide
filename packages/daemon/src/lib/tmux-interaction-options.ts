import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Private tmux pane options used only to correlate/suppress interaction hooks. */
export const INTERNAL_SEND_OPERATION_OPTION = "@tmux_ide_send_operation";
export const INTERNAL_READ_OPERATION_OPTION = "@tmux_ide_read_operation";

const INTERNAL_READ_PREFIX = "tmux-ide-internal-read-v2:";
const INTERNAL_READ_TTL_MS = 10_000;
const INTERNAL_READ_CAPACITY = 512;
const internalReads = new Map<string, { readonly paneId: string; readonly expiresAt: number }>();

const AUTHENTICATED_INTERNAL_READ_PREFIX = "tmux-ide-internal-read-v3:";
const AUTHENTICATED_INTERNAL_READ_NONCE_BYTES = 12;
const AUTHENTICATED_INTERNAL_READ_SIGNATURE_BYTES = 32;
const AUTHENTICATED_INTERNAL_READ_CLOCK_SKEW_MS = 1_000;
const AUTHENTICATED_INTERNAL_READ_PATTERN = new RegExp(
  `^${AUTHENTICATED_INTERNAL_READ_PREFIX}([0-9a-z]+):([0-9a-f]{${
    AUTHENTICATED_INTERNAL_READ_NONCE_BYTES * 2
  }}):([A-Za-z0-9_-]{43})$`,
  "u",
);

function authenticatedReadPayload(
  daemonInstanceId: string,
  runtimePaneId: string,
  issuedAtMs: number,
  nonce: string,
): string {
  return `${daemonInstanceId}\u0000${runtimePaneId}\u0000${issuedAtMs}\u0000${nonce}`;
}

function authenticatedReadSignature(ownerToken: string, payload: string): Buffer {
  return createHmac("sha256", ownerToken).update(payload).digest();
}

/**
 * Mint a short-lived, pane-bound proof that a separate tmux-ide process owns
 * this capture. The daemon owner token never enters tmux: only a one-use HMAC
 * does. This is the cross-process counterpart to {@link registerInternalReadOperation}.
 */
export function createAuthenticatedInternalReadOperation(
  runtimePaneId: string,
  authority: { readonly daemonInstanceId: string; readonly ownerToken: string },
  nowMs = Date.now(),
): string {
  if (!/^%(?:0|[1-9][0-9]*)$/u.test(runtimePaneId)) {
    throw new Error("authenticated internal reads require a runtime pane id");
  }
  if (!authority.daemonInstanceId || !authority.ownerToken) {
    throw new Error("authenticated internal reads require daemon authority");
  }
  const issuedAt = Math.floor(nowMs);
  const nonce = randomBytes(AUTHENTICATED_INTERNAL_READ_NONCE_BYTES).toString("hex");
  const payload = authenticatedReadPayload(
    authority.daemonInstanceId,
    runtimePaneId,
    issuedAt,
    nonce,
  );
  const signature = authenticatedReadSignature(authority.ownerToken, payload).toString("base64url");
  return `${AUTHENTICATED_INTERNAL_READ_PREFIX}${issuedAt.toString(36)}:${nonce}:${signature}`;
}

/** Generation-local verifier: valid proofs are consumed once and never replayable. */
export class AuthenticatedInternalReadVerifier {
  readonly #daemonInstanceId: string;
  readonly #ownerToken: string | null;
  readonly #consumed = new Map<string, number>();

  constructor(authority: {
    readonly daemonInstanceId: string;
    readonly ownerToken?: string | null;
  }) {
    this.#daemonInstanceId = authority.daemonInstanceId;
    this.#ownerToken = authority.ownerToken ?? null;
  }

  consume(
    marker: string | null,
    runtimePaneId: string,
    operationKind: "workspace.pane.send" | "workspace.pane.read",
    nowMs = Date.now(),
  ): boolean {
    if (!this.#ownerToken || operationKind !== "workspace.pane.read" || marker === null)
      return false;
    const match = AUTHENTICATED_INTERNAL_READ_PATTERN.exec(marker);
    if (!match) return false;
    const issuedAt = Number.parseInt(match[1]!, 36);
    const nonce = match[2]!;
    if (!Number.isSafeInteger(issuedAt)) return false;
    const age = nowMs - issuedAt;
    if (age < -AUTHENTICATED_INTERNAL_READ_CLOCK_SKEW_MS || age > INTERNAL_READ_TTL_MS)
      return false;

    for (const [seenNonce, expiresAt] of this.#consumed) {
      if (expiresAt <= nowMs) this.#consumed.delete(seenNonce);
    }
    if (this.#consumed.has(nonce)) return false;

    const payload = authenticatedReadPayload(
      this.#daemonInstanceId,
      runtimePaneId,
      issuedAt,
      nonce,
    );
    const expected = authenticatedReadSignature(this.#ownerToken, payload);
    let actual: Buffer;
    try {
      actual = Buffer.from(match[3]!, "base64url");
    } catch {
      return false;
    }
    if (
      actual.byteLength !== AUTHENTICATED_INTERNAL_READ_SIGNATURE_BYTES ||
      !timingSafeEqual(actual, expected)
    ) {
      return false;
    }
    while (this.#consumed.size >= INTERNAL_READ_CAPACITY) {
      this.#consumed.delete(this.#consumed.keys().next().value!);
    }
    this.#consumed.set(nonce, issuedAt + INTERNAL_READ_TTL_MS);
    return true;
  }
}

/**
 * Register one bounded, one-use product capture. A marker-shaped tmux option
 * alone is never trusted: the observer must redeem this in-memory fact for the
 * exact pane and read operation before it suppresses any external activity.
 */
export function registerInternalReadOperation(runtimePaneId: string): string {
  const now = Date.now();
  for (const [marker, registration] of internalReads) {
    if (registration.expiresAt <= now) internalReads.delete(marker);
  }
  while (internalReads.size >= INTERNAL_READ_CAPACITY) {
    internalReads.delete(internalReads.keys().next().value!);
  }
  const marker = `${INTERNAL_READ_PREFIX}${randomUUID()}`;
  internalReads.set(marker, { paneId: runtimePaneId, expiresAt: now + INTERNAL_READ_TTL_MS });
  return marker;
}

/**
 * Retire one failed owner-local read proof without consuming any newer pane
 * operation. The tmux option has a separate compare-and-unset fence; this is
 * only the matching in-memory half of that retirement.
 */
export function retireInternalReadOperation(marker: string, runtimePaneId: string): boolean {
  const registration = internalReads.get(marker);
  if (!registration || registration.paneId !== runtimePaneId) return false;
  internalReads.delete(marker);
  return true;
}

export function consumeInternalReadOperation(
  marker: string | null,
  runtimePaneId: string,
  operationKind: "workspace.pane.send" | "workspace.pane.read",
): boolean {
  if (marker === null || !marker.startsWith(INTERNAL_READ_PREFIX)) return false;
  const registration = internalReads.get(marker);
  if (!registration) return false;
  internalReads.delete(marker);
  return (
    operationKind === "workspace.pane.read" &&
    registration.paneId === runtimePaneId &&
    registration.expiresAt > Date.now()
  );
}
