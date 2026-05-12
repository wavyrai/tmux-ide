import type { PlanStatus } from "@/lib/api";

export interface PlanFrontmatter {
  title?: string;
  status?: PlanStatus;
  effort?: string;
  owner?: string;
  due?: string;
  related?: string[];
  tags?: string[];
}

export interface TocItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface ParsedPlan {
  frontmatter: PlanFrontmatter;
  content: string;
  toc: TocItem[];
}

const VALID_STATUSES = new Set(["pending", "in-progress", "done", "archived"]);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitList(value: string): string[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function normalizeStatus(value: string): PlanStatus | undefined {
  const normalized = value.toLowerCase().trim().replace(/\s+/g, "-");
  return VALID_STATUSES.has(normalized) ? (normalized as PlanStatus) : undefined;
}

export function parseFrontmatter(raw: string): { frontmatter: PlanFrontmatter; content: string } {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, content: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, content: raw };

  const block = raw.slice(4, end);
  const content = raw.slice(end + 4).replace(/^\n/, "");
  const frontmatter: PlanFrontmatter = {};

  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (!value) continue;

    if (key === "status") {
      const status = normalizeStatus(value);
      if (status) frontmatter.status = status;
    } else if (key === "title") frontmatter.title = value;
    else if (key === "effort") frontmatter.effort = value;
    else if (key === "owner") frontmatter.owner = value;
    else if (key === "due") frontmatter.due = value;
    else if (key === "related") frontmatter.related = splitList(value);
    else if (key === "tags") frontmatter.tags = splitList(value);
  }

  return { frontmatter, content };
}

export function extractToc(markdown: string): TocItem[] {
  const seen = new Map<string, number>();
  return markdown.split("\n").flatMap((line) => {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (!match) return [];
    const text = match[2]!.replace(/\s+#*$/, "").trim();
    const base = slugify(text) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [
      {
        id: count === 0 ? base : `${base}-${count + 1}`,
        text,
        level: match[1]!.length as 1 | 2 | 3,
      },
    ];
  });
}

export function diffStats(code: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of code.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function parsePlanDocument(raw: string): ParsedPlan {
  const parsed = parseFrontmatter(raw);
  return {
    ...parsed,
    toc: extractToc(parsed.content),
  };
}

export function headingIdFromText(text: string, index: number): string {
  return extractToc(`${"#".repeat(2)} ${text}`)[0]?.id ?? `section-${index}`;
}
