import type { RemoteAccessRestartRequest } from "../command-center/actions/handlers/app-set-remote-access.ts";

/** Runtime reset retains the effective listener configuration, not settings defaults. */
export type DaemonRestartRequest =
  | RemoteAccessRestartRequest
  | {
      kind: "runtime";
      bindHostname: string;
      token: string | null;
      port: number;
    };
