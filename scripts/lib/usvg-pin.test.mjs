// The favicon check parses SVGs with usvg so that it reads them exactly as the
// renderer (bezel-gpui) does. That only holds while both use one usvg (#724).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const upstream = new URL("../../apps/tmux-gpui/upstream/", import.meta.url);

/** Packages of a Cargo.lock: name, version and the names they depend on. */
function packages(lock) {
  return lock
    .split("[[package]]")
    .slice(1)
    .map((block) => ({
      name: /^name = "([^"]+)"$/m.exec(block)?.[1],
      version: /^version = "([^"]+)"$/m.exec(block)?.[1],
      dependencies: [
        ...(/^dependencies = \[([^\]]*)\]/m.exec(block)?.[1] ?? "").matchAll(/"([^" ]+)/g),
      ].map((match) => match[1]),
    }));
}
export function usvgDrift(lock, manifest) {
  const all = packages(lock);
  const usvg = all.filter((entry) => entry.name === "usvg");
  if (usvg.length !== 1)
    return `Cargo.lock has ${usvg.length} usvg versions (${usvg.map((entry) => entry.version).join(", ")}); the favicon check and the renderer must share one`;
  const pin = /^usvg\s*=\s*\{[^}]*version = "=([^"]+)"/m.exec(manifest)?.[1];
  if (!pin) return "the workspace no longer pins usvg to an exact version";
  if (pin !== usvg[0].version) return `usvg is pinned to ${pin} but locked at ${usvg[0].version}`;
  for (const user of ["bezel-gpui", "tmux-ide-gpui"])
    if (!all.some((entry) => entry.name === user && entry.dependencies.includes("usvg")))
      return `${user} no longer depends on usvg directly; revisit the favicon check`;
  return null;
}

const lock = readFileSync(new URL("Cargo.lock", upstream), "utf8");
const manifest = readFileSync(new URL("Cargo.toml", upstream), "utf8");

test("the favicon check and the renderer resolve the same usvg", () => {
  assert.equal(usvgDrift(lock, manifest), null);
});

test("drift between the pin and the renderer's usvg is reported", () => {
  const block = lock.split("[[package]]").find((part) => /^name = "usvg"$/m.test(part));
  const version = /^version = "([^"]+)"$/m.exec(block)[1];
  const second = `[[package]]${block.replace(`version = "${version}"`, 'version = "0.99.0"')}`;
  assert.match(usvgDrift(lock + second, manifest), /2 usvg versions \(.*0\.99\.0\)/);
  assert.match(
    usvgDrift(lock.replace(block, block.replace(`"${version}"`, '"0.99.0"')), manifest),
    /pinned to .* but locked at 0\.99\.0/,
  );
  assert.match(
    usvgDrift(lock, manifest.replace(`"=${version}"`, `"${version}"`)),
    /no longer pins/,
  );
  const withoutRenderer = lock
    .split("[[package]]")
    .map((part) => (/^name = "bezel-gpui"$/m.test(part) ? part.replace(/^ "usvg",?\n/m, "") : part))
    .join("[[package]]");
  assert.notEqual(withoutRenderer, lock);
  assert.match(usvgDrift(withoutRenderer, manifest), /bezel-gpui no longer depends on usvg/);
});
