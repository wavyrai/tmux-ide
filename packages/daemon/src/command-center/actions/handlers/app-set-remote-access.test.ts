import { describe, expect, it } from "bun:test";
import {
  appSetRemoteAccessHandler,
  type RemoteAccessRestartRequest,
} from "./app-set-remote-access.ts";
import type { AppSettings } from "../../../lib/app-settings.ts";

describe("appSetRemoteAccessHandler", () => {
  it("enables remote access, persists a token, and requests a 0.0.0.0 restart", async () => {
    let settings: AppSettings = { remoteAccess: { enabled: false, token: null } };
    const restarts: RemoteAccessRestartRequest[] = [];

    const result = await appSetRemoteAccessHandler(
      { enabled: true },
      {
        readSettings: () => settings,
        writeSettings: (next) => {
          settings = next;
        },
        generateToken: () => "token_abc",
        restartDaemon: (request) => {
          restarts.push(request);
          return { host: "192.168.1.20", port: 6060 };
        },
        deferRestart: (restart) => restart(),
        port: 6060,
        host: "192.168.1.20",
      },
    );

    expect(settings).toEqual({ remoteAccess: { enabled: true, token: "token_abc" } });
    expect(restarts).toEqual([
      { enabled: true, bindHostname: "0.0.0.0", token: "token_abc", port: 6060 },
    ]);
    expect(result).toEqual({
      enabled: true,
      url: "http://192.168.1.20:6060",
      token: "token_abc",
      qrPayload: "http://192.168.1.20:6060?token=token_abc",
    });
  });

  it("reuses the existing token when enabling again", async () => {
    let generated = 0;
    const result = await appSetRemoteAccessHandler(
      { enabled: true },
      {
        readSettings: () => ({ remoteAccess: { enabled: false, token: "existing" } }),
        writeSettings: () => {},
        generateToken: () => {
          generated += 1;
          return "new";
        },
        restartDaemon: () => ({ host: "host.local", port: 7000 }),
        deferRestart: (restart) => restart(),
        port: 7000,
      },
    );

    expect(generated).toBe(0);
    expect(result.token).toBe("existing");
  });

  it("disables remote access, clears the token, and requests a loopback restart", async () => {
    let settings: AppSettings = { remoteAccess: { enabled: true, token: "token_abc" } };
    const restarts: RemoteAccessRestartRequest[] = [];

    const result = await appSetRemoteAccessHandler(
      { enabled: false },
      {
        readSettings: () => settings,
        writeSettings: (next) => {
          settings = next;
        },
        restartDaemon: (request) => {
          restarts.push(request);
          return {};
        },
        deferRestart: (restart) => restart(),
        port: 6060,
      },
    );

    expect(settings).toEqual({ remoteAccess: { enabled: false, token: null } });
    expect(restarts).toEqual([
      { enabled: false, bindHostname: "127.0.0.1", token: null, port: 6060 },
    ]);
    expect(result).toEqual({ enabled: false, url: null, token: null, qrPayload: null });
  });

  it("returns before a deferred restart runs", async () => {
    const restarts: RemoteAccessRestartRequest[] = [];
    const deferred: Array<() => void> = [];

    const result = await appSetRemoteAccessHandler(
      { enabled: true },
      {
        readSettings: () => ({ remoteAccess: { enabled: false, token: null } }),
        writeSettings: () => {},
        generateToken: () => "token_abc",
        restartDaemon: (request) => {
          restarts.push(request);
          throw new Error("bind failed");
        },
        deferRestart: (restart) => {
          deferred.push(restart);
        },
        port: 6060,
        host: "192.168.1.20",
      },
    );

    expect(result.enabled).toBe(true);
    expect(restarts).toEqual([]);
    expect(deferred).toHaveLength(1);
  });
});
