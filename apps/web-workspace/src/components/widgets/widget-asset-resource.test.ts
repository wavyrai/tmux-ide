import { expect, it } from "vitest";
import type { WidgetAsset } from "@tmux-ide/contracts";
import { createWidgetAssetResource } from "./widget-asset-resource";

const id = "a".repeat(64);
const asset = (text: string): WidgetAsset => ({
  assetId: id,
  media: "text/markdown",
  name: "note.md",
  data: btoa(text),
});
const deferred = () => {
  let resolve!: (value: WidgetAsset) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WidgetAsset>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
it("discards late completions when a pane or machine binding is removed", async () => {
  const pending = deferred();
  const resource = createWidgetAssetResource(id, "markdown", () => pending.promise);
  const loading = resource.load();
  resource.cancel();
  pending.resolve(asset("old machine"));
  await loading;
  expect(resource.getSnapshot()).toEqual({ status: "loading" });
});
it("keeps the latest retry when an earlier request fails late", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const resource = createWidgetAssetResource(id, "markdown", () =>
    ++calls === 1 ? first.promise : second.promise,
  );
  const old = resource.load();
  const latest = resource.load();
  second.resolve(asset("latest"));
  await latest;
  first.reject(Error("old failure"));
  await old;
  expect(resource.getSnapshot()).toEqual({
    status: "ready",
    document: { kind: "markdown", text: "latest" },
  });
});
it("recovers from an error without retaining the previous error", async () => {
  let calls = 0;
  const resource = createWidgetAssetResource(id, "markdown", async () => {
    if (++calls === 1) throw Error("offline");
    return asset("reconnected");
  });
  await resource.load();
  expect(resource.getSnapshot()).toEqual({ status: "error" });
  await resource.load();
  expect(resource.getSnapshot().status).toBe("ready");
});
it.each([
  { ...asset("hello"), assetId: "b".repeat(64) },
  { ...asset("hello"), media: "image/png" as const },
  { ...asset("hello"), data: "/w==" },
])("rejects mismatched identity, media and malformed UTF-8", async (value) => {
  const resource = createWidgetAssetResource(id, "markdown", async () => value);
  await resource.load();
  expect(resource.getSnapshot()).toEqual({ status: "error" });
});
