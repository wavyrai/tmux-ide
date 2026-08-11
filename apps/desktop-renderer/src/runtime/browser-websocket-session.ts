type BrowserWebSocketUrlRewriter = (url: string) => string;

let current: { readonly owner: symbol; readonly rewrite: BrowserWebSocketUrlRewriter } | null =
  null;

/**
 * Document-local development seam for browser-created privileged sockets.
 * Production never installs a rewriter. The descriptor remains a canonical,
 * credential-free daemon contract; only the actual browser handshake receives
 * the Vite-only document capability.
 */
export function installBrowserWebSocketUrlRewriter(
  rewrite: BrowserWebSocketUrlRewriter,
): () => void {
  const owner = Symbol("browser-websocket-url-rewriter");
  current = { owner, rewrite };
  return () => {
    if (current?.owner === owner) current = null;
  };
}

export function browserWebSocketHandshakeUrl(url: string): string {
  return current?.rewrite(url) ?? url;
}
