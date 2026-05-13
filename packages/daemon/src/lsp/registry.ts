import {
  createLspClient,
  languageForFile,
  type LspClient,
  type Language,
} from "./client.ts";

const clients = new Map<string, Promise<LspClient>>();

function keyFor(root: string, language: Language): string {
  return root + "::" + language;
}

export function getLspClient(
  root: string,
  language: Language,
): Promise<LspClient> {
  const key = keyFor(root, language);
  const existing = clients.get(key);
  if (existing) return existing;
  const pending = createLspClient({ root, language }).catch((err) => {
    clients.delete(key);
    throw err;
  });
  clients.set(key, pending);
  return pending;
}

export async function getLspClientForFile(
  root: string,
  file: string,
): Promise<LspClient | undefined> {
  const language = languageForFile(file);
  if (!language) return undefined;
  return getLspClient(root, language);
}

export async function shutdownAllLspClients(): Promise<void> {
  const pending = [...clients.values()];
  clients.clear();
  await Promise.allSettled(
    pending.map(async (p) => {
      const c = await p.catch(() => null);
      if (c) await c.shutdown();
    }),
  );
}

export { languageForFile } from "./client.ts";
export type { Language, LspClient } from "./client.ts";
