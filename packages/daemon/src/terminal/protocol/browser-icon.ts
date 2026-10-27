/** Browser-provided 16×16 RGBA pixels, never a URL or filesystem path. */
export function browserIcon(value: string, alive = processAlive): string | null {
  const match = /^([1-9][0-9]{0,9}):([0-9a-f]{2048}|)$/u.exec(value);
  if (!match || !alive(Number(match[1]))) return null;
  return match[2]!;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
