import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateHostDescriptor } from "./host-descriptor.mjs";
const runtimeKeys = ["bootId", "clockTicksPerSecond", "cgroupPath"];
export function artifactHostSha256(artifact) {
  assert(artifact && typeof artifact === "object");
  for (const key of runtimeKeys) assert(!Object.hasOwn(artifact, key), `Runtime identity in artifact: ${key}`);
  return createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
}
/** Compose a new campaign identity; never edit an already frozen specification. */
export function admitCampaignHost(inputs, expectedArtifactSha256) {
  assert.deepEqual(Object.keys(inputs).sort(), ["artifact", "runtime"]);
  assert.deepEqual(Object.keys(inputs.runtime).sort(), [...runtimeKeys].sort());
  assert.match(expectedArtifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(artifactHostSha256(inputs.artifact), expectedArtifactSha256, "Artifact host pins changed");
  return validateHostDescriptor({ ...inputs.artifact, ...inputs.runtime });
}
