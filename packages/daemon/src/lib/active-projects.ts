export interface ProjectActivationOptions {
  orchestrate?: boolean;
}

export interface ProjectActivationBackend {
  activateProject(name: string, options?: ProjectActivationOptions): Promise<void>;
  deactivateProject(name: string): Promise<void>;
}

let backend: ProjectActivationBackend | null = null;
const active = new Set<string>();

export function setActivationBackend(next: ProjectActivationBackend | null): void {
  backend = next;
  active.clear();
}

export function isProjectActive(name: string): boolean {
  return active.has(name);
}

export async function activateProject(
  name: string,
  options: ProjectActivationOptions = {},
): Promise<void> {
  if (active.has(name) && !options.orchestrate) return;
  if (!backend) {
    throw new Error("No active-project backend is registered");
  }
  await backend.activateProject(name, options);
  active.add(name);
}

export async function deactivateProject(name: string): Promise<void> {
  if (!active.has(name)) return;
  if (!backend) {
    active.delete(name);
    return;
  }
  try {
    await backend.deactivateProject(name);
  } finally {
    active.delete(name);
  }
}

export function listActiveProjects(): string[] {
  return Array.from(active);
}
