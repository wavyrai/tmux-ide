//! A local/SSH/WSL gen1 client. All transport I/O runs on a dedicated worker.
//! No reconnect/replay: commands carry the boot ID of the snapshot they act on.
//! Drain `Client::events` on a GUI background task, never block the UI thread.
#![doc = include_str!("../README.md")]

mod catalog;
mod clipboard;
mod compat;
mod connect;
mod discovery;
mod error;
mod event;
mod forward;
mod frame;
mod handle;
mod host_theme;
mod limits;
mod method;
mod options;
mod queue;
mod remote_host;
mod script;
pub mod scrollback;
mod session;
mod sessions;
mod ssh;
mod surface_images;
pub mod tmux_control;
pub mod tmux_controller;
pub mod tmux_daemon;
pub mod tmux_delivery;
pub mod tmux_handoff;
pub mod tmux_native_session;
pub mod tmux_receiver;
pub mod tmux_ssh;
pub mod tmux_stream;
pub mod tmux_terminal;
pub mod tmux_topology;
mod transport;
mod upload;
mod wsl;

#[cfg(all(test, unix))]
mod test_executable;
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;

pub use crossbeam_channel::Receiver;
pub use herdr_protocol as protocol;

pub use catalog::{
    SavedHost, load_saved_host_selection, load_saved_hosts, store_saved_host_selection,
    valid_profile_id,
};
pub use clipboard::{ClipboardImageCancellation, ClipboardImageUpload};
pub use compat::{MIN_HERDR_VERSION, VersionMismatch};
pub use connect::{Transport, connect, connect_with_connector, connect_with_surface_active};
#[cfg(feature = "cloud")]
pub use discovery::CloudProvider;
pub use discovery::{ConnectTarget, session_socket};
/// Error returned when queueing commands; also available as the crate's `Error`.
pub use error::Error as SendError;
pub use error::{Error, Result, StorageOperation};
pub use event::ClientEvent;
pub use forward::{ForwardEvent, PortForward, preferred_local_port};
pub use handle::{Client, ClientHandle};
pub use host_theme::HostTheme;
pub use method::Method;
pub use options::ConnectOptions;
pub use remote_host::RemoteHost;
pub use script::{ScriptHost, ScriptLimits, run_script, shell_quote};
pub use sessions::{
    LocalSession, RemoteSession, SessionState, delete_local_session, delete_remote_session,
    list_local_sessions, list_remote_sessions,
};
#[cfg(unix)]
pub use ssh::script_command;
pub use ssh::{Bridge, connect_command};
pub use ssh::{
    Destination, FORWARD_READY, HostProbe, SshFailure, forward_command, probe_host,
    remote_config_value, remote_origin_url, resolve_destination,
};
pub use surface_images::{
    MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MAX_IMAGES, MAX_PLACEMENTS, SurfaceImage, SurfaceImages,
    valid_asset,
};
pub use transport::Stream;
pub use upload::{remove_uploaded_files, upload_files};
pub use wsl::{
    WslHost, WslHosts, add_wsl_host, delete_distro_session, list_distro_sessions, list_distros,
    load_wsl_hosts, probe_distro, remove_wsl_host, store_wsl_selection, valid_distro,
};

pub mod tmux_history;

pub mod tmux_input;

pub mod tmux_graphics;

pub mod tmux_pointer;

pub mod tmux_broker_process;
