//! Internal failures retain their categories and sources until presentation.
pub use crate::updater::UpdateError;
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(any(target_os = "macos", windows))]
use wry::raw_window_handle::HandleError as WindowHandleError;

pub type Result<T, E = Error> = std::result::Result<T, E>;

fn daemon_error_message(error: &serde_json::Value) -> &str {
    error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| error.as_str())
        .or_else(|| error.get("code").and_then(serde_json::Value::as_str))
        .filter(|message| !message.is_empty())
        .unwrap_or("Invalid daemon error")
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Could not finish saving Settings: {0}")]
    SettingsSave(#[source] std::sync::Arc<Error>),
    #[error("palette.project_roots must contain at most 16 nonempty paths of at most 8192 bytes")]
    PaletteProjectRoots,
    #[error("Project paths must be absolute UTF-8 paths without control characters")]
    PaletteProjectPath,
    #[error("Project path references an unset environment variable: {0}")]
    PaletteProjectVariable(String),
    #[error("Project discovery reached its directory limit; narrow palette.project_roots")]
    PaletteProjectLimit,
    #[error("Project directory is no longer available")]
    PaletteProjectRemoved,
    #[error("The local connection changed. Reopen the palette.")]
    PaletteLocalChanged,
    #[error("Unexpected workspace creation response. Review workspace state before retrying.")]
    PaletteProjectResponse,
    #[error("Workspace directories changed. Select the project again.")]
    PaletteProjectStateChanged,
    #[error("Invalid saved window geometry or too many saved windows")]
    InvalidWindowState,
    #[error("Sound configuration exceeds 1 MiB")]
    SoundConfigSize,
    #[error("Unknown sidebar layout {0:?}")]
    UnknownLayout(String),
    #[error("Could not open audio output: {0}")]
    SoundDevice(#[from] rodio::DeviceSinkError),
    #[error("Audio output failed: {0}")]
    SoundStream(#[from] rodio::cpal::StreamError),
    #[error("Could not decode MP3 sound: {0}")]
    SoundDecode(#[from] rodio::decoder::DecoderError),
    #[error("Could not read sound file {}: {source}", path.display())]
    SoundFile {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Sound must be a regular file of at most 16 MiB")]
    SoundFileSize,
    #[error("Audio playback timed out")]
    SoundTimeout,
    #[error("Audio playback cancelled")]
    SoundCancelled,
    #[error("Could not keep the display awake: {0}")]
    Caffeine(#[source] keepawake::Error),
    #[error("Could not start the keep-awake thread")]
    CaffeineThread(#[source] io::Error),
    #[error("The keep-awake thread stopped; the display may sleep")]
    CaffeineWorkerStopped,
    #[error(
        "PR lookup requires your owned local session socket or a saved SSH device. Other socket locations are unsupported."
    )]
    PrUntrustedEndpoint,
    #[error("The selected pane is no longer on screen.")]
    SelectionStale,
    #[error("Selection is too large to copy.")]
    SelectionSize,
    #[error("The selection reaches rows the pane no longer shows.")]
    SelectionOffscreen,
    #[error("File drop exceeds 256 paths or 64 KiB of quoted text.")]
    FileDropSize,
    #[error("Dropped paths must be UTF-8.")]
    FileDropEncoding,
    #[error("Dropped paths must not contain control characters.")]
    FileDropControl,
    #[error("Dropped paths must not be empty.")]
    FileDropEmptyPath,
    #[error("Could not {operation} the local image file.")]
    ImageFile {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("The local image must be a regular file.")]
    ImageFileType,
    #[error("The image must not be empty.")]
    ImageSize,
    #[error("The image exceeds Herdr's {limit}-byte upload limit.")]
    ImageTooLarge { limit: usize },
    #[error("The image exceeds the {limit}-byte resize input limit.")]
    ImageInputTooLarge { limit: usize },
    #[error("The image exceeds the resize pixel or decoded-memory limit.")]
    ImageDecodeLimit,
    #[error("Oversized GIF, WebP, and animated PNG images cannot be resized safely.")]
    ImageAnimationResize,
    #[error("Could not decode the oversized image.")]
    ImageDecode(#[source] image::ImageError),
    #[error("Could not encode the resized image.")]
    ImageEncode(#[source] image::ImageError),
    #[error("Reading the local image timed out (3 seconds).")]
    ImageReadTimeout,
    #[error("SVG clipboard images are not supported. Use PNG, JPEG, GIF, WebP, BMP, or TIFF.")]
    ImageFormat,
    #[error("Could not decode an image a pane placed.")]
    PaneImageDecode(#[source] image::ImageError),
    #[error("An image a pane placed exceeds the decoded size limit.")]
    PaneImageLimit,
    #[error("Clipboard content exceeds the {limit}-byte limit.")]
    ClipboardSize { limit: usize },
    #[error("Clipboard text is not valid UTF-8.")]
    ClipboardEncoding(#[source] std::str::Utf8Error),
    #[error("The clipboard changed while reading. Try pasting again.")]
    ClipboardChanged,
    #[error("Clipboard acquisition timed out.")]
    ClipboardTimeout,
    #[error("Could not read the clipboard using wl-paste or xclip.")]
    ClipboardProcess(#[source] io::Error),
    #[error("Remote clipboard acquisition is not supported on this platform.")]
    ClipboardUnsupported,
    #[error("Checkout lookup failed. Dismiss and reopen the menu.")]
    DeletionLookup,
    #[error("Reopen the deletion dialog.")]
    MissingDeletion,
    #[error("Invalid or oversized worktree list. Dismiss and reopen the menu.")]
    WorktreeList,
    #[error("Malformed worktree list. Dismiss and reopen the menu.")]
    WorktreeListDecode(#[source] serde_json::Error),
    #[error("Select a checkout from the daemon's worktree list.")]
    WorktreeSelection,
    #[error("{method}: {source}")]
    Request {
        method: herdr_client::Method,
        #[source]
        source: herdr_client::Error,
    },
    #[error("Workspace is no longer available. Dismiss and reopen the menu.")]
    StaleWorkspace,
    #[error("Workspace label must not be empty.")]
    EmptyWorkspaceLabel,
    #[error("{0} cannot be reached by script. Choose another host.")]
    DispatchHostUnavailable(String),
    #[error("Another host is still being set up. Wait for it to finish.")]
    DispatchBusy,
    #[error(
        "Invalid Git branch name. Use a name such as config-reload, without spaces or special ref characters."
    )]
    InvalidBranchName,
    #[error("Workspace group changed. Dismiss and review the group again.")]
    WorkspaceGroupChanged,
    #[error("Repository changed. Dismiss and reopen the menu.")]
    WorkspaceRepositoryChanged,
    #[error("Checkout changed. Dismiss and reopen the menu.")]
    WorkspaceCheckoutChanged,
    #[error("Daemon did not provide an absolute checkout and repository key.")]
    PrAbsolutePath,
    #[error("No supported branch available.")]
    PrBranch,
    #[error("Local repository unavailable for worktree lookup.")]
    PrWorktreeLookup,
    #[error("Local checkout unavailable or not a trusted Git repository.")]
    PrCheckout,
    #[error("Local repository does not match daemon metadata.")]
    PrRepositoryMismatch,
    #[error("Checkout branch changed. Waiting for daemon metadata.")]
    PrBranchChanged,
    #[error("PR lookup supports GitHub.com origins only.")]
    PrOrigin,
    #[error("No local worktree matches the daemon branch.")]
    PrMissingWorktree,
    #[error("Multiple local worktrees match the daemon branch.")]
    PrAmbiguousWorktree,
    #[error("GitHub repository unavailable. Check repository access and token permissions.")]
    PrRepository,
    #[error("PR response exceeded the size limit.")]
    PrSize,
    #[error("Multiple PRs match this branch; no PR selected.")]
    PrAmbiguous,
    #[error("PR identity does not match the repository and branch.")]
    PrIdentity,
    #[error("Could not {operation} for Git PR lookup.")]
    PrProcess {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("Invalid process text.")]
    PrEncoding(#[source] std::str::Utf8Error),
    #[error("No repository metadata.")]
    PrMetadata,
    #[error("Workspace directory is not in a Git repository.")]
    PrWorkspaceRepository,
    #[error("Could not {operation} the agent context note for the new checkout.")]
    AgentContext {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("git {operation} failed: {details}")]
    GitFailed {
        operation: &'static str,
        details: String,
    },
    #[error("A Git operation is already running.")]
    GitBusy,
    #[error("No local checkout is focused.")]
    GitNoCheckout,
    #[error("Enter a commit message of at most 4096 characters.")]
    GitCommitMessage,
    #[error("Nothing to commit: the checkout has no changes.")]
    GitNothingToCommit,
    #[error("The branch has no commit to describe. Commit before opening a pull request.")]
    GitPullRequestTitle,
    #[error("This branch is the repository default branch; no pull request can be opened from it.")]
    GitPullRequestBase,
    #[error("Git worker stopped. Retry the operation.")]
    GitWorker,
    #[error(
        "No base branch to compare with: neither the pull request's base nor origin/HEAD, main, or master exists locally."
    )]
    ReviewNoBase,
    #[error("A saved review tab names a checkout that is not a local absolute path.")]
    InvalidReviewCheckout,
    #[error("These changes are too large to review here, even leaving out the largest files.")]
    ReviewTooLarge,
    #[error("Could not {operation}.")]
    GitProcess {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error(
        "GitHub authentication required. Use menu > GitHub sign-in or set GH_TOKEN / GITHUB_TOKEN."
    )]
    GitHubAuthentication,
    #[error("GitHub denied access: check token permissions, SSO authorization, or rate limits.")]
    GitHubForbidden,
    #[error("GitHub rate limit reached. Retry later.")]
    GitHubRateLimit,
    #[error("GitHub request failed (HTTP {0}). Check network and repository access.")]
    GitHubStatus(u16),
    #[error("GitHub response could not be read within the size/time limit.")]
    GitHubRead(#[source] io::Error),
    #[error("GitHub response exceeded the size limit.")]
    GitHubSize,
    #[error("Invalid GitHub JSON response.")]
    GitHubJson(#[source] GitHubJsonError),
    #[error("Invalid GitHub token. Replace the configured credential.")]
    GitHubToken,
    #[error("Invalid GitHub credential encoding.")]
    GitHubEncoding(#[source] std::str::Utf8Error),
    #[cfg(target_os = "macos")]
    #[error("Cannot read GitHub Keychain entry. Unlock your login Keychain or set GH_TOKEN.")]
    KeychainRead(#[source] security_framework::base::Error),
    #[cfg(target_os = "macos")]
    #[error("GitHub Keychain update failed. Unlock your login Keychain and try again.")]
    KeychainWrite(#[source] security_framework::base::Error),
    #[cfg(target_os = "linux")]
    #[error(
        "Cannot read GitHub sign-in from the desktop keyring. Unlock your keyring or set GH_TOKEN."
    )]
    SecretServiceRead(#[source] Box<oo7::Error>),
    #[cfg(target_os = "linux")]
    #[error("GitHub keyring update failed. Unlock your desktop keyring and try again.")]
    SecretServiceWrite(#[source] Box<oo7::Error>),
    #[cfg(target_os = "linux")]
    #[error(
        "No desktop keyring (Secret Service) is running. Start GNOME Keyring, KWallet, or KeePassXC, or set [github] allow_plaintext_credentials = true, or use GH_TOKEN / GITHUB_TOKEN."
    )]
    SecretServiceUnavailable,
    #[error("Missing credential directory.")]
    CredentialDirectory,
    #[error(
        "Cannot access private credential file. Require an owned directory and regular 0600 file; symlinks are rejected."
    )]
    CredentialPermissions,
    #[error("Cannot access private credential file.")]
    CredentialIo(#[source] io::Error),
    #[error(
        "No secure credential store configured. Explicitly opt in with allow_plaintext_credentials = true in the [github] or [coder] table, or use GH_TOKEN / GITHUB_TOKEN for GitHub."
    )]
    CredentialPolicy,
    #[error(
        "No GitHub credential store is available on this platform. Use GH_TOKEN / GITHUB_TOKEN."
    )]
    CredentialUnsupported,
    #[error("PR lookup cancelled.")]
    PrCancelled,
    #[error("PR lookup timed out (15 seconds).")]
    PrTimeout,
    #[error("GitHub network request failed or timed out ({0}).")]
    GitHubNetwork(#[source] ureq::Error),
    #[error("GitHub query failed. Check token repository permissions and rate limits.")]
    GitHubQuery,
    /// GitHub's own refusal of a requested change, cleaned and bounded.
    #[error("GitHub refused the request: {0}")]
    GitHubRejected(String),
    #[error("A pull request action is already running.")]
    PrActionBusy,
    #[error(
        "This pull request cannot be acted on here: it is not open, or its details are incomplete. Refresh and try again."
    )]
    PrActionTarget,
    #[error("Enter a comment of at most 4096 characters.")]
    PrCommentBody,
    #[error("The branch changed since this dialog opened. Review the pull request again.")]
    PrMergeChanged,
    #[error("The repository does not allow this merge method.")]
    PrMergeMethod,
    #[error("Pull request worker stopped. Check the pull request on GitHub before retrying.")]
    PrActionWorker,
    #[error("Could not start the pull request worker.")]
    PrActionProcess {
        #[source]
        source: io::Error,
    },
    #[error("Invalid GitHub authorization header.")]
    GitHubHeader(#[source] ureq::http::header::InvalidHeaderValue),
    #[error("Invalid GitHub device authorization response.")]
    GitHubDevice,
    #[error("GitHub code expired. Sign in again.")]
    GitHubExpired,
    #[error("GitHub authorization denied.")]
    GitHubDenied,
    #[error("GitHub authorization failed. Check OAuth application settings.")]
    GitHubAuthorization,
    #[error("Unsupported GitHub token type.")]
    GitHubTokenType,
    #[error("GitHub {0} worker stopped.")]
    GitHubWorker(&'static str),
    #[cfg(feature = "coder")]
    #[error(transparent)]
    Coder(#[from] crate::coder::Error),
    #[cfg(feature = "daytona")]
    #[error(transparent)]
    Daytona(#[from] crate::daytona::Error),
    #[cfg(feature = "cloud")]
    #[error(transparent)]
    Cloud(#[from] crate::cloud::Error),
    #[error("{0}")]
    Config(#[source] config_loader::ConfigError),
    #[error("{source}")]
    ConfigFile {
        uri: Option<String>,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("HERDR_GITHUB_OAUTH_CLIENT_ID must be UTF-8")]
    ClientIdEncoding,
    #[error(
        "{0} must be 1..256 ASCII letters, digits, '.', '_' or '-' (public client ID, not a secret)"
    )]
    InvalidClientId(&'static str),
    #[error(
        "[github] {0} must not be in the config. Sign in from the app, or use GH_TOKEN / GITHUB_TOKEN."
    )]
    GitHubSecretInConfig(&'static str),
    #[error("Could not {operation}.")]
    UsageProcess {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("Usage check timed out.")]
    UsageTimeout,
    #[error("Usage output exceeded the size limit.")]
    UsageSize,
    #[error("Usage request failed or timed out.")]
    UsageNetwork(#[source] ureq::Error),
    #[error("Could not reach the usage service from this host.")]
    UsageConnect,
    #[error("No sign-in found on this host. Set it up under [usage.providers] in the config.")]
    UsageNotSignedIn,
    #[error("This account has no plan with usage limits to show.")]
    UsageNoPlan,
    #[error("Reading this sign-in needs Keychain access, which macOS asks for.")]
    UsageKeychainAccess,
    #[error("Keychain access was denied, so this sign-in cannot be read.")]
    UsageKeychainDenied,
    #[error("Usage request mixes this machine's settings with the remote host's sign-in.")]
    UsageMixedSecrets,
    #[error("Usage command failed: {0}.")]
    UsageCommand(&'static str),
    #[error("Saved sign-in cannot be sent as a header.")]
    UsageHeader(#[source] ureq::http::header::InvalidHeaderValue),
    #[error("Saved sign-in was rejected. Open the agent to sign in again.")]
    UsageRejected,
    #[error("Usage is rate limited. Retrying later.")]
    UsageRateLimited,
    #[error("Usage service returned HTTP {0}.")]
    UsageStatus(u16),
    /// The body may hold account details, so only the parser's category is kept.
    #[error("Usage response was not the expected JSON.")]
    UsageJson(serde_json::error::Category),
    #[error("Could not reach this host over SSH to read usage.")]
    UsageUnreachable,
    #[error("curl is not installed on this host, so usage cannot be read.")]
    UsageMissingCurl,
    #[error("Remote usage needs SSH, which this platform's client does not support.")]
    UsageUnsupported,
    #[error("usage must be a TOML table")]
    InvalidUsageTable,
    #[error("Could not read CPU and memory on this host.")]
    SystemLoadRemote(#[source] Box<Error>),
    /// The host's `uname -s`, bounded, so the message names what it is.
    #[error("CPU and memory cannot be read on {0:?} hosts.")]
    SystemLoadUnsupported(String),
    #[error("CPU and memory output was not understood.")]
    SystemLoadOutput,
    #[error("No checkout of this branch was found on its host.")]
    CheckpointCheckout,
    #[error("This checkout has no commit yet, so it has no checkpoints.")]
    CheckpointUnborn,
    #[error("That checkpoint no longer exists.")]
    CheckpointMissing,
    #[error("That checkpoint was taken on another branch. Check that branch out to restore it.")]
    CheckpointBranch,
    #[error("A merge, rebase, cherry-pick, or revert is in progress. Finish or abort it first.")]
    CheckpointBusy,
    #[error("Checkpoint Git commands failed")]
    CheckpointScript(#[source] herdr_client::Error),
    #[error("Checkpoint output was not understood.")]
    CheckpointOutput,
    #[error("Could not start the checkpoint worker")]
    CheckpointThread(#[source] io::Error),
    #[error("The checkpoint worker stopped.")]
    CheckpointWorker,
    #[error("Enter a port number from 1 to 65535.")]
    ForwardPort,
    #[error("Port {0} is already forwarded from this host.")]
    ForwardDuplicate(u16),
    #[error("At most {0} ports can be forwarded at once.")]
    ForwardLimit(usize),
    #[error("Could not read listening ports on this host.")]
    ListeningPorts(#[source] Box<Error>),
    #[error("Neither ss nor lsof is installed on this host, so listening ports cannot be read.")]
    ListeningPortsTool,
    #[error("Listening ports cannot be read on this platform.")]
    ListeningPortsUnsupported,
    /// Probes that open a shell on the host (usage, load, ports, checkpoints)
    /// have no route into a WSL distribution yet.
    #[error("This is not available for WSL distributions yet.")]
    WslHostUnsupported,
    #[error("No free local port for an SSH tunnel.")]
    TunnelPort(#[source] io::Error),
    #[error("Could not start ssh for a tunnel.")]
    TunnelStart(#[source] io::Error),
    #[error("SSH ended before the tunnel opened ({0}).")]
    TunnelExited(std::process::ExitStatus),
    #[error("The SSH tunnel did not open in time.")]
    TunnelTimeout,
    #[error("Could not ask Herdr which process the pane runs.")]
    ProcessesQuery(#[source] herdr_client::Error),
    #[error("Herdr's answer about the pane's process was not understood.")]
    ProcessesAnswer(#[source] serde_json::Error),
    #[error("Herdr did not name a process for this pane.")]
    ProcessesNoRoot,
    #[error("The pane's process has exited.")]
    ProcessesRootExited,
    #[error("The herdr executable's path is not valid UTF-8.")]
    ProcessesExecutable,
    #[error("Still ending the last processes. Try again in a moment.")]
    ProcessesBusy,
    #[error("The process list stopped updating. Reopen it to try again.")]
    ProcessesStopped,
    #[error("Could not start watching the pane's processes.")]
    ProcessesWorker(#[source] io::Error),
    #[error("{0}")]
    Update(#[from] UpdateError),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Toml(#[from] toml::de::Error),
    #[error("{0}")]
    TomlEdit(#[from] toml_edit::TomlError),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Client(#[from] herdr_client::Error),
    #[error(".herdr/worktree.toml exceeds {limit} bytes")]
    WorktreeScriptsSize { limit: u64 },
    #[error(".herdr/worktree.toml is not valid UTF-8")]
    WorktreeScriptsEncoding(#[source] std::str::Utf8Error),
    #[error(".herdr/worktree.toml: {0}")]
    WorktreeScriptsParse(#[source] toml::de::Error),
    #[error(".herdr/worktree.toml scripts must not contain NUL bytes")]
    WorktreeScriptsNul,
    #[error("Could not read .herdr/worktree.toml: {0}")]
    WorktreeScriptsRead(#[source] io::Error),
    #[error("Could not read .herdr/worktree.toml on the host: {0}")]
    WorktreeScriptsRemote(#[source] herdr_client::Error),
    #[error("The daemon did not identify this workspace's checkout")]
    WorktreeScriptsCheckout,
    #[error("Worktree scripts cannot be read from a WSL distribution yet")]
    WorktreeScriptsUnsupportedHost,
    #[error("Another worktree script is still starting")]
    WorktreeScriptsBusy,
    #[error("{0}")]
    WorktreeScriptsRequest(#[source] std::sync::Arc<Error>),
    #[error("Unexpected daemon response while opening the script's tab")]
    WorktreeScriptsResponse,
    #[error("This workspace is not a Git checkout Herdr knows yet")]
    WorktreeScriptsNotGit,
    #[error("neither XDG_STATE_HOME nor HOME is set")]
    MissingStateRoot,
    #[error("{} exceeds {limit} bytes", path.display())]
    StateFileSize { path: PathBuf, limit: u64 },
    #[error("Browser tabs open only http and https addresses with a host, of at most 8 KiB.")]
    InvalidBrowserUrl,
    #[error(
        "Local pages must be a plain file in a folder that is not hidden and does not hold your home directory."
    )]
    InvalidLocalPage,
    #[error("The page reported an invalid annotation")]
    InvalidAnnotation,
    #[error("Invalid saved browser tabs")]
    InvalidBrowserTabs,
    #[error("Worktree notes stay in this app and are never sent to the daemon")]
    LocalWorktreeNote,
    #[error("Invalid saved worktree notes")]
    InvalidWorktreeNotes,
    #[error("Invalid saved dispatch history")]
    InvalidDispatchHistory,
    #[error("Invalid saved editor groups")]
    InvalidGroupLayouts,
    #[error("Herdr GPUI is not running, or its control socket {} is unreachable: {source}", path.display())]
    ControlUnavailable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Another Herdr GPUI already serves {}", path.display())]
    ControlSocketInUse { path: PathBuf },
    #[error("Control request or response exceeds {limit} bytes")]
    ControlMessageSize { limit: usize },
    #[error("Herdr GPUI closed the control connection without answering")]
    ControlNoResponse,
    #[error("{message}")]
    ControlRejected {
        code: crate::control::ErrorCode,
        message: String,
    },
    #[error(
        "Controlling a running Herdr GPUI needs a Unix socket, which this platform build does not provide"
    )]
    ControlUnsupported,
    #[cfg(any(target_os = "macos", windows))]
    #[error("Could not create the page: {0}")]
    WebView(#[from] wry::Error),
    #[cfg(any(target_os = "macos", windows))]
    #[error("Could not reach the native window for the page: {0}")]
    WindowHandle(#[from] WindowHandleError),
    #[cfg(target_os = "macos")]
    #[error("The page that opened a popup is no longer in a window")]
    PopupOpener,
    #[error("Could not install the agent skill at {}: {source}", path.display())]
    SkillInstall {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    DeviceSetupInput(&'static str),
    #[error("Saving the device failed ({status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") })]
    DeviceSetup {
        status: std::process::ExitStatus,
        detail: String,
    },
    #[error("Saving the device timed out")]
    DeviceSetupTimeout,
    #[error("This host and session are already saved as \u{201c}{0}\u{201d}.")]
    DeviceExists(String),
    #[error("This host is already being added.")]
    DeviceAdding,
    #[error("Searching the local network failed: {0}")]
    Bonjour(#[from] mdns_sd::Error),
    #[error("Could not list this machine's network addresses: {0}")]
    LocalAddresses(#[source] io::Error),
    #[error("Tailscale is unavailable ({status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") })]
    TailscaleStatus {
        status: std::process::ExitStatus,
        detail: String,
    },
    #[error("Tailscale did not answer in time")]
    TailscaleTimeout,
    #[error("Tailscale returned an unreadable status: {0}")]
    TailscaleJson(#[source] serde_json::Error),
    #[error("Could not read {}: {source}", path.display())]
    SshConfig {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Removing the device failed ({status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") })]
    DeviceRemove {
        status: std::process::ExitStatus,
        detail: String,
    },
    #[error("Renaming the device failed ({status}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") })]
    DeviceRename {
        status: std::process::ExitStatus,
        detail: String,
    },
    #[error("preferences must be an object")]
    PreferencesNotObject,
    #[error("sidebar_width_px must be finite and positive, or null")]
    InvalidStoredWidth,
    #[error("invalid sidebar width")]
    InvalidSidebarWidth,
    #[error("preferences path has no parent")]
    PreferencesPath,
    #[error("{}: {source}", path.display())]
    Path {
        path: PathBuf,
        #[source]
        source: Box<Error>,
    },
    #[error("{source}; removing {}: {cleanup}", path.display())]
    Cleanup {
        #[source]
        source: io::Error,
        path: PathBuf,
        cleanup: io::Error,
    },
    #[error("HOME is not set")]
    MissingHome,
    #[error("XDG_CONFIG_HOME must be an absolute path")]
    RelativeConfigRoot,
    #[error("Cannot migrate {}: {} already contains different settings. Merge your old settings into the local file, then remove the old config; it will be regenerated.", original.display(), local.display())]
    ConfigMigrationConflict { original: PathBuf, local: PathBuf },
    #[error("theme must not be empty")]
    EmptyTheme,
    #[error("{0}.family must not be empty")]
    EmptyFontFamily(&'static str),
    #[error("{0}.size must be finite and between 8 and 48 logical pixels")]
    InvalidFontSize(&'static str),
    #[error("{0}.line_height must be a finite number between 1 and 2 times the font size")]
    InvalidLineHeight(&'static str),
    #[error("{0}.fallback families must not be empty")]
    EmptyFontFallback(&'static str),
    #[error("{0}.fallback must list at most 8 families")]
    TooManyFontFallbacks(&'static str),
    #[error("layout.sidebar_gap must be finite and between 0 and 64 logical pixels")]
    InvalidSidebarGap,
    #[error("sidebar.{key} must be finite and between 0 and {max} logical pixels")]
    InvalidSidebarMetric { key: &'static str, max: f32 },
    #[error("sidebar.hosts.{host:?} must be a #rgb or #rrggbb colour, not {value:?}")]
    InvalidHostColor { host: String, value: String },
    #[error("theme must be a name, absolute path, or ~/ path")]
    InvalidThemePath,
    #[error("a theme that follows the system must name both sides: light:NAME,dark:NAME")]
    InvalidThemePair,
    #[error("keybindings.{0} is not a command; see the keybindings list in config-gpui.toml")]
    UnknownKeybinding(String),
    #[error("keybindings.{command}: invalid keystroke {keystroke:?}")]
    InvalidKeystroke {
        command: &'static str,
        keystroke: String,
        #[source]
        source: gpui::InvalidKeystrokeError,
    },
    #[error(
        "keybindings.{command}: {keystroke:?} needs a cmd, ctrl, alt, or fn modifier so typing still reaches the terminal"
    )]
    KeystrokeWithoutModifier {
        command: &'static str,
        keystroke: String,
    },
    #[error("keybindings.{0} must list at most 8 keystrokes")]
    TooManyKeystrokes(&'static str),
    #[error("keybindings: {keystroke:?} is bound to both {first} and {second}")]
    DuplicateKeystroke {
        keystroke: String,
        first: &'static str,
        second: &'static str,
    },
    #[error("pane_keys: invalid keystroke {keystroke:?}")]
    InvalidPaneKey {
        keystroke: String,
        #[source]
        source: gpui::InvalidKeystrokeError,
    },
    #[error(
        "pane_keys: {0:?} needs a cmd, ctrl, alt, or fn modifier so typing still reaches the terminal"
    )]
    PaneKeyWithoutModifier(String),
    #[error("pane_keys.{from:?}: a pane cannot receive {to:?}")]
    UnsendablePaneKey { from: String, to: String },
    #[error("pane_keys: {0:?} is listed twice")]
    DuplicatePaneKey(String),
    #[error("pane_keys must list at most {0} keystrokes")]
    TooManyPaneKeys(usize),
    #[error("pane_keys: {keystroke:?} is also bound to keybindings.{command}")]
    PaneKeyBound {
        keystroke: String,
        command: &'static str,
    },
    #[error("the host did not publish its keybindings")]
    ServerKeybindingsMissing,
    #[error("the host's keybindings exceed {max} bytes")]
    ServerKeybindingsTooLarge { max: usize },
    #[error("the host's keybindings are not valid TOML: {0}")]
    ServerKeybindingsParse(#[source] toml::de::Error),
    #[error("the host's keybindings have no [keys] table")]
    ServerKeybindingsNoKeys,
    #[error("devices.{0:?} is not a saved device ID")]
    InvalidDeviceId(String),
    #[error("devices and each devices.<id> must be tables")]
    InvalidDevicesTable,
    #[error("[devices] must list at most {0} devices")]
    TooManyDevices(usize),
    #[error("theme {name:?} not found in {directories:?}")]
    ThemeNotFound {
        name: String,
        directories: Vec<PathBuf>,
    },
    #[error("line {line}: {key}: {source}")]
    ThemeLine {
        line: usize,
        key: String,
        #[source]
        source: ThemeParseError,
    },
    #[error("The original target changed or no longer exists. Cancel and try again.")]
    StaleCloseTarget,
    #[error("The selected connection changed or is not ready. Cancel and try again.")]
    StaleConnection,
    #[error("Not connected to a daemon.")]
    NotConnected,
    #[error("The original tab changed or no longer exists. Cancel and try again.")]
    StaleTab,
    #[error("The original pane changed or no longer exists. Cancel and try again.")]
    StalePane,
    #[error("Enter a tab name.")]
    EmptyTabName,
    #[error("No tab selected.")]
    NoTab,
    #[error("The connection is not ready. Try again.")]
    ConnectionNotReady,
    #[error("Connection is busy. Try again.")]
    ConnectionBusy,
    #[error("The daemon session changed. Reopen the palette.")]
    PaletteSessionChanged,
    #[error("This workspace no longer exists. Reopen the palette.")]
    PaletteWorkspaceRemoved,
    #[error("This command action is not supported by this client.")]
    UnsupportedCommand,
    #[error("This command changed or was removed. Reopen the palette.")]
    PaletteCommandChanged,
    #[error("The original tab no longer exists in its workspace. Reopen the palette.")]
    PaletteTabRemoved,
    #[error("The original pane no longer exists in its tab. Reopen the palette.")]
    PalettePaneRemoved,
    #[error("This agent or terminal no longer exists. Reopen the palette.")]
    PaletteDestinationRemoved,
    #[error("This host is no longer connected. Reopen the palette.")]
    PaletteHostUnavailable,
    #[error("The selected connection is not ready.")]
    PaletteConnectionNotReady,
    #[error("No current daemon snapshot.")]
    NoSnapshot,
    #[error("No captured daemon session. Reopen the palette.")]
    NoPaletteSession,
    #[error("{}", daemon_error_message(.0))]
    DaemonResponse(serde_json::Value),
    #[error("Could not start herdr server: {source}. Use Terminal > Reconnect to retry.")]
    DaemonSpawn {
        #[source]
        source: io::Error,
    },
    #[error("daemon startup cancelled")]
    DaemonCancelled,
    #[error("Timed out waiting for herdr server at {}. Check the Herdr server log and use Terminal > Reconnect.", .0.display())]
    DaemonTimeout(PathBuf),
    #[error("herdr server exited before accepting connections: {0}. Check the Herdr server log.")]
    DaemonExited(std::process::ExitStatus),
}

impl Error {
    pub(crate) fn github_json(source: serde_json::Error) -> Self {
        Self::GitHubJson(GitHubJsonError(source))
    }

    pub(crate) fn at_path(self, path: &Path) -> Self {
        Self::Path {
            path: path.to_owned(),
            source: Box::new(self),
        }
    }
}

/// Parser diagnostics can quote credential-bearing fields; expose the cause only
/// to explicit source inspection, never ordinary Display or Debug formatting.
#[derive(thiserror::Error)]
#[error("Invalid GitHub JSON response.")]
pub struct GitHubJsonError(#[source] serde_json::Error);

impl std::fmt::Debug for GitHubJsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GitHubJsonError([REDACTED])")
    }
}

impl From<config_loader::ConfigError> for Error {
    fn from(error: config_loader::ConfigError) -> Self {
        // config preserves this cause but does not expose it through Error::source.
        match error {
            config_loader::ConfigError::FileParse { uri, cause } => {
                Self::ConfigFile { uri, source: cause }
            }
            error => Self::Config(error),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ThemeParseError {
    #[error("expected a six-digit RGB hex color (optionally prefixed by #)")]
    InvalidColor,
    #[error("invalid hex color")]
    InvalidHex(#[source] std::num::ParseIntError),
    #[error("expected index=color")]
    MissingPaletteColor,
    #[error("palette index must be between 0 and 255")]
    InvalidPaletteIndex(#[source] std::num::ParseIntError),
    #[error("palette index must be between 0 and 255")]
    PaletteIndexOutOfRange,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn github_network_message_names_the_transport_failure() {
        let error = Error::GitHubNetwork(ureq::Error::Io(io::Error::other(
            "invalid peer certificate: UnknownIssuer",
        )));
        let message = error.to_string();
        assert!(message.starts_with("GitHub network request failed or timed out"));
        assert!(
            message.contains("invalid peer certificate: UnknownIssuer"),
            "{message}"
        );
    }

    #[test]
    fn updater_wrapper_preserves_source_chain() {
        let error = Error::from(UpdateError::Io(io::Error::from(io::ErrorKind::BrokenPipe)));
        assert!(matches!(error, Error::Update(_)));
        assert_eq!(
            error
                .source()
                .and_then(|source| source.source())
                .and_then(|source| source.downcast_ref::<io::Error>())
                .map(io::Error::kind),
            Some(io::ErrorKind::BrokenPipe)
        );
    }

    #[test]
    fn github_failures_keep_typed_sources_and_redact_parser_diagnostics() -> anyhow::Result<()> {
        let source = serde_json::from_str::<u64>("\"fixture-private-value\"")
            .err()
            .ok_or_else(|| anyhow::anyhow!("expected JSON type error"))?;
        let error = Error::github_json(source);
        assert!(matches!(error, Error::GitHubJson(_)));
        assert!(!format!("{error} {error:?}").contains("fixture-private-value"));
        assert!(
            error
                .source()
                .and_then(|source| source.source())
                .is_some_and(|source| source.is::<serde_json::Error>())
        );

        let error = Error::CredentialIo(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(
            error
                .source()
                .and_then(|source| source.downcast_ref::<io::Error>())
                .is_some_and(|source| source.kind() == io::ErrorKind::PermissionDenied)
        );
        let error = Error::GitHubRead(io::Error::from(io::ErrorKind::TimedOut));
        assert!(
            matches!(&error, Error::GitHubRead(source) if source.kind() == io::ErrorKind::TimedOut)
        );
        Ok(())
    }

    #[test]
    fn io_context_retains_source_kind_and_cleanup_failure() {
        let error = Error::from(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            .at_path(Path::new("config.toml"));
        assert_eq!(error.to_string(), "config.toml: denied");
        assert!(
            error
                .source()
                .and_then(|source| source.source())
                .and_then(|source| source.downcast_ref::<io::Error>())
                .is_some_and(|source| source.kind() == io::ErrorKind::PermissionDenied)
        );

        let error = Error::Cleanup {
            source: io::Error::other("write failed"),
            path: "temporary".into(),
            cleanup: io::Error::new(io::ErrorKind::PermissionDenied, "cleanup denied"),
        };
        assert_eq!(
            error.to_string(),
            "write failed; removing temporary: cleanup denied"
        );
        assert!(
            error
                .source()
                .is_some_and(|source| source.is::<io::Error>())
        );
        assert!(
            matches!(error, Error::Cleanup { cleanup, .. } if cleanup.kind() == io::ErrorKind::PermissionDenied)
        );
    }

    #[test]
    fn client_schema_presentation_remains_redacted() -> anyhow::Result<()> {
        let source = serde_json::from_str::<Vec<String>>("{}")
            .err()
            .ok_or_else(|| anyhow::anyhow!("expected schema error"))?;
        let error = Error::from(herdr_client::Error::CatalogSchema(source));
        assert_eq!(error.to_string(), "invalid endpoint catalog schema");
        assert!(
            error
                .source()
                .and_then(|source| source.source())
                .is_some_and(|source| source.is::<serde_json::Error>())
        );
        Ok(())
    }
}
