const MIN_COLUMNS = 2;

function boundedColumns(value) {
  return Number.isSafeInteger(value) && value >= MIN_COLUMNS ? value : 80;
}

export function createCausalFixtureGeometry({
  readColumns,
  write,
  markReady,
  subscribeResize,
  clearHistory = true,
}) {
  let columns = boundedColumns(readColumns());
  let readiness = "ready-v1";
  let publication = 0;

  const position = (clear) => {
    const expectedPublication = ++publication;
    const ready = readiness;
    columns = boundedColumns(readColumns());
    write(
      `\x1b[0m${clear ? `\x1b[2J${clearHistory ? "\x1b[3J" : ""}` : ""}\x1b[?7l\x1b[1;${columns}H\x1b[2K\x1b[1;${columns}H \x1b[1;${columns}H`,
      () => {
        if (expectedPublication === publication) markReady(ready);
      },
    );
  };

  const unsubscribe = subscribeResize(() => position(false));
  return Object.freeze({
    start: () => position(true),
    reset: (traceId) => {
      readiness = `ready-v1:${traceId}`;
      position(true);
    },
    columns: () => columns,
    dispose: () => {
      publication += 1;
      unsubscribe?.();
    },
  });
}
