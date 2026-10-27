//! Lets processes on this machine, such as an agent in a Herdr pane, show
//! the user a page and hear back what the user noted on it. Herdr itself has
//! no way to reach a client, so the app listens on a socket of its own and
//! `herdr-gpui browser ...` talks to it. Only this user's local processes
//! can reach it: an agent on an SSH host has no path to this machine's socket.

mod protocol;
#[cfg(unix)]
mod socket;

#[cfg(unix)]
use crate::{
    HerdrWindow,
    browser::{Feedback, Location},
};
use crate::{
    browser::{LocalFile, WebUrl},
    cli::BrowserCommand,
};
use gpui::App;
pub use protocol::ErrorCode;
use protocol::{
    BrowserOpen, Caller, FeedbackRequest, MAX_WAIT_SECONDS, OpenedIn, Page, Request, Response,
};
#[cfg(unix)]
use std::path::PathBuf;
use std::{path::Path, process::ExitCode};

#[cfg(any(target_os = "macos", windows))]
/// The command that reloads a caller's pages, for the notes prompt.
pub(crate) fn reload_command() -> String {
    static COMMAND: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    COMMAND
        .get_or_init(|| {
            format!(
                "{} browser reload",
                crate::agent_skill::command(std::env::current_exe().ok().as_deref())
            )
        })
        .clone()
}

/// Exit status when no app is listening, so a caller can fall back to
/// printing the address instead.
const EXIT_NOT_RUNNING: u8 = 3;
/// Exit status of `browser feedback` when no notes arrived.
const EXIT_NO_FEEDBACK: u8 = 4;

#[cfg(unix)]
fn socket_path() -> Option<PathBuf> {
    crate::preferences::state_dir().map(|dir| dir.join("control.sock"))
}

/// What a request asks the windows to find: a workspace, optionally of one
/// particular local daemon, and the pane asking.
#[cfg(unix)]
pub(crate) struct Target<'a> {
    pub daemon: Option<&'a Path>,
    pub workspace: Option<&'a str>,
    pub pane: Option<&'a str>,
}

/// Where a window opened a requested tab.
#[cfg(unix)]
pub(crate) enum Placed {
    Opened { workspace_id: String },
    Full,
}

