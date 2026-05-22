import { z } from "zod";

/** Shared status shape for tunnel providers (Tailscale Serve, ngrok, Cloudflare Quick Tunnel). */
export type TunnelStatus = {
  running: boolean;
  publicUrl?: string | null;
  port?: number;
  lastError?: string;
  /** Provider-specific fields (funnel, mode, etc.) */
  meta?: Record<string, unknown>;
};

/**
 * Common surface for tunnel integrations (see `tailscale.ts`, `ngrok.ts`, `cloudflare.ts`).
 * Concrete classes may take additional constructor arguments (port, auth, etc.).
 */
export interface TunnelService {
  start(...args: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
}

export const tunnelConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("tailscale"),
    port: z.number().int().positive(),
    enableFunnel: z.boolean().optional(),
  }),
  z.object({
    provider: z.literal("ngrok"),
    port: z.number().int().positive(),
    authToken: z.string().optional(),
    domain: z.string().optional(),
    region: z.string().optional(),
    startupTimeoutMs: z.number().positive().optional(),
  }),
  z.object({
    provider: z.literal("cloudflare"),
    port: z.number().int().positive(),
    startupTimeoutMs: z.number().positive().optional(),
  }),
]);

export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;
