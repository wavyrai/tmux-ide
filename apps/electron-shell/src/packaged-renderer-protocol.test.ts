import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_PACKAGED_RENDERER_ENTRY_URL,
  DESKTOP_PACKAGED_RENDERER_ORIGIN,
  developmentRendererContentSecurityPolicy,
  installDevelopmentRendererCsp,
  installPackagedRendererProtocol,
  packagedRendererContentSecurityPolicy,
  registerPackagedRendererScheme,
} from "./packaged-renderer-protocol.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tmux-ide-renderer-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>tmux-ide</title>");
  await writeFile(join(root, "assets", "app-ABC123.js"), "export {};\n");

  let handler: ((request: Request) => Response | Promise<Response>) | null = null;
  const protocol = {
    handle: vi.fn((_scheme: string, next: typeof handler) => {
      handler = next;
    }),
    unhandle: vi.fn(),
  };
  const fileFetcher = {
    fetch: vi.fn(
      async () =>
        new Response("export {};\n", {
          headers: { "Content-Type": "text/javascript" },
        }),
    ),
  };
  const dispose = installPackagedRendererProtocol({
    protocol,
    fileFetcher,
    rendererRoot: root,
    contentSecurityPolicy: () => packagedRendererContentSecurityPolicy("http://127.0.0.1:6060"),
  });
  const installedHandler = handler as ((request: Request) => Response | Promise<Response>) | null;
  if (!installedHandler) throw new Error("handler was not installed");
  return { handler: installedHandler, protocol, fileFetcher, dispose };
}

describe("packaged renderer protocol", () => {
  it("registers one standard secure scheme without CSP bypass or service workers", () => {
    const registerSchemesAsPrivileged = vi.fn();
    registerPackagedRendererScheme({ registerSchemesAsPrivileged });
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "tmux-ide",
        privileges: expect.objectContaining({
          standard: true,
          secure: true,
          supportFetchAPI: true,
          bypassCSP: false,
          allowServiceWorkers: false,
          corsEnabled: false,
        }),
      },
    ]);
  });

  it("serves only the entry point and flat, built asset names", async () => {
    const { handler, fileFetcher } = await fixture();
    const entry = await handler(new Request(DESKTOP_PACKAGED_RENDERER_ENTRY_URL));
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("tmux-ide");
    expect(entry.headers.get("content-security-policy")).toContain(
      "connect-src 'self' ws://127.0.0.1:6060",
    );
    expect(entry.headers.get("x-content-type-options")).toBe("nosniff");

    const asset = await handler(
      new Request(`${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/app-ABC123.js`),
    );
    expect(asset.status).toBe(200);
    expect(fileFetcher.fetch).toHaveBeenCalledOnce();

    for (const url of [
      "tmux-ide://other/index.html",
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/secret.txt`,
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/nested/app.js`,
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/%2e%2e/secret.js`,
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/app.js?cache=1`,
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/no-extension`,
      `${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/app.js.map`,
    ]) {
      expect((await handler(new Request(url))).status, url).toBe(404);
    }
    expect(
      (await handler(new Request(DESKTOP_PACKAGED_RENDERER_ENTRY_URL, { method: "POST" }))).status,
    ).toBe(405);
  });

  it("unregisters the exact scheme and contains file failures", async () => {
    const { handler, protocol, fileFetcher, dispose } = await fixture();
    fileFetcher.fetch.mockRejectedValueOnce(new Error("private path"));
    expect(
      (await handler(new Request(`${DESKTOP_PACKAGED_RENDERER_ORIGIN}/assets/app-ABC123.js`)))
        .status,
    ).toBe(404);
    dispose();
    expect(protocol.unhandle).toHaveBeenCalledWith("tmux-ide");
  });

  it("emits an exact current loopback daemon connect source and rejects malformed origins", () => {
    expect(packagedRendererContentSecurityPolicy("http://localhost:6123")).toContain(
      "connect-src 'self' ws://localhost:6123",
    );
    expect(packagedRendererContentSecurityPolicy("http://[::1]:6123")).toContain(
      "connect-src 'self' ws://[::1]:6123",
    );
    for (const value of [
      "https://127.0.0.1:6060",
      "http://127.0.0.1",
      "http://127.0.0.1:6060/path",
      "http://evil.invalid:6060",
      "not-an-origin",
    ]) {
      expect(packagedRendererContentSecurityPolicy(value)).toContain("connect-src 'self';");
      expect(packagedRendererContentSecurityPolicy(value)).not.toContain("ws://");
    }
  });

  it("narrows development responses to Vite HMR and the current daemon", () => {
    let listener:
      | ((
          details: {
            url: string;
            resourceType: string;
            responseHeaders?: Record<string, string | string[]>;
          },
          callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void,
        ) => void)
      | null = null;
    const onHeadersReceived = vi.fn((_filter, next) => {
      listener = next;
    });
    const dispose = installDevelopmentRendererCsp({
      webRequest: { onHeadersReceived },
      rendererOrigin: "http://127.0.0.1:5173",
      contentSecurityPolicy: () =>
        developmentRendererContentSecurityPolicy("http://127.0.0.1:6060", "http://127.0.0.1:5173"),
    });
    const installed = listener as
      | ((
          details: {
            url: string;
            resourceType: string;
            responseHeaders?: Record<string, string | string[]>;
          },
          callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void,
        ) => void)
      | null;
    if (!installed) throw new Error("CSP listener was not installed");
    let response: { responseHeaders?: Record<string, string | string[]> } | undefined;
    installed(
      {
        url: "http://127.0.0.1:5173/",
        resourceType: "mainFrame",
        responseHeaders: { Server: ["vite"], "content-security-policy": ["stale"] },
      },
      (value: { responseHeaders?: Record<string, string | string[]> }) => {
        response = value;
      },
    );
    const policy = response?.responseHeaders?.["Content-Security-Policy"]?.[0];
    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:5173 ws://127.0.0.1:6060");
    expect(JSON.stringify(response?.responseHeaders)).not.toContain("stale");
    expect(response?.responseHeaders?.Server).toEqual(["vite"]);

    dispose();
    expect(onHeadersReceived).toHaveBeenLastCalledWith({ urls: ["http://127.0.0.1:5173/*"] }, null);
  });
});
