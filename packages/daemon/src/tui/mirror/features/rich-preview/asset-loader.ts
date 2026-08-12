import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import {
  WidgetAssetIdSchemaZ,
  WidgetAssetMediaTypeSchemaZ,
  type WidgetAssetId,
} from "@tmux-ide/contracts";

import { stateHome } from "../../../../lib/state-home.ts";
import {
  WIDGET_ASSET_MAX_BYTES,
  WIDGET_ASSET_RETENTION_MS,
} from "../../../../lib/widget-asset-policy.ts";
import type { RichPreviewAssetLoadResult } from "./contract.ts";

const ASSET_DIRECTORY = "widget-assets";
const METADATA_MAX_BYTES = 4 * 1024;

interface Metadata {
  readonly version: 1;
  readonly assetId: WidgetAssetId;
  readonly media: ReturnType<typeof WidgetAssetMediaTypeSchemaZ.parse>;
  readonly name: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface RichPreviewAssetLoaderOptions {
  readonly root?: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const aborted = (): RichPreviewAssetLoadResult => ({ status: "error", reason: "aborted" });

function parseMetadata(raw: string, maxBytes: number): Metadata | null {
  try {
    const value = JSON.parse(raw) as Partial<Metadata>;
    const id = WidgetAssetIdSchemaZ.safeParse(value.assetId);
    const media = WidgetAssetMediaTypeSchemaZ.safeParse(value.media);
    if (
      value.version !== 1 ||
      !id.success ||
      !media.success ||
      typeof value.name !== "string" ||
      value.name.length < 1 ||
      value.name.length > 200 ||
      [...value.name].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      typeof value.byteLength !== "number" ||
      !Number.isInteger(value.byteLength) ||
      value.byteLength < 1 ||
      value.byteLength > maxBytes ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      return null;
    return {
      version: 1,
      assetId: id.data,
      media: media.data,
      name: value.name,
      byteLength: value.byteLength,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

async function readRegularFile(
  path: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array | "unsafe" | "too-large"> {
  if (signal.aborted) throw signal.reason;
  let handle;
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return "unsafe";
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return "unsafe";
    if (stat.size < 1 || stat.size > maxBytes) return "too-large";
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      if (signal.aborted) throw signal.reason;
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset < 1 || offset > maxBytes) return "too-large";
    return Uint8Array.from(bounded.subarray(0, offset));
  } finally {
    await handle?.close();
  }
}

/** Async, abortable, content-addressed reader for the local widget asset store. */
export function createRichPreviewAssetLoader(options: RichPreviewAssetLoaderOptions = {}) {
  const root = options.root ?? join(stateHome(), ASSET_DIRECTORY);
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? WIDGET_ASSET_MAX_BYTES));
  const now = options.now ?? Date.now;
  return async (
    assetIdInput: WidgetAssetId,
    signal: AbortSignal,
  ): Promise<RichPreviewAssetLoadResult> => {
    const parsed = WidgetAssetIdSchemaZ.safeParse(assetIdInput);
    if (!parsed.success) return { status: "error", reason: "invalid-id" };
    const assetId = parsed.data;
    try {
      const metadataBytes = await readRegularFile(
        join(root, `${assetId}.json`),
        signal,
        METADATA_MAX_BYTES,
      );
      if (metadataBytes === "unsafe") return { status: "error", reason: "unsafe-path" };
      if (metadataBytes === "too-large") return { status: "error", reason: "invalid-metadata" };
      const metadata = parseMetadata(new TextDecoder().decode(metadataBytes), maxBytes);
      const createdAt = metadata ? Date.parse(metadata.createdAt) : Number.NaN;
      if (
        !metadata ||
        metadata.assetId !== assetId ||
        createdAt > now() ||
        now() - createdAt > WIDGET_ASSET_RETENTION_MS
      )
        return { status: "error", reason: "invalid-metadata" };
      const bytes = await readRegularFile(join(root, `${assetId}.bin`), signal, maxBytes);
      if (bytes === "unsafe") return { status: "error", reason: "unsafe-path" };
      if (bytes === "too-large") return { status: "error", reason: "too-large" };
      if (bytes.byteLength !== metadata.byteLength)
        return { status: "error", reason: "invalid-metadata" };
      if (createHash("sha256").update(bytes).digest("hex") !== assetId)
        return { status: "error", reason: "hash-mismatch" };
      if (signal.aborted) return aborted();
      return {
        status: "ok",
        asset: Object.freeze({ ...metadata, bytes }),
      };
    } catch (error) {
      if (signal.aborted || (error as { name?: string }).name === "AbortError") return aborted();
      if (["ELOOP", "EMLINK"].includes((error as { code?: string }).code ?? ""))
        return { status: "error", reason: "unsafe-path" };
      return { status: "error", reason: "unavailable" };
    }
  };
}
