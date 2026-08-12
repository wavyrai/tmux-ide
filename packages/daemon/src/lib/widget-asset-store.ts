import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  WidgetAssetIdSchemaZ,
  WidgetAssetMediaTypeSchemaZ,
  type WidgetAssetId,
  type WidgetAssetMediaType,
} from "@tmux-ide/contracts";

import { stateHome } from "./state-home.ts";
import { WIDGET_ASSET_MAX_BYTES, WIDGET_ASSET_RETENTION_MS } from "./widget-asset-policy.ts";

export { WIDGET_ASSET_MAX_BYTES, WIDGET_ASSET_RETENTION_MS } from "./widget-asset-policy.ts";
const MAX_ASSET_FILES = 256;
const ASSET_DIRECTORY = "widget-assets";

interface StoredWidgetAssetMetadata {
  readonly version: 1;
  readonly assetId: WidgetAssetId;
  readonly media: WidgetAssetMediaType;
  readonly name: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface StoredWidgetAsset extends StoredWidgetAssetMetadata {
  readonly bytes: Buffer;
}

export class WidgetAssetStoreError extends Error {
  constructor(
    readonly code: "empty" | "too-large" | "unsupported-media" | "invalid-name",
    message: string,
  ) {
    super(message);
    this.name = "WidgetAssetStoreError";
  }
}

function assetRoot(): string {
  return join(stateHome(), ASSET_DIRECTORY);
}

function ensureAssetRoot(): string {
  const root = assetRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function safeName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new WidgetAssetStoreError("invalid-name", "The widget asset name is invalid.");
  }
  return trimmed;
}

function assetPaths(root: string, assetId: WidgetAssetId): { data: string; metadata: string } {
  return {
    data: join(root, `${assetId}.bin`),
    metadata: join(root, `${assetId}.json`),
  };
}

function parseMetadata(raw: string): StoredWidgetAssetMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredWidgetAssetMetadata>;
    const assetId = WidgetAssetIdSchemaZ.safeParse(value.assetId);
    const media = WidgetAssetMediaTypeSchemaZ.safeParse(value.media);
    if (
      value.version !== 1 ||
      !assetId.success ||
      !media.success ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      value.name.length > 200 ||
      typeof value.byteLength !== "number" ||
      !Number.isInteger(value.byteLength) ||
      value.byteLength < 1 ||
      value.byteLength > WIDGET_ASSET_MAX_BYTES ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return {
      version: 1,
      assetId: assetId.data,
      media: media.data,
      name: value.name,
      byteLength: value.byteLength,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

function pruneAssets(root: string, now = Date.now()): void {
  const metadataFiles = readdirSync(root)
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
    .map((name) => {
      const path = join(root, name);
      try {
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink() ? { name, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const [index, entry] of metadataFiles.entries()) {
    if (index < MAX_ASSET_FILES && now - entry.mtimeMs <= WIDGET_ASSET_RETENTION_MS) continue;
    const assetId = entry.name.slice(0, -".json".length);
    rmSync(join(root, `${assetId}.json`), { force: true });
    rmSync(join(root, `${assetId}.bin`), { force: true });
  }
}

export function publishWidgetAsset(
  bytes: Uint8Array,
  options: { readonly media: WidgetAssetMediaType; readonly name: string },
): StoredWidgetAssetMetadata {
  if (bytes.byteLength === 0) {
    throw new WidgetAssetStoreError("empty", "The widget asset is empty.");
  }
  if (bytes.byteLength > WIDGET_ASSET_MAX_BYTES) {
    throw new WidgetAssetStoreError(
      "too-large",
      `The widget asset is ${Math.ceil(bytes.byteLength / 1_048_576)} MB; the limit is ` +
        `${WIDGET_ASSET_MAX_BYTES / 1_048_576} MB.`,
    );
  }
  const media = WidgetAssetMediaTypeSchemaZ.safeParse(options.media);
  if (!media.success) {
    throw new WidgetAssetStoreError("unsupported-media", "The widget asset media type is unsafe.");
  }

  const root = ensureAssetRoot();
  const assetId = createHash("sha256").update(bytes).digest("hex") as WidgetAssetId;
  const paths = assetPaths(root, assetId);
  const metadata: StoredWidgetAssetMetadata = {
    version: 1,
    assetId,
    media: media.data,
    name: safeName(options.name),
    byteLength: bytes.byteLength,
    createdAt: new Date().toISOString(),
  };

  if (!existsSync(paths.data)) {
    const temporary = join(root, `.${assetId}.${randomUUID()}.bin`);
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, paths.data);
  }
  const metadataTemporary = join(root, `.${assetId}.${randomUUID()}.json`);
  writeFileSync(metadataTemporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(metadataTemporary, paths.metadata);
  pruneAssets(root);
  return metadata;
}

export function readWidgetAsset(assetIdInput: string): StoredWidgetAsset | null {
  const parsedId = WidgetAssetIdSchemaZ.safeParse(assetIdInput);
  if (!parsedId.success) return null;
  const root = assetRoot();
  const paths = assetPaths(root, parsedId.data);
  try {
    const metadataStat = lstatSync(paths.metadata);
    const dataStat = lstatSync(paths.data);
    if (
      metadataStat.isSymbolicLink() ||
      dataStat.isSymbolicLink() ||
      !metadataStat.isFile() ||
      !dataStat.isFile() ||
      dataStat.size < 1 ||
      dataStat.size > WIDGET_ASSET_MAX_BYTES
    ) {
      return null;
    }
    const metadata = parseMetadata(readFileSync(paths.metadata, "utf8"));
    if (
      !metadata ||
      metadata.assetId !== parsedId.data ||
      metadata.byteLength !== dataStat.size ||
      Date.now() - Date.parse(metadata.createdAt) > WIDGET_ASSET_RETENTION_MS
    ) {
      return null;
    }
    const bytes = readFileSync(paths.data);
    if (createHash("sha256").update(bytes).digest("hex") !== parsedId.data) return null;
    return { ...metadata, bytes };
  } catch {
    return null;
  }
}
