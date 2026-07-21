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
const generatedRoot = join(packageRoot, "dist", "ui", "workbench-dock");
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

  // Prove prepack owns every exported artifact. A stale local Vite output must
  // not be able to make the package check pass.
  rmSync(generatedRoot, { recursive: true, force: true });
  run("pnpm", ["pack", "--pack-destination", tarballRoot], packageRoot, "pipe");

  const tarballName = readdirSync(tarballRoot).find((name) => name.startsWith("tmux-ide-daemon-"));
  if (!tarballName) throw new Error("Daemon prepack produced no tarball");
  const tarball = join(tarballRoot, tarballName);

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const webExport = packageJson.exports?.["./workbench-dock-web"];
  if (webExport?.types !== "./dist/ui/workbench-dock/web-entry.d.ts") {
    throw new Error("Workbench dock types export is not the generated declaration entry");
  }
  for (const file of [
    "workbench-dock-web.js",
    "workbench-dock-web.css",
    "web-entry.d.ts",
    "web-host.d.ts",
    "presenter.d.ts",
    "navigation.d.ts",
  ]) {
    requireFile(join(generatedRoot, file));
  }
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
  symlinkSync(
    join(repoRoot, "node_modules", "solid-js"),
    join(consumerRoot, "node_modules", "solid-js"),
    process.platform === "win32" ? "junction" : "dir",
  );
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
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const js = import.meta.resolve("@tmux-ide/daemon/workbench-dock-web");\n` +
        `if (!js.endsWith("workbench-dock-web.js")) throw new Error("missing JavaScript export");\n` +
        `const css = import.meta.resolve("@tmux-ide/daemon/workbench-dock-web.css");\n` +
        `if (!css.endsWith("workbench-dock-web.css")) throw new Error("missing CSS export");\n`,
    ],
    consumerRoot,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
