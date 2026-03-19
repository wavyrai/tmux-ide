// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getByPath(obj: Record<string, any>, path: string): unknown {
  return path.split(".").reduce((o: any, k) => o?.[k], obj);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setByPath(obj: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = keys.reduce((o: any, k) => {
    const nextKey = keys[i + 1] ?? last;
    if (o[k] === undefined) o[k] = /^\d+$/.test(nextKey) ? [] : {};
    i++;
    return o[k];
  }, obj);
  target[last] = value;
}
