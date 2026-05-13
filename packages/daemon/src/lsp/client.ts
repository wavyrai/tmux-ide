import { extname } from "node:path";
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
  PublishDiagnosticsNotification,
  ShutdownRequest,
  ExitNotification,
  type Diagnostic,
  type Hover,
  type Location,
  type LocationLink,
} from "vscode-languageserver-protocol/node.js";
import { launchTypescriptLanguageServer } from "./launch.ts";

export type Language = "typescript";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export function languageForFile(file: string): Language | undefined {
  const ext = extname(file).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return "typescript";
  return undefined;
}

function languageIdFor(file: string): string {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    default:
      return "javascript";
  }
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
  references(
    file: string,
    line: number,
    character: number,
  ): Promise<Location[] | null>;
  diagnostics(file: string): Diagnostic[];
  waitForDiagnostics(file: string, timeoutMs: number): Promise<Diagnostic[]>;
  shutdown(): Promise<void>;
}

const INITIALIZE_TIMEOUT_MS = 30_000;

export async function createLspClient(input: {
  root: string;
  language: Language;
}): Promise<LspClient> {
  if (input.language !== "typescript") {
    throw new Error(`Unsupported LSP language: ${input.language}`);
  }

  const handle = launchTypescriptLanguageServer(input.root);
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
      workspaceFolders: [
        { uri: pathToFileURL(input.root).href, name: "workspace" },
      ],
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          publishDiagnostics: { versionSupport: false },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
      },
      initializationOptions: {},
    } as Parameters<typeof connection.sendRequest>[1]),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("LSP initialize timeout")),
        INITIALIZE_TIMEOUT_MS,
      ),
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
