import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing";
import { testRender, type JSX } from "@opentui/solid";
import { afterEach, expect } from "bun:test";
import { terminalDisplayWidth } from "../panel-host.ts";

const activeRenderers = new Set<TestRendererSetup>();

/**
 * Mount a Solid/OpenTUI tree and register it for deterministic teardown.
 *
 * Renderer tests must never leak an attached renderer into the next test. A
 * shared registry makes that invariant automatic while still allowing tests to
 * destroy a renderer early when they need to assert Solid cleanup behavior.
 */
export async function renderForTest(
  node: () => JSX.Element,
  options: TestRendererOptions,
): Promise<TestRendererSetup> {
  const setup = await testRender(node, options);
  activeRenderers.add(setup);
  return setup;
}

export function destroyTestRenderer(setup: TestRendererSetup | null | undefined): void {
  if (!setup) return;
  activeRenderers.delete(setup);
  setup.renderer.destroy();
}

export function destroyAllTestRenderers(): void {
  for (const setup of activeRenderers) setup.renderer.destroy();
  activeRenderers.clear();
}

afterEach(() => {
  destroyAllTestRenderers();
});

export function frameLines(frame: string): string[] {
  const lines = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
  return lines.map((line) => line.replace(/\r$/u, ""));
}

export function stableFrame(frame: string): string {
  return frameLines(frame)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

export function expectFrameBounds(frame: string, width: number, height: number): void {
  const lines = frameLines(frame);
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(width);
}
