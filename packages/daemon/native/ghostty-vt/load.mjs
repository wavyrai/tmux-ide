import { createRequire } from "node:module";

export const REQUIRED_NAPI_VERSION = 9;

export function loadGhosttyVtProof(
  addonPath,
  { runtimeNapi = Number(process.versions.napi), load = createRequire(import.meta.url) } = {},
) {
  if (!Number.isInteger(runtimeNapi) || runtimeNapi < REQUIRED_NAPI_VERSION) {
    return {
      status: "unsupported",
      requiredNapi: REQUIRED_NAPI_VERSION,
      runtimeNapi: Number.isFinite(runtimeNapi) ? runtimeNapi : null,
    };
  }

  try {
    return { status: "loaded", binding: load(addonPath) };
  } catch (error) {
    return {
      status: "unavailable",
      requiredNapi: REQUIRED_NAPI_VERSION,
      runtimeNapi,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
