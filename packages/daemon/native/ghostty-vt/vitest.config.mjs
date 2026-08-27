import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/full-canonical-conformance.test.ts"],
    environment: "node",
  },
});
