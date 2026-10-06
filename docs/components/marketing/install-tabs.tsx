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
  then,
  className = "",
}: {
  name: string;
  methods: readonly InstallMethod[];
  /** Optional follow-up command shown inside the box under the install line. */
  then?: string;
  className?: string;
}) {
  return (
    <div className={`install-tabs w-full ${className}`}>
      <div className="install-box">
        <fieldset className="install-box-tabs">
          <legend className="sr-only">Install method</legend>
          {methods.map((method, index) => (
            <label key={method.id} className="install-tab">
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
          <div key={method.id} className="install-panel" data-method={method.id}>
            <CopyButton
              text={method.command}
              label={`Copy ${method.label} install command`}
              className="install-box-command"
            >
              <span aria-hidden className="font-mono">
                $
              </span>
              <code className="install-command-text font-mono">{method.command}</code>
              <span className="install-box-copy">Copy</span>
            </CopyButton>
          </div>
        ))}
        {then ? (
          <p className="install-box-then">
            <span aria-hidden>$</span>
            <code>{then}</code>
            <span aria-hidden>then open the app</span>
          </p>
        ) : null}
      </div>
      {methods.map((method) => (
        <p key={method.id} className="install-note" data-method={method.id}>
          {method.note}
        </p>
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
      <code className="install-command-text font-mono">{command}</code>
      <span className="type-caption-1 ml-auto opacity-65">Copy</span>
    </CopyButton>
  );
}