/// Identifiers a request carries are compared, never interpreted, but they
/// are echoed in answers, so they stay short and printable.
#[cfg(any(unix, test))]
fn plain(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

#[cfg(unix)]
fn valid_caller(caller: &Caller) -> bool {
    caller
        .workspace_id
        .as_deref()
        .is_none_or(|id| plain(id, 256))
        && caller.pane_id.as_deref().is_none_or(|id| plain(id, 256))
        && caller
            .daemon_socket
            .as_deref()
            .is_none_or(|path| plain(path, 4096))
}

#[cfg(unix)]
fn main_windows(cx: &App) -> Vec<gpui::WindowHandle<HerdrWindow>> {
    let active = cx.active_window();
    let mut windows: Vec<_> = cx
        .windows()
        .into_iter()
        .filter_map(|handle| handle.downcast::<HerdrWindow>())
        .collect();
    // The frontmost window wins a workspace that several windows show.
    windows.sort_by_key(|handle| Some(handle.window_id()) != active.map(|a| a.window_id()));
    windows
}

#[cfg(unix)]
fn location(page: &Page) -> Result<Location, Response> {
    match page {
        Page::Url(url) => WebUrl::try_from(url.as_str())
            .map(|url| Location::Web { url })
            .map_err(|error| Response::error(ErrorCode::InvalidUrl, error.to_string())),
        Page::File(path) => {
            let home = crate::config::home().ok();
            LocalFile::new(Path::new(path), home.as_deref())
                .map(|file| Location::Local { file })
                .map_err(|error| Response::error(ErrorCode::InvalidUrl, error.to_string()))
        }
    }
}

#[cfg(unix)]
fn open_browser(request: &BrowserOpen, cx: &mut App) -> Response {
    if !valid_caller(&request.caller) {
        return Response::error(
            ErrorCode::InvalidRequest,
            "Invalid workspace, pane, or daemon",
        );
    }
    let location = match location(&request.page) {
        Ok(location) => location,
        Err(response) => return response,
    };
    if !crate::browser::EMBEDDED {
        let Location::Web { url } = &location else {
            return Response::error(
                ErrorCode::Unsupported,
                "Local pages need browser tabs, which this platform's build does not have",
            );
        };
        cx.open_url(url.as_str());
        return Response::Opened {
            opened_in: OpenedIn::SystemBrowser,
            workspace_id: None,
        };
    }
    let windows = main_windows(cx);
    if windows.is_empty() {
        return Response::error(ErrorCode::NoWindow, "Herdr GPUI has no window open");
    }
    let caller = &request.caller;
    let target = Target {
        daemon: caller.daemon_socket.as_deref().map(Path::new),
        workspace: caller.workspace_id.as_deref(),
        pane: caller.pane_id.as_deref(),
    };
    // First the window connected to the caller's own daemon; then, when the
    // socket paths are spelled differently, any window showing its workspace.
    for strict in [true, false] {
        for handle in &windows {
            let placed = handle.update(cx, |view, window, cx| {
                view.open_requested_browser_tab(
                    &target,
                    strict,
                    &location,
                    request.focus,
                    window,
                    cx,
                )
            });
            match placed {
                Ok(Some(Placed::Opened { workspace_id })) => {
                    return Response::Opened {
                        opened_in: OpenedIn::Tab,
                        workspace_id: Some(workspace_id),
                    };
                }
                Ok(Some(Placed::Full)) => {
                    return Response::error(ErrorCode::TabLimit, "Too many browser tabs are open");
                }
                Ok(None) | Err(_) => {}
            }
        }
    }
    Response::error(
        ErrorCode::WorkspaceNotFound,
        match &caller.workspace_id {
            Some(id) => format!("No Herdr GPUI window shows workspace {id}"),
            None => "No Herdr GPUI window shows a workspace".into(),
        },
    )
}

/// Reloads every page the calling pane opened, in every window.
#[cfg(unix)]
fn reload(caller: &Caller, cx: &mut App) -> Response {
    let Some(pane) = caller.pane_id.as_deref().filter(|pane| plain(pane, 256)) else {
        return Response::error(
            ErrorCode::InvalidRequest,
            "browser reload runs in the Herdr pane that opened the page",
        );
    };
    let tabs: Vec<_> = cx
        .try_global::<crate::browser::Store>()
        .map(|store| store.opened_by(pane).map(|tab| tab.id).collect())
        .unwrap_or_default();
    for handle in main_windows(cx) {
        let _ = handle.update(cx, |view, _, cx| view.reload_browser_tabs(&tabs, cx));
    }
    Response::Reloaded { tabs: tabs.len() }
}

/// An agent waiting in `browser feedback --wait`.
#[cfg(unix)]
struct Waiter {
    pane_id: String,
    until: std::time::Instant,
    incoming: socket::Incoming,
}

/// At most this many agents wait at once; the socket bounds connections too.
#[cfg(unix)]
const MAX_WAITERS: usize = 8;

#[cfg(unix)]
fn feedback(
    request: &FeedbackRequest,
    incoming: socket::Incoming,
    waiters: &mut Vec<Waiter>,
    cx: &mut App,
) {
    if !plain(&request.pane_id, 256) {
        incoming.respond(Response::error(ErrorCode::InvalidRequest, "Invalid pane"));
        return;
    }
    let kept = cx.default_global::<Feedback>().take(&request.pane_id);
    if kept.is_some() || request.wait_seconds == 0 {
        incoming.respond(Response::Feedback { text: kept });
        return;
    }
    if waiters.len() >= MAX_WAITERS {
        incoming.respond(Response::error(
            ErrorCode::Busy,
            "Too many agents are waiting for notes",
        ));
        return;
    }
    // A newer wait from the same pane replaces the older one.
    if let Some(index) = waiters
        .iter()
        .position(|waiter| waiter.pane_id == request.pane_id)
    {
        waiters
            .remove(index)
            .incoming
            .respond(Response::Feedback { text: None });
    }
    waiters.push(Waiter {
        pane_id: request.pane_id.clone(),
        until: std::time::Instant::now()
            + std::time::Duration::from_secs(request.wait_seconds.min(MAX_WAIT_SECONDS)),
        incoming,
    });
}

/// Hands sent notes to waiting agents and releases the ones whose wait ran
/// out, then tells the windows who is still waiting.
#[cfg(unix)]
fn serve_waiters(waiters: &mut Vec<Waiter>, cx: &mut App) {
    let now = std::time::Instant::now();
    let mut still = Vec::with_capacity(waiters.len());
    for waiter in waiters.drain(..) {
        let has = cx
            .try_global::<Feedback>()
            .is_some_and(|feedback| feedback.has(&waiter.pane_id));
        if has {
            let text = cx.default_global::<Feedback>().take(&waiter.pane_id);
            waiter.incoming.respond(Response::Feedback { text });
        } else if now >= waiter.until {
            waiter.incoming.respond(Response::Feedback { text: None });
        } else {
            still.push(waiter);
        }
    }
    *waiters = still;
    let panes: Vec<String> = waiters
        .iter()
        .map(|waiter| waiter.pane_id.clone())
        .collect();
    let current = cx.try_global::<Feedback>().map(Feedback::waiting);
    if current.is_none_or(|current| current != panes.as_slice()) {
        cx.default_global::<Feedback>().set_waiting(panes);
    }
}

/// Starts answering requests. A second app instance leaves the first one's
/// socket alone and simply does not listen.
#[cfg(unix)]
pub(crate) fn install(cx: &mut App) {
    let Some(path) = socket_path() else {
        return;
    };
    let server = match socket::Server::bind(&path) {
        Ok(server) => server,
        Err(error) => {
            tracing::warn!(%error, "Browser control socket unavailable");
            return;
        }
    };
    tracing::info!(path = %server.path().display(), "Browser control socket listening");
    cx.on_app_quit(move |cx| {
        let path = path.clone();
        cx.background_executor().spawn(async move {
            let _ = std::fs::remove_file(path);
        })
    })
    .detach();
    let timer = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        let mut waiters = Vec::new();
        loop {
            timer.timer(std::time::Duration::from_millis(50)).await;
            cx.update(|cx| {
                for incoming in server.drain() {
                    match incoming.request.clone() {
                        Request::Open(request) => {
                            incoming.respond(open_browser(&request, cx));
                        }
                        Request::Reload(caller) => incoming.respond(reload(&caller, cx)),
                        Request::Feedback(request) => {
                            feedback(&request, incoming, &mut waiters, cx);
                        }
                    }
                }
                serve_waiters(&mut waiters, cx);
            });
        }
    })
    .detach();
}

