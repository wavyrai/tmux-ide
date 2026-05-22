/**
 * Per-extension file icon lookup. Returns a lucide-solid icon
 * component for a filename, falling back to the generic `File`
 * glyph. Used by the file tree row and the editor tab strip so
 * both surfaces share the same mapping.
 */

import { File, FileCode, FileCode2, FileJson, FileText, FileImage, FileType } from "lucide-solid";
import type { Component, JSX } from "solid-js";

export type FileIconComponent = Component<{
  class?: string;
  "aria-hidden"?: boolean | "true" | "false";
}> &
  ((props: { class?: string }) => JSX.Element);

const EXTENSION_MAP: Record<string, FileIconComponent> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  cc: FileCode,
  hpp: FileCode,
  rb: FileCode,
  php: FileCode,
  lua: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sh: FileCode2,
  bash: FileCode2,
  zsh: FileCode2,
  fish: FileCode2,
  ps1: FileCode2,
  css: FileCode2,
  scss: FileCode2,
  sass: FileCode2,
  less: FileCode2,
  html: FileCode2,
  htm: FileCode2,
  xml: FileCode2,
  sql: FileCode2,
  json: FileJson,
  jsonc: FileJson,
  json5: FileJson,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  log: FileText,
  rst: FileText,
  yml: FileText,
  yaml: FileText,
  toml: FileText,
  ini: FileText,
  env: FileText,
  conf: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  bmp: FileImage,
  ico: FileImage,
  svg: FileImage,
  woff: FileType,
  woff2: FileType,
  ttf: FileType,
  otf: FileType,
};

export function getFileIcon(filename: string): FileIconComponent {
  const base = filename.split("/").pop() ?? filename;
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return File;
  const ext = base.slice(dotIdx + 1).toLowerCase();
  return EXTENSION_MAP[ext] ?? File;
}
