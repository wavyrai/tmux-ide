import type {
  PaletteDynamicFacts,
  PaletteFeatureSession,
  PaletteHostIntent,
  PaletteHostPort,
  PaletteWorkspaceIdentity,
} from "../features/palette/contract.ts";
import type { ApplicationOptionalFeatures } from "./application-optional-features.ts";
import type {
  ModalAdmissionCoordinator,
  ModalAdmissionToken,
} from "./modal-admission-coordinator.ts";
import type { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

export type PaletteProductionLoadState = "idle" | "loading" | "ready" | "error";
type PaletteModalKind = "dialogs" | "settings" | "palette";

export interface PaletteProductionHostSources {
  readonly width: () => number;
  readonly height: () => number;
  readonly identity: () => PaletteWorkspaceIdentity;
  readonly facts: () => PaletteDynamicFacts;
  readonly loadRepoFiles: PaletteHostPort["loadRepoFiles"];
  readonly loadBuffers: PaletteHostPort["loadBuffers"];
  readonly disabledReason?: PaletteHostPort["disabledReason"];
}

export function createProductionPaletteHostPort(
  sources: PaletteProductionHostSources,
  dispatch: PaletteHostPort["dispatch"],
): PaletteHostPort {
  return Object.freeze({
    width: sources.width,
    height: sources.height,
    identity: sources.identity,
    facts: sources.facts,
    loadRepoFiles: sources.loadRepoFiles,
    loadBuffers: sources.loadBuffers,
    dispatch,
    disabledReason: sources.disabledReason,
  });
}

export interface PaletteProductionControllerOptions {
  readonly registry: OptionalFeatureRegistry<ApplicationOptionalFeatures>;
  readonly admission: ModalAdmissionCoordinator<PaletteModalKind>;
  readonly reserveAdmission: () => ModalAdmissionToken<PaletteModalKind> | null;
  readonly sources: PaletteProductionHostSources;
  readonly publish: {
    readonly open: (value: boolean) => void;
    readonly loadState: (value: PaletteProductionLoadState) => void;
    readonly loadError: (value: string) => void;
    readonly feature: (value: ApplicationOptionalFeatures["palette"]) => void;
    readonly session: (value: PaletteFeatureSession) => void;
    readonly clearHover: () => void;
  };
  readonly execute: {
    readonly recordUsage: (usageKey: string) => void;
    readonly action: (intent: Extract<PaletteHostIntent, { kind: "action" }>) => void;
    readonly settings: (intent: Extract<PaletteHostIntent, { kind: "settings" }>) => void;
    readonly pasteBuffer: (bufferName: string) => void;
  };
}

/**
 * Production authority for the palette's deferred module, modal reservation,
 * feature session, and semantic execution boundary. application-root and the
 * native renderer regression both drive this exact object.
 */
export function createPaletteProductionController(options: PaletteProductionControllerOptions) {
  let token: ModalAdmissionToken<PaletteModalKind> | null = null;
  let featureRequest: Promise<ApplicationOptionalFeatures["palette"] | undefined> | null = null;
  let session: PaletteFeatureSession | undefined;
  let disposed = false;

  const release = () => {
    options.publish.open(false);
    if (token && options.admission.isCurrent(token)) options.admission.release(token);
    token = null;
  };
  const dispatch = (intent: PaletteHostIntent) => {
    if (intent.kind === "close") {
      release();
      return;
    }
    if (intent.kind === "paste-buffer") {
      options.execute.pasteBuffer(intent.bufferName);
      return;
    }
    options.execute.recordUsage(intent.usageKey);
    if (intent.kind === "settings") options.execute.settings(intent);
    else options.execute.action(intent);
  };
  const ensure = async (): Promise<PaletteFeatureSession | undefined> => {
    if (disposed) return undefined;
    if (session) {
      if (token && options.admission.isCurrent(token)) options.admission.markReady(token);
      options.publish.loadState("ready");
      return session;
    }
    const authority = token;
    if (!authority || !options.admission.isCurrent(authority)) return undefined;
    options.publish.loadState("loading");
    options.admission.markLoading(authority);
    const request = featureRequest ?? options.registry.request("palette");
    featureRequest = request;
    try {
      const feature = await request;
      if (!feature || disposed || !options.admission.isCurrent(authority)) return undefined;
      const owned = feature.createPaletteFeatureSession(
        createProductionPaletteHostPort(options.sources, dispatch),
      );
      if (disposed || !options.admission.isCurrent(authority)) {
        owned.dispose();
        return undefined;
      }
      session = owned;
      options.publish.feature(feature);
      options.publish.session(owned);
      options.publish.loadState("ready");
      options.publish.loadError("");
      options.admission.markReady(authority);
      return owned;
    } catch (error) {
      if (featureRequest === request) featureRequest = null;
      const message =
        error instanceof Error ? error.message : "The command palette is unavailable.";
      options.publish.loadState("error");
      options.publish.loadError(message);
      if (options.admission.isCurrent(authority)) options.admission.markError(authority, error);
      return undefined;
    }
  };
  const open = () => {
    if (disposed || token) return;
    const authority = options.reserveAdmission();
    if (!authority) return;
    token = authority;
    options.publish.clearHover();
    options.publish.open(true);
    void ensure().then((owned) => owned?.openPalette());
  };
  const close = (reason: "escape" | "outside" | "action" = "escape") => {
    if (session?.open()) session.close(reason);
    else release();
  };

  return Object.freeze({
    open,
    close,
    retry() {
      close("escape");
      featureRequest = null;
      open();
    },
    switchWorkspace(identity: PaletteWorkspaceIdentity) {
      session?.switchWorkspace(identity);
    },
    currentSession: () => session,
    dispose() {
      if (disposed) return;
      disposed = true;
      session?.dispose();
      session = undefined;
      release();
    },
  });
}

export type PaletteProductionController = ReturnType<typeof createPaletteProductionController>;
