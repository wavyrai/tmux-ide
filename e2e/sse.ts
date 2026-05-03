export function fulfillSnapshotStream(
  route: {
    fulfill(options: {
      status?: number;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<void>;
  },
  snapshot: unknown,
): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
    body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
  });
}
