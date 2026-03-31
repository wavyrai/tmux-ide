"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Step =
  | {
      kind: "command";
      text: string;
      speed?: number;
      prompt?: string;
    }
  | {
      kind: "output";
      text: string;
      delay?: number;
    };

type Scenario = {
  label: string;
  subtitle: string;
  steps: Step[];
};

const AUTO_CYCLE_MS = 8000;
const CURSOR_MS = 530;
const DEFAULT_COMMAND_SPEED = 40;
const DEFAULT_OUTPUT_DELAY = 280;

const SCENARIOS: Scenario[] = [
  {
    label: "Init",
    subtitle: "Scaffold a mission-ready workspace",
    steps: [
      {
        kind: "command",
        text: "tmux-ide init --template missions",
      },
      {
        kind: "output",
        text: `Created ide.yml from "missions" template
  +-----------+-----------+-----------+
  |   Lead    | Frontend  |  Backend  |  70%
  +-----------+-----------+-----------+
  | Validator | Researcher|   Shell   |  30%
  +-----------+-----------+-----------+
Scaffolded .tmux-ide/skills/ (5 skills)
Created AGENTS.md`,
      },
    ],
  },
  {
    label: "Mission",
    subtitle: "Plan and activate the mission",
    steps: [
      {
        kind: "command",
        text: `tmux-ide mission create "Build a todo API"`,
      },
      {
        kind: "output",
        text: "Mission created (planning): Build a todo API",
      },
      {
        kind: "command",
        text: "tmux-ide mission plan-complete",
      },
      {
        kind: "output",
        text: `Mission activated. Milestones: 3
  M1 [active]  Foundation
  M2 [locked]  Implementation
  M3 [locked]  Testing
Coverage: 6/6 assertions claimed`,
      },
    ],
  },
  {
    label: "Running",
    subtitle: "Watch the orchestrator drive the team",
    steps: [
      {
        kind: "output",
        text: `[orchestrator] Dispatching task 001 to Backend (specialty: backend)
[orchestrator] Dispatching task 002 to Frontend (specialty: frontend)
[Backend]      Completed: Setup Express server
[Frontend]     Completed: Build React components
[orchestrator] M1 complete -> dispatching validation
[validator]    4/4 assertions passing
[orchestrator] M1 validated -> activating M2`,
        delay: 420,
      },
    ],
  },
  {
    label: "Metrics",
    subtitle: "Summarize the finished run",
    steps: [
      {
        kind: "command",
        text: "tmux-ide metrics",
      },
      {
        kind: "output",
        text: `Session: 2h 15m (complete)
Tasks: 12/12 done | Completion: 100% | Retries: 8%
Agents: Backend 82% util | Frontend 71% | Validator 45%
Mission: "Build a todo API" [complete]
  Milestones: 3/3 | Validation: 100% pass`,
      },
    ],
  },
];

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function buildRenderedLines(
  scenario: Scenario,
  activeStepIndex: number,
  typedChars: number,
): Array<{ key: string; kind: "command" | "output"; content: ReactNode; active?: boolean }> {
  const lines: Array<{
    key: string;
    kind: "command" | "output";
    content: ReactNode;
    active?: boolean;
  }> = [];

  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]!;

    if (index > activeStepIndex) break;

    if (step.kind === "command") {
      const fullText = index < activeStepIndex ? step.text : step.text.slice(0, typedChars);
      lines.push({
        key: `${scenario.label}-command-${index}`,
        kind: "command",
        active: index === activeStepIndex,
        content: (
          <>
            <span className="text-emerald-300">{step.prompt ?? "$"}</span>
            <span className="ml-2 text-fd-foreground">{fullText}</span>
          </>
        ),
      });
      continue;
    }

    lines.push({
      key: `${scenario.label}-output-${index}`,
      kind: "output",
      content: (
        <span className="whitespace-pre-wrap text-[hsl(var(--color-fd-muted-foreground))]">
          {step.text}
        </span>
      ),
    });
  }

  return lines;
}

