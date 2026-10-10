import { randomUUID } from "node:crypto";
import { parseLayoutTree, type LayoutTreeNode } from "../terminal/protocol/layout-parse.ts";
import {
  resizeNativeSplit,
  type NativeSplitResizeRequest,
  type NativeSplitResizeResult,
} from "../terminal/protocol/native-split-resize.ts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import {
  nativeOperationWrapperArgs,
  type NativeOperationSessionGuard,
} from "./native-operation-command.ts";
import { decodeNativeOperationInvocation } from "./native-operation-reply.ts";
import type { WorkspaceTmuxRunOptions } from "./workspace-pane-creation.ts";

/** Internal, daemon-resolved identities; never accept this object from a renderer. */
export interface GuardedNativeSplitResizeAuthority {
  readonly operationId: string;
  readonly serverEpoch: string;
  readonly session: NativeOperationSessionGuard;
  readonly anchor: Readonly<{ paneId: string; paneBirthId: string }>;
  /** Must revalidate generation, semantic lifetimes and the exact geometry lease. */
  readonly authorizeBeforeEffect: () => void;
}
export type GuardedNativeSplitResizeResult =
  | NativeSplitResizeResult
  | { status: "refused"; reason: "invalid-authority" | "authority-retired" };

type Observation = Pick<
  OwnerInteractionObservation,
  | "ownedOperationTransport"
  | "ownedOperationEpochGuard"
  | "ownedOperationPaneGuard"
  | "ownedOperationSessionGuard"
  | "nativeServerEpoch"
>;

function hasPane(tree: LayoutTreeNode, paneId: string): boolean {
  return tree.kind === "leaf"
    ? tree.id === paneId
    : tree.children.some((child) => hasPane(child, paneId));
}

/** No stock fallback, journal completion claim or retry. The owner must supply a
 * bounded synchronous raw pinned runner; it must not enqueue work after returning.
 * The native wrapper guards server/session/pane lifetimes, while the split child
 * atomically checks session membership and exact layout before changing geometry.
 * Successful readback still needs canonical publication before a GUI settles. */
export function createGuardedNativeSplitResize(options: {
  readonly observation: () => Observation | null;
  readonly runPinnedTmux: (args: readonly string[], options?: WorkspaceTmuxRunOptions) => string;
}) {
  return async (
    request: NativeSplitResizeRequest,
    authority: GuardedNativeSplitResizeAuthority,
  ): Promise<GuardedNativeSplitResizeResult> => {
    let captured: GuardedNativeSplitResizeAuthority;
    let input: NativeSplitResizeRequest;
    try {
      captured = {
        ...authority,
        session: { ...authority.session },
        anchor: { ...authority.anchor },
      };
      input = { ...request, path: [...request.path] };
      const tree = parseLayoutTree(input.expectedLayout);
      if (
        input.sessionId !== captured.session.id ||
        typeof captured.authorizeBeforeEffect !== "function" ||
        !tree ||
        !hasPane(tree, captured.anchor.paneId)
      )
        return { status: "refused", reason: "invalid-authority" };
      // Validate all lifetime guards before probing or dispatching any command.
      nativeOperationWrapperArgs(
        captured.operationId,
        [["tmux-ide-resize-split", "-V"]],
        captured.serverEpoch,
        captured.anchor,
        captured.session,
      );
    } catch {
      return { status: "refused", reason: "invalid-authority" };
    }
    const observer = options.observation();
    const supported = () =>
      observer !== null &&
      options.observation() === observer &&
      observer.ownedOperationTransport &&
      observer.ownedOperationEpochGuard &&
      observer.ownedOperationPaneGuard &&
      observer.ownedOperationSessionGuard &&
      observer.nativeServerEpoch === captured.serverEpoch;
    if (!supported()) return { status: "refused", reason: "unsupported" };
    let mutationDispatched = false;
    let authorityRetired = false;
    const result = await resizeNativeSplit(input, (command) => {
      const probe = command.length === 2 && command[1] === "-V";
      const operationId = probe ? randomUUID() : captured.operationId;
      const args = [
        "tmux-ide-events",
        "-i",
        ";",
        ...nativeOperationWrapperArgs(
          operationId,
          [command],
          captured.serverEpoch,
          captured.anchor,
          captured.session,
        ),
      ];
      try {
        if (!supported()) throw new Error("Native owner retired");
        captured.authorizeBeforeEffect();
      } catch {
        authorityRetired = true;
        throw new Error("Split resize authority retired");
      }
      // There is no await between final authorization and synchronous dispatch.
      if (!probe) mutationDispatched = true;
      const raw = options.runPinnedTmux(args, { preserveTrailingNewlines: true });
      if (Buffer.byteLength(raw, "utf8") > 16 * 1024 + 2050)
        throw new Error("Split resize response exceeds bounds");
      return decodeNativeOperationInvocation(raw, {
        serverEpoch: captured.serverEpoch,
        operationId,
      }).output;
    });
    if (authorityRetired && !mutationDispatched)
      return { status: "refused", reason: "authority-retired" };
    return result;
  };
}
