import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLddDependencies,
  isSystemGlibc,
  minimumGlibc,
  assertElfArchitecture,
} from "./linux-tmux-bundle.mjs";
test("ELF dependency parser fails closed and separates only platform libc", () => {
  assert.deepEqual(
    parseLddDependencies(
      "linux-vdso.so.1 (0xabc)\nlibevent.so.2 => /lib/libevent.so.2 (0xdef)\n/lib/ld-linux-aarch64.so.1 (0xaaa)",
    ),
    [
      { name: "libevent.so.2", path: "/lib/libevent.so.2" },
      { name: "ld-linux-aarch64.so.1", path: "/lib/ld-linux-aarch64.so.1" },
    ],
  );
  assert.throws(() => parseLddDependencies("libevent.so.2 => not found"));
  assert.throws(() => parseLddDependencies("unknown"));
  assert(isSystemGlibc("libc.so.6"));
  assert(isSystemGlibc("ld-linux-aarch64.so.1"));
  assert(!isSystemGlibc("libevent_core.so.2"));
  assert(!isSystemGlibc("libcrypto.so.3"));
});
test("ELF arch and minimum glibc requirements are explicit", () => {
  assert.doesNotThrow(() => assertElfArchitecture(" Class: ELF64\n Machine: AArch64", "arm64"));
  assert.throws(() => assertElfArchitecture(" Class: ELF64\n Machine: AArch64", "x64"));
  assert.equal(minimumGlibc(["GLIBC_2.9 GLIBC_2.34", "GLIBC_2.17"]), "2.34");
  assert.throws(() => minimumGlibc(["none"]));
});
