/**
 * Paste / drop → image attachment plumbing. Pure helpers + a small
 * async file→data-URL reader. Adapted from the upstream composer's
 * `addComposerImages` flow but trimmed to chat-solid's
 * `ComposerAttachment` shape (no toast manager, no draft store —
 * the host owns those).
 *
 * Limits mirror the upstream provider caps so a pasted image that
 * the daemon would reject is caught before it ever enters the
 * composer:
 *   - `MAX_IMAGE_BYTES`  — per-file ceiling (5 MB).
 *   - `MAX_ATTACHMENTS`  — total staged images per message (10).
 *
 * The reader uses `FileReader` → base64 data URL so the carousel
 * can render a thumbnail with zero extra fetches and the sender
 * re-encodes to a `ContentBlock` on send.
 */

import type { ComposerAttachment } from "../types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

export interface ValidatedImageFiles {
  /** Files that passed the type + size + count gate, in order. */
  accepted: File[];
  /**
   * First validation failure encountered, human-readable. Null when
   * every candidate passed. The composer surfaces this inline + via
   * the optional `onAttachmentError` host hook.
   */
  error: string | null;
}

function isImageFile(file: File): boolean {
  return typeof file.type === "string" && file.type.startsWith("image/");
}

/**
 * Filter + validate a candidate file list against the type / size /
 * count caps. `existingCount` is the number of images already
 * staged so the running total is enforced across multiple
 * paste / drop bursts.
 */
export function validateImageFiles(
  files: ReadonlyArray<File>,
  existingCount: number,
): ValidatedImageFiles {
  const accepted: File[] = [];
  let count = existingCount;
  let error: string | null = null;

  for (const file of files) {
    if (!isImageFile(file)) {
      error = `Unsupported file type for "${file.name || "file"}". Attach image files only.`;
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      error = `"${file.name || "image"}" exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
      continue;
    }
    if (count >= MAX_ATTACHMENTS) {
      error = `You can attach up to ${MAX_ATTACHMENTS} images per message.`;
      break;
    }
    accepted.push(file);
    count += 1;
  }

  return { accepted, error };
}

/** Pull the image File list out of a paste ClipboardData. */
export function imageFilesFromClipboard(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  return Array.from(clipboardData.files).filter(isImageFile);
}

/** Pull the image File list out of a drag DataTransfer. */
export function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files).filter(isImageFile);
}

/** True when the drag payload carries OS files (vs. text / html). */
export function dragHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  // `types` is a DOMStringList in some browsers; spread to array.
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

/**
 * Read a single image File into a `ComposerAttachment` of kind
 * "image" with a base64 data URL. Rejects if the FileReader errors.
 */
export function fileToImageAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read "${file.name || "image"}".`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Unexpected reader result for "${file.name || "image"}".`));
        return;
      }
      resolve({
        kind: "image",
        dataUrl: result,
        label: file.name || "image",
        mimeType: file.type || "image/png",
        sizeBytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Validate + read a candidate file list. Returns the staged
 * attachments (in order) plus the first validation error, if any.
 * Files that fail to read are skipped and recorded as the error.
 */
export async function buildImageAttachments(
  files: ReadonlyArray<File>,
  existingCount: number,
): Promise<{ attachments: ComposerAttachment[]; error: string | null }> {
  const { accepted, error } = validateImageFiles(files, existingCount);
  const attachments: ComposerAttachment[] = [];
  let readError = error;
  for (const file of accepted) {
    try {
      attachments.push(await fileToImageAttachment(file));
    } catch (err) {
      readError = err instanceof Error ? err.message : `Failed to read "${file.name}".`;
    }
  }
  return { attachments, error: readError };
}
