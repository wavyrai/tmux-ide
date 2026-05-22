// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import * as crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../log.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthChallenge {
  challengeId: string;
  challenge: Buffer;
  timestamp: number;
  userId: string;
}

export interface AuthResult {
  success: boolean;
  userId?: string;
  token?: string;
  error?: string;
}

interface SSHKeyAuth {
  publicKey: string;
  signature: string;
  challengeId: string;
}

// ---------------------------------------------------------------------------
// JWT helpers (HMAC-SHA256, no external dependency)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64url");
}

function decodeBase64url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec: number): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };

  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(body))];
  const sigInput = segments.join(".");
  const sig = crypto.createHmac("sha256", secret).update(sigInput).digest();
  segments.push(base64url(sig));
  return segments.join(".");
}

function verifyJwt(
  token: string,
  secret: string,
): { valid: true; payload: Record<string, unknown> } | { valid: false } {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false };

  const sigInput = parts[0] + "." + parts[1];
  const expected = crypto.createHmac("sha256", secret).update(sigInput).digest();
  const actual = decodeBase64url(parts[2]!);

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(decodeBase64url(parts[1]!).toString()) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

const TOKEN_EXPIRY_SEC = 24 * 60 * 60; // 24 hours
const CHALLENGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class AuthService {
  private challenges = new Map<string, AuthChallenge>();
  private jwtSecret: string;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(secret?: string) {
    this.jwtSecret = secret ?? process.env.JWT_SECRET ?? crypto.randomBytes(64).toString("hex");
    this.cleanupTimer = setInterval(() => this.cleanupExpiredChallenges(), 60_000);
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [id, ch] of this.challenges) {
      if (now - ch.timestamp > CHALLENGE_TIMEOUT_MS) {
        this.challenges.delete(id);
      }
    }
  }

  // ---- JWT ----------------------------------------------------------------

  generateToken(userId: string): string {
    return signJwt({ userId }, this.jwtSecret, TOKEN_EXPIRY_SEC);
  }

  verifyToken(token: string): { valid: boolean; userId?: string } {
    const result = verifyJwt(token, this.jwtSecret);
    if (!result.valid) return { valid: false };
    return { valid: true, userId: result.payload.userId as string };
  }

  // ---- SSH challenge-response --------------------------------------------

  createChallenge(userId: string): { challengeId: string; challenge: string } {
    const challengeId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32);

    this.challenges.set(challengeId, {
      challengeId,
      challenge,
      timestamp: Date.now(),
      userId,
    });

    return { challengeId, challenge: challenge.toString("base64") };
  }

  async authenticateWithSSHKey(auth: SSHKeyAuth): Promise<AuthResult> {
    const challenge = this.challenges.get(auth.challengeId);
    if (!challenge) {
      return { success: false, error: "Invalid or expired challenge" };
    }

    const sigBuf = Buffer.from(auth.signature, "base64");
    if (!this.verifySSHSignature(challenge.challenge, sigBuf, auth.publicKey)) {
      return { success: false, error: "Invalid SSH key signature" };
    }

    const authorized = this.checkSSHKeyAuthorization(challenge.userId, auth.publicKey);
    if (!authorized) {
      return { success: false, error: "SSH key not authorized for this user" };
    }

    this.challenges.delete(auth.challengeId);
    const token = this.generateToken(challenge.userId);
    return { success: true, userId: challenge.userId, token };
  }

  // ---- SSH helpers -------------------------------------------------------

  private verifySSHSignature(challenge: Buffer, signature: Buffer, publicKeyStr: string): boolean {
    try {
      const parts = publicKeyStr.trim().split(" ");
      if (parts.length < 2) return false;

      const keyType = parts[0];
      const keyData = parts[1]!;

      if (keyType !== "ssh-ed25519") {
        logger.warn("auth", `Unsupported key type: ${keyType}`);
        return false;
      }

      if (signature.length !== 64) return false;

      const sshBuf = Buffer.from(keyData, "base64");
      let offset = 0;
      const algLen = sshBuf.readUInt32BE(offset);
      offset += 4 + algLen;
      const keyLen = sshBuf.readUInt32BE(offset);
      offset += 4;
      if (keyLen !== 32) return false;

      const rawPub = sshBuf.subarray(offset, offset + 32);
      const pubKey = crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from([0x30, 0x2a]),
          Buffer.from([0x30, 0x05]),
          Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]),
          Buffer.from([0x03, 0x21, 0x00]),
          rawPub,
        ]),
        format: "der",
        type: "spki",
      });

      return crypto.verify(null, challenge, pubKey, signature);
    } catch (err) {
      logger.error("auth", "SSH signature verification failed", {
        error: String(err),
      });
      return false;
    }
  }

  private checkSSHKeyAuthorization(userId: string, publicKey: string): boolean {
    try {
      const home = userId === process.env.USER ? homedir() : `/home/${userId}`;
      const authKeysPath = join(home, ".ssh", "authorized_keys");
      if (!existsSync(authKeysPath)) return false;

      const authorizedKeys = readFileSync(authKeysPath, "utf-8");
      const parts = publicKey.trim().split(" ");
      const keyData = parts.length > 1 ? parts[1]! : parts[0]!;
      return authorizedKeys.includes(keyData);
    } catch {
      return false;
    }
  }

  getCurrentUser(): string {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}