#[cfg(not(unix))]
pub(crate) fn install(_: &mut App) {}

/// The daemon a pane's agent belongs to, from the variables Herdr sets in it.
fn caller_daemon() -> crate::Result<Option<String>> {
    if std::env::var_os("HERDR_SOCKET_PATH").is_none() {
        return Ok(None);
    }
    let path = herdr_client::ConnectTarget::Local.socket_path()?;
    Ok(path.to_str().map(str::to_owned))
}

fn env_id(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|id| !id.is_empty())
}

fn caller(workspace: Option<String>) -> crate::Result<Caller> {
    Ok(Caller {
        pane_id: env_id("HERDR_PANE_ID"),
        workspace_id: workspace.or_else(|| env_id("HERDR_WORKSPACE_ID")),
        daemon_socket: caller_daemon()?,
    })
}

#[cfg(unix)]
fn send(request: &Request) -> crate::Result<Response> {
    let path = socket_path().ok_or(crate::Error::MissingStateRoot)?;
    socket::call(&path, request)
}

#[cfg(not(unix))]
fn send(_: &Request) -> crate::Result<Response> {
    Err(crate::Error::ControlUnsupported)
}

fn rejected(response: Response) -> crate::Error {
    match response {
        Response::Error { code, message } => crate::Error::ControlRejected { code, message },
        _ => crate::Error::ControlNoResponse,
    }
}

/// A file that exists is shown as a local page; anything else is an address.
fn page(target: &str) -> crate::Result<(Page, String)> {
    let path = Path::new(target);
    if !target.contains("://") && path.is_file() {
        let path = path.canonicalize()?;
        let home = crate::config::home().ok();
        LocalFile::new(&path, home.as_deref())?;
        let text = path
            .to_str()
            .ok_or(crate::Error::InvalidLocalPage)?
            .to_owned();
        return Ok((Page::File(text.clone()), text));
    }
    let url = WebUrl::from_typed(target)?;
    Ok((Page::Url(url.as_str().to_owned()), url.as_str().to_owned()))
}

fn browser_open(target: &str, workspace: Option<String>, focus: bool) -> crate::Result<String> {
    let (page, shown) = page(target)?;
    let request = Request::Open(BrowserOpen {
        page,
        caller: caller(workspace)?,
        focus,
    });
    match send(&request)? {
        Response::Opened {
            opened_in: OpenedIn::Tab,
            workspace_id,
        } => Ok(match workspace_id {
            Some(id) => format!("Opened {shown} in a browser tab of workspace {id}"),
            None => format!("Opened {shown} in a browser tab"),
        }),
        Response::Opened {
            opened_in: OpenedIn::SystemBrowser,
            ..
        } => Ok(format!(
            "Opened {shown} in the system browser; this platform's build has no browser tabs"
        )),
        response => Err(rejected(response)),
    }
}

