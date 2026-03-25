import { z } from "zod";

export const updateTaskSchema = z.object({
  status: z.enum(["todo", "in-progress", "review", "done"]).optional(),
  assignee: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  description: z.string().optional(),
  priority: z.number().optional(),
  goal: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const savePlanSchema = z.object({
  content: z.string(),
});

export const sendCommandSchema = z.object({
  target: z.string().min(1, "Target pane is required"),
  message: z.string().min(1, "Message is required"),
  noEnter: z.boolean().optional(),
});

export const launchSchema = z
  .object({
    attach: z.boolean().optional(),
  })
  .optional();

export const stopSchema = z.object({}).optional();
