/**
 * What the PAGE saw, kept for failures.
 *
 * A chain against live infrastructure fails with a product-level message —
 * "the terminal tile never became visible" — while the actual cause is a
 * request that never completed. Playwright's trace holds this, but only if a
 * human opens it; recording the failed requests and console errors as plain
 * text puts the cause in the failure output itself.
 */
import type { Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export interface PageDiagnostics {
  readonly lines: readonly string[];
}

export function recordPageDiagnostics(page: Page): PageDiagnostics {
  const lines: string[] = [];
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  page.on("requestfailed", (request) => {
    lines.push(
      `${stamp()} REQUEST FAILED ${request.method()} ${request.url()} — ${
        request.failure()?.errorText ?? "no error text"
      }`,
    );
  });
  page.on("response", (response) => {
    if (!response.ok() && response.status() >= 400) {
      lines.push(`${stamp()} HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") lines.push(`${stamp()} CONSOLE ERROR ${message.text()}`);
  });
  page.on("pageerror", (error) => lines.push(`${stamp()} PAGE ERROR ${error.message}`));
  page.on("websocket", (socket) => {
    lines.push(`${stamp()} WS OPEN ${socket.url()}`);
    socket.on("socketerror", (error) =>
      lines.push(`${stamp()} WS ERROR ${socket.url()} — ${error}`),
    );
    socket.on("close", () => lines.push(`${stamp()} WS CLOSE ${socket.url()}`));
  });
  return { lines };
}

export async function attachPageDiagnostics(
  testInfo: TestInfo,
  diagnostics: PageDiagnostics,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const path = testInfo.outputPath("page-diagnostics.txt");
  await writeFile(
    path,
    diagnostics.lines.join("\n") || "(the page reported nothing)",
    "utf8",
  ).catch(() => undefined);
  await testInfo.attach("page-diagnostics.txt", { path }).catch(() => undefined);
}
