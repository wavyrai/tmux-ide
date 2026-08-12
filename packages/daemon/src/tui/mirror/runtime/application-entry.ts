/**
 * Bundle-safe lazy boundary for the production OpenTUI root.
 *
 * The literal specifier is intentional: Bun can embed the Solid-transformed
 * root in the standalone executable without evaluating it during dispatcher
 * startup.
 */
export async function startApplicationEntry(): Promise<void> {
  const { startApplicationRoot } = await import("./application-root.tsx");
  await startApplicationRoot();
}
