/// `text` with control and direction-override characters removed, bounded
/// to `limit` characters.
pub(crate) fn safe_text(text: &str, limit: usize) -> String {
    // Bound scanning as well as output, even for a payload made entirely of controls.
    text.chars()
        .take(limit)
        .filter(|c| !unsafe_char(*c))
        .collect()
}

/// A control or direction-override character, which untrusted text loses.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}' | '\u{061c}' | '\u{2028}' | '\u{2029}')
}

#[cfg(test)]
mod tests {
    use super::safe_text;

    #[test]
    fn untrusted_text_loses_controls_and_overrides_within_its_bound() {
        let text = "\u{1b}\n\u{202e}\u{2066}界".repeat(1000);
        let safe = safe_text(&text, 160);
        assert!(safe.chars().count() <= 160);
        assert!(safe.chars().all(|c| c == '界'));
        assert_eq!(safe_text(&"\0".repeat(10000), 160), "");
    }
}
