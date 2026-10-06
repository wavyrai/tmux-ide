/**
 * Clipboard writes for copy actions. Browser-only: call from event handlers.
 *
 * A pending source (for example a fetched Markdown page) is handed to
 * ClipboardItem as a promise so the write stays attached to the user's click
 * in browsers that drop the gesture across an await; everything else falls
 * back to writeText and finally to a hidden-textarea copy.
 */
export async function writeClipboard(source: string | Promise<string>): Promise<boolean> {
  try {
    if (
      typeof source !== "string" &&
      typeof ClipboardItem !== "undefined" &&
      navigator.clipboard?.write
    ) {
      const blob = source.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
  } catch {
    // Fall through to the text paths below.
  }

  let text: string;
  try {
    text = await source;
  } catch {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
