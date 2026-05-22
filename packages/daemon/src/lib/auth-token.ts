import { randomBytes } from "node:crypto";

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}
