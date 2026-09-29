/** Enumeration uncertainty never prevents attempts to retire directly owned children. */
export async function captureDescendants(roots, inspect, limit = 32, budgetMs = 10_000, now = Date.now) {
  const pids = new Set(), errors = [];
  const deadline = now() + budgetMs;
  const add = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid descendant PID');
    if (!pids.has(pid) && pids.size >= limit) throw Error('Descendant bound exceeded');
    pids.add(pid);
  };
  for (const pid of roots) {
    try { add(pid); } catch (error) { errors.push(String(error)); }
  }
  for (const pid of pids) {
    const remaining = deadline - now();
    if (remaining <= 0) { errors.push("Descendant enumeration deadline exceeded"); break; }
    try { for (const child of await inspect(pid, remaining)) add(child); }
    catch (error) { errors.push(`enumerate ${pid}: ${String(error)}`); }
  }
  return { pids: [...pids], errors };
}
export function requireSuccessfulExit(child) {
  if (child.exitCode !== 0 || child.signalCode !== null)
    throw Error(`Reader retirement failed: exit=${child.exitCode}, signal=${child.signalCode}`);
}
