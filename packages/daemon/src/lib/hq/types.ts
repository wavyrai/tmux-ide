// Schemas + serializable types extracted to @tmux-ide/contracts (T056).
// `RemoteMachine` stays here because it carries Date / Set runtime state
// that's daemon-only.
export {
  HQConfigSchema,
  RegistrationPayloadSchema,
  type HQConfig,
  type RegistrationPayload,
} from "@tmux-ide/contracts";

export interface RemoteMachine {
  id: string;
  name: string;
  url: string;
  token: string;
  registeredAt: Date;
  lastHeartbeat: Date;
  sessionIds: Set<string>;
}
