import { isAbsolute, join, resolve } from "node:path";

const HMAC = /^[0-9a-f]{64}$/u;

export type ApplicationHostFocusControlCapability = Readonly<{
  enabled: boolean;
  path: string | null;
  runtimeRoot: string | null;
  key: string | null;
  observation: Readonly<{
    capability: boolean;
    detail: boolean;
    path: boolean;
    root: boolean;
    key: boolean;
    trace: boolean;
    enabled: boolean;
  }>;
}>;

export function resolveApplicationHostFocusControlCapability(
  environment: NodeJS.ProcessEnv,
): ApplicationHostFocusControlCapability {
  const rawPath = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_PATH?.trim() ?? "";
  const rawRoot = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_ROOT?.trim() ?? "";
  const rawKey = environment.TMUX_IDE_PERFORMANCE_TRACE_INPUT_FINGERPRINT_KEY?.trim() ?? "";
  const capability = environment.TMUX_IDE_CARD5_HOST_FOCUS_CONTROL_CAPABILITY === "1";
  const detail = environment.TMUX_IDE_PERFORMANCE_TRACE_DETAIL === "1";
  const root = isAbsolute(rawRoot) && rawRoot === resolve(rawRoot);
  const path =
    root &&
    isAbsolute(rawPath) &&
    rawPath === resolve(rawPath) &&
    rawPath === join(rawRoot, "hf.sock");
  const key = HMAC.test(rawKey);
  const rawTrace = environment.TMUX_IDE_TUI_PERF_LOG?.trim() ?? "";
  const trace = isAbsolute(rawTrace) && rawTrace === resolve(rawTrace);
  const enabled = capability && detail && path && root && key && trace;
  return Object.freeze({
    enabled,
    path: path ? rawPath : null,
    runtimeRoot: root ? rawRoot : null,
    key: key ? rawKey : null,
    observation: Object.freeze({ capability, detail, path, root, key, trace, enabled }),
  });
}
