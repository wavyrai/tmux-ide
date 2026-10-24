// Exact previously witnessed PIDs only; never discover or sample personal processes.
export async function sampleOwnedRss(owned, { identify, readRss, now = Date.now }) {
  const rows = [];
  for (const target of owned) {
    const row = { name: target.name, pid: target.pid, time: now() };
    try {
      if (!target.identity || (await identify(target.pid)) !== target.identity) {
        rows.push({ ...row, status: "identity-unavailable" });
        continue;
      }
      const rssKiB = await readRss(target.pid);
      if (
        !Number.isSafeInteger(rssKiB) ||
        rssKiB < 0 ||
        (await identify(target.pid)) !== target.identity
      )
        rows.push({ ...row, status: "invalidated" });
      else rows.push({ ...row, status: "ok", rssKiB });
    } catch {
      rows.push({ ...row, status: "unavailable" });
    }
  }
  return rows;
}

// Keep only fixed memory counters; never persist arbitrary diagnostic responses.
export async function sampleOwnedMemory(target, { identify, readDiagnostics, now = Date.now }) {
  const row = { name: target.name, pid: target.pid, time: now() };
  try {
    if (!target.identity || (await identify(target.pid)) !== target.identity)
      return { ...row, status: "identity-unavailable" };
    const data = await readDiagnostics();
    const fields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];
    if (
      data?.pid !== target.pid ||
      data?.daemon?.instanceId !== target.instanceId ||
      !target.instanceId ||
      fields.some((key) => !Number.isSafeInteger(data?.memory?.[key]) || data.memory[key] < 0) ||
      (await identify(target.pid)) !== target.identity
    )
      return { ...row, status: "invalidated" };
    return {
      ...row,
      status: "ok",
      memoryBytes: Object.fromEntries(fields.map((key) => [key, data.memory[key]])),
    };
  } catch {
    return { ...row, status: "unavailable" };
  }
}
