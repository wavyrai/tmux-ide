"use client";

import { CopyButton } from "@/app/(home)/copy-button";
import type { InstallMethod } from "@/lib/landing-content";

/**
 * Install command with one choice per supported method. Selection is native
 * radio state styled through :has() in global.css, so the switch works before
 * hydration and without JavaScript. It is a client module only so its markup
 * is not repeated in the RSC payload; keep its imports free of server-only
 * helpers (tailwind-merge, site metadata) to protect the home JS budget.
 */
export function InstallTabs({
  name,
  methods,
  className = "",
}: {
  name: string;
  methods: readonly InstallMethod[];
  className?: string;
}) {
  return (
    <div className={`install-tabs w-full max-w-xl ${className}`}>
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Install method</legend>
        {methods.map((method, index) => (
          <label key={method.id} className="install-tab marketing-pill-action">
            <input
              type="radio"
              name={name}
              value={method.id}
              defaultChecked={index === 0}
              className="sr-only"
            />
            {method.label}
          </label>
        ))}
      </fieldset>
      {methods.map((method) => (
        <div key={method.id} className="install-panel mt-2" data-method={method.id}>
          <InstallCommand command={method.command} label={`Copy ${method.label} install command`} />
          <p className="type-caption-1 mt-2 text-fd-muted-foreground">{method.note}</p>
        </div>
      ))}
    </div>
  );
}

/** The ink command button with copy feedback, shared by every install call to action. */
export function InstallCommand({ command, label }: { command: string; label?: string }) {
  return (
    <CopyButton text={command} label={label} className="marketing-copy-action marketing-command">
      <span aria-hidden className="font-mono">
        $
      </span>
      <code className="min-w-0 break-all font-mono">{command}</code>
      <span className="type-caption-1 ml-auto opacity-65">Copy</span>
    </CopyButton>
  );
}
