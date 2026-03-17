/**
 * Composable builders for tmux session configuration.
 * Each returns an array of tmux command arrays.
 */

export function buildSessionOptions(session, { theme = {} } = {}) {
  return [
    ...themeOptions(session, theme),
    ...borderOptions(session, theme),
    ...behaviorOptions(session),
    ...statusBarOptions(session, theme),
    ...keyBindings(),
  ];
}

export function themeOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const bg = theme.bg ?? "colour235";
  const fg = theme.fg ?? "colour248";

  return [
    ["set-option", "-t", session, "status-style", `bg=${bg},fg=${fg}`],
    ["set-option", "-t", session, "pane-border-style", `fg=${border}`],
    ["set-option", "-t", session, "pane-active-border-style", `fg=${accent}`],
  ];
}

export function borderOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";

  return [
    ["set-option", "-t", session, "pane-border-status", "top"],
    [
      "set-option",
      "-t",
      session,
      "pane-border-format",
      ` #{?pane_active,#[fg=${accent}#,bold]▸ #T  #[fg=${fg}]#{pane_current_path},#[fg=${border}]· #T  #{pane_current_path}} `,
    ],
  ];
}

export function behaviorOptions(session) {
  return [
    ["set-option", "-t", session, "mouse", "on"],
    ["set-option", "-t", session, "escape-time", "0"],
    ["set-option", "-t", session, "status-interval", "1"],
  ];
}

export function statusBarOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";

  // Pane tab components — each is a self-contained piece
  const agentIndicator = [
    `#{?#{==:#{@agent_busy},1},#[fg=${accent}]⏺ ,`,
    `#{?#{==:#{@agent_idle},1},#[fg=${border}]● ,}}`,
  ].join("");
  const portIndicator = `#{?#{==:#{@has_port},1},#[fg=green]⏺ ,}`;
  const paneStyle = `#{?pane_active,#[fg=${accent}],#[fg=${border}]}`;
  const paneTab = `${agentIndicator}${portIndicator}${paneStyle}#[range=pane|#{pane_id}] #T #[norange]#[default]`;
  const separator = `#{?loop_last_flag,,#[fg=${border}]│}`;

  return [
    [
      "set-option",
      "-t",
      session,
      "status-left",
      `#[fg=colour0,bg=${accent},bold]  ${session.toUpperCase()} IDE #[default] `,
    ],
    ["set-option", "-t", session, "status-left-length", "30"],
    [
      "set-option",
      "-t",
      session,
      "status-right",
      `#[fg=colour243]%H:%M #[fg=${accent}]│ #[fg=${fg}]%b %d `,
    ],
    ["set-option", "-t", session, "status-justify", "centre"],
    ["set-option", "-t", session, "window-status-current-format", `#[fg=${accent},bold]●`],
    ["set-option", "-t", session, "window-status-format", `#[fg=${border}]○`],
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-format[1]", `  #{P:${paneTab}${separator}}`],
  ];
}

export function keyBindings() {
  return [["bind-key", "-n", "MouseDown1StatusDefault", "select-pane", "-t", "="]];
}
