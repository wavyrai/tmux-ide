use super::*;
use theme::theme_files_in;
use watch::{ThemeWatch, fingerprint_all};

#[test]
fn theme_files_name_each_file_a_theme_reads_and_no_more() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let first = temp.0.join("first");
    let second = temp.0.join("second");
    fs::create_dir(&first)?;
    fs::create_dir(&second)?;
    fs::write(second.join("Dune"), "background=120d0a")?;
    let directories = || Ok(vec![first.clone(), second.clone()]);
    let files = |theme: &str| theme_files_in(theme, directories);

    for theme in ["Nord", "Follow Herdr", "missing", "light:Nord", "../Dune"] {
        assert!(files(theme).is_empty(), "{theme}");
    }
    assert_eq!(files("Dune"), [second.join("Dune")]);
    // A path is watched before it exists, so creating it reloads.
    let absolute = temp.0.join("later.conf");
    let absolute_name = absolute.to_string_lossy();
    assert_eq!(files(&absolute_name), vec![absolute.clone()]);
    assert_eq!(
        files(&format!("light:{absolute_name},dark:Dune")),
        [absolute.clone(), second.join("Dune")]
    );
    assert_eq!(files("light:Dune,dark:Dune"), [second.join("Dune")]);
    assert_eq!(
        files("light:Catppuccin Latte,dark:Dune"),
        [second.join("Dune")]
    );
    Ok(())
}

#[test]
fn one_fingerprint_follows_every_file_it_covers() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let light = temp.0.join("light");
    let dark = temp.0.join("dark");
    fs::write(&light, "background=ffffff")?;
    let paths = [&light, &dark];
    let missing = fingerprint_all(paths);
    assert_eq!(missing, fingerprint_all(paths), "unchanged files agree");
    fs::write(&dark, "background=000000")?;
    let created = fingerprint_all(paths);
    assert_ne!(missing, created);
    fs::write(&light, "background=eeeeee")?;
    assert_ne!(created, fingerprint_all(paths));
    fs::write(&light, "background=ffffff")?;
    assert_eq!(created, fingerprint_all(paths));
    fs::remove_file(&dark)?;
    assert_eq!(missing, fingerprint_all(paths));
    Ok(())
}

#[test]
fn a_theme_reloads_once_its_edited_file_settles() {
    let mut watch = ThemeWatch::default();
    // The first sample of a value is what loading it already read.
    assert!(!watch.observe("Dune", 1, "Dune"));
    assert!(!watch.observe("Dune", 1, "Dune"));
    assert!(!watch.observe("Dune", 2, "Dune"), "an edit must settle");
    assert!(watch.observe("Dune", 2, "Dune"));
    // A reload that could not start, say under the picker, stays due.
    assert!(watch.observe("Dune", 2, "Dune"));
    watch.accept(2);
    assert!(!watch.observe("Dune", 2, "Dune"));
}

#[test]
fn choosing_another_theme_reloads_nothing_by_itself() {
    let mut watch = ThemeWatch::default();
    assert!(!watch.observe("Dune", 1, "Dune"));
    // Files sampled for the old value, read after the value changed.
    assert!(!watch.observe("Dune", 1, "Nord"));
    assert!(!watch.observe("Dune", 3, "Nord"));
    assert!(!watch.observe("Nord", 2, "Nord"));
    assert!(!watch.observe("Nord", 2, "Nord"));
    // Coming back is a new baseline too, not an edit of the first file.
    assert!(!watch.observe("Dune", 3, "Dune"));
    assert!(!watch.observe("Dune", 3, "Dune"));
}