fn browser_reload() -> crate::Result<String> {
    match send(&Request::Reload(caller(None)?))? {
        Response::Reloaded { tabs: 0 } => Err(crate::Error::ControlRejected {
            code: ErrorCode::InvalidRequest,
            message: "This pane has no browser tabs open".into(),
        }),
        Response::Reloaded { tabs } => Ok(format!("Reloaded {tabs} browser tab(s)")),
        response => Err(rejected(response)),
    }
}

/// The user's notes for this pane, or `None` when none arrived in time.
fn browser_feedback(wait: u64) -> crate::Result<Option<String>> {
    let pane_id = env_id("HERDR_PANE_ID").ok_or(crate::Error::ControlRejected {
        code: ErrorCode::InvalidRequest,
        message: "browser feedback runs in the Herdr pane that opened the page".into(),
    })?;
    let request = Request::Feedback(FeedbackRequest {
        pane_id,
        wait_seconds: wait.min(MAX_WAIT_SECONDS),
    });
    match send(&request)? {
        Response::Feedback { text } => Ok(text),
        response => Err(rejected(response)),
    }
}

const BROWSER_USAGE: &str = "\
herdr-gpui browser open URL|FILE [--workspace ID] [--no-focus]
    Show a web address, or a local HTML file, in a browser tab of the running
    Herdr GPUI. The tab joins the caller's own workspace (HERDR_WORKSPACE_ID),
    or the frontmost one outside Herdr. Showing the same page again from the
    same pane reuses and reloads its tab. Bare hosts such as localhost:3000
    are accepted. A file is served with the other files in its folder.
herdr-gpui browser reload
    Reload the pages this pane opened, for example after editing the file.
herdr-gpui browser feedback [--wait SECONDS]
    Print the notes the user sent about this pane's pages and have not been
    delivered yet. With --wait, wait up to SECONDS (at most 600) for them.
    Notes are otherwise typed into this pane as a prompt once it is idle.
herdr-gpui browser skill
    Print the agent skill that explains these commands.
Exit status: 0 done, 1 refused, 2 invalid arguments, 3 Herdr GPUI not running,
4 no notes (feedback).";

fn report(result: crate::Result<String>) -> ExitCode {
    match result {
        Ok(message) => {
            println!("{}", crate::notifications::safe_text(&message, 4096));
            ExitCode::SUCCESS
        }
        Err(error) => {
            // The running app's answer reaches the caller's terminal.
            eprintln!(
                "{}",
                crate::notifications::safe_text(&error.to_string(), 4096)
            );
            ExitCode::from(match error {
                crate::Error::InvalidBrowserUrl | crate::Error::InvalidLocalPage => 2,
                crate::Error::ControlUnavailable { .. } => EXIT_NOT_RUNNING,
                _ => 1,
            })
        }
    }
}

/// Runs a control subcommand without starting GPUI.
pub(crate) fn run(command: BrowserCommand) -> ExitCode {
    match command {
        BrowserCommand::Help => {
            println!("{BROWSER_USAGE}");
            ExitCode::SUCCESS
        }
        BrowserCommand::Skill => {
            print!(
                "{}",
                crate::agent_skill::text(std::env::current_exe().ok().as_deref())
            );
            ExitCode::SUCCESS
        }
        BrowserCommand::Open {
            target,
            workspace,
            focus,
        } => report(browser_open(&target, workspace, focus)),
        BrowserCommand::Reload => report(browser_reload()),
        BrowserCommand::Feedback { wait } => match browser_feedback(wait) {
            // Notes keep their line breaks: they are Markdown for the agent.
            Ok(Some(text)) => {
                print!("{text}");
                ExitCode::SUCCESS
            }
            Ok(None) => {
                eprintln!("No notes from the user yet");
                ExitCode::from(EXIT_NO_FEEDBACK)
            }
            Err(error) => report(Err(error)),
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn echoed_identifiers_are_short_and_printable() {
        assert!(plain("w_1", 256));
        for invalid in ["", "w 1", "w\u{1b}[2J", "w\n1"] {
            assert!(!plain(invalid, 256), "{invalid:?}");
        }
        assert!(!plain(&"w".repeat(257), 256));
    }
}
