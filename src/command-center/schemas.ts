import { z } from "zod";

export const updateTaskSchema = z.object({
  status: z.enum(["todo", "in-progress", "review", "done"]).optional(),
  assignee: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  priority: z.number().optional(),
  goal: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const savePlanSchema = z.object({
  content: z.string(),
});
