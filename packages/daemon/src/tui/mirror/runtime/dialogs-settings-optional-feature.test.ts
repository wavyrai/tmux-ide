import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";
import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";
import { ModalAdmissionCoordinator } from "./modal-admission-coordinator.ts";

describe("production dialogs and settings cutover", () => {
  const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");

  it("uses retained literal optional modules and no process singleton", () => {
    const registry = readFileSync(
      new URL("./application-optional-features.ts", import.meta.url),
      "utf8",
    );
    expect(registry).toContain('dialogs: () => import("../features/dialogs/feature.tsx")');
    expect(registry).toContain('settings: () => import("../features/settings/feature.ts")');
    expect(source).not.toMatch(/from\s+["']\.\.\/dialog-stack/u);
    expect(source).not.toContain("dialogStack");
    expect(source).not.toMatch(/from\s+["']\.\.\/settings-model/u);
  });

  it("reserves modal admission before every optional dialog/settings request", () => {
    expect(source).toContain('reserveModal("dialogs")');
    expect(source).toContain('reserveModal("settings")');
    expect(source).toContain("if (token) cancelPointerCaptureForModal()");
    expect(source).toContain("if (!token || !modalAdmission.isCurrent(token)) return undefined");
    expect(source).toContain("dialogOpen: modalAdmissionSnapshot().reserved");
    expect(source).toContain("if (modalAdmissionSnapshot().reserved) return;");
  });

  it("gates pointer routing before every captured drag path", () => {
    const routeStart = source.indexOf("const route = (e: RouteEvent) =>");
    const modalGate = source.indexOf("if (modalAdmissionSnapshot().reserved)", routeStart);
    const sidebarCapture = source.indexOf("routeSidebarResizePointer(e, true)", routeStart);
    const paneCapture = source.indexOf("routeCapturedDragPointer(e)", routeStart);
    expect(modalGate).toBeGreaterThan(routeStart);
    expect(modalGate).toBeLessThan(sidebarCapture);
    expect(modalGate).toBeLessThan(paneCapture);
    expect(source).toContain("cancelModalPointerCapture({");
    expect(source).toContain("cancelBorderResize: () => resizeTransaction.cancelDrag()");
  });

  it("keeps deferred feature modules outside the root first-frame closure", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      process.cwd(),
      ["src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    for (const deferred of [
      "src/tui/mirror/features/dialogs/feature.tsx",
      "src/tui/mirror/features/dialogs/session.ts",
      "src/tui/mirror/features/settings/feature.ts",
      "src/tui/mirror/features/settings/session.ts",
      "src/tui/mirror/settings-model.ts",
      "src/tui/mirror/dialog-stack-core.ts",
    ]) {
      expect(graph.files).not.toContain(deferred);
    }
  });

  it("disposes settings before dialogs before the optional registry", () => {
    expect(source.indexOf("settingsSession()?.dispose()")).toBeLessThan(
      source.indexOf("dialogsSession()?.dispose()"),
    );
    expect(source.indexOf("dialogsSession()?.dispose()")).toBeLessThan(
      source.indexOf("optionalFeatures.dispose()"),
    );
  });

  it("fences cancellation before readiness and admits an explicit retry", async () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const admission = new ModalAdmissionCoordinator<"dialogs">();
    const cancelled = admission.reserve("dialogs")!;
    admission.markLoading(cancelled);
    const firstLoad = registry.request("dialogs");
    expect(admission.release(cancelled)).toBe(true);
    registry.admit();
    const feature = await firstLoad;
    expect(feature?.createDialogFeatureSession).toBeTypeOf("function");
    expect(admission.markReady(cancelled)).toBe(false);

    const retry = admission.reserve("dialogs")!;
    admission.markLoading(retry);
    expect(await registry.request("dialogs")).toBe(feature);
    expect(admission.markReady(retry)).toBe(true);
    admission.dispose();
    registry.dispose();
    expect(admission.release(retry)).toBe(false);
  });
});
