// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
//
// Schemas + serializable interfaces only. The daemon-only `RemoteMachine`
// runtime type (Date / Set fields) lives in @tmux-ide/daemon's lib/hq —
// not here.
import { z } from "zod";

export interface HQConfig {
  enabled: boolean;
  role: "hq" | "remote";
  hq_url?: string;
  secret?: string;
  heartbeat_interval?: number;
  machine_name?: string;
}

export interface RegistrationPayload {
  id: string;
  name: string;
  url: string;
  token: string;
}

export const RegistrationPayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  token: z.string().min(1),
});

export const HQConfigSchema = z.object({
  enabled: z.boolean().default(false),
  role: z.enum(["hq", "remote"]),
  hq_url: z.string().url().optional(),
  secret: z.string().optional(),
  heartbeat_interval: z.number().min(1000).default(15000),
  machine_name: z.string().optional(),
});
