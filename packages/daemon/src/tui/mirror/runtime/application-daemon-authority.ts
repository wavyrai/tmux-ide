export {
  createApplicationDaemonAuthority,
  type ApplicationDaemonAuthorityDependencies,
  type ApplicationDaemonEndpoint,
} from "./application-daemon-authority-owner.ts";
import {
  applicationMachineAuthorityManager,
  initializeSelectedApplicationSshAuthority,
} from "./application-machine-authority.ts";
export const readApplicationDaemonInfo = applicationMachineAuthorityManager.read;
export const isApplicationDaemonAlive = applicationMachineAuthorityManager.isAlive;
export const observeApplicationDaemonGeneration =
  applicationMachineAuthorityManager.observeSelected;
export const applicationDaemonEndpoint = applicationMachineAuthorityManager.endpoint;
export const initializeApplicationSshAuthority = initializeSelectedApplicationSshAuthority;
export const disposeApplicationDaemonAuthority = applicationMachineAuthorityManager.dispose;
