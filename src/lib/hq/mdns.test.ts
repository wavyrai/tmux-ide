import { describe, it, expect, afterEach } from "bun:test";
import { MDNSService } from "./mdns.ts";

describe("MDNSService", () => {
  let svc: MDNSService;

  afterEach(async () => {
    if (svc) await svc.stopAdvertising();
  });

  it("starts inactive", () => {
    svc = new MDNSService();
    expect(svc.isActive()).toBe(false);
  });

  it("stopAdvertising is a no-op when not active", async () => {
    svc = new MDNSService();
    await svc.stopAdvertising(); // should not throw
    expect(svc.isActive()).toBe(false);
  });

  if (process.platform === "darwin") {
    it("advertises via dns-sd on macOS", async () => {
      svc = new MDNSService();
      await svc.startAdvertising(19876, "test-tmux-ide");
      expect(svc.isActive()).toBe(true);

      await svc.stopAdvertising();
      expect(svc.isActive()).toBe(false);
    });

    it("skips duplicate startAdvertising", async () => {
      svc = new MDNSService();
      await svc.startAdvertising(19877, "dup-test");
      await svc.startAdvertising(19877, "dup-test"); // should warn but not throw
      expect(svc.isActive()).toBe(true);
    });

    it("advertises _tmux-ide._tcp service type", async () => {
      // The service type is hardcoded in the module. We just verify the
      // service starts successfully (dns-sd logs the type on stdout).
      svc = new MDNSService();
      await svc.startAdvertising(19878);
      expect(svc.isActive()).toBe(true);
    });
  } else {
    it("skips advertisement on non-macOS", async () => {
      svc = new MDNSService();
      await svc.startAdvertising(19876, "test");
      // On non-macOS the service doesn't actually start dns-sd
      expect(svc.isActive()).toBe(false);
    });
  }
});
