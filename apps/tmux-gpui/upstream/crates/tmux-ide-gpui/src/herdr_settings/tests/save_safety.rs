use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;

#[test]
#[cfg(unix)]
fn saves_reject_changed_deleted_created_or_replaced_originals() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let settings = Settings::load_path(path.clone())?;
    fs::write(&path, "# concurrently created\n")?;
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("clobbered creation"))?;
    assert!(matches!(source(&error), Some(Error::Conflict)));
    let settings = Settings::load_path(path.clone())?;
    fs::write(&path, "# unrelated edit\n")?;
    assert!(matches!(
        source(
            &settings
                .save(Edit::Sound(false))
                .err()
                .ok_or_else(|| anyhow::anyhow!("clobbered edit"))?
        ),
        Some(Error::Conflict)
    ));
    assert_eq!(fs::read_to_string(&path)?, "# unrelated edit\n");
    let settings = Settings::load_path(path.clone())?;
    fs::remove_file(&path)?;
    assert!(settings.save(Edit::Sound(false)).is_err());
    let settings = Settings::load_path(path.clone())?.save(Edit::Sound(false))?;
    let stale = settings.clone();
    settings.save(Edit::Sound(true))?;
    assert!(
        stale
            .save(Edit::Indicators(IndicatorStyle::Symbols))
            .is_err()
    );
    let settings = Settings::load_path(path.clone())?;
    let replacement = temp.path().join("replacement");
    fs::write(&replacement, fs::read_to_string(&path)?)?;
    fs::rename(replacement, &path)?;
    assert!(settings.save(Edit::Sound(false)).is_err());
    Ok(())
}

#[test]
#[cfg(unix)]
fn symlinks_hardlinks_permissions_and_size_are_protected() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let target = temp.path().join("target");
    fs::write(&target, "# untouched\n")?;
    symlink(&target, &path)?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    fs::remove_file(&path)?;
    let settings = Settings::load_path(path.clone())?;
    symlink(&target, &path)?;
    assert!(settings.save(Edit::Sound(false)).is_err());
    assert_eq!(fs::read_to_string(&target)?, "# untouched\n");
    fs::remove_file(&path)?;
    fs::hard_link(&target, &path)?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    fs::remove_file(&path)?;
    fs::write(&path, "")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666))?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    fs::write(&path, " ".repeat(1024 * 1024 + 1))?;
    assert!(matches!(persistence::read(&path), Err(Error::TooLarge)));
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o777))?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[test]
fn invalid_theme_edits_do_not_create_config_or_parent() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("missing/config.toml");
    let settings = Settings::load_path(path.clone())?;
    let error = settings
        .save(Edit::Theme("not-a-theme".into()))
        .err()
        .ok_or_else(|| anyhow::anyhow!("saved unknown theme"))?;
    assert!(matches!(source(&error), Some(Error::Theme(_))));
    assert!(!path.parent().is_some_and(Path::exists));
    #[cfg(unix)]
    {
        let settings = settings.save(Edit::Sound(false))?;
        assert!(!settings.sound_enabled);
        assert_eq!(fs::metadata(path)?.permissions().mode() & 0o777, 0o600);
    }
    Ok(())
}

#[test]
#[cfg(unix)]
fn advisory_lock_is_nonblocking_and_released_after_saves() -> anyhow::Result<()> {
    use rustix::fs::{FlockOperation, flock};
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let settings = Settings::load_path(path)?.save(Edit::Sound(false))?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp.path().join(".config.toml.gpui-lock"))?;
    flock(&lock, FlockOperation::NonBlockingLockExclusive)?;
    let error = settings
        .save(Edit::Sound(true))
        .err()
        .ok_or_else(|| anyhow::anyhow!("ignored held lock"))?;
    assert!(matches!(source(&error), Some(Error::Busy)));
    flock(&lock, FlockOperation::Unlock)?;
    drop(lock);
    let settings = settings.save(Edit::Sound(true))?;
    assert!(settings.sound_enabled);
    assert!(!settings.save(Edit::Sound(false))?.sound_enabled);
    Ok(())
}

#[test]
#[cfg(unix)]
fn parent_replacement_and_permission_changes_are_conflicts() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let parent = temp.path().join("config");
    fs::create_dir(&parent)?;
    let path = parent.join("config.toml");
    let settings = Settings::load_path(path.clone())?.save(Edit::Sound(true))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640))?;
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("ignored mode change"))?;
    assert!(matches!(source(&error), Some(Error::Conflict)));
    let settings = Settings::load_path(path.clone())?;
    let moved = temp.path().join("moved");
    fs::rename(&parent, &moved)?;
    fs::create_dir(&parent)?;
    fs::write(&path, "[ui.sound]\nenabled = true\n")?;
    assert!(settings.save(Edit::Sound(false)).is_err());
    fs::remove_dir_all(&parent)?;
    symlink(&moved, &parent)?;
    assert!(settings.save(Edit::Sound(false)).is_err());
    assert!(Settings::load_path(path).is_err());
    assert!(Settings::load_path(moved.join("config.toml"))?.sound_enabled);
    Ok(())
}

#[test]
#[cfg(unix)]
fn symlink_ancestors_cannot_redirect_directory_creation() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let target = temp.path().join("target");
    fs::create_dir(&target)?;
    let alias = temp.path().join("alias");
    let path = alias.join("new/config.toml");
    let settings = Settings::load_path(path.clone())?;
    symlink(&target, &alias)?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("followed symlink ancestor"))?;
    assert!(matches!(source(&error), Some(Error::UnsafePath)));
    assert!(!target.join("new").exists());
    Ok(())
}

#[test]
#[cfg(unix)]
fn in_place_file_revision_changes_are_not_overwritten() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    fs::write(&path, "# unchanged contents\n")?;
    let settings = Settings::load_path(path.clone())?;
    // Explicit timestamps avoid relying on filesystem clock resolution or sleeps.
    fs::File::options().write(true).open(&path)?.set_times(
        fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(123)),
    )?;
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("ignored changed revision"))?;
    assert!(matches!(source(&error), Some(Error::Conflict)));
    assert_eq!(fs::read_to_string(&path)?, "# unchanged contents\n");
    Ok(())
}

#[test]
#[cfg(unix)]
fn lock_symlinks_and_nonregular_configs_are_rejected() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("config.toml");
    let settings = Settings::load_path(path.clone())?;
    let target = temp.path().join("target");
    fs::write(&target, "unchanged")?;
    symlink(&target, temp.path().join(".config.toml.gpui-lock"))?;
    let error = settings
        .save(Edit::Sound(false))
        .err()
        .ok_or_else(|| anyhow::anyhow!("followed lock symlink"))?;
    assert!(matches!(source(&error), Some(Error::UnsafePath)));
    assert_eq!(fs::read_to_string(&target)?, "unchanged");
    assert!(!path.exists());
    fs::create_dir(&path)?;
    assert!(matches!(persistence::read(&path), Err(Error::UnsafePath)));
    Ok(())
}
