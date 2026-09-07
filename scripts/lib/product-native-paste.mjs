/** Prepare a trusted OS paste in an owned test browser, retaining clipboard data there. */
export async function prepareNativePaste(page, text) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const clipboard = await page.evaluateHandle(async (text) => {
    const previous = await navigator.clipboard.read();
    // Materialize every advertised type before replacing the clipboard.
    const retained = await Promise.all(
      previous
        .filter((item) => item.types.length > 0)
        .map(async (item) => {
          const entries = await Promise.all(
            item.types.map(async (type) => [type, await item.getType(type)]),
          );
          return new globalThis.ClipboardItem(Object.fromEntries(entries));
        }),
    );
    await navigator.clipboard.writeText(text);
    return { retained };
  }, text);
  return {
    dispatch: () => page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v"),
    async dispose() {
      try {
        await clipboard.evaluate(async ({ retained }) => {
          if (retained.length) await navigator.clipboard.write(retained);
          else await navigator.clipboard.writeText("");
        });
      } finally {
        await clipboard.dispose();
      }
    },
  };
}
