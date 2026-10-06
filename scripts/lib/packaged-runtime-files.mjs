/** Apply the same development-file boundary to pack reports and actual archives. */
export function assertNoPackagedContributorTests(paths) {
  const tests = [...paths].filter((path) =>
    /(?:\.test\.|\.spec\.|(?:^|\/)(?:__tests__|__snapshots__)\/)/u.test(path),
  );
  if (tests.length > 0) {
    throw new Error(
      `npm package leaked ${tests.length} contributor test or snapshot files: ${tests.slice(0, 10).join(", ")}`,
    );
  }
}
