import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as crypto from "node:crypto";
import { AuthService } from "./auth-service.ts";

describe("AuthService", () => {
  let auth: AuthService;
  const SECRET = "test-secret-key-for-jwt";

  beforeEach(() => {
    auth = new AuthService(SECRET);
  });

  afterEach(() => {
    auth.dispose();
  });

  // ---- JWT ----------------------------------------------------------------

  describe("JWT sign/verify round-trip", () => {
    it("generates and verifies a valid token", () => {
      const token = auth.generateToken("alice");
      const result = auth.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe("alice");
    });

    it("works with different user IDs", () => {
      const token = auth.generateToken("bob@example.com");
      const result = auth.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.userId).toBe("bob@example.com");
    });
  });

  describe("expired token rejected", () => {
    it("rejects a token with exp in the past", () => {
      // Create a service with extremely short expiry by manipulating the token
      // We'll manually craft a token with an expired timestamp
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          userId: "alice",
          iat: Math.floor(Date.now() / 1000) - 7200,
          exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
        }),
      ).toString("base64url");
      const sigInput = header + "." + payload;
      const sig = crypto.createHmac("sha256", SECRET).update(sigInput).digest("base64url");
      const expiredToken = `${header}.${payload}.${sig}`;

      const result = auth.verifyToken(expiredToken);
      expect(result.valid).toBe(false);
    });
  });

  describe("tampered token rejected", () => {
    it("rejects a token with modified payload", () => {
      const token = auth.generateToken("alice");
      const parts = token.split(".");

      // Tamper with payload — change userId
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      payload.userId = "eve";
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const tampered = parts.join(".");

      const result = auth.verifyToken(tampered);
      expect(result.valid).toBe(false);
    });

    it("rejects a token with modified signature", () => {
      const token = auth.generateToken("alice");
      const parts = token.split(".");
      // Flip a character in the signature
      const sig = parts[2]!;
      parts[2] = sig[0] === "A" ? "B" + sig.slice(1) : "A" + sig.slice(1);
      const tampered = parts.join(".");

      const result = auth.verifyToken(tampered);
      expect(result.valid).toBe(false);
    });

    it("rejects a token signed with a different secret", () => {
      const other = new AuthService("different-secret");
      const token = other.generateToken("alice");
      other.dispose();

      const result = auth.verifyToken(token);
      expect(result.valid).toBe(false);
    });

    it("rejects garbage strings", () => {
      expect(auth.verifyToken("not.a.jwt").valid).toBe(false);
      expect(auth.verifyToken("").valid).toBe(false);
      expect(auth.verifyToken("only-one-part").valid).toBe(false);
    });
  });

  // ---- SSH challenge-response -------------------------------------------

  describe("SSH challenge with test keypair", () => {
    // Generate an Ed25519 keypair for testing
    function makeTestKey() {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

      // Export raw 32-byte public key
      const rawPub = publicKey.export({ type: "spki", format: "der" });
      // Last 32 bytes of the DER encoding are the raw key
      const raw32 = rawPub.subarray(rawPub.length - 32);

      // Build SSH wire format: uint32(len) + "ssh-ed25519" + uint32(32) + raw32
      const alg = Buffer.from("ssh-ed25519");
      const algLenBuf = Buffer.alloc(4);
      algLenBuf.writeUInt32BE(alg.length);
      const keyLenBuf = Buffer.alloc(4);
      keyLenBuf.writeUInt32BE(32);
      const sshPubBuf = Buffer.concat([algLenBuf, alg, keyLenBuf, raw32]);
      const sshPubStr = `ssh-ed25519 ${sshPubBuf.toString("base64")} test@test`;

      return { publicKey, privateKey, sshPubStr };
    }

    it("creates a challenge and verifies a valid signature", async () => {
      const { privateKey, sshPubStr } = makeTestKey();

      // Create challenge
      const { challengeId, challenge } = auth.createChallenge("testuser");
      expect(challengeId).toBeTruthy();
      expect(challenge).toBeTruthy();

      // Sign the challenge
      const challengeBuf = Buffer.from(challenge, "base64");
      const signature = crypto.sign(null, challengeBuf, privateKey);

      // authenticateWithSSHKey checks authorized_keys which won't exist in test,
      // so we just verify the signature verification path works by checking
      // that it gets past signature verification (fails at authorization)
      const result = await auth.authenticateWithSSHKey({
        publicKey: sshPubStr,
        challengeId,
        signature: signature.toString("base64"),
      });

      // Expect "not authorized" — which means signature verification passed
      expect(result.success).toBe(false);
      expect(result.error).toBe("SSH key not authorized for this user");
    });

    it("rejects an invalid signature", async () => {
      const { sshPubStr } = makeTestKey();

      const { challengeId } = auth.createChallenge("testuser");

      // Send garbage signature (wrong length for ed25519 = 64 bytes)
      const result = await auth.authenticateWithSSHKey({
        publicKey: sshPubStr,
        challengeId,
        signature: Buffer.alloc(64).toString("base64"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid SSH key signature");
    });

    it("rejects an expired/unknown challenge ID", async () => {
      const result = await auth.authenticateWithSSHKey({
        publicKey: "ssh-ed25519 AAAA test",
        challengeId: "nonexistent-id",
        signature: Buffer.alloc(64).toString("base64"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid or expired challenge");
    });
  });
});
