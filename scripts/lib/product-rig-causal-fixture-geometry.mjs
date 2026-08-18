const MIN_COLUMNS = 2;

function boundedColumns(value) {
  return Number.isSafeInteger(value) && value >= MIN_COLUMNS ? value : 80;
}

export function createCausalFixtureGeometry({ readColumns, write, markReady, subscribeResize }) {
  let columns = boundedColumns(readColumns());

  const position = (clear, ready) => {
    columns = boundedColumns(readColumns());
    write(
      `\x1b[0m${clear ? "\x1b[2J\x1b[3J" : ""}\x1b[?7l\x1b[1;${columns}H\x1b[2K\x1b[1;${columns}H \x1b[1;${columns}H`,
      () => {
        markReady(ready);
      },
    );
  };

  const unsubscribe = subscribeResize(() => position(false, "ready-v1"));
  return Object.freeze({
    start: () => position(true, "ready-v1"),
    reset: (traceId) => position(true, `ready-v1:${traceId}`),
    columns: () => columns,
    dispose: () => unsubscribe?.(),
  });
}
