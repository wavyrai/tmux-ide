use super::*;

#[test]
fn words_are_plain_lowercase_and_names_vary() {
    for word in ADJECTIVES.iter().chain(&NOUNS) {
        assert!(word.bytes().all(|b| b.is_ascii_lowercase()), "{word}");
    }
    let names: std::collections::HashSet<_> = (0..64).map(|_| random("herdr", 32)).collect();
    assert!(
        names.len() > 32,
        "names should rarely repeat: {}",
        names.len()
    );
    for name in &names {
        assert!(name.starts_with("herdr-") && name.len() <= 32, "{name}");
    }
    // Without room for the suffix, the name stops at the noun.
    assert_eq!(random("herdr", 5).matches('-').count(), 2);
}
