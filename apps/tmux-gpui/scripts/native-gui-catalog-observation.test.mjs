import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogObservation, nativeCatalogObservation } from "./native-gui-catalog-observation.mjs";
test("observes catalog without copying session contents, credentials or freeform status", () => {
  const value = {
    version: 1,
    sessions: [{ token: "SECRET", id: "SECRET" }],
    panes: [{ content: "SECRET" }],
    selectedSession: "SECRET",
    selectedPane: "SECRET",
    preferredPane: "SECRET",
    sessionCatalogComplete: true,
    status: "SECRET",
    ownerToken: "SECRET",
    connection: { token: "SECRET" },
    request: 0,
    sequence: 3,
    home: { phase: "live" },
    surface: "home",
  };
  const event = catalogObservation(value);
  assert(!JSON.stringify(event).includes("SECRET"));
  assert.equal(event.sessionCount, 1);
  assert.equal(event.paneCount, 1);
  assert.equal(event.status, "other");
  assert.equal(event.sequence, 3);
  assert.equal(event.preferredPane, true);
  assert.equal(event.sessionCatalogComplete, true);
});
test("ignores capabilities and limits counts", () => {
  assert.equal(
    catalogObservation({ type: "native-terminal-open", capability: { secret: "private" } }),
    null,
  );
  assert.equal(catalogObservation({ version: 1, sessions: Array(1000) }).sessionCount, 513);
});

test("native catalog digest distinguishes layout changes without logging contents", () => {
  const message = {
    type: "native-terminal-catalog",
    request: 1,
    layouts: [{ name: "PRIVATE", active: true }],
  };
  const first = nativeCatalogObservation(message);
  assert(!JSON.stringify(first).includes("PRIVATE"));
  assert.equal(
    nativeCatalogObservation({ ...message, request: 2 }).layoutDigest,
    first.layoutDigest,
  );
  assert.notEqual(
    nativeCatalogObservation({ ...message, layouts: [{ name: "PRIVATE", active: false }] })
      .layoutDigest,
    first.layoutDigest,
  );
  assert.equal(nativeCatalogObservation({ type: "other", layouts: [] }), null);
  assert.equal(nativeCatalogObservation({ ...message, layouts: ["x".repeat(1024 * 1024)] }), null);
});
