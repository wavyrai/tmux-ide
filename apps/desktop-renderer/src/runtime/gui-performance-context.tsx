import { createContext, useContext, type JSX } from "solid-js";

import type { GuiPerformanceTelemetry } from "./gui-performance-telemetry.ts";

const GuiPerformanceContext = createContext<GuiPerformanceTelemetry | null>(null);

export function GuiPerformanceProvider(props: {
  readonly telemetry: GuiPerformanceTelemetry;
  readonly children: JSX.Element;
}) {
  return (
    <GuiPerformanceContext.Provider value={props.telemetry}>
      {props.children}
    </GuiPerformanceContext.Provider>
  );
}

export function useGuiPerformanceTelemetry(): GuiPerformanceTelemetry | null {
  return useContext(GuiPerformanceContext);
}
