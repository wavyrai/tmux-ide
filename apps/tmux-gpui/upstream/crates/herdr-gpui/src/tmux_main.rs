// Dedicated tmux-ide entry: never dispatches to upstream application startup.
fn main() -> std::process::ExitCode {
    herdr_gpui::run_tmux()
}
