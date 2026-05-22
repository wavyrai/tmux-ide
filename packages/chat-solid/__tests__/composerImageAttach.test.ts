/**
 * Pure helpers for the paste / drop image-attachment flow.
 * Pins the validation gate (type / size / count caps), the
 * clipboard + dataTransfer extractors, and the FileReader →
 * data-URL conversion so a future tweak can't silently let an
 * oversized or non-image file through.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImageAttachments,
  dragHasFiles,
  fileToImageAttachment,
  IMAGE_SIZE_LIMIT_LABEL,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  validateImageFiles,
} from "../src/lib/composerImageAttach";

function fakeFile(name: string, type: string, size: number): File {
  const blob = new Blob(["x".repeat(Math.min(size, 16))], { type });
  // happy-dom's File honors the size of the parts; override so we
  // can assert the cap without allocating 5MB.
  const file = new File([blob], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

function dataTransferWith(files: File[], types: string[] = ["Files"]): DataTransfer {
  return {
    files: files as unknown as FileList,
    types,
  } as unknown as DataTransfer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateImageFiles", () => {
  it("accepts in-spec images and reports no error", () => {
    const files = [fakeFile("a.png", "image/png", 1024), fakeFile("b.jpg", "image/jpeg", 2048)];
    const { accepted, error } = validateImageFiles(files, 0);
    expect(accepted).toHaveLength(2);
    expect(error).toBeNull();
  });

  it("rejects non-image files with a type error but keeps scanning", () => {
    const files = [fakeFile("notes.txt", "text/plain", 10), fakeFile("ok.png", "image/png", 10)];
    const { accepted, error } = validateImageFiles(files, 0);
    expect(accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(error).toContain("Unsupported file type");
  });

  it("rejects files over the per-file size cap", () => {
    const files = [fakeFile("huge.png", "image/png", MAX_IMAGE_BYTES + 1)];
    const { accepted, error } = validateImageFiles(files, 0);
    expect(accepted).toHaveLength(0);
    expect(error).toContain(IMAGE_SIZE_LIMIT_LABEL);
  });

  it("stops at the per-message attachment cap, counting existing", () => {
    const files = Array.from({ length: 5 }, (_, i) => fakeFile(`img${i}.png`, "image/png", 100));
    const { accepted, error } = validateImageFiles(files, MAX_ATTACHMENTS - 2);
    expect(accepted).toHaveLength(2);
    expect(error).toContain(`up to ${MAX_ATTACHMENTS} images`);
  });
});

describe("imageFilesFromClipboard / DataTransfer", () => {
  it("extracts only image files from clipboard data", () => {
    const dt = dataTransferWith([
      fakeFile("doc.pdf", "application/pdf", 10),
      fakeFile("shot.png", "image/png", 10),
    ]);
    expect(imageFilesFromClipboard(dt).map((f) => f.name)).toEqual(["shot.png"]);
  });

  it("returns [] for null clipboard / dataTransfer", () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
    expect(imageFilesFromDataTransfer(undefined)).toEqual([]);
  });

  it("dragHasFiles is true only when the payload advertises Files", () => {
    expect(dragHasFiles(dataTransferWith([], ["Files"]))).toBe(true);
    expect(dragHasFiles(dataTransferWith([], ["text/plain"]))).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});

describe("fileToImageAttachment", () => {
  it("reads a file into an image ComposerAttachment with a data URL", async () => {
    const file = fakeFile("hero.png", "image/png", 64);
    const attachment = await fileToImageAttachment(file);
    expect(attachment.kind).toBe("image");
    if (attachment.kind === "image") {
      expect(attachment.label).toBe("hero.png");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.sizeBytes).toBe(64);
      expect(attachment.dataUrl.startsWith("data:")).toBe(true);
    }
  });
});

describe("buildImageAttachments", () => {
  it("validates then reads, returning attachments + first error", async () => {
    const files = [fakeFile("bad.txt", "text/plain", 10), fakeFile("good.png", "image/png", 32)];
    const { attachments, error } = await buildImageAttachments(files, 0);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.kind).toBe("image");
    expect(error).toContain("Unsupported file type");
  });

  it("returns no attachments + no error for an empty list", async () => {
    const { attachments, error } = await buildImageAttachments([], 0);
    expect(attachments).toEqual([]);
    expect(error).toBeNull();
  });
});
