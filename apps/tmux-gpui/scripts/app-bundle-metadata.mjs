// Pre-signing metadata only. This does not authenticate an app or qualify distribution.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
export const developmentMetadata = Object.freeze({
  bundleId: "com.tmux-ide.gpui.development",
  version: "0.0.0",
  buildNumber: "0",
});
export function validateBundleMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "buildNumber,bundleId,version"
  )
    throw new Error("Invalid bundle metadata fields");
  const { bundleId, version, buildNumber } = value;
  if (
    typeof bundleId !== "string" ||
    bundleId.length > 128 ||
    !/^com\.tmux-ide\.gpui(?:\.[a-z][a-z0-9-]{0,31})*$/.test(bundleId) ||
    bundleId.split(".").includes("development")
  )
    throw new Error("Invalid preview bundle identifier");
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
  )
    throw new Error("Invalid preview bundle version");
  if (typeof buildNumber !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(buildNumber))
    throw new Error("Invalid preview build number");
  return Object.freeze({ bundleId, version, buildNumber });
}
export async function readBundleMetadata(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error("Invalid metadata file");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Metadata file exceeds bound");
    return validateBundleMetadata(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))),
    );
  } finally {
    await file.close();
  }
}
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function bundlePlist(metadata = developmentMetadata) {
  const value = metadata === developmentMetadata ? metadata : validateBundleMetadata(metadata);
  const fields = {
    CFBundleExecutable: "tmux-ide-launcher",
    CFBundleIdentifier: value.bundleId,
    CFBundleName: metadata === developmentMetadata ? "tmux-ide Development" : "tmux-ide Preview",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: value.version,
    CFBundleVersion: value.buildNumber,
    LSMinimumSystemVersion: "14.2",
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(
    fields,
  )
    .map(([key, val]) => `<key>${key}</key><string>${escape(val)}</string>`)
    .join("\n")}\n</dict></plist>\n`;
}
