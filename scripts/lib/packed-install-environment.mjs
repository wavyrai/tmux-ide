import { isAbsolute, join } from "node:path";

/** Capture ambient inputs once. Gate selectors must be read separately before this boundary. */
export function capturePackedInstallEnvironment(ambient) {
  return Object.fromEntries(
    Object.entries(ambient).filter(([key, value]) => {
      const upper = key.toUpperCase();
      return (
        typeof value === "string" &&
        !upper.startsWith("TMUX_IDE_") &&
        !upper.startsWith("NPM_CONFIG_") &&
        !upper.startsWith("BUN_") &&
        !upper.startsWith("XDG_") &&
        ![
          "HOME",
          "USERPROFILE",
          "TMUX",
          "TMUX_PANE",
          "TMUX_TMPDIR",
          "NODE_OPTIONS",
          "NODE_PATH",
          "ZDOTDIR",
          "ENV",
          "BASH_ENV",
        ].includes(upper)
      );
    }),
  );
}

/** Call only with the captured base; explicit fixture overrides remain intentional. */
export function privatePackedInstallEnvironment(base, { home, cache, overrides = {} }) {
  if (!isAbsolute(home) || !isAbsolute(cache))
    throw new Error("Packed fixture paths must be absolute");
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    ZDOTDIR: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    npm_config_cache: cache,
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, ".npm-globalrc"),
    npm_config_prefix: join(home, "npm-prefix"),
    npm_config_global: "false",
    ...overrides,
  };
}
