//! Keystroke-to-echo latency through the production controller and input
//! scheduler, for an isolated fixture daemon only. Never point it at personal
//! sessions: it types into the first session of the daemon it is given.
//!
//! Usage: tmux_input_latency_probe <daemon-record.json> [ws-port] [poll-ms]
//! `ws-port` replaces the issued WebSocket port (an SSH -L forward to the
//! same daemon), exactly as the app's SSH route rewrites it.
//!
//! `PROBE_SCENARIOS` (comma-separated) selects the remote-latency CI set:
//! `echo` (20 keys, 150 ms apart), `burst30` (30 keys, 60 ms apart; `last` is
//! the last key's press-to-echo) and `lines` (10 × "ab" + Enter, then a marker
//! line, 60 ms apart, 3 rounds; `lag` is the time from the last key press until
//! the marker line is on screen). Without it the probe prints its original set.
use herdr_client::{
    tmux_control::{Authority, Input, Lifetime},
    tmux_controller::Controller,
    tmux_daemon::{LocalDaemon, ServerRegistration, TerminalSelection},
    tmux_input::{Admission, Scheduler, Scope, Work},
    tmux_stream::ViewerMode,
};
use std::{
    collections::VecDeque,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

type Error = Box<dyn std::error::Error>;

struct Probe {
    controller: Controller,
    scheduler: Scheduler<()>,
    pane: String,
    lifetime: Lifetime,
    start: Instant,
    poll: Duration,
}

impl Probe {
    fn now(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
    fn text(&self) -> String {
        self.controller
            .committed(&self.pane)
            .and_then(|p| p.snapshot.as_ref())
            .map(|s| {
                s.grid
                    .iter()
                    .map(|row| {
                        row.cells()
                            .iter()
                            .map(|c| c.grapheme.as_ref())
                            .collect::<String>()
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    }
    fn dispatch(&mut self, input: Input) -> Result<bool, Error> {
        let scope = Scope {
            pane: self.pane.clone(),
            lifetime: self.lifetime.clone(),
            presentation_epoch: 1,
        };
        match self.scheduler.admit(&scope, Work::Input(input)) {
            Ok(Admission::Ready(d)) => {
                let Work::Input(input) = d.work else {
                    return Err("barrier".into());
                };
                let now = self.now();
                let seq = self
                    .controller
                    .input(&self.pane, &self.lifetime, input, now)?;
                self.scheduler.bind_input(d.ticket, &self.pane, seq)?;
                Ok(true)
            }
            Ok(Admission::Queued(_)) => Ok(true),
            Err(rejected) if rejected.reason == herdr_client::tmux_input::Error::Busy => Ok(false),
            Err(rejected) => Err(format!("{:?}", rejected.reason).into()),
        }
    }
    /// One app-loop turn: poll the controller, settle ACKs, release a waiting
    /// admission onto the wire.
    fn turn(&mut self) -> Result<(), Error> {
        let now = self.now();
        let update = self.controller.poll(now)?;
        for completion in &update.inputs {
            let next = self.scheduler.complete_input(completion);
            if let Some(d) = next.next {
                let Work::Input(input) = d.work else {
                    return Err("barrier".into());
                };
                let seq = self
                    .controller
                    .input(&self.pane, &self.lifetime, input, now)?;
                self.scheduler.bind_input(d.ticket, &self.pane, seq)?;
            }
        }
        Ok(())
    }
    /// Type `keys` with `gap` between key presses (0 = all at once). Returns
    /// each key's press-to-echo latency in ms, the echo read from the
    /// controller's committed grid (what the renderer paints).
    /// Type `lines` × ("ab", Enter) and then `marker`, one key every `gap`;
    /// ms from the first key until the marker is on screen (all applied).
    fn lines(&mut self, marker: &str, lines: usize, gap: Duration) -> Result<(f64, f64), Error> {
        let mut keys: Vec<Input> = Vec::new();
        for _ in 0..lines {
            keys.push(Input::Text("a".into()));
            keys.push(Input::Text("b".into()));
            keys.push(Input::Key("Enter".into()));
        }
        keys.extend(marker.chars().map(|c| Input::Text(c.to_string())));
        // cat writes the marker's line in one write after this Enter: the tty
        // echo of fast typing interleaves with cat's own output, its line does not.
        keys.push(Input::Key("Enter".into()));
        let begin = Instant::now();
        let deadline = begin + Duration::from_secs(30);
        let mut queue: VecDeque<Input> = VecDeque::new();
        let mut next_press = begin;
        let mut typed = 0;
        let mut acked: Option<f64> = None;
        loop {
            if Instant::now() > deadline {
                return Err(format!(
                    "lines deadline: typed {typed}/{} queued {} pending {} retired {} text {:?}",
                    keys.len(),
                    queue.len(),
                    self.scheduler.pending(),
                    self.scheduler.retired(),
                    self.text().trim_end()
                )
                .into());
            }
            while typed < keys.len() && Instant::now() >= next_press {
                queue.push_back(keys[typed].clone());
                typed += 1;
                next_press += gap;
            }
            // Like the app's transport worker: one admission per turn, and a
            // 5 ms sleep on a turn that admitted nothing.
            let mut admitted = false;
            if let Some(input) = queue.front().cloned()
                && self.dispatch(input)?
            {
                queue.pop_front();
                admitted = true;
            }
            self.turn()?;
            let ms = (begin.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
            if acked.is_none() && typed == keys.len() && queue.is_empty() && self.scheduler.idle() {
                acked = Some(ms);
            }
            if let Some(acked) = acked
                && self.text().contains(marker)
            {
                return Ok((acked, ms));
            }
            if !admitted {
                std::thread::sleep(self.poll);
            }
        }
    }
    fn run(&mut self, marker: &str, keys: &str, gap: Duration) -> Result<Vec<f64>, Error> {
        let mut pressed: Vec<Instant> = Vec::new();
        let mut echoed: Vec<Option<Instant>> = vec![None; keys.chars().count()];
        let chars: Vec<char> = keys.chars().collect();
        let mut queue: VecDeque<char> = VecDeque::new();
        let begin = Instant::now();
        let mut next_press = begin;
        let deadline = begin + Duration::from_secs(30);
        let mut typed = 0;
        while echoed.iter().any(Option::is_none) {
            if Instant::now() > deadline {
                let echoed_n = echoed.iter().filter(|e| e.is_some()).count();
                return Err(format!(
                    "echo deadline: typed {typed} queued {} echoed {echoed_n} pending {} text {:?}",
                    queue.len(),
                    self.scheduler.pending(),
                    self.text().trim_end()
                )
                .into());
            }
            while typed < chars.len() && Instant::now() >= next_press {
                pressed.push(Instant::now());
                queue.push_back(chars[typed]);
                typed += 1;
                next_press += gap;
            }
            // Like the app worker: at most one admission per loop turn.
            if let Some(&c) = queue.front()
                && self.dispatch(Input::Text(c.to_string()))?
            {
                queue.pop_front();
            }
            self.turn()?;
            let text = self.text();
            for (i, slot) in echoed.iter_mut().enumerate() {
                if slot.is_none() && i < pressed.len() {
                    let want: String = std::iter::once(marker.to_owned())
                        .chain(chars[..=i].iter().map(|c| c.to_string()))
                        .collect();
                    if text.contains(&want) {
                        *slot = Some(Instant::now());
                    }
                }
            }
            if queue.is_empty() {
                std::thread::sleep(self.poll);
            }
        }
        Ok(pressed
            .iter()
            .zip(echoed)
            .map(|(p, e)| {
                let e = e.unwrap_or_else(Instant::now);
                (e.duration_since(*p).as_secs_f64() * 1000.0 * 100.0).round() / 100.0
            })
            .collect())
    }
    /// Types `marker` and waits for it, so each key of the run echoes uniquely;
    /// then types `keys` with `gap` between presses, and settles an Enter.
    fn echo_run(&mut self, marker: &str, keys: &str, gap: Duration) -> Result<Vec<f64>, Error> {
        for c in marker.chars() {
            while !self.dispatch(Input::Text(c.to_string()))? {
                self.turn()?;
            }
        }
        let settle = Instant::now();
        while !self.text().contains(marker) {
            if settle.elapsed() > Duration::from_secs(10) {
                return Err("marker never echoed".into());
            }
            self.turn()?;
            std::thread::sleep(self.poll);
        }
        let latencies = self.run(marker, keys, gap)?;
        // Enter is a barrier key: settle it before the next run.
        while !self.dispatch(Input::Key("Enter".into()))? {
            self.turn()?;
        }
        self.settle()?;
        Ok(latencies)
    }
    fn settle(&mut self) -> Result<(), Error> {
        let settle = Instant::now();
        while !self.scheduler.idle() {
            if settle.elapsed() > Duration::from_secs(10) {
                return Err("input never settled".into());
            }
            self.turn()?;
            std::thread::sleep(self.poll);
        }
        Ok(())
    }
}

fn nonce() -> String {
    uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .bytes()
        .take(6)
        .map(|b| char::from(b'G' + b % 16))
        .collect()
}

/// The remote-latency CI set (see the module docs).
fn scenarios(probe: &mut Probe, names: &str) -> Result<serde_json::Value, Error> {
    let nonce = nonce();
    let mut results = serde_json::Map::new();
    for name in names.split(',').map(str::trim).filter(|n| !n.is_empty()) {
        let value = match name {
            "echo" => {
                let marker = format!("Q{nonce}");
                let latencies =
                    probe.echo_run(&marker, "abcdefghijklmnopqrst", Duration::from_millis(150))?;
                stats(&latencies)
            }
            "burst30" => {
                let marker = format!("X{nonce}");
                let latencies = probe.echo_run(
                    &marker,
                    "abcdefghijklmnopqrstuvwxyz0123",
                    Duration::from_millis(60),
                )?;
                let mut value = stats(&latencies);
                value["last"] = serde_json::json!(latencies.last().copied().unwrap_or(0.0));
                value
            }
            "lines" => {
                let gap = Duration::from_millis(60);
                let mut lags = Vec::new();
                for round in 0..3 {
                    let marker = format!("L{round}{nonce}");
                    // 10 × (a, b, Enter), the marker, and its Enter.
                    let presses = 10 * 3 + marker.chars().count() + 1;
                    let (_, shown) = probe.lines(&marker, 10, gap)?;
                    let last_press = (presses - 1) as f64 * gap.as_secs_f64() * 1000.0;
                    lags.push(((shown - last_press) * 100.0).round() / 100.0);
                    probe.settle()?;
                }
                let mut value = stats(&lags);
                value["lag"] = value["p50"].clone();
                value
            }
            other => return Err(format!("unknown scenario {other}").into()),
        };
        results.insert(name.into(), value);
    }
    Ok(serde_json::Value::Object(results))
}

fn stats(values: &[f64]) -> serde_json::Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = |q: f64| sorted[((sorted.len() as f64 - 1.0) * q).round() as usize];
    serde_json::json!({"n":sorted.len(),"p50":at(0.5),"p90":at(0.9),"max":at(1.0),"all":values})
}

fn run() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().collect();
    let record = args.get(1).ok_or("record path required")?;
    let port: Option<u16> = args
        .get(2)
        .map(|p| p.parse())
        .transpose()?
        .filter(|p| *p != 0);
    let poll = Duration::from_millis(args.get(3).map(|p| p.parse()).transpose()?.unwrap_or(5));
    let daemon = Arc::new(LocalDaemon::discover(Path::new(record))?);
    let scope = daemon
        .list_servers()?
        .into_iter()
        .find_map(|s| match s {
            ServerRegistration::Online { scope, .. } => Some(scope),
            ServerRegistration::Offline { .. } => None,
        })
        .ok_or("no online server")?;
    let client = daemon.select_server(&scope)?;
    let session = client.sessions()?.into_iter().next().ok_or("no session")?;
    let workspace = client.open_session(&session.live_session_id)?;
    let panes = client.workspace_panes(&session.live_session_id, &workspace)?;
    // Type into the pane that is not a busy neighbour (fixture "spinner" panes).
    let mut chosen = None;
    for selected in &panes {
        let mut handoff = client.issue_terminal(&TerminalSelection {
            workspace_name: workspace.clone(),
            live_session_id: session.live_session_id.clone(),
            selected_pane: selected.clone(),
            visible_panes: panes.clone(),
            mode: ViewerMode::Interactive,
        })?;
        if let Some(port) = port {
            let mut url = url::Url::parse(&handoff.descriptor.web_socket_url)?;
            url.set_port(Some(port)).map_err(|()| "port")?;
            handoff.descriptor.web_socket_url = url.to_string();
        }
        let mut controller = Controller::spawn(handoff)?;
        let start = Instant::now();
        controller.presence(true, 1, 0)?;
        let lifetime = loop {
            if start.elapsed() > Duration::from_secs(15) {
                return Err("input never became ready".into());
            }
            let now = u64::try_from(start.elapsed().as_millis())?;
            let update = controller.poll(now)?;
            let coherent = update.window.as_ref().is_some_and(|w| w.coherent);
            if controller.owns(Authority::Input)
                && coherent
                && controller.input_ready()
                && let Some(p) = controller.committed(selected)
                && p.snapshot.is_some()
            {
                break Lifetime {
                    generation: p.identity.generation.clone(),
                    incarnation: p.identity.incarnation.clone(),
                };
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let probe = Probe {
            controller,
            scheduler: Scheduler::new(Scope {
                pane: selected.clone(),
                lifetime: lifetime.clone(),
                presentation_epoch: 1,
            }),
            pane: selected.clone(),
            lifetime,
            start,
            poll,
        };
        if !probe.text().contains("spinner") {
            chosen = Some(probe);
            break;
        }
    }
    let mut probe = chosen.ok_or("no quiet pane")?;
    eprintln!("panes {} selected {}", panes.len(), probe.pane);
    if let Ok(go) = std::env::var("GO_FILE") {
        std::fs::write(go, b"go")?;
        // Let the neighbours reach steady state (and their history limit).
        let settle = Instant::now();
        while settle.elapsed() < Duration::from_secs(3) {
            probe.turn()?;
            std::thread::sleep(probe.poll);
        }
    }
    if let Ok(names) = std::env::var("PROBE_SCENARIOS") {
        println!("{}", scenarios(&mut probe, &names)?);
        return Ok(());
    }
    let mut results = serde_json::Map::new();
    if std::env::var("SCENARIO").as_deref() == Ok("enter") {
        let nonce: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .bytes()
            .take(6)
            .map(|b| char::from(b'G' + b % 16))
            .collect();
        for (name, gap_ms, tag) in [("lines10_burst", 0u64, "E"), ("lines10_typed60", 60, "F")] {
            let mut runs = Vec::new();
            let mut acks = Vec::new();
            for round in 0..3 {
                let marker = format!("{tag}{round}{nonce}");
                let (acked, shown) = probe.lines(&marker, 10, Duration::from_millis(gap_ms))?;
                acks.push(acked);
                runs.push(shown);
                let settle = Instant::now();
                while !probe.scheduler.idle() && settle.elapsed() < Duration::from_secs(10) {
                    probe.turn()?;
                    std::thread::sleep(probe.poll);
                }
            }
            results.insert(name.into(), stats(&runs));
            results.insert(format!("{name}_all_acked"), stats(&acks));
        }
        println!("{}", serde_json::Value::Object(results));
        return Ok(());
    }
    let nonce: String = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .bytes()
        .take(6)
        .map(|b| char::from(b'G' + b % 16))
        .collect();
    for (name, gap_ms, tag) in [
        ("single_150ms", 150u64, "Q"),
        ("typing_60ms", 60, "W"),
        ("burst", 0, "X"),
    ] {
        let marker = &format!("{tag}{nonce}");
        // The marker is typed and settled first so each key's echo is unique.
        let keys = "abcdefghijklmnopqrst";
        for c in marker.chars() {
            while !probe.dispatch(Input::Text(c.to_string()))? {
                probe.turn()?;
            }
        }
        let settle = Instant::now();
        while !probe.text().contains(marker) {
            if settle.elapsed() > Duration::from_secs(10) {
                return Err("marker never echoed".into());
            }
            probe.turn()?;
            std::thread::sleep(probe.poll);
        }
        let latencies = probe.run(marker, keys, Duration::from_millis(gap_ms))?;
        results.insert(name.into(), stats(&latencies));
        // Enter is a barrier key: settle it before the next run.
        let scope = Scope {
            pane: probe.pane.clone(),
            lifetime: probe.lifetime.clone(),
            presentation_epoch: 1,
        };
        match probe
            .scheduler
            .admit(&scope, Work::Input(Input::Key("Enter".into())))
        {
            Ok(Admission::Ready(d)) => {
                let Work::Input(input) = d.work else {
                    unreachable!()
                };
                let now = probe.now();
                let seq = probe
                    .controller
                    .input(&probe.pane, &probe.lifetime, input, now)?;
                probe.scheduler.bind_input(d.ticket, &probe.pane, seq)?;
            }
            Ok(Admission::Queued(_)) => {}
            Err(e) => return Err(format!("{:?}", e.reason).into()),
        }
        let settle = Instant::now();
        while !probe.scheduler.idle() {
            if settle.elapsed() > Duration::from_secs(10) {
                return Err("enter never settled".into());
            }
            probe.turn()?;
            std::thread::sleep(probe.poll);
        }
    }
    println!("{}", serde_json::Value::Object(results));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("input latency probe failed: {error}");
        std::process::exit(1);
    }
}
