// Upstream reference entry; tmux-ide launchers use the separate tmux-ide-gpui binary.
fn main() -> std::process::ExitCode {
    tmux_ide_gpui::run_herdr()
}
