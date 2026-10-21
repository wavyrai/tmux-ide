//! Negotiated pipe transport; publications retain one atomic authority validation path.
use super::*;
use decode::binary::{Kind, Parser, cells};

pub(super) enum SnapshotPayload {
    Json(Box<serde_json::value::RawValue>),
    Binary(cells::CellFrame),
}
impl<'de> Deserialize<'de> for SnapshotPayload {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Box::<serde_json::value::RawValue>::deserialize(deserializer).map(Self::Json)
    }
}
impl SnapshotPayload {
    pub(super) fn json(&self) -> Result<&[u8], Error> {
        match self {
            Self::Json(raw) => Ok(raw.get().as_bytes()),
            Self::Binary(_) => Err(Error::Invalid("binary snapshot not negotiated")),
        }
    }
    pub(super) fn prepare(
        &self,
        store: &decode::delta::Store,
    ) -> Result<decode::delta::Outcome, Error> {
        match self {
            Self::Json(raw) => store.prepare(raw.get().as_bytes()),
            Self::Binary(cells) => store.prepare_binary(cells),
        }
    }
}
impl Reader {
    pub(super) fn accept_binary(
        &mut self,
        outer: &[u8],
        cells: cells::CellFrame,
    ) -> Result<State, Error> {
        let value: serde_json::Value = serde_json::from_slice(outer)?;
        if value
            .as_object()
            .is_none_or(|object| object.contains_key("snapshot"))
        {
            return Err(Error::Invalid("binary outer metadata contains snapshot"));
        }
        let mut p: Publication = serde_json::from_value(value)?;
        p.snapshot = Some(SnapshotPayload::Binary(cells));
        self.accept_publication(p)
    }
    fn accept_control(&mut self, bytes: &[u8]) -> Result<State, Error> {
        let p: Publication = serde_json::from_slice(bytes)?;
        if p.snapshot.is_some() {
            return Err(Error::Invalid("binary JSON frame contains live snapshot"));
        }
        self.accept_publication(p)
    }
}
fn metadata(payload: &[u8], limit: usize) -> Result<(&[u8], &[u8]), Error> {
    let head = payload
        .get(..4)
        .ok_or(Error::Invalid("truncated binary metadata prefix"))?;
    let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
    if len > limit {
        return Err(Error::Invalid("binary metadata exceeds limit"));
    }
    let end = 4usize
        .checked_add(len)
        .ok_or(Error::Invalid("binary metadata length overflow"))?;
    Ok((
        payload
            .get(4..end)
            .ok_or(Error::Invalid("truncated binary metadata"))?,
        payload
            .get(end..)
            .ok_or(Error::Invalid("truncated binary body"))?,
    ))
}
fn publish(
    reader: &mut Reader,
    state: State,
    incoming: &Mailbox,
    commands: &mpsc::SyncSender<Command>,
) -> Result<(), Error> {
    if let Some(command) = reader.resync.take() {
        // Revoke authority before a backpressured command enqueue can wait.
        if let Ok(mut slot) = incoming.lock() {
            *slot = Some(Some(state.clone()));
        }
        commands
            .send(command)
            .map_err(|_| Error::Invalid("resync writer closed"))?;
    }
    if let Ok(mut slot) = incoming.lock() {
        *slot = Some(Some(state));
    }
    Ok(())
}
fn binary_loop(
    input: &mut impl Read,
    reader: &mut Reader,
    kitty: &super::super::kitty_graphics::Store,
    incoming: &Mailbox,
    commands: &mpsc::SyncSender<Command>,
) -> Result<(), Error> {
    let mut parser = Parser::default();
    let mut buffer = [0u8; 65536];
    loop {
        let len = input.read(&mut buffer)?;
        if len == 0 {
            return parser.finish();
        }
        parser.push(&buffer[..len], |kind, payload| {
            let state = match kind {
                Kind::Json => reader.accept_control(payload)?,
                Kind::Cells => {
                    let (outer, body) = metadata(payload, 8 * 1024 * 1024)?;
                    reader.accept_binary(outer, cells::decode(body)?)?
                }
                Kind::Image => {
                    if let Err(error) = metadata(payload, 4096)
                        .and_then(|(meta, raw)| kitty.accept_binary(meta, raw))
                    {
                        eprintln!(
                            "tmux-preview: binary kitty image rejected: {}",
                            rejection_reason(&error)
                        );
                    }
                    return Ok(true);
                }
            };
            publish(reader, state, incoming, commands)?;
            Ok(true)
        })?;
    }
}
fn line_loop(
    input: &mut impl BufRead,
    reader: &mut Reader,
    kitty: &super::super::kitty_graphics::Store,
    incoming: &Mailbox,
    commands: &mpsc::SyncSender<Command>,
) -> Result<(), Error> {
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            return Ok(());
        }
        if count > 8 * 1024 * 1024 || line.last() != Some(&b'\n') {
            return Err(Error::Invalid("oversized or incomplete publication"));
        }
        if super::super::kitty_graphics::is_chunk_line(&line) {
            if let Err(error) = kitty.accept_line(&line) {
                eprintln!(
                    "tmux-preview: kitty image chunk rejected: {}",
                    rejection_reason(&error)
                );
            }
            continue;
        }
        let state = reader.accept(&line)?;
        publish(reader, state, incoming, commands)?;
    }
}
pub(in crate::tmux_snapshot) fn start(kitty: super::super::kitty_graphics::Store) -> Bridge {
    let mailbox = Arc::new(Mutex::new(None));
    let incoming = mailbox.clone();
    let (commands, receiver) = mpsc::sync_channel::<Command>(32);
    let recovery_commands = commands.clone();
    std::thread::spawn(move || {
        let encoding = std::env::var("TMUX_IDE_GUI_NATIVE_ENCODING").unwrap_or_default();
        let mut reader = Reader {
            delta: matches!(encoding.as_str(), "rle-delta-v1" | "binary-rle-v1"),
            ..Reader::default()
        };
        let mut input = BufReader::new(std::io::stdin().lock());
        let result = if encoding == "binary-rle-v1" {
            binary_loop(
                &mut input,
                &mut reader,
                &kitty,
                &incoming,
                &recovery_commands,
            )
        } else {
            line_loop(
                &mut input,
                &mut reader,
                &kitty,
                &incoming,
                &recovery_commands,
            )
        };
        if let Err(error) = result {
            eprintln!(
                "tmux-preview: browser stream rejected: {}",
                rejection_reason(&error)
            );
        }
        if let Ok(mut slot) = incoming.lock() {
            *slot = Some(None);
        }
    });
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        for command in receiver {
            let Ok(mut line) = serde_json::to_vec(&command) else {
                break;
            };
            line.push(b'\n');
            if output
                .write_all(&line)
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    });
    Bridge { mailbox, commands }
}

#[cfg(test)]
#[path = "browser_transport_tests.rs"]
mod tests;
