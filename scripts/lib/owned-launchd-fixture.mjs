import {
  CanonicalDaemonReservationSchema,
  CanonicalDaemonInfoSchema,
} from "../../packages/contracts/src/daemon-wire.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";

const refuse = () => new Error("Owned launchd fixture refused");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function literal(value) {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw refuse();
  return value;
}
function xml(value) {
  return (value === "" ? value : literal(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function launchdDefinition({
  root,
  node,
  entry,
  env,
  supervisionId,
  uid = process.getuid(),
  nonce = randomUUID(),
}) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^[0-9a-f-]{36}$/.test(nonce)) throw refuse();
  for (const path of [root, node, entry]) if (!isAbsolute(literal(path))) throw refuse();
  const label = `org.tmux-ide.qualification.${nonce}`;
  if (supervisionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supervisionId))
    throw refuse();
  const args = [
    node,
    entry,
    "--headless",
    "--json",
    ...(supervisionId ? ["--supervised", supervisionId] : []),
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
    env,
  )
    .map(([k, v]) => `<key>${xml(literal(k))}</key><string>${xml(v)}</string>`)
    .join(
      "",
    )}</dict><key>LimitLoadToSessionType</key><string>Aqua</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer><key>StandardOutPath</key><string>${xml(join(root, "service.stdout"))}</string><key>StandardErrorPath</key><string>${xml(join(root, "service.stderr"))}</string></dict></plist>\n`;
  return {
    label,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    path: join(root, "service.plist"),
    node,
    args,
    plist,
    sha256: hash(plist),
  };
}
/** Refuse unrelated login/background contexts; never switch domains after failure. */
export async function inspectLaunchdLoginContext(run, uid = process.getuid()) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw refuse();
  const name = await run(["managername"]);
  const owner = await run(["manageruid"]);
  if (
    name.code !== 0 ||
    name.stdout.trim() !== "Aqua" ||
    owner.code !== 0 ||
    owner.stdout.trim() !== String(uid)
  )
    throw refuse();
  const domain = `gui/${uid}`;
  const result = await run(["print", domain]);
  const scalar = (key) =>
    [...result.stdout.matchAll(new RegExp(`^\\s*${key} = ([^\\n]+)$`, "gm"))].map((m) => m[1]);
  if (
    result.code !== 0 ||
    !result.stdout.startsWith(`${domain} = {`) ||
    JSON.stringify(scalar("type")) !== '["login"]' ||
    JSON.stringify(scalar("uid")) !== JSON.stringify([String(uid)])
  )
    throw refuse();
  return { domain, type: "login", manager: "Aqua", uid };
}

export function inspectLaunchdResult(result, definition) {
  if (result.code !== 0) {
    if (result.code === 113 && result.stderr.includes("Could not find service")) return null;
    throw refuse();
  }
  const text = result.stdout;
  const scalar = (key) => {
    const matches = [...text.matchAll(new RegExp(`^\\s*${key} = (.+)$`, "gm"))];
    if (matches.length !== 1) throw refuse();
    return matches[0][1];
  };
  if (
    !text.startsWith(`${definition.target} = {`) ||
    scalar("path") !== definition.path ||
    scalar("program") !== definition.node
  )
    throw refuse();
  const args = /\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/
    .exec(text)?.[1]
    .split("\n")
    .map((v) => v.trim());
  if (JSON.stringify(args) !== JSON.stringify(definition.args)) throw refuse();
  const matches = [...text.matchAll(/^\s*pid = ([1-9][0-9]*)$/gm)];
  if (matches.length > 1) throw refuse();
  return { pid: matches.length ? Number(matches[0][1]) : null };
}
export function publishLaunchdEntry(path, modulePath, environment) {
  if (!isAbsolute(literal(modulePath))) throw refuse();
  const prefix = environment
    ? `for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, ${JSON.stringify(environment)});\n`
    : "";
  const bytes = `${prefix}await import(${JSON.stringify(pathToFileURL(modulePath).href)});\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  return hash(bytes);
}
/** One exact temporary job; no global environment or service mutation. */
export function ownedLaunchdJob({
  definition,
  run,
  lint,
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof lint !== "function") throw refuse();
  let attempted = false;
  let plistWitness;
  const verify = () => {
    const current = lstatSync(definition.path);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.uid !== process.getuid() ||
      (current.mode & 0o777) !== 0o600 ||
      current.size > 65536 ||
      (plistWitness && (current.ino !== plistWitness.ino || current.dev !== plistWitness.dev))
    )
      throw refuse();
    if (hash(readFileSync(definition.path)) !== definition.sha256) throw refuse();
  };
  const inspect = async () =>
    inspectLaunchdResult(await run(["print", definition.target]), definition);
  return {
    inspect,
    async bootstrap() {
      if (await inspect()) throw refuse();
      writeFileSync(definition.path, definition.plist, { flag: "wx", mode: 0o600 });
      plistWitness = lstatSync(definition.path);
      verify();
      await lint(definition.path);
      verify();
      attempted = true;
      const result = await run(["bootstrap", definition.domain, definition.path]);
      if (result.code !== 0) throw refuse();
    },
    async retire() {
      if (!attempted) return;
      verify();
      if (!(await inspect())) return;
      const result = await run(["bootout", definition.target]);
      if (result.code !== 0) throw refuse();
      const deadline = now() + 30000;
      while (await inspect()) {
        if (now() >= deadline) throw refuse();
        await pause(100);
      }
    },
  };
}

