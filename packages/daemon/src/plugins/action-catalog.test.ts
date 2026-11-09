import { describe, expect, it } from "vitest";
import { PluginActionCatalog } from "./action-catalog.ts";

const action = (overrides: Record<string, unknown> = {}) => ({
  id: "go",
  title: "Go",
  category: "Plugins",
  dangerous: false,
  params: [],
  ...overrides,
});

function catalog() {
  let changes = 0;
  const made = new PluginActionCatalog(() => {
    changes += 1;
  });
  return { catalog: made, changes: () => changes };
}

describe("PluginActionCatalog.publish", () => {
  it("accepts the longest local id under the longest plugin name", () => {
    const { catalog: c } = catalog();
    const name = `p${"a".repeat(62)}`;
    expect(c.publish(name, JSON.stringify([action({ id: "a".repeat(80) })]))).toBeNull();
    expect(c.entries()[0]?.descriptor.id.length).toBe(151);
  });

  it("refuses an over-long local id instead of throwing", () => {
    const { catalog: c, changes } = catalog();
    const problem = c.publish("p".repeat(63), JSON.stringify([action({ id: "a".repeat(81) })]));
    expect(problem).toMatch(/invalid at 0\.id/u);
    expect(c.entries()).toEqual([]);
    expect(changes()).toBe(0);
  });

  it("refuses an entry the catalog schema rejects, without throwing", () => {
    // The catalog id limit (160) is checked on the built entry, not just
    // on the published list.
    const { catalog: c, changes } = catalog();
    expect(() =>
      c.publish("p".repeat(90), JSON.stringify([action({ id: "a".repeat(80) })])),
    ).not.toThrow();
    expect(c.publish("p".repeat(90), JSON.stringify([action({ id: "a".repeat(80) })]))).toMatch(
      /invalid at descriptor\.id/u,
    );
    expect(c.entries()).toEqual([]);
    expect(changes()).toBe(0);
  });

  it("refuses the whole list when one entry is bad, and keeps the previous list", () => {
    const { catalog: c } = catalog();
    expect(c.publish("tasks", JSON.stringify([action()]))).toBeNull();
    const problem = c.publish(
      "tasks",
      JSON.stringify([action({ id: "fine" }), action({ id: "bad", title: "a\u001b[2Jb" })]),
    );
    expect(problem).toMatch(/invalid at 1\.title/u);
    expect(c.entries().map((e) => e.descriptor.id)).toEqual(["plugin.tasks.go"]);
  });

  it("refuses control, newline and bidi characters in every shown text", () => {
    const bad = [
      action({ title: "a\nb" }),
      action({ title: "a\u009bb" }),
      action({ title: "a\u007fb" }),
      action({ category: "a\u202eb" }),
      action({ description: "a\u0007b" }),
      action({ params: [{ name: "x", type: "text", label: "a\u001bb", optional: false }] }),
      action({ params: [{ name: "x", type: "text", description: "a\rb", optional: false }] }),
      action({ params: [{ name: "x", type: "text", default: "a\u2066b", optional: false }] }),
      action({
        params: [
          {
            name: "x",
            type: "choice",
            optional: false,
            choices: [{ value: "a\u001bb", label: "ok" }],
          },
        ],
      }),
      action({
        params: [
          {
            name: "x",
            type: "choice",
            optional: false,
            choices: [{ value: "ok", label: "a\u0085b" }],
          },
        ],
      }),
    ];
    for (const entry of bad) {
      const { catalog: c, changes } = catalog();
      expect(c.publish("tasks", JSON.stringify([entry])), JSON.stringify(entry)).toMatch(
        /invalid/u,
      );
      expect(c.entries()).toEqual([]);
      expect(changes()).toBe(0);
    }
  });

  it("keeps ordinary Unicode text", () => {
    const { catalog: c } = catalog();
    expect(c.publish("tasks", JSON.stringify([action({ title: "Café: ✓ 日本 🚀" })]))).toBeNull();
    expect(c.entries()[0]?.descriptor.label).toBe("Café: ✓ 日本 🚀");
  });
});
