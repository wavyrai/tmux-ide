import { once } from "node:events";

// Only an exact child created by this fixture may be passed here.
export async function stopFixtureChild(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const controller = new AbortController();
  const closed = once(child, "close", { signal: controller.signal });
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  const deadline = setTimeout(() => controller.abort(), graceMs + 2000);
  try {
    child.kill("SIGTERM");
    await closed;
  } finally {
    clearTimeout(escalation);
    clearTimeout(deadline);
    controller.abort();
  }
}