/** Only numeric references are retained; unknown/failed inventories refuse cleanup. */
export function privateRootReferences(result) {
  if (result.stderr || ![0, 1].includes(result.code)) throw refuse();
  if (result.code === 1 && result.stdout.trim()) throw refuse();
  if (!result.stdout.trim()) return [];
  return [
    ...new Set(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          if (!/^p[1-9][0-9]*$/.test(line)) throw refuse();
          return Number(line.slice(1));
        }),
    ),
  ];
}

/** A private record alone does not grant authority to signal a detached owner. */
export async function verifyLaunchdDaemonIdentity({ read, identify, request }) {
  const value = read();
  if (!value) return null;
  const birth = await identify(value.pid);
  if (!birth) return null;
  let response;
  try {
    response = await request(value);
  } catch {
    response = null;
  }
  const current = read();
  const keys = [
    "pid",
    "instanceId",
    "productVersion",
    "protocolVersion",
    "startedAt",
    "port",
    "authToken",
  ];
  if (!current || keys.some((key) => current[key] !== value[key])) return null;
  if (!response) return null;
  if (!response.ok || keys.slice(0, 5).some((key) => response.identity?.[key] !== value[key]))
    throw new Error("public-identity-mismatch");
  const confirmed = await identify(value.pid);
  if (confirmed === null) return null;
  if (confirmed !== birth) throw new Error("owner-incarnation-changed");
  return { value, birth };
}

export function launchdCommandDiagnostic(operation, result) {
  if (!["print", "bootstrap", "bootout", "managername", "manageruid"].includes(operation))
    throw refuse();
  const text = result.stderr.slice(0, 65536);
  const category = !text
    ? "none"
    : text.includes("Could not find service")
      ? "service-not-found"
      : text.includes("Input/output error")
        ? "input-output-error"
        : text.includes("Permission denied") || text.includes("Operation not permitted")
          ? "permission-denied"
          : text.includes("Could not find domain")
            ? "domain-unavailable"
            : "other";
  return {
    operation,
    exitCode: Number.isInteger(result.code) ? result.code : -1,
    stderrCategory: category,
  };
}

/** A reservation is pending; only the declared policy's ready record can be probed. */
export function readLaunchdSupervisedRecord(value, supervisionId) {
  const reservation = CanonicalDaemonReservationSchema.safeParse(value);
  if (reservation.success) {
    if (reservation.data.supervisionId !== supervisionId) throw new Error("invalid-daemon-record");
    return null;
  }
  if (value && typeof value === "object" && "kind" in value)
    throw new Error("invalid-daemon-record");
  const ready = CanonicalDaemonInfoSchema.safeParse(value);
  if (
    !ready.success ||
    ready.data.supervisionId !== supervisionId ||
    ready.data.bindHostname !== "127.0.0.1" ||
    !ready.data.authToken
  )
    throw new Error("invalid-daemon-record");
  return ready.data;
}
