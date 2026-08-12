import { describe, expect, it } from "vitest";
import type { PushResourceSessionMetrics } from "@tmux-ide/daemon-client/push-resource-session";

import {
  GUI_RESOURCE_TELEMETRY_GLOBAL,
  createGuiResourceTelemetry,
} from "./gui-resource-telemetry.ts";

const metrics = (
  overrides: Partial<PushResourceSessionMetrics> = {},
): PushResourceSessionMetrics => ({
  idleWakeups: 0,
  activeInterests: 0,
  fetchesStarted: 0,
  fetchesSettled: 0,
  fetchesAborted: 0,
  lateResultsIgnored: 0,
  invalidationsObserved: 0,
  invalidationsCoalesced: 0,
  subscriptionsOpened: 0,
  subscriptionsClosed: 0,
  publications: 0,
  ...overrides,
});

describe("GUI resource telemetry", () => {
  it("keeps structurally idle and subprocess counters flat while reporting real store work", () => {
    let value = metrics();
    const telemetry = createGuiResourceTelemetry([{ getMetrics: () => value }]);
    telemetry.recordCompositionMount();
    telemetry.recordCentralShellFrameOpportunity();
    expect(telemetry.snapshot()).toEqual({
      idleWakeups: 0,
      storeInvalidations: 0,
      storePublications: 0,
      compositionMounts: 1,
      centralShellFrameOpportunities: 1,
      activeSubscriptions: 0,
      fetchesStarted: 0,
      fetchesSettled: 0,
      fetchesAborted: 0,
      rendererSubprocessLaunches: 0,
    });

    value = metrics({
      invalidationsObserved: 2,
      publications: 4,
      subscriptionsOpened: 2,
      subscriptionsClosed: 1,
      fetchesStarted: 3,
      fetchesSettled: 2,
      fetchesAborted: 1,
    });
    expect(telemetry.snapshot()).toMatchObject({
      idleWakeups: 0,
      storeInvalidations: 2,
      storePublications: 4,
      activeSubscriptions: 1,
      fetchesStarted: 3,
      fetchesSettled: 2,
      fetchesAborted: 1,
      rendererSubprocessLaunches: 0,
    });
  });

  it("publishes no global unless the debug query explicitly opts in", () => {
    const host = globalThis as unknown as Record<string, unknown>;
    delete host[GUI_RESOURCE_TELEMETRY_GLOBAL];
    const telemetry = createGuiResourceTelemetry([]);
    telemetry.exposeDebugAccessor("")();
    expect(host[GUI_RESOURCE_TELEMETRY_GLOBAL]).toBeUndefined();
    const remove = telemetry.exposeDebugAccessor("?tmuxIdeResourceTelemetry=1");
    expect(host[GUI_RESOURCE_TELEMETRY_GLOBAL]).toBeTypeOf("function");
    remove();
    expect(host[GUI_RESOURCE_TELEMETRY_GLOBAL]).toBeUndefined();
  });
});
