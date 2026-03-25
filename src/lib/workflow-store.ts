import { join } from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { getTasksRoot } from "./task-store.ts";

const SCHEMA_VERSION = 1;

function atomicWriteJSON(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, filePath);
}

// MARK: - Checkpoint

export interface Checkpoint {
  id: string;
  taskId: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdBy: string;
  reviewedBy: string | null;
  created: string;
  updated: string;
  diff: string | null;
  files: string[];
  comments: string[];
}

function checkpointsDir(dir: string): string {
  return join(getTasksRoot(dir), "checkpoints");
}

function ensureCheckpointsDir(dir: string): void {
  const d = checkpointsDir(dir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function nextCheckpointId(dir: string): string {
  const d = checkpointsDir(dir);
  if (!existsSync(d)) return "001";
  const files = readdirSync(d).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "001";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(3, "0");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function loadCheckpoints(dir: string): Checkpoint[] {
  const d = checkpointsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf-8")) as Checkpoint;
      } catch {
        return null;
      }
    })
    .filter((c): c is Checkpoint => c !== null);
}

export function loadCheckpoint(dir: string, id: string): Checkpoint | null {
  const d = checkpointsDir(dir);
  if (!existsSync(d)) return null;
  const file = readdirSync(d).find((f) => f.startsWith(id + "-") || f === id + ".json");
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(join(d, file), "utf-8")) as Checkpoint;
  } catch {
    return null;
  }
}

export function loadCheckpointsForTask(dir: string, taskId: string): Checkpoint[] {
  return loadCheckpoints(dir).filter((c) => c.taskId === taskId);
}

export function saveCheckpoint(dir: string, checkpoint: Checkpoint): void {
  ensureCheckpointsDir(dir);
  const d = checkpointsDir(dir);
  const filename = `${checkpoint.id}-${slugify(checkpoint.title)}.json`;
  const newPath = join(d, filename);
  // Remove old file if slug changed
  const existing = readdirSync(d).find(
    (f) => f.startsWith(checkpoint.id + "-") || f === checkpoint.id + ".json",
  );
  atomicWriteJSON(newPath, { _version: SCHEMA_VERSION, ...checkpoint });
  if (existing && join(d, existing) !== newPath) unlinkSync(join(d, existing));
}

export function deleteCheckpoint(dir: string, id: string): boolean {
  const d = checkpointsDir(dir);
  if (!existsSync(d)) return false;
  const file = readdirSync(d).find((f) => f.startsWith(id + "-") || f === id + ".json");
  if (!file) return false;
  unlinkSync(join(d, file));
  return true;
}

// MARK: - Review Request

export interface ReviewRequest {
  id: string;
  taskId: string;
  checkpointId: string | null;
  title: string;
  description: string;
  status: "open" | "approved" | "changes-requested" | "closed";
  requestedBy: string;
  reviewer: string | null;
  created: string;
  updated: string;
  comments: ReviewComment[];
}

export interface ReviewComment {
  author: string;
  body: string;
  created: string;
}

function reviewsDir(dir: string): string {
  return join(getTasksRoot(dir), "reviews");
}

function ensureReviewsDir(dir: string): void {
  const d = reviewsDir(dir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function nextReviewId(dir: string): string {
  const d = reviewsDir(dir);
  if (!existsSync(d)) return "001";
  const files = readdirSync(d).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "001";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(3, "0");
}

export function loadReviews(dir: string): ReviewRequest[] {
  const d = reviewsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(d, f), "utf-8")) as ReviewRequest;
      } catch {
        return null;
      }
    })
    .filter((r): r is ReviewRequest => r !== null);
}

export function loadReview(dir: string, id: string): ReviewRequest | null {
  const d = reviewsDir(dir);
  if (!existsSync(d)) return null;
  const file = readdirSync(d).find((f) => f.startsWith(id + "-") || f === id + ".json");
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(join(d, file), "utf-8")) as ReviewRequest;
  } catch {
    return null;
  }
}

export function loadReviewsForTask(dir: string, taskId: string): ReviewRequest[] {
  return loadReviews(dir).filter((r) => r.taskId === taskId);
}

export function saveReview(dir: string, review: ReviewRequest): void {
  ensureReviewsDir(dir);
  const d = reviewsDir(dir);
  const filename = `${review.id}-${slugify(review.title)}.json`;
  const newPath = join(d, filename);
  const existing = readdirSync(d).find(
    (f) => f.startsWith(review.id + "-") || f === review.id + ".json",
  );
  atomicWriteJSON(newPath, { _version: SCHEMA_VERSION, ...review });
  if (existing && join(d, existing) !== newPath) unlinkSync(join(d, existing));
}

export function deleteReview(dir: string, id: string): boolean {
  const d = reviewsDir(dir);
  if (!existsSync(d)) return false;
  const file = readdirSync(d).find((f) => f.startsWith(id + "-") || f === id + ".json");
  if (!file) return false;
  unlinkSync(join(d, file));
  return true;
}
