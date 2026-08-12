/**
 * Complete deferred Changes capability.
 *
 * Keep this as the literal optional-feature import root so the controller,
 * projection/model helpers, and OpenTUI renderer enter both source and compiled
 * Bun processes only after terminal readiness and explicit Changes demand.
 */
export { ChangesSurface, type ChangesSurfaceProps } from "../../changes-surface.tsx";
export { createChangesFeatureController } from "./controller.ts";
export type {
  ChangesContextTarget,
  ChangesFeatureHost,
  ChangesFeatureSession,
  ChangesHoverTarget,
  ChangesKeyEvent,
  ChangesPointerEvent,
  ChangesScrollState,
  ChangesWorkspaceIdentity,
} from "./contract.ts";
