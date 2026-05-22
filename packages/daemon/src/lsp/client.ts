import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  HoverRequest,
  DefinitionRequest,
  ReferencesRequest,
  WorkspaceSymbolRequest,
  RenameRequest,
  CodeActionRequest,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  ExitNotification,
  type CodeAction,
  type Command,
  type Diagnostic,
  type Hover,
  type Location,
  type LocationLink,
  type Range,
  type SymbolInformation,
  type WorkspaceSymbol,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node.js";
import {
  languageServerConfig,
  languageServerConfigForFile,
  launchLanguageServer,
  type Language,
} from "./launch.ts";

export type { Language } from "./launch.ts";

export function languageForFile(file: string): Language | undefined {
  return languageServerConfigForFile(file)?.language;
}

function languageIdFor(file: string): string {
  const config = languageServerConfigForFile(file);
  // Fall back to "plaintext" when the file extension isn't in the
  // table — `ensureOpen` only reaches here after `languageForFile`
  // already returned a non-undefined value, but we stay defensive.
  return config ? config.languageIdFor(file) : "plaintext";
}

export interface LspClient {
  readonly root: string;
  readonly language: Language;
  ensureOpen(file: string): Promise<void>;
  hover(file: string, line: number, character: number): Promise<Hover | null>;
  definition(
    file: string,
    line: number,
    character: number,
  ): Promise<Location | Location[] | LocationLink[] | null>;
  references(file: string, line: number, character: number): Promise<Location[] | null>;
  diagnostics(file: string): Diagnostic[];
  waitForDiagnostics(file: string, timeoutMs: number): Promise<Diagnostic[]>;
  workspaceSymbols(query: string): Promise<Array<SymbolInformation | WorkspaceSymbol> | null>;
  rename(
    file: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<WorkspaceEdit | null>;
  codeActions(
    file: string,
    range: Range,
    diagnostics?: Diagnostic[],
  ): Promise<Array<Command | CodeAction> | null>;
  shutdown(): Promise<void>;
}

const INITIALIZE_TIMEOUT_MS = 30_000;

export async function createLspClient(input: {
  root: string;
  language: Language;
}): Promise<LspClient> {
  // Confirm the language is registered. Throws on a typo at call
  // sites; an unregistered language is a bug, not a missing binary.
  languageServerConfig(input.language);

  const handle = launchLanguageServer(input.language, input.root);
  if (!handle) {
    // Binary not on PATH and no workspace-local copy — degrade to a
    // no-op client so the rest of the daemon (and the agent) keep
    // going. The user might not have `pyright` / `rust-analyzer` /
    // `gopls` installed but should still be able to edit those
    // files without the LSP service crashing the chat loop.
    return makeNoOpLspClient(input.root, input.language);
  }
  handle.process.stderr.on("data", () => {
    /* swallow stderr — surface via logs separately if needed */
  });

  const connection: ProtocolConnection = createProtocolConnection(
    new StreamMessageReader(handle.process.stdout),
    new StreamMessageWriter(handle.process.stdin),
  );

  const diagnosticsByFile = new Map<string, Diagnostic[]>();
  const openDocs = new Map<string, { version: number; text: string }>();
  const diagnosticsWaiters = new Map<string, Array<() => void>>();

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    let file: string;
    try {
      file = fileURLToPath(params.uri);
    } catch {
      return;
    }
    diagnosticsByFile.set(file, params.diagnostics);
    const waiters = diagnosticsWaiters.get(file);
    if (waiters?.length) {
      diagnosticsWaiters.delete(file);
      for (const w of waiters) w();
    }
  });

  // Some servers ask for these; respond with empty/no-op.
  connection.onRequest("workspace/configuration", () => []);
  connection.onRequest("window/workDoneProgress/create", () => null);
  connection.onRequest("client/registerCapability", () => null);
  connection.onRequest("client/unregisterCapability", () => null);

  connection.listen();

  const initializeResult = await Promise.race([
    connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(input.root).href,
      workspaceFolders: [{ uri: pathToFileURL(input.root).href, name: "workspace" }],
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          rename: { prepareSupport: false },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "",
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                ],
              },
            },
          },
          publishDiagnostics: { versionSupport: false },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: {},
          applyEdit: false,
        },
      },
      initializationOptions: {},
    } as Parameters<typeof connection.sendRequest>[1]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("LSP initialize timeout")), INITIALIZE_TIMEOUT_MS),
    ),
  ]);
  void initializeResult;

  await connection.sendNotification(InitializedNotification.type, {});

  async function ensureOpen(file: string): Promise<void> {
    if (openDocs.has(file)) return;
    const text = await readFile(file, "utf-8").catch(() => "");
    openDocs.set(file, { version: 0, text });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: pathToFileURL(file).href,
        languageId: languageIdFor(file),
        version: 0,
        text,
      },
    });
  }

  async function touch(file: string): Promise<void> {
    const current = openDocs.get(file);
    if (!current) {
      await ensureOpen(file);
      return;
    }
    const text = await readFile(file, "utf-8").catch(() => current.text);
    if (text === current.text) return;
    const nextVersion = current.version + 1;
    openDocs.set(file, { version: nextVersion, text });
    await connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: pathToFileURL(file).href, version: nextVersion },
      contentChanges: [{ text }],
    });
  }

  return {
    root: input.root,
    language: input.language,
    ensureOpen,
    async hover(file, line, character) {
      await ensureOpen(file);
      await touch(file);
      return connection
        .sendRequest(HoverRequest.type, {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line, character },
        })
        .catch(() => null);
    },
    async definition(file, line, character) {
      await ensureOpen(file);
      await touch(file);
      return connection
        .sendRequest(DefinitionRequest.type, {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line, character },
        })
        .catch(() => null);
    },
    async references(file, line, character) {
      await ensureOpen(file);
      await touch(file);
      return connection
        .sendRequest(ReferencesRequest.type, {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line, character },
          context: { includeDeclaration: true },
        })
        .catch(() => null);
    },
    diagnostics(file) {
      return diagnosticsByFile.get(file) ?? [];
    },
    async workspaceSymbols(query) {
      return connection.sendRequest(WorkspaceSymbolRequest.type, { query }).catch(() => null);
    },
    async rename(file, line, character, newName) {
      await ensureOpen(file);
      await touch(file);
      return connection
        .sendRequest(RenameRequest.type, {
          textDocument: { uri: pathToFileURL(file).href },
          position: { line, character },
          newName,
        })
        .catch(() => null);
    },
    async codeActions(file, range, diagnostics) {
      await ensureOpen(file);
      await touch(file);
      return connection
        .sendRequest(CodeActionRequest.type, {
          textDocument: { uri: pathToFileURL(file).href },
          range,
          context: { diagnostics: diagnostics ?? [] },
        })
        .catch(() => null);
    },
    async waitForDiagnostics(file, timeoutMs) {
      const existing = diagnosticsByFile.get(file);
      if (existing) return existing;
      return new Promise<Diagnostic[]>((resolve) => {
        const timer = setTimeout(() => {
          const waiters = diagnosticsWaiters.get(file);
          if (waiters) {
            const idx = waiters.indexOf(done);
            if (idx >= 0) waiters.splice(idx, 1);
            if (waiters.length === 0) diagnosticsWaiters.delete(file);
          }
          resolve(diagnosticsByFile.get(file) ?? []);
        }, timeoutMs);
        const done = () => {
          clearTimeout(timer);
          resolve(diagnosticsByFile.get(file) ?? []);
        };
        const waiters = diagnosticsWaiters.get(file) ?? [];
        waiters.push(done);
        diagnosticsWaiters.set(file, waiters);
      });
    },
    async shutdown() {
      try {
        await connection.sendRequest(ShutdownRequest.type);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        /* ignore */
      }
      try {
        connection.dispose();
      } catch {
        /* ignore */
      }
      if (!handle.process.killed) {
        handle.process.kill();
      }
    },
  };
}

/**
 * Construct a no-op LspClient — used when the language is registered
 * (we know how it *would* spawn) but the binary isn't available on
 * the host. Every verb resolves to the empty / null variant the
 * G21-P1 REST endpoints already expose for "nothing to report":
 *
 *   hover            → null
 *   definition       → null
 *   references       → null
 *   diagnostics      → []
 *   workspaceSymbols → null
 *   rename           → null
 *   codeActions      → null
 *
 * The chat tools' wrapping envelope is unchanged so the agent sees a
 * predictable empty response rather than a thrown exception
 * propagating up the tool loop.
 */
function makeNoOpLspClient(root: string, language: Language): LspClient {
  return {
    root,
    language,
    async ensureOpen() {
      // No server to notify.
    },
    async hover() {
      return null;
    },
    async definition() {
      return null;
    },
    async references() {
      return null;
    },
    diagnostics() {
      return [];
    },
    async waitForDiagnostics() {
      return [];
    },
    async workspaceSymbols() {
      return null;
    },
    async rename() {
      return null;
    },
    async codeActions() {
      return null;
    },
    async shutdown() {
      // Nothing to tear down.
    },
  };
}
