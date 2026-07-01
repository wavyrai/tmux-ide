/**
 * Front-door decision for bare `tmux-ide` / `tmux-ide start`: open the team
 * cockpit (the multi-project TUI) instead of launching a single project.
 *
 * The cockpit is the default entry when there's no single-project `ide.yml` to
 * launch here, or when `--team` forces it. When an `ide.yml` is present, bare
 * invocation still launches that project (backward compatible).
 */
export function shouldOpenCockpit(hasIdeYml: boolean, teamFlag: boolean): boolean {
  return teamFlag || !hasIdeYml;
}
