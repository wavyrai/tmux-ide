// Explicit-version authenticated offer only. No endpoints, key defaults or filesystem I/O.
import { verifyManifest } from "./preview-release-manifest.mjs";
const fail = () => {
  throw new Error("Release offer unavailable or authentication refused");
};
function https(value, query = false) {
  if (typeof value !== "string" || value.length > 4096) fail();
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!query && url.search) ||
    url.hash
  )
    fail();
  return url;
}
export async function fetchReleaseOffer(options, { fetchImpl = fetch } = {}) {
  if (
    !(options.publicKey instanceof Uint8Array) ||
    options.publicKey.byteLength !== 32 ||
    typeof options.expectedVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.expectedVersion) ||
    options.expectedVersion.includes("..") ||
    !Array.isArray(options.redirectOrigins) ||
    options.redirectOrigins.length > 16 ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    fail();
  const policy = Object.freeze({
    publicKey: Buffer.from(options.publicKey),
    expectedVersion: options.expectedVersion,
  });
  const base = https(options.baseUrl);
  if (!base.pathname.endsWith("/")) fail();
  const redirectOrigins = Object.freeze([...options.redirectOrigins]);
  const origins = new Set([base.origin]);
  for (const value of redirectOrigins) {
    const origin = https(value);
    if (origin.pathname !== "/") fail();
    origins.add(origin.origin);
  }
  const versionBase = new URL(policy.expectedVersion + "/", base).href;
  const callerSignal = options.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30000);
  if (callerSignal?.aborted) abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (controller.signal.aborted) fail();
  };
  async function bounded(action) {
    check();
    let listener;
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(new Error("Release offer cancelled or timed out"));
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    try {
      return await Promise.race([action(), cancelled]);
    } finally {
      controller.signal.removeEventListener("abort", listener);
    }
  }
  async function get(name, cap) {
    let url = new URL(name, versionBase),
      response,
      reader;
    const discard = async () => {
      if (response.body) await bounded(() => response.body.cancel());
    };
    try {
      for (let redirects = 0; ; redirects++) {
        response = await bounded(async () => {
          const received = await fetchImpl(url.href, {
            method: "GET",
            redirect: "manual",
            headers: { "Accept-Encoding": "identity" },
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            void received.body?.cancel().catch(() => {});
            check();
          }
          return received;
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await discard();
        if (redirects >= 3) fail();
        const location = response.headers.get("location");
        if (!location || location.length > 4096) fail();
        url = https(new URL(location, url).href, true);
        if (!origins.has(url.origin)) fail();
      }
      if (
        response.status !== 200 ||
        (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase() !== "identity"
      ) {
        await discard();
        fail();
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^[0-9]{1,6}$/.test(declared) || Number(declared) > cap)) {
        await discard();
        fail();
      }
      if (!response.body) fail();
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const step = await bounded(() => reader.read());
        if (step.done) break;
        if (!(step.value instanceof Uint8Array) || step.value.byteLength > cap - total) fail();
        total += step.value.byteLength;
        chunks.push(Buffer.from(step.value));
      }
      check();
      if (declared !== null && Number(declared) !== total) fail();
      return Buffer.concat(chunks, total);
    } finally {
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  try {
    const manifestBytes = await get("update-manifest.json", 65536);
    const signature = await get("update-manifest.sig", 64);
    verifyManifest(manifestBytes, signature, policy);
    check();
    return Object.freeze({
      manifestBytes,
      signature,
      policy,
      baseUrl: versionBase,
      redirectOrigins,
    });
  } catch {
    fail();
  } finally {
    abort();
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}
