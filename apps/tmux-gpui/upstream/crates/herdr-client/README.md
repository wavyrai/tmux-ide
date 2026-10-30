# tmux-ide native client

The transport the tmux-ide native app uses to reach its daemon and tmux:
tmux control mode (`tmux_control`, `tmux_controller`), terminal delivery and
pane streams (`tmux_delivery`, `tmux_stream`, `tmux_native_session`), graphics
(`tmux_graphics`), the daemon HTTP and socket client (`tmux_daemon`), and SSH
transport to remote tmux servers (`tmux_ssh`). Wire types come from
`herdr-protocol`, re-exported as `herdr_client::protocol`.

This crate does not link GPUI or a PTY implementation. All transport I/O runs
on worker threads; drain their receivers on a background task, never on the UI
thread.

The Herdr endpoint client that this crate started from (local, SSH and WSL
sessions, file uploads, port forwards, saved hosts) was removed from the tree
in the Mac app cleanup; git history keeps it.
