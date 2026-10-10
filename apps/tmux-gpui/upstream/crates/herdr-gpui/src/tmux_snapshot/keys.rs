//! Initial key path. IME composition and clipboard paste require separate handlers.
use gpui::Keystroke;
use serde::Serialize;
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "lowercase")]
pub(super) enum Input {
    Text(String),
    Paste(String),
    Key(String),
    Bytes(String),
    Resize { cols: u16, rows: u16 },
    Scroll(i16),
}
pub(super) fn translate(key: &Keystroke) -> Option<Input> {
    let m = key.modifiers;
    if m.platform {
        return None;
    }
    let named = match key.key.as_str() {
        "f1" => Some("F1"),
        "f2" => Some("F2"),
        "f3" => Some("F3"),
        "f4" => Some("F4"),
        "f5" => Some("F5"),
        "f6" => Some("F6"),
        "f7" => Some("F7"),
        "f8" => Some("F8"),
        "f9" => Some("F9"),
        "f10" => Some("F10"),
        "f11" => Some("F11"),
        "f12" => Some("F12"),
        "enter" => Some("Enter"),
        "escape" => Some("Escape"),
        "backspace" | "back" => Some("BSpace"),
        "tab" => Some("Tab"),
        "up" => Some("Up"),
        "down" => Some("Down"),
        "left" => Some("Left"),
        "right" => Some("Right"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("PPage"),
        "pagedown" => Some("NPage"),
        "delete" => Some("DC"),
        "insert" => Some("IC"),
        "space" if m.control || m.alt => Some("Space"),
        _ => None,
    };
    let prefix = format!(
        "{}{}{}",
        if m.control { "C-" } else { "" },
        if m.alt { "M-" } else { "" },
        if m.shift { "S-" } else { "" }
    );
    if let Some(name) = named {
        return Some(Input::Key(format!("{prefix}{name}")));
    }
    let text = if key.key == "space" { " " } else { &key.key };
    let mut chars = text.chars();
    let ch = chars.next()?;
    if chars.next().is_some() || ch.is_control() {
        return None;
    }
    if m.control {
        let control = match ch {
            '@' | '`' => Some(0u8),
            '[' => Some(27),
            '\\' => Some(28),
            ']' => Some(29),
            '^' => Some(30),
            '_' => Some(31),
            '?' => Some(127),
            _ => None,
        };
        if let Some(byte) = control {
            return Some(Input::Bytes(format!(
                "{}{byte:02x}",
                if m.alt { "1b" } else { "" }
            )));
        }
    }
    if m.control || m.alt {
        return ch
            .is_ascii_alphanumeric()
            .then(|| Input::Key(format!("{prefix}{ch}")));
    }
    // Use the platform's layout-resolved character (e.g. Shift-1 or non-US keys).
    if let Some(text) = &key.key_char
        && !text.is_empty()
        && !text.chars().any(char::is_control)
    {
        return Some(Input::Text(text.clone()));
    }
    Some(Input::Text(if m.shift {
        ch.to_ascii_uppercase().to_string()
    } else {
        text.to_owned()
    }))
}
#[cfg(test)]
#[path = "keys_tests.rs"]
mod tests;

pub(super) fn clipboard_text(text: String) -> Option<Input> {
    (!text.is_empty() && text.len() <= 65536 && !text.contains(['\0', '\u{1b}']))
        .then_some(Input::Paste(text))
}
