//! Content polling also handles editors that replace the file by rename. All
//! reads happen on the background executor; two equal samples debounce saves.
use std::{
    collections::hash_map::DefaultHasher,
    fs::File,
    hash::{Hash, Hasher},
    io::{self, Read},
    path::Path,
};

pub(crate) type Fingerprint = Result<u64, io::ErrorKind>;

pub(crate) fn fingerprint(path: &Path) -> Fingerprint {
    let read = || -> io::Result<u64> {
        let mut file = File::open(path)?;
        let mut hash = DefaultHasher::new();
        let mut buffer = [0; 8192];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                return Ok(hash.finish());
            }
            hash.write(&buffer[..count]);
        }
    };
    read().map_err(|error| error.kind())
}

/// One sample for files read together, such as both sides of a light/dark
/// theme: editing, creating, or removing any of them changes it.
pub(crate) fn fingerprint_all(paths: impl IntoIterator<Item = impl AsRef<Path>>) -> u64 {
    let mut hash = DefaultHasher::new();
    for path in paths {
        fingerprint(path.as_ref()).hash(&mut hash);
    }
    hash.finish()
}

/// Debounces samples of a file, or of several read together.
pub(crate) struct Watch<T = Fingerprint> {
    observed: Option<T>,
    accepted: Option<T>,
}

impl<T> Default for Watch<T> {
    fn default() -> Self {
        Self {
            observed: None,
            accepted: None,
        }
    }
}

impl<T: Copy + PartialEq> Watch<T> {
    pub(crate) fn observe(&mut self, current: T) -> bool {
        let stable = self.observed == Some(current);
        self.observed = Some(current);
        stable && self.accepted != Some(current)
    }

    /// Acknowledge the sample whose load completed, not a newer edit observed
    /// in the meantime. Cancelled loads must leave their sample pending.
    pub(crate) fn accept(&mut self, sample: T) {
        self.accepted = Some(sample);
    }
}

/// Decides when to read the configured theme again because its files
/// changed in place, as when a desktop theme switcher rewrites one. The first
/// sample of a theme value is its baseline: whatever set that value, a config
/// load or the picker, read the files then.
#[derive(Default)]
pub(crate) struct ThemeWatch {
    theme: Option<String>,
    watch: Watch<u64>,
}

impl ThemeWatch {
    /// `sampled` is the theme value whose files gave `sample`, and `current`
    /// the value configured now. `true` means reload now; [`Self::accept`]
    /// the sample once that reload has started.
    pub(crate) fn observe(&mut self, sampled: &str, sample: u64, current: &str) -> bool {
        if sampled != current {
            return false;
        }
        if self.theme.as_deref() != Some(current) {
            self.theme = Some(current.to_owned());
            self.watch = Watch {
                observed: Some(sample),
                accepted: Some(sample),
            };
            return false;
        }
        self.watch.observe(sample)
    }

    pub(crate) fn accept(&mut self, sample: u64) {
        self.watch.accept(sample);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debounces_and_retains_changes_until_accepted() {
        let mut watch: Watch = Watch::default();
        assert!(!watch.observe(Ok(1)));
        assert!(watch.observe(Ok(1)));
        watch.accept(Ok(1));
        assert!(!watch.observe(Ok(1)));
        assert!(!watch.observe(Ok(2)));
        assert!(!watch.observe(Ok(3)));
        assert!(watch.observe(Ok(3)));
        assert!(watch.observe(Ok(3)), "busy UI must not lose the change");
        watch.accept(Ok(3));
        assert!(!watch.observe(Ok(3)));
        assert!(!watch.observe(Err(io::ErrorKind::NotFound)));
        assert!(watch.observe(Err(io::ErrorKind::NotFound)));
        watch.accept(Err(io::ErrorKind::NotFound));
        assert!(!watch.observe(Err(io::ErrorKind::NotFound)));
        assert!(!watch.observe(Ok(3)));
        assert!(watch.observe(Ok(3)), "recreation must reload");
    }

    #[test]
    fn a_completed_load_does_not_acknowledge_a_newer_edit() {
        let mut watch: Watch = Watch::default();
        assert!(!watch.observe(Ok(1)));
        assert!(watch.observe(Ok(1)));
        assert!(!watch.observe(Ok(2)));
        watch.accept(Ok(1));
        assert!(watch.observe(Ok(2)));
        watch.accept(Ok(2));
        assert!(!watch.observe(Ok(2)));
    }

    #[test]
    fn detects_same_length_edits_atomic_replacement_and_recreation() -> anyhow::Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("config.toml");
        std::fs::write(&path, "[terminal]\nsize=14")?;
        let original = fingerprint(&path);
        assert!(original.is_ok());
        std::fs::write(&path, "[terminal]\nsize=18")?;
        assert_ne!(original, fingerprint(&path));
        let mut replacement = tempfile::NamedTempFile::new_in(directory.path())?;
        use std::io::Write;
        replacement.write_all(b"[terminal]\nsize=20")?;
        let before = fingerprint(&path);
        replacement.persist(&path)?;
        assert_ne!(before, fingerprint(&path));
        std::fs::remove_file(&path)?;
        assert_eq!(fingerprint(&path), Err(io::ErrorKind::NotFound));
        std::fs::write(&path, "[terminal]\nsize=14")?;
        assert_eq!(original, fingerprint(&path));
        Ok(())
    }
}