export default function TerminalDemo() {
  const [activeTab, setActiveTab] = useState(0);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const [cursorOn, setCursorOn] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scenario = SCENARIOS[activeTab]!;
  const activeStep = scenario.steps[activeStepIndex];
  const isScenarioDone = activeStepIndex >= scenario.steps.length;

  const renderedLines = useMemo(
    () =>
      isScenarioDone
        ? buildRenderedLines(scenario, scenario.steps.length - 1, 0)
        : buildRenderedLines(scenario, activeStepIndex, typedChars),
    [activeStepIndex, isScenarioDone, scenario, typedChars],
  );

  useEffect(() => {
    setActiveStepIndex(0);
    setTypedChars(0);
  }, [activeTab]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCursorOn((value) => !value);
    }, CURSOR_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setActiveTab((current) => (current + 1) % SCENARIOS.length);
    }, AUTO_CYCLE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [activeTab]);

  useEffect(() => {
    if (!activeStep) return;

    if (activeStep.kind === "output") {
      const timeoutId = window.setTimeout(() => {
        setActiveStepIndex((current) => current + 1);
        setTypedChars(0);
      }, activeStep.delay ?? DEFAULT_OUTPUT_DELAY);

      return () => window.clearTimeout(timeoutId);
    }

    if (typedChars >= activeStep.text.length) {
      const timeoutId = window.setTimeout(() => {
        setActiveStepIndex((current) => current + 1);
        setTypedChars(0);
      }, 360);

      return () => window.clearTimeout(timeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      setTypedChars((current) => current + 1);
    }, activeStep.speed ?? DEFAULT_COMMAND_SPEED);

    return () => window.clearTimeout(timeoutId);
  }, [activeStep, typedChars]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    node.scrollTo({
      top: node.scrollHeight,
      behavior: "smooth",
    });
  }, [renderedLines]);

  return (
    <div className="w-full max-w-4xl">
      <div className="overflow-hidden border border-fd-border bg-[#09090b] text-fd-foreground">
        <div className="flex items-center gap-3 border-b border-fd-border bg-[#111114] px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="flex gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            </div>
          </div>
          <div className="min-w-0 flex-1 text-center">
            <div className="truncate font-mono text-[10px] uppercase tracking-[0.24em] text-[hsl(var(--color-fd-muted-foreground))]">
              tmux-ide mission demo
            </div>
          </div>
          <div className="hidden min-w-0 flex-1 text-right sm:block">
            <div className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--color-fd-muted-foreground))]">
              {scenario.subtitle}
            </div>
          </div>
        </div>

        <div className="border-b border-fd-border bg-[#0d0d10]">
          <div className="flex flex-wrap">
            {SCENARIOS.map((item, index) => {
              const active = index === activeTab;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setActiveTab(index)}
                  className={joinClasses(
                    "border-r border-fd-border px-4 py-2 text-left font-mono text-[11px] uppercase tracking-[0.22em] transition-colors last:border-r-0",
                    active
                      ? "bg-[#09090b] text-fd-foreground"
                      : "bg-[#111114] text-[hsl(var(--color-fd-muted-foreground))] hover:bg-[#16161a] hover:text-fd-foreground",
                  )}
                >
                  <div>{item.label}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="max-h-[460px] min-h-[340px] overflow-y-auto bg-[#09090b] px-5 py-5 font-mono text-[13px] leading-6 sm:px-6"
        >
          <div className="space-y-4">
            {renderedLines.map((line) => (
              <div
                key={line.key}
                className={joinClasses(
                  "whitespace-pre-wrap break-words",
                  line.kind === "command"
                    ? "text-fd-foreground"
                    : "text-[hsl(var(--color-fd-muted-foreground))]",
                )}
              >
                {line.content}
                {line.active && activeStep?.kind === "command" ? (
                  <span
                    className={joinClasses(
                      "ml-0.5 inline-block h-[1.05rem] w-2 translate-y-0.5 bg-fd-primary transition-opacity",
                      cursorOn ? "opacity-100" : "opacity-0",
                    )}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
