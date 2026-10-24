//! Typed native pointer routing. Scope contains presentation identity, never content revision.
use crate::{
    tmux_control::Input,
    tmux_delivery::{MouseEncoding, MouseProtocol},
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub generation: String,
    pub incarnation: String,
    pub presentation_epoch: u64,
    pub cols: usize,
    pub rows: usize,
    pub protocol: Option<MouseProtocol>,
    pub encoding: Option<MouseEncoding>,
    pub alternate_screen: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Down,
    Drag,
    Move,
    Up,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub alt: bool,
    pub control: bool,
}
#[derive(Clone, Debug)]
pub struct Report {
    pub action: Action,
    pub gesture: u64,
    pub row: usize,
    pub col: usize,
    pub button: Option<u8>,
    pub modifiers: Modifiers,
    /// Geometry and canonical modes at hit testing time.
    pub cols: usize,
    pub rows: usize,
    pub protocol: MouseProtocol,
    pub encoding: MouseEncoding,
}
#[derive(Clone, Debug)]
pub enum PointerEvent {
    Cancel { gesture: u64 },
    Report(Report),
}
#[derive(Debug)]
pub enum PointerDecision {
    Input(Input),
    Ignore,
    UnsupportedEncoding,
}
#[derive(Clone, Copy, Debug)]
pub struct WheelEvent {
    pub lines: i16,
    pub row: usize,
    pub col: usize,
    pub modifiers: Modifiers,
}
#[derive(Debug)]
pub enum WheelDecision {
    History { lines: i16 },
    Application { inputs: Vec<Input> },
    Ignore,
    UnsupportedEncoding,
}
struct Held {
    gesture: u64,
    button: u8,
    scope: Scope,
}
#[derive(Default)]
pub struct MouseOwner {
    held: Option<Held>,
    high_water: u64,
}
fn valid_scope(scope: &Scope) -> bool {
    !scope.generation.is_empty()
        && scope.generation.len() <= 128
        && !scope.incarnation.is_empty()
        && scope.incarnation.len() <= 512
        && (1..=16384).contains(&scope.cols)
        && (1..=16384).contains(&scope.rows)
}
fn supported(scope: &Scope, action: Action) -> bool {
    if !matches!(
        scope.encoding,
        Some(MouseEncoding::Default | MouseEncoding::Utf8 | MouseEncoding::Sgr)
    ) {
        return false;
    }
    match scope.protocol {
        None | Some(MouseProtocol::None) => false,
        Some(MouseProtocol::X10) => action == Action::Down,
        Some(MouseProtocol::Vt200) => matches!(action, Action::Down | Action::Up),
        Some(MouseProtocol::Drag) => action != Action::Move,
        Some(MouseProtocol::Any) => true,
    }
}
fn encode(
    encoding: &MouseEncoding,
    code: u8,
    row: usize,
    col: usize,
    release: bool,
    modifiers: Modifiers,
) -> Option<Input> {
    let modifiers = if modifiers.alt { 8 } else { 0 } + if modifiers.control { 16 } else { 0 };
    if *encoding == MouseEncoding::Sgr {
        return Some(Input::Text(format!(
            "\x1b[<{};{};{}{}",
            code + modifiers,
            col + 1,
            row + 1,
            if release { 'm' } else { 'M' }
        )));
    }
    let values = [
        usize::from(if release { 3 } else { code }) + usize::from(modifiers) + 32,
        col + 33,
        row + 33,
    ];
    let mut bytes = vec![0x1b, b'[', b'M'];
    match encoding {
        MouseEncoding::Default => bytes.extend(values.map(|value| value.min(255) as u8)),
        MouseEncoding::Utf8 => {
            if values.iter().any(|value| *value > 2047) {
                return None;
            }
            for value in values {
                let character = char::from_u32(value as u32)?;
                let mut buffer = [0; 4];
                bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
            }
        }
        _ => return None,
    }
    Some(Input::Bytes(
        bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
    ))
}
impl MouseOwner {
    /// Focus loss clears held gestures without allowing previously consumed IDs to replay.
    pub fn retire(&mut self) {
        self.held = None;
    }
    pub fn observe(&mut self, scope: Option<&Scope>) {
        if scope.is_none()
            || self
                .held
                .as_ref()
                .is_some_and(|held| scope != Some(&held.scope))
        {
            self.retire();
        }
    }
    pub fn route(&mut self, scope: &Scope, event: PointerEvent) -> PointerDecision {
        self.observe(Some(scope));
        let gesture = match &event {
            PointerEvent::Cancel { gesture } => *gesture,
            PointerEvent::Report(report) => report.gesture,
        };
        if !(1..=9_007_199_254_740_991).contains(&gesture) || !valid_scope(scope) {
            self.retire();
            return PointerDecision::Ignore;
        }
        let report = match event {
            PointerEvent::Cancel { gesture } => {
                self.high_water = self.high_water.max(gesture);
                if self
                    .held
                    .as_ref()
                    .is_some_and(|held| held.gesture <= gesture)
                {
                    self.retire();
                }
                return PointerDecision::Ignore;
            }
            PointerEvent::Report(report) => report,
        };
        if report.modifiers.shift
            || report.row >= scope.rows
            || report.col >= scope.cols
            || report.cols != scope.cols
            || report.rows != scope.rows
            || Some(&report.protocol) != scope.protocol.as_ref()
            || Some(&report.encoding) != scope.encoding.as_ref()
            || report.button.is_some_and(|button| button > 2)
        {
            self.retire();
            return PointerDecision::Ignore;
        }
        match report.action {
            Action::Move => {
                if report.gesture <= self.high_water
                    || report.button.is_some()
                    || self.held.is_some()
                    || !supported(scope, Action::Move)
                {
                    return PointerDecision::Ignore;
                }
            }
            Action::Down => {
                if report.button.is_none() || report.gesture <= self.high_water {
                    return PointerDecision::Ignore;
                }
                self.high_water = report.gesture;
                self.retire();
                if !supported(scope, Action::Down) {
                    return PointerDecision::Ignore;
                }
            }
            Action::Drag | Action::Up => {
                if !self.held.as_ref().is_some_and(|held| {
                    held.gesture == report.gesture && Some(held.button) == report.button
                }) {
                    return PointerDecision::Ignore;
                }
                if report.action == Action::Up {
                    self.retire();
                }
                if !supported(scope, report.action) {
                    return PointerDecision::Ignore;
                }
            }
        }
        let button = report.button.unwrap_or(0);
        let code = match report.action {
            Action::Move => 35,
            Action::Drag => 32 + button,
            _ => button,
        };
        let Some(input) = encode(
            &report.encoding,
            code,
            report.row,
            report.col,
            report.action == Action::Up,
            report.modifiers,
        ) else {
            return PointerDecision::Ignore;
        };
        if report.action == Action::Move {
            self.high_water = report.gesture;
        }
        if report.action == Action::Down
            && let Some(button) = report.button
        {
            self.held = Some(Held {
                gesture: report.gesture,
                button,
                scope: scope.clone(),
            });
        }
        PointerDecision::Input(input)
    }
}
pub fn route_wheel(scope: &Scope, history_offset: usize, wheel: WheelEvent) -> WheelDecision {
    if !valid_scope(scope)
        || wheel.lines == 0
        || !(-128..=128).contains(&wheel.lines)
        || wheel.row >= scope.rows
        || wheel.col >= scope.cols
    {
        return WheelDecision::Ignore;
    }
    if history_offset > 0 || wheel.modifiers.shift || !supported(scope, Action::Up) {
        return WheelDecision::History { lines: wheel.lines };
    }
    // Bridge deliberately ignores Alt for wheel reports. Ctrl is preserved.
    let Some(encoding) = scope.encoding.as_ref() else {
        return WheelDecision::Ignore;
    };
    let Some(input) = encode(
        encoding,
        if wheel.lines > 0 { 64 } else { 65 },
        wheel.row,
        wheel.col,
        false,
        Modifiers {
            shift: false,
            alt: false,
            control: wheel.modifiers.control,
        },
    ) else {
        return WheelDecision::Ignore;
    };
    let (report, bytes) = match input {
        Input::Text(report) => (report, false),
        Input::Bytes(report) => (report, true),
        _ => return WheelDecision::Ignore,
    };
    // Keep complete reports inside the 1024-byte/character input bound.
    let per_input = if bytes { 2048 } else { 1024 } / report.len();
    let mut remaining = usize::from(wheel.lines.unsigned_abs());
    let mut inputs = Vec::new();
    while remaining > 0 {
        let count = remaining.min(per_input);
        inputs.push(if bytes {
            Input::Bytes(report.repeat(count))
        } else {
            Input::Text(report.repeat(count))
        });
        remaining -= count;
    }
    WheelDecision::Application { inputs }
}
#[cfg(test)]
mod tests;
