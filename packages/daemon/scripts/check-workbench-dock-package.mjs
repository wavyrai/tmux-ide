import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const distRoot = join(packageRoot, "dist");
const generatedRoot = join(packageRoot, "dist", "ui", "workbench-dock");
const webGeneratedRoot = join(generatedRoot, "web");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tmux-ide-dock-package-"));
const tarballRoot = join(temporaryRoot, "tarball");
const consumerRoot = join(temporaryRoot, "consumer");

function run(command, args, cwd, stdio = "inherit") {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function requireFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Expected generated package file ${path}`, { cause: error });
  }
}

try {
  mkdirSync(tarballRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  // Prove prepack owns every exported artifact in its real script order. No
  // stale normal-daemon or Vite output may make this check pass.
  rmSync(distRoot, { recursive: true, force: true });
  run("pnpm", ["pack", "--pack-destination", tarballRoot], packageRoot, "pipe");

  const tarballName = readdirSync(tarballRoot).find((name) => name.startsWith("tmux-ide-daemon-"));
  if (!tarballName) throw new Error("Daemon prepack produced no tarball");
  const tarball = join(tarballRoot, tarballName);

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const webExport = packageJson.exports?.["./workbench-dock-web"];
  if (webExport?.types !== "./dist/ui/workbench-dock/web-entry.d.ts") {
    throw new Error("Workbench dock types export is not the generated declaration entry");
  }
  if (webExport?.default !== "./dist/ui/workbench-dock/web/workbench-dock-web.js") {
    throw new Error("Workbench dock JavaScript export is not in the Vite-owned output leaf");
  }
  const cssExport = packageJson.exports?.["./workbench-dock-web.css"];
  if (cssExport?.default !== "./dist/ui/workbench-dock/web/workbench-dock-web.css") {
    throw new Error("Workbench dock CSS export is not in the Vite-owned output leaf");
  }
  for (const file of ["web-entry.d.ts", "web-host.d.ts", "presenter.d.ts", "navigation.d.ts"]) {
    requireFile(join(generatedRoot, file));
  }
  for (const file of ["workbench-dock-web.js", "workbench-dock-web.css"]) {
    requireFile(join(webGeneratedRoot, file));
  }
  requireFile(join(generatedRoot, "navigation.js"));
  requireFile(join(distRoot, "tui", "mirror", "workspace", "workbench-shell.js"));
  for (const declaration of [
    "web-entry.d.ts",
    "web-host.d.ts",
    "presenter.d.ts",
    "navigation.d.ts",
  ]) {
    const source = requireFile(join(generatedRoot, declaration));
    if (/from\s+["'][^"']+\.(?:ts|tsx)["']/u.test(source)) {
      throw new Error(`${declaration} exposes a TypeScript source extension`);
    }
  }

  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "dock-consumer", private: true, type: "module" }, null, 2)}\n`,
  );

  // Materialize the exact packed daemon as a conventional external
  // node_modules package without asking the registry to resolve unrelated
  // daemon runtime dependencies. The exported dock itself only externalizes
  // Solid, which is linked from this checkout's already-installed dependency.
  const extractionRoot = join(temporaryRoot, "extracted");
  const installedScope = join(consumerRoot, "node_modules", "@tmux-ide");
  mkdirSync(extractionRoot, { recursive: true });
  mkdirSync(installedScope, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractionRoot], consumerRoot, "pipe");
  renameSync(join(extractionRoot, "package"), join(installedScope, "daemon"));
  for (const dependency of ["happy-dom", "solid-js", "string-width"]) {
    symlinkSync(
      join(packageRoot, "node_modules", dependency),
      join(consumerRoot, "node_modules", dependency),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  writeFileSync(
    join(consumerRoot, "consumer.ts"),
    `import { mountWebWorkbenchDock, type WorkbenchDockHostProjection } from "@tmux-ide/daemon/workbench-dock-web";\n\n` +
      `declare const element: HTMLElement;\n` +
      `declare const projection: WorkbenchDockHostProjection;\n` +
      `const dispose: () => void = mountWebWorkbenchDock(element, { projection });\n` +
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
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumerRoot,
  );

  const runtimeCheck = join(consumerRoot, "runtime-check.mjs");
  writeFileSync(
    runtimeCheck,
    `import { pathToFileURL } from "node:url";\n` +
      `import { Window } from "happy-dom";\n\n` +
      `const [shellPath, webTarget, mode] = process.argv.slice(2);\n` +
      `const shell = await import(pathToFileURL(shellPath).href);\n` +
      `if (typeof shell.projectWorkbenchShell !== "function") throw new Error("missing workbench shell runtime");\n` +
      `const dockTools = [\n` +
      `  { id: "files", icon: "files", label: "Files", shortcut: "F3" },\n` +
      `  { id: "changes", icon: "changes", label: "Changes", shortcut: "F4" },\n` +
      `  { id: "missions", icon: "missions", label: "Missions", shortcut: "F6" },\n` +
      `  { id: "activity", icon: "activity", label: "Activity", shortcut: "F9" },\n` +
      `];\n` +
      `const projection = shell.projectWorkbenchShell({ width: 80, height: 24, dockMode: "open", persistedDockHeight: 8, activeDockTab: "missions", focusZone: "dock-tabs", dockTools });\n` +
      `if (projection.activeDockTab !== "missions") throw new Error("workbench shell runtime failed");\n` +
      `const browserWindow = new Window({ url: "http://localhost/" });\n` +
      `Object.defineProperties(globalThis, {\n` +
      `  window: { configurable: true, value: browserWindow },\n` +
      `  document: { configurable: true, value: browserWindow.document },\n` +
      `  Node: { configurable: true, value: browserWindow.Node },\n` +
      `  HTMLElement: { configurable: true, value: browserWindow.HTMLElement },\n` +
      `  KeyboardEvent: { configurable: true, value: browserWindow.KeyboardEvent },\n` +
      `});\n` +
      `const webSpecifier = webTarget.startsWith("@") ? webTarget : pathToFileURL(webTarget).href;\n` +
      `const web = await import(webSpecifier);\n` +
      `if (typeof web.mountWebWorkbenchDock !== "function") throw new Error("missing web runtime export");\n` +
      `if (mode === "package") {\n` +
      `  const css = import.meta.resolve("@tmux-ide/daemon/workbench-dock-web.css");\n` +
      `  if (!css.endsWith("workbench-dock-web.css")) throw new Error("missing CSS export");\n` +
      `}\n` +
      `browserWindow.close();\n`,
  );

  run(
    process.execPath,
    [
      "--conditions=browser",
      runtimeCheck,
      join(distRoot, "tui", "mirror", "workspace", "workbench-shell.js"),
      join(webGeneratedRoot, "workbench-dock-web.js"),
      "files",
    ],
    consumerRoot,
  );
  run(
    process.execPath,
    [
      "--conditions=browser",
      runtimeCheck,
      join(installedScope, "daemon", "dist", "tui", "mirror", "workspace", "workbench-shell.js"),
      "@tmux-ide/daemon/workbench-dock-web",
      "package",
    ],
    consumerRoot,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
