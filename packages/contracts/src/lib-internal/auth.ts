// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { z } from "zod";

export const AuthConfigSchema = z.object({
  /** Auth method: "none" disables auth (default), "ssh" enables SSH key challenge-response. */
  method: z.enum(["none", "ssh"]).default("none"),
  /** JWT secret — auto-generated if omitted. */
  secret: z.string().optional(),
  /** Token expiry in seconds (default 86400 = 24h). */
  token_expiry: z.number().min(60).default(86400),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
