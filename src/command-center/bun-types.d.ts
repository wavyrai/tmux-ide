// Minimal Bun type declarations for the command center PTY manager
// The command center runs with Bun, but tsc needs these types to compile
declare module "bun" {
  export interface Subprocess {
    stdout: ReadableStream;
    stderr: ReadableStream;
    stdin: { write(data: string): void };
    kill(): void;
    pid: number;
  }

  export function spawn(
    cmd: string[],
    options?: {
      cwd?: string;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      stdin?: "pipe" | "inherit" | "ignore";
      env?: Record<string, string | undefined>;
    },
  ): Subprocess;
}
