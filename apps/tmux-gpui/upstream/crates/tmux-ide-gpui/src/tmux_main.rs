// Dedicated tmux-ide entry: never dispatches to upstream application startup.
fn main() -> std::process::ExitCode {
    tmux_ide_gpui::run_tmux()
}
