//! Opt-in, headless journey adapter for the production native worker.
//! This exercises ownership and transport, not OS events or GPU rendering.
use super::{browser, keys, pane_actions};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Cursor, Read, Write},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const LIMIT: usize = 8 * 1024 * 1024;
struct PipeReader {
    receiver: mpsc::Receiver<Vec<u8>>,
    current: Cursor<Vec<u8>>,
}
impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            let count = self.current.read(out)?;
            if count != 0 {
                return Ok(count);
            }
            match self.receiver.recv() {
                Ok(bytes) => self.current = Cursor::new(bytes),
                Err(_) => return Ok(0),
            }
        }
    }
}
#[derive(Default)]
struct PipeWriter(Vec<u8>);
impl Write for PipeWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len() + bytes.len() > LIMIT {
            return Err(io::Error::other("journey output exceeded bound"));
        }
        self.0.extend_from_slice(bytes);
        while let Some(end) = self.0.iter().position(|byte| *byte == b'\n') {
            let command: Value = serde_json::from_slice(&self.0[..end])?;
            emit(json!({"type":"probe-command", "command":command}))?;
            self.0.drain(..=end);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn emit(value: Value) -> io::Result<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()
}
fn string(value: &Value, field: &str) -> Result<String> {
    Ok(value[field]
        .as_str()
        .with_context(|| format!("missing {field}"))?
        .to_owned())
}
fn command(value: &Value) -> Result<browser::Command> {
    use browser::Command as C;
    if value["type"] == "presence" {
        return Ok(C::Presence {
            active: value["active"].as_bool().context("missing active")?,
            revision: value["revision"].as_u64().context("missing revision")?,
        });
    }
    let request = value["request"].as_u64().context("missing request")?;
    Ok(match value["type"].as_str().context("missing type")? {
        "home" => C::Home { request },
        "refresh" => C::Refresh { request },
        "session" => C::Session {
            request,
            id: string(value, "id")?,
        },
        "pane" => C::Pane {
            request,
            id: string(value, "id")?,
        },
        "open-editor" => C::OpenEditor {
            request,
            id: string(value, "id")?,
            token: string(value, "token")?,
        },
        "pane-action" => C::PaneAction {
            request,
            id: string(value, "id")?,
            token: string(value, "token")?,
            action: match value["action"].as_str() {
                Some("new-window") => pane_actions::Action::NewWindow,
                Some("close") => pane_actions::Action::Close,
                Some("zoom") => pane_actions::Action::Zoom {
                    desired: match value["desired"].as_str() {
                        Some("zoomed") => pane_actions::Zoom::Zoomed,
                        Some("unzoomed") => pane_actions::Zoom::Unzoomed,
                        _ => bail!("invalid fixture zoom"),
                    },
                },
                Some("rename") => pane_actions::Action::Rename {
                    name: string(value, "name")?,
                },
                Some("new-agent") => pane_actions::Action::NewAgent {
                    name: string(value, "name")?,
                    harness: match value["harness"].as_str() {
                        Some("claude") => pane_actions::Harness::Claude,
                        Some("codex") => pane_actions::Harness::Codex,
                        _ => bail!("unsupported fixture harness"),
                    },
                },
                _ => bail!("unsupported fixture pane action"),
            },
        },
        "split-gesture" => C::SplitGesture {
            request,
            gesture: string(value, "gesture")?,
            update: match value["phase"].as_str() {
                Some("begin") => super::divider::canonical::Update::Begin {
                    target: serde_json::from_value(value["target"].clone())?,
                    axis: serde_json::from_value(value["axis"].clone())?,
                },
                Some("release") => super::divider::canonical::Update::Release {
                    boundary: u16::try_from(value["boundary"].as_u64().context("boundary")?)?,
                },
                Some("cancel") => super::divider::canonical::Update::Cancel,
                _ => bail!("unsupported split phase"),
            },
        },
        "input" => {
            let input = &value["input"];
            let data = &input["data"];
            C::Input {
                request,
                id: string(value, "id")?,
                input_target: value["inputTarget"].as_str().map(str::to_owned),
                input: match input["kind"].as_str() {
                    Some("text") => keys::Input::Text(string(input, "data")?),
                    Some("key") => keys::Input::Key(string(input, "data")?),
                    Some("paste") => keys::Input::Paste(string(input, "data")?),
                    Some("resize") => keys::Input::Resize {
                        cols: u16::try_from(data["cols"].as_u64().context("resize cols")?)?,
                        rows: u16::try_from(data["rows"].as_u64().context("resize rows")?)?,
                        cell_width: None,
                        cell_height: None,
                        cell_width_milli: None,
                        cell_height_milli: None,
                    },
                    Some("scroll") => {
                        keys::Input::Scroll(i16::try_from(data.as_i64().context("scroll lines")?)?)
                    }
                    _ => bail!("unsupported fixture input"),
                },
            }
        }
        _ => bail!("unsupported fixture command"),
    })
}
fn state(value: &browser::State) -> Value {
    let choices = |values: &[browser::Choice]| {
        values
            .iter()
            .map(|v| {
                json!({
                    "id":v.id,"label":v.label,"paneCount":v.pane_count,
                    "windowId":v.window_id,"windowLabel":v.window_label,
                })
            })
            .collect::<Vec<_>>()
    };
    json!({
        "request":value.request,"inputReady":value.input_ready,
        "splitLayout":value.split_layout.as_ref().map(|l|json!({
            "window":l.window,"layoutId":l.layout_id,
            "splits":l.splits.iter().map(|e|json!({"splitId":e.split_id,"boundary":e.boundary,"axis":e.axis})).collect::<Vec<_>>()
        })),
        "splitGesture":value.split_gesture.as_ref().map(|a|json!({
            "gesture":a.gesture,"boundary":a.boundary,"phase":match a.phase {
                super::divider::gesture::Phase::Dragging=>"dragging",
                super::divider::gesture::Phase::Pending=>"pending",
                super::divider::gesture::Phase::Settled=>"settled",
                super::divider::gesture::Phase::Failed=>"failed",
                super::divider::gesture::Phase::Cancelled=>"cancelled",
            }
        })),
        "home":{"phase":match value.home_phase {browser::HomePhase::Loading=>"loading",browser::HomePhase::Live=>"live",browser::HomePhase::Unavailable=>"unavailable"}},
        "surface":match value.surface {browser::Surface::Home=>"home",browser::Surface::Workspace=>"workspace"},
        // Only isolated fixture content crosses this opt-in test pipe.
        "frameText":value.frame.as_ref().map(|f| {
            let frame=f.view();
            (0..frame.height()).map(|y|frame.row(usize::from(y)).unwrap_or_default().iter().map(|cell|cell.symbol.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
        }),
        "selectedPane":value.selected_pane,"selectedSession":value.selected_session,
        "preferredPane":value.preferred_pane,"status":value.status,
        "sessionCatalogComplete":value.session_catalog_complete,
        "sessions":choices(&value.sessions),"panes":choices(&value.panes),
        "presenceRevision":value.presence_revision,"historyOffset":value.history_offset,
        "selectionIdentity":value.selection_identity,
        "regions":value.regions.iter().map(|r|json!({"id":r.id,"left":r.left,"top":r.top,"width":r.width,"height":r.height})).collect::<Vec<_>>(),
        "paneActions":value.pane_actions.as_ref().map(|a|json!({"id":a.id,"token":a.token,"zoomed":a.zoomed})),
        "snapshot":value.frame.as_ref().map(|f| {let frame=f.view(); json!({"cols":frame.width(),"rows":frame.height()})}),
        "inputTargets":value.input_targets.iter().map(|t|json!({"id":t.id,"token":t.token})).collect::<Vec<_>>(),
    })
}
pub(crate) fn run() -> Result<()> {
    let (incoming, receiver) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            let read = input
                .by_ref()
                .take((LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes);
            match read {
                Ok(0) => break,
                Ok(_) if bytes.len() <= LIMIT => {
                    if incoming.send(Ok(bytes)).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = incoming.send(Err("journey input exceeded bound or failed"));
                    break;
                }
            }
        }
    });
    let (broker, broker_receiver) = mpsc::sync_channel(16);
    let bridge = browser::start_journey(
        PipeReader {
            receiver: broker_receiver,
            current: Cursor::new(Vec::new()),
        },
        PipeWriter::default(),
    );
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(2)) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes.map_err(anyhow::Error::msg)?)?;
                match value["type"].as_str() {
                    Some("stop") => return Ok(()),
                    Some("broker") => {
                        let mut bytes = serde_json::to_vec(&value["data"])?;
                        bytes.push(b'\n');
                        broker
                            .try_send(bytes)
                            .map_err(|_| anyhow::anyhow!("journey broker queue unavailable"))?;
                    }
                    Some("command") => bridge
                        .commands
                        .try_send(command(&value["data"])?)
                        .map_err(|_| anyhow::anyhow!("journey command queue unavailable"))?,
                    _ => bail!("unknown journey envelope"),
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let next = bridge
            .mailbox
            .lock()
            .map_err(|_| anyhow::anyhow!("journey mailbox poisoned"))?
            .take();
        if let Some(next) = next {
            emit(json!({"type":"probe-state","state":next.as_ref().map(state)}))?;
        }
    }
    bail!("journey deadline exceeded")
}
