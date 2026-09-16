import { contractsInitializerPurityPlugin } from "./contracts-initializer-purity.mjs";

/** Shared CLI/manager policy: bundle workspace code and keep third-party runtime dependencies external. */
export function cliBundlePlugins() {
  return [
    contractsInitializerPurityPlugin(),
    {
      name: "external-non-workspace",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          const id = args.path;
          if (id.startsWith(".") || id.startsWith("/")) return undefined;
          if (id.startsWith("node:")) return { external: true };
          if (id === "@tmux-ide/xterm-headless" || id === "@xterm/addon-unicode11")
            return undefined;
          if (id.startsWith("@tmux-ide/")) return undefined;
          return { external: true };
        });
      },
    },
  ];
}
