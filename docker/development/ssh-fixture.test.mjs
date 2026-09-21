import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  authorizedPublicKey,
  renderFixtureSshConfig,
  validateFixtureLease,
  requireFixtureOriginalCommand,
} from "./ssh-fixture.mjs";
const lease = {
  version: 1,
  worktree: "/workspace/tree",
  store: "/state/instances",
  name: `ti-dev-${"a".repeat(24)}`,
  instanceId: `dev-${"b".repeat(24)}`,
  generation: `build-${randomUUID()}`,
  manifestHash: "c".repeat(64),
  daemonId: randomUUID(),
  pid: 123,
  port: 43210,
  startedAt: "2026-09-17T00:00:00Z",
  protocolVersion: 1,
  productVersion: "2.9.0-beta.18",
};
test("fixed nonroot SSH configuration allows only the verified loopback daemon forward", () => {
  const config = renderFixtureSshConfig(lease);
  for (const setting of [
    "AllowUsers node",
    "AuthenticationMethods publickey",
    "UsePAM no",
    "PasswordAuthentication no",
    "PermitRootLogin no",
    "AllowTcpForwarding local",
    "PermitListen none",
    "PermitOpen 127.0.0.1:43210",
    "AllowStreamLocalForwarding no",
    "PermitTunnel no",
    "PermitTTY no",
    "PermitUserRC no",
    "PermitUserEnvironment no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
  ])
    assert.ok(config.includes(`${setting}\n`));
  assert.ok(
    config.includes("ForceCommand /usr/local/bin/node /opt/fixture/ssh-fixture.mjs dispatch\n"),
  );
  assert.ok(!config.includes("AcceptEnv"));
  assert.ok(!config.includes("Include"));
});
test("rejects injected ports/targets and malformed lease before producing config", () => {
  for (const changed of [
    { port: "43210\nPermitOpen any" },
    { port: 0 },
    { worktree: "/home/node" },
    { name: "x;command" },
    { generation: "bad" },
    { manifestHash: "bad" },
    { daemonId: "bad" },
    { store: "/production" },
  ])
    assert.throws(() => renderFixtureSshConfig({ ...lease, ...changed }));
  for (const value of [null, false, [], {}]) assert.throws(() => validateFixtureLease(value));
});
test("accepts one plain ed25519 public key while stripping comments; rejects options/multiple keys", () => {
  const blob = Buffer.alloc(51);
  blob.writeUInt32BE(11, 0);
  blob.write("ssh-ed25519", 4);
  blob.writeUInt32BE(32, 15);
  const key = `ssh-ed25519 ${blob.toString("base64")}`;
  assert.equal(authorizedPublicKey(`${key} private-label\n`), `${key}\n`);
  for (const value of [
    `command="evil" ${key}`,
    `${key}\n${key}`,
    "ssh-ed25519 AAAA",
    `${key}\ncommand`,
  ])
    assert.throws(() => authorizedPublicKey(value));
});

test("forced dispatcher accepts only the exact existing readonly CLI command", () => {
  assert.doesNotThrow(() => requireFixtureOriginalCommand("tmux-ide remote-daemon-info --json"));
  for (const command of [
    undefined,
    "",
    "bash",
    "tmux-ide up",
    "tmux-ide remote-daemon-info --json; id",
    "tmux-ide remote-daemon-info --json\n",
    " tmux-ide remote-daemon-info --json",
  ])
    assert.throws(() => requireFixtureOriginalCommand(command));
});
