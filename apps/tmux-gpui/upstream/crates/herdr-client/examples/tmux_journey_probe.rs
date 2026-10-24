//! Persistent, test-only driver for isolated broker -> Rust -> daemon journeys.
//! Uses the production controller. Emits structure and broker notices, never cells or tickets.
use herdr_client::{
    tmux_control::{Input, Lifetime},
    tmux_controller::Controller,
    tmux_handoff::Event,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Read, Write},
    sync::mpsc,
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Command {
    Presence { active: bool, revision: u64 },
    Select { pane: String, request: u64 },
    Text { text: String },
    Key { key: String },
    Resize { cols: u16, rows: u16 },
    Stop,
}
struct Active {
    id: String,
    request: u64,
    session: String,
    generation: String,
    catalog_only: bool,
    controller: Controller,
    presence: u64,
    pending_selection: Option<u64>,
    last_catalog: Option<Value>,
    last_ready: Option<Value>,
    last_state: Option<Value>,
    inputs: usize,
}
fn emit(value: Value) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &value)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}
fn notice(value: Value) -> Result<()> {
    emit(json!({"type":"probe-command","command":value}))
}
impl Active {
    fn poll(&mut self, now: u64) -> Result<()> {
        let update = self.controller.poll(now)?;
        self.presence = update.presence_revision.unwrap_or(self.presence);
        self.inputs += update.inputs.len();
        if let Some(selection) = update.selection {
            let request = self
                .pending_selection
                .take()
                .ok_or("unexpected selection completion")?;
            notice(
                json!({"type":"native-pane-selected","id":self.id,"fromRequest":self.request,
                "request":request,"pane":self.controller.selected()}),
            )?;
            self.request = request;
            if !selection.selected {
                return Err("native selection refused".into());
            }
        }
        let topology = self.controller.topology();
        if topology.epoch().is_some() && !topology.awaiting_authority() {
            let catalog = json!({"type":"native-terminal-catalog","version":1,"id":self.id,
                "request":self.request,"pane":self.controller.selected(),"liveSessionId":self.session,
                "generation":self.generation,"presenceRevision":self.presence,
                "layouts":topology.layouts().values().collect::<Vec<_>>()});
            if self.last_catalog.as_ref() != Some(&catalog) {
                notice(catalog.clone())?;
                self.last_catalog = Some(catalog);
            }
        }
        let coherent = update.window.as_ref().is_some_and(|w| w.coherent);
        let ready = !self.catalog_only && coherent && self.controller.input_ready();
        if ready {
            let command = json!({"type":"native-terminal-ready","version":1,"id":self.id,
                "request":self.request,"pane":self.controller.selected(),"liveSessionId":self.session,
                "generation":self.generation,"presenceRevision":self.presence,"inputReady":true,"coherent":true});
            if self.last_ready.as_ref() != Some(&command) {
                notice(command.clone())?;
                self.last_ready = Some(command);
            }
        }
        let state = json!({"type":"probe-state","id":self.id,"request":self.request,
            "selectedPane":self.controller.selected(),"preferredPane":topology.preferred_pane(),
            "catalogOnly":self.catalog_only,"inputReady":ready,"coherent":coherent,
            "presenceRevision":self.presence,"inputAcknowledgements":self.inputs,
            "cols":update.window.as_ref().map(|w| w.paint.cols),
            "rows":update.window.as_ref().map(|w| w.paint.rows),
            "panes":topology.layouts().values().flat_map(|w| &w.panes).filter_map(|p| p.pane.as_ref())
                .filter_map(|id| self.controller.committed(id).map(|p| json!({"pane":id,
                    "revision":p.identity.canonical_revision,"incarnation":p.identity.incarnation,
                    "cols":p.snapshot.as_ref().map(|s|s.cols),"rows":p.snapshot.as_ref().map(|s|s.rows)})))
                .collect::<Vec<_>>()});
        if self.last_state.as_ref() != Some(&state) {
            emit(state.clone())?;
            self.last_state = Some(state);
        }
        Ok(())
    }
    fn input(&mut self, input: Input, now: u64) -> Result<()> {
        let pane = self.controller.selected().to_owned();
        let committed = self
            .controller
            .committed(&pane)
            .ok_or("no committed target")?;
        let lifetime = Lifetime {
            generation: committed.identity.generation.clone(),
            incarnation: committed.identity.incarnation.clone(),
        };
        self.controller.input(&pane, &lifetime, input, now)?;
        Ok(())
    }
}
fn run() -> Result<()> {
    let (send, receive) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let mut reader = io::stdin().lock();
        loop {
            let mut bytes = Vec::new();
            let result = (&mut reader).take(65537).read_until(b'\n', &mut bytes);
            if matches!(result, Ok(0)) {
                break;
            }
            if bytes.len() > 65536 {
                break;
            }
            if send.send(result.map(|_| bytes)).is_err() {
                break;
            }
        }
    });
    let start = Instant::now();
    let mut active: Option<Active> = None;
    let mut presence = (true, 0);
    while start.elapsed() < Duration::from_secs(180) {
        let now = u64::try_from(start.elapsed().as_millis())?;
        if let Some(current) = &mut active {
            current.poll(now)?;
        }
        let bytes = match receive.recv_timeout(Duration::from_millis(5)) {
            Ok(bytes) => bytes?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let value: Value = serde_json::from_slice(&bytes)?;
        if value["type"]
            .as_str()
            .is_some_and(|s| s.starts_with("native-terminal-"))
        {
            match Event::parse(&bytes)? {
                Event::Open {
                    id,
                    request,
                    live_session_id,
                    capability,
                    ..
                } => {
                    if let Some(old) = &mut active {
                        old.controller.retire();
                    }
                    let generation = capability.descriptor.daemon_instance_id.clone();
                    let catalog_only = capability.catalog_only;
                    let mut controller = Controller::spawn(*capability)?;
                    controller.presence(presence.0, presence.1, now)?;
                    active = Some(Active {
                        id,
                        request,
                        session: live_session_id,
                        generation,
                        catalog_only,
                        controller,
                        presence: presence.1,
                        pending_selection: None,
                        last_catalog: None,
                        last_ready: None,
                        last_state: None,
                        inputs: 0,
                    });
                }
                Event::Close { id, .. } => {
                    if active.as_ref().is_some_and(|a| a.id == id) {
                        if let Some(mut old) = active.take() {
                            old.controller.retire();
                        }
                        emit(json!({"type":"probe-closed","id":id}))?;
                    }
                }
            }
            continue;
        }
        match serde_json::from_value(value)? {
            Command::Stop => break,
            Command::Presence {
                active: foreground,
                revision,
            } => {
                presence = (foreground, revision);
                if let Some(a) = &mut active {
                    a.controller.presence(foreground, revision, now)?;
                }
            }
            command => {
                let a = active.as_mut().ok_or("no active native connection")?;
                match command {
                    Command::Select { pane, request } => {
                        let lifetime = a
                            .controller
                            .selectable(&pane)
                            .ok_or("pane is not selectable")?;
                        if request <= a.request {
                            return Err("selection request did not advance".into());
                        }
                        if a.controller.select_pane(
                            &pane,
                            &lifetime,
                            &uuid::Uuid::new_v4().to_string(),
                            now,
                        )? {
                            a.pending_selection = Some(request);
                        }
                    }
                    Command::Text { text } => a.input(Input::Text(text), now)?,
                    Command::Key { key } => a.input(Input::Key(key), now)?,
                    Command::Resize { cols, rows } => a.controller.viewport(cols, rows, now)?,
                    Command::Stop | Command::Presence { .. } => unreachable!(),
                }
            }
        }
    }
    if let Some(mut a) = active {
        a.controller.retire();
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("native journey probe failed: {error}");
        std::process::exit(1);
    }
}
