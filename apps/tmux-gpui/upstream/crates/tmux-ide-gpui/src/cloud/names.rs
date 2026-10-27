//! Default names for new cloud machines, so adding one needs no typing:
//! `prefix-adjective-noun`, with a short random suffix when it fits. Every
//! part is lowercase ASCII words joined by hyphens, which each provider's
//! naming rules accept.

const ADJECTIVES: [&str; 32] = [
    "amber", "bold", "brave", "bright", "calm", "clever", "cosmic", "crisp", "eager", "fancy",
    "gentle", "glad", "golden", "happy", "jolly", "keen", "lively", "lucky", "mellow", "misty",
    "nimble", "noble", "quiet", "rapid", "rosy", "silent", "sunny", "swift", "tidy", "vivid",
    "witty", "zesty",
];

const NOUNS: [&str; 32] = [
    "badger", "beacon", "breeze", "canyon", "cedar", "comet", "coral", "falcon", "fern", "fjord",
    "galaxy", "harbor", "heron", "island", "lagoon", "lark", "maple", "meadow", "nebula", "otter",
    "pebble", "pine", "quartz", "raven", "reef", "river", "sparrow", "summit", "tundra", "valley",
    "willow", "zephyr",
];

/// A fresh name of at most `limit` bytes when the prefix leaves room for the
/// words. Randomness comes from the OS, falling back to the clock, which only
/// makes a clash slightly likelier.
pub(crate) fn random(prefix: &str, limit: usize) -> String {
    let mut bytes = [0u8; 3];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or_default();
        bytes = [(nanos >> 16) as u8, (nanos >> 8) as u8, nanos as u8];
    }
    let adjective = ADJECTIVES[usize::from(bytes[0]) % ADJECTIVES.len()];
    let noun = NOUNS[usize::from(bytes[1]) % NOUNS.len()];
    let base = format!("{prefix}-{adjective}-{noun}");
    let suffixed = format!("{base}-{:02x}", bytes[2]);
    if suffixed.len() <= limit {
        suffixed
    } else {
        base
    }
}

#[cfg(test)]
mod tests;
