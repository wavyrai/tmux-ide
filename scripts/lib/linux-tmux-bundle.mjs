/** ELF dependency parsing for the private Linux tmux distribution. */
export function parseLddDependencies(output) {
  const dependencies = [];
  for (const raw of output.trim().split("\n")) {
    const line = raw.trim();
    if (!line || /^linux-vdso[^ ]* \(0x[a-f0-9]+\)$/u.test(line)) continue;
    if (line.includes("not found")) throw new Error("Unresolved ELF dependency");
    const mapped = /^([^ /]+) => (\/[^ ]+) \(0x[a-f0-9]+\)$/u.exec(line);
    const loader = /^(\/[^ ]+) \(0x[a-f0-9]+\)$/u.exec(line);
    if (mapped) dependencies.push({ name: mapped[1], path: mapped[2] });
    else if (loader) dependencies.push({ name: loader[1].split("/").at(-1), path: loader[1] });
    else throw new Error("Unexpected ldd dependency record");
  }
  if (dependencies.length === 0) throw new Error("No dynamic ELF dependency proof");
  return dependencies;
}
export function isSystemGlibc(name) {
  return (
    /^(?:libc|libm|libpthread|libdl|librt|libresolv|libutil)\.so\.[0-9]+$/u.test(name) ||
    /^ld-linux-(?:aarch64|x86-64)\.so\.[0-9]+$/u.test(name)
  );
}
export function minimumGlibc(outputs) {
  const versions = outputs.flatMap((output) =>
    [...output.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)\b/gu)].map((match) => match[1]),
  );
  if (versions.length === 0) throw new Error("Missing ELF glibc version requirements");
  return versions
    .sort((a, b) => {
      const left = a.split(".").map(Number),
        right = b.split(".").map(Number);
      for (let i = 0; i < 3; i++)
        if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
      return 0;
    })
    .at(-1);
}
export function assertElfArchitecture(header, arch) {
  const expected = { arm64: "AArch64", x64: "Advanced Micro Devices X86-64" }[arch];
  if (
    !expected ||
    !/^\s*Class:\s+ELF64\s*$/mu.test(header) ||
    !header
      .split("\n")
      .some(
        (line) =>
          line.trim() === `Machine:                           ${expected}` ||
          /^\s*Machine:\s+(.+)$/u.exec(line)?.[1] === expected,
      )
  )
    throw new Error("Unexpected ELF architecture");
}
