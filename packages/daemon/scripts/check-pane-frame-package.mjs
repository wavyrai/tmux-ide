import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const generatedRoot = join(packageRoot, "dist", "ui", "pane-frame");
const webRoot = join(generatedRoot, "web");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tmux-ide-pane-frame-package-"));

function requireFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Expected generated PaneFrame package file ${path}`, { cause: error });
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

try {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const webExport = packageJson.exports?.["./pane-frame-web"];
  if (webExport?.types !== "./dist/ui/pane-frame/web-entry.d.ts") {
    throw new Error("PaneFrame types export is not the generated declaration entry");
  }
  if (webExport?.default !== "./dist/ui/pane-frame/web/pane-frame-web.js") {
    throw new Error("PaneFrame JavaScript export is not the Vite-owned output leaf");
  }
  if (
    packageJson.exports?.["./pane-frame-web.css"]?.default !==
    "./dist/ui/pane-frame/web/pane-frame-web.css"
  ) {
    throw new Error("PaneFrame CSS export is not the Vite-owned output leaf");
  }

  for (const file of ["web-entry.d.ts", "web-host.d.ts", "presenter.d.ts", "action-state.d.ts"]) {
    const declaration = requireFile(join(generatedRoot, file));
    if (/from\s+["'][^"']+\.(?:ts|tsx)["']/u.test(declaration)) {
      throw new Error(`${file} exposes a TypeScript source extension`);
    }
  }
  const javascript = requireFile(join(webRoot, "pane-frame-web.js"));
  const css = requireFile(join(webRoot, "pane-frame-web.css"));
  if (/@opentui|node:|process\.exit|\bxterm\b|\bpty\b|\btmux\b/iu.test(javascript)) {
    throw new Error("PaneFrame web bundle contains a terminal or process runtime dependency");
  }
  if (!css.includes("prefers-reduced-motion") || !css.includes("@container")) {
    throw new Error("PaneFrame CSS is missing responsive or reduced-motion policy");
  }

  const consumerRoot = join(temporaryRoot, "consumer");
  const scopeRoot = join(consumerRoot, "node_modules", "@tmux-ide");
  mkdirSync(scopeRoot, { recursive: true });
  symlinkSync(packageRoot, join(scopeRoot, "daemon"), "dir");
  symlinkSync(resolve(repoRoot, "packages/contracts"), join(scopeRoot, "contracts"), "dir");
  for (const dependency of ["solid-js", "happy-dom", "zod"]) {
    symlinkSync(
      resolve(dependency === "happy-dom" ? packageRoot : repoRoot, "node_modules", dependency),
      join(consumerRoot, "node_modules", dependency),
      "dir",
    );
  }
  writeFileSync(
    join(consumerRoot, "consumer.ts"),
    `import { mountWebPaneFrame, type PaneFrameModel } from "@tmux-ide/daemon/pane-frame-web";\n` +
      `declare const element: HTMLElement;\n` +
      `declare const model: PaneFrameModel;\n` +
      `const dispose: () => void = mountWebPaneFrame(element, { model });\n` +
      `dispose();\n`,
  );
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: false,
          types: [],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [resolve(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    consumerRoot,
  );

  const runtimeCheck = join(consumerRoot, "runtime-check.mjs");
  writeFileSync(
    runtimeCheck,
    `import { Window } from "happy-dom";\n` +
      `const browserWindow = new Window({ url: "http://localhost/" });\n` +
      `Object.defineProperties(globalThis, { window: { configurable: true, value: browserWindow }, document: { configurable: true, value: browserWindow.document }, Node: { configurable: true, value: browserWindow.Node }, HTMLElement: { configurable: true, value: browserWindow.HTMLElement } });\n` +
      `const web = await import(${JSON.stringify(pathToFileURL(join(webRoot, "pane-frame-web.js")).href)});\n` +
      `if (typeof web.mountWebPaneFrame !== "function" || typeof web.WebPaneFrame !== "function") throw new Error("missing PaneFrame web runtime exports");\n` +
      `browserWindow.close();\n`,
  );
  run(process.execPath, ["--conditions=browser", runtimeCheck], consumerRoot);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
