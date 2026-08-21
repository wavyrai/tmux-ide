const server = Bun.serve({
  port: 0,
  fetch(request, bunServer) {
    if (bunServer.upgrade(request)) return undefined;
    return new Response("upgrade required", { status: 426 });
  },
  websocket: {
    message(socket, raw) {
      const frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as {
        sequence: number;
        sentAtEpochMicros: number;
      };
      socket.send(
        JSON.stringify({
          ...frame,
          callbackAtEpochMicros: (performance.timeOrigin + performance.now()) * 1_000,
        }),
      );
    },
  },
});
postMessage({ port: server.port });
