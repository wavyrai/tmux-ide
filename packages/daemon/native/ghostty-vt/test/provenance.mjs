import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = resolve(process.argv[2]);
const zig = resolve(process.argv[3]);
const nodeInclude = process.argv[4] ? resolve(process.argv[4]) : null;
const proof = resolve(new URL("..", import.meta.url).pathname);
const verifySource = resolve(proof, "scripts/verify-patched-source.sh");
const verifyRecipe = resolve(proof, "scripts/verify-recipe.sh");
const verifyHeaders = resolve(proof, "scripts/verify-node-headers.sh");

const cleanSource = spawnSync(verifySource, [source], { encoding: "utf8" });
assert.equal(cleanSource.status, 0, cleanSource.stderr);

const sourceCopy = mkdtempSync(resolve(tmpdir(), "tmux-ide-ghostty-mutation-"));
cpSync(source, sourceCopy, { recursive: true, filter: (path) => !path.includes("/.git/") });
appendFileSync(
  resolve(sourceCopy, "src/terminal/Terminal.zig"),
  "\n// injected reviewer mutation\n",
);
const mutatedSource = spawnSync(verifySource, [sourceCopy], { encoding: "utf8" });
assert.notEqual(mutatedSource.status, 0);
assert.match(mutatedSource.stderr, /source-tree verification failed/);

const recipeCopy = mkdtempSync(resolve(tmpdir(), "tmux-ide-ghostty-recipe-mutation-"));
mkdirSync(resolve(recipeCopy, "src"));
cpSync(resolve(proof, "src/addon.c"), resolve(recipeCopy, "src/addon.c"));
appendFileSync(resolve(recipeCopy, "src/addon.c"), "\n/* injected reviewer mutation */\n");
const mutatedRecipe = spawnSync(verifyRecipe, [recipeCopy, zig], { encoding: "utf8" });
assert.notEqual(mutatedRecipe.status, 0);

let nodeHeaderMutationRejected = null;
if (nodeInclude) {
  const cleanHeaders = spawnSync(verifyHeaders, [nodeInclude], { encoding: "utf8" });
  assert.equal(cleanHeaders.status, 0, cleanHeaders.stderr);
  const headerCopy = mkdtempSync(resolve(tmpdir(), "tmux-ide-node-headers-mutation-"));
  for (const header of [
    "node_api.h",
    "node_api_types.h",
    "js_native_api.h",
    "js_native_api_types.h",
  ]) {
    cpSync(resolve(nodeInclude, header), resolve(headerCopy, header));
  }
  appendFileSync(resolve(headerCopy, "node_api.h"), "\n/* injected reviewer mutation */\n");
  const mutatedHeaders = spawnSync(verifyHeaders, [headerCopy], { encoding: "utf8" });
  assert.notEqual(mutatedHeaders.status, 0);
  nodeHeaderMutationRejected = true;
}

console.log(
  JSON.stringify({
    ok: true,
    compiledSourceMutationRejected: true,
    addonMutationRejected: true,
    nodeHeaderMutationRejected,
  }),
);
