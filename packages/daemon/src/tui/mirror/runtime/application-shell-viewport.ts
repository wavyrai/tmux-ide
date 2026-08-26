import { shellChromeLayout } from "../shell-chrome.ts";

/** The one physical terminal viewport after production shell chrome. */
export function applicationShellViewport(
  dimensions: { readonly width: number; readonly height: number },
  hasSemanticShell: boolean,
): { readonly width: number; readonly height: number } {
  if (!hasSemanticShell)
    return {
      width: Math.max(1, dimensions.width),
      height: Math.max(2, dimensions.height - 2),
    };
  const shell = shellChromeLayout(dimensions.width, dimensions.height, 28);
  return {
    width: Math.max(1, shell.main.width),
    height: Math.max(2, shell.main.height - shell.status.height - 1),
  };
}
