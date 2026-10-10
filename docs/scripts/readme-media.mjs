// Exports the landing page's agent-teams diagram (Fig. 5) for the README:
// an animated GIF of one loop and a static PNG of the settled final frame,
// in the site's light and dark themes, into .github/assets (outside the npm
// package). Run `pnpm docs:build` first; then `pnpm readme:media`.
//
// Needs: the production docs build, Playwright's Chromium (the docs
// workspace depends on Playwright; set PLAYWRIGHT_CHROMIUM_EXECUTABLE
// to use another Chromium) and uv, which provides ffmpeg (imageio-ffmpeg) and
// Pillow for encoding without system packages.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = resolve(docsDir, "../.github/assets");
const SELECTOR = "figure.pf-team .pf-stage";
const VIEWPORT = { width: 1024, height: 1100 }; // the wide layout starts at 64rem
const SCALE = 2;
const FPS = 12;
const LOOP_SECONDS = 18; // --pf-loop on .pf-team (components/figures/pane-figure.css)

if (!existsSync(join(docsDir, ".next/BUILD_ID")))
  throw new Error("No production docs build found: run `pnpm docs:build` first.");

const require = createRequire(resolve(docsDir, "package.json"));
const { chromium } = require("@playwright/test");

function uv(args, options = {}) {
  const result = spawnSync("uvx", args, { encoding: "utf8", ...options });
  if (result.error)
    throw new Error(`readme:media needs uv (https://docs.astral.sh/uv/): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const port = await freePort();
const server = spawn(join(docsDir, "node_modules/.bin/next"), ["start", "-p", String(port)], {
  cwd: docsDir,
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}/`;
for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    if (attempt > 100) throw new Error("next start did not become ready");
  }
  await new Promise((done) => setTimeout(done, 200));
}

const ffmpeg = uv([
  "--from",
  "imageio-ffmpeg",
  "python",
  "-c",
  "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())",
]);
const work = mkdtempSync(join(tmpdir(), "readme-media-"));
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
);
mkdirSync(outDir, { recursive: true });
try {
  for (const theme of ["light", "dark"]) {
    // Static fallback: reduced motion shows the settled final frame.
    const still = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await still.goto(base);
    await still.evaluate(() => document.fonts.ready);
    const stillPng = join(work, `${theme}-still.png`);
    await (await still.$(SELECTOR)).screenshot({ path: stillPng, animations: "disabled" });
    await still.close();

    // One loop, frame by frame: pause every animation and seek it.
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: theme,
    });
    await page.goto(base);
    await page.evaluate(() => document.fonts.ready);
    const stage = await page.$(SELECTOR);
    await stage.scrollIntoViewIfNeeded();
    const frames = join(work, theme);
    mkdirSync(frames);
    for (let index = 0; index < LOOP_SECONDS * FPS; index++) {
      await page.evaluate(
        (ms) => {
          for (const animation of document.getAnimations()) {
            animation.pause();
            animation.currentTime = ms;
          }
        },
        (index * 1000) / FPS,
      );
      await stage.screenshot({ path: join(frames, `${String(index).padStart(4, "0")}.png`) });
    }
    await page.close();

    const palette = join(work, `${theme}-palette.png`);
    const gif = join(outDir, `agent-teams-${theme}.gif`);
    const run = (args) => {
      const result = spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    run([
      "-framerate",
      String(FPS),
      "-i",
      join(frames, "%04d.png"),
      "-vf",
      "palettegen=max_colors=96:stats_mode=diff",
      palette,
    ]);
    run([
      "-framerate",
      String(FPS),
      "-i",
      join(frames, "%04d.png"),
      "-i",
      palette,
      "-lavfi",
      "paletteuse=dither=none:diff_mode=rectangle",
      "-loop",
      "0",
      gif,
    ]);
    const png = join(outDir, `agent-teams-${theme}.png`);
    uv([
      "--from",
      "pillow",
      "python",
      "-I",
      "-c",
      "import sys; from PIL import Image; Image.open(sys.argv[1]).convert('RGB').quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(sys.argv[2], optimize=True)",
      stillPng,
      png,
    ]);
    for (const file of [gif, png]) console.log(`${file}: ${statSync(file).size} bytes`);
  }
} finally {
  await browser.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
