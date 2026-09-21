import assert from "node:assert/strict";
import test from "node:test";
import { configureNativeScrollRuntime } from "./native-scroll-runtime-policy.mjs";

for (const platform of ["darwin", "linux"]) {
  test(`qualified ${platform} uses both tested preview defaults`, () => {
    const env = {};
    assert.deepEqual(configureNativeScrollRuntime({ release: true, platform, glibc: true, env }), {
      useNative: true,
      renderer: "qualified-native-scroll",
    });
    assert.deepEqual(env, { TMUX_IDE_NATIVE_SCROLL_PROTOTYPE: "1", TMUX_IDE_FRAME_OUTPUT: "1" });
  });
}
test("explicit baseline opt-outs survive qualified release defaults", () => {
  const env = { TMUX_IDE_NATIVE_SCROLL_PROTOTYPE: "0", TMUX_IDE_FRAME_OUTPUT: "0" };
  configureNativeScrollRuntime({ release: true, platform: "darwin", env });
  assert.deepEqual(env, { TMUX_IDE_NATIVE_SCROLL_PROTOTYPE: "0", TMUX_IDE_FRAME_OUTPUT: "0" });
});
test("experimental builds never select runtime experiments implicitly", () => {
  const env = {};
  const policy = configureNativeScrollRuntime({
    release: false,
    platform: "linux",
    glibc: true,
    env,
  });
  assert.deepEqual(env, {});
  assert.equal(policy.useNative, true);
  assert.equal(policy.renderer, "experimental-native-scroll");
});
test("unqualified musl uses stock assets without native or frame defaults", () => {
  const env = {};
  assert.deepEqual(
    configureNativeScrollRuntime({ release: true, platform: "linux", glibc: false, env }),
    { useNative: false, renderer: "stock-musl-fallback" },
  );
  assert.deepEqual(env, {});
});
