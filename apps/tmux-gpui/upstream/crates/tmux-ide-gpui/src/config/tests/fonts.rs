use super::*;

/// Installed families as macOS reports them, in arbitrary order.
fn installed() -> Vec<String> {
    [
        "Menlo",
        "Zapfino",
        "JetBrainsMono Nerd Font Propo",
        "Symbols Nerd Font",
        "Hack Nerd Font Mono",
        "Symbols Nerd Font Mono",
        "Agave Nerd Font Mono",
        "Hack Nerd Font Mono",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[test]
fn detection_ranks_symbol_and_mono_faces_and_ignores_text_families() {
    // Symbols first, then single-cell Mono faces, alphabetical within each
    // rank, deduplicated, and capped so the cascade stays short.
    assert_eq!(
        symbol_fallbacks(installed()),
        [
            "Symbols Nerd Font Mono",
            "Symbols Nerd Font",
            "Agave Nerd Font Mono",
        ]
    );
    assert!(symbol_fallbacks(["Menlo".to_owned(), "Zapfino".to_owned()]).is_empty());
}
