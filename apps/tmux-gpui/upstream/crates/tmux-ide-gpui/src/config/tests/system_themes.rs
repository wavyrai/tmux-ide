use super::*;

#[test]
fn theme_names_parse_a_system_pair_in_either_order() -> anyhow::Result<()> {
    assert_eq!(ThemeName::parse(" Nord ")?, ThemeName::Single("Nord"));
    // A name may contain a colon or comma when it is not a pair.
    assert_eq!(
        ThemeName::parse("~/themes/a,b")?,
        ThemeName::Single("~/themes/a,b")
    );
    let pair = ThemeName::System {
        light: "Catppuccin Latte",
        dark: "Catppuccin Mocha",
    };
    for value in [
        "light:Catppuccin Latte,dark:Catppuccin Mocha",
        " dark: Catppuccin Mocha , light: Catppuccin Latte ",
    ] {
        assert_eq!(ThemeName::parse(value)?, pair);
    }
    assert_eq!(pair.get(true), "Catppuccin Latte");
    assert_eq!(pair.get(false), "Catppuccin Mocha");
    assert_eq!(ThemeName::Single("Nord").get(true), "Nord");
    for value in [
        "light:Nord",
        "dark:Nord",
        "light:Nord,light:Dracula",
        "light:,dark:Nord",
        "light:Nord,dark:",
        "light:Nord,dark:Dracula,dark:Default",
        "light:Nord,Dracula",
    ] {
        assert!(
            matches!(ThemeName::parse(value), Err(Error::InvalidThemePair)),
            "{value}"
        );
    }
    Ok(())
}

#[test]
fn a_side_is_replaced_and_a_single_theme_is_replaced_outright() {
    let pair = ThemeName::system("Catppuccin Latte", "Nord");
    assert_eq!(pair, "light:Catppuccin Latte,dark:Nord");
    assert!(ThemeName::follows_system(&pair));
    assert!(!ThemeName::follows_system("Nord"));
    assert_eq!(
        ThemeName::with_side(&pair, false, "Dracula"),
        "light:Catppuccin Latte,dark:Dracula"
    );
    assert_eq!(
        ThemeName::with_side(&pair, true, "Default"),
        "light:Default,dark:Nord"
    );
    assert_eq!(ThemeName::with_side("Nord", true, "Dracula"), "Dracula");
    assert_eq!(ThemeName::side(&pair, true), "Catppuccin Latte");
    assert_eq!(ThemeName::side("light:Nord", true), "light:Nord");
}

#[test]
fn config_resolves_the_side_for_the_appearance_with_contrast() -> anyhow::Result<()> {
    let config =
        Config::parse("theme = 'light:Catppuccin Latte,dark:Catppuccin Mocha'\ncontrast = 'high'")?;
    let expected = |name| -> anyhow::Result<Theme> {
        Ok(Theme::builtin(name)
            .context("missing builtin")?
            .with_contrast(Contrast::High))
    };
    assert_eq!(config.theme(true)?, expected("Catppuccin Latte")?);
    assert_eq!(config.theme(false)?, expected("Catppuccin Mocha")?);
    assert!(matches!(
        Config::parse("theme = 'light:Nord'"),
        Err(Error::InvalidThemePair)
    ));
    Ok(())
}

#[test]
fn saving_a_pair_validates_both_sides() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let path = temp.0.join("config.toml");
    let config = Config::default();
    let broken = temp.0.join("broken");
    fs::write(&broken, "background=invalid")?;
    let broken = broken.to_str().context("non-UTF8 temporary path")?;
    // The side the system is not showing must not fail only once it is.
    for value in [
        ThemeName::system(broken, "Nord"),
        ThemeName::system("Nord", broken),
    ] {
        assert!(config.save_theme_path(&value, &path).is_err());
        assert!(!path.exists());
    }
    let pair = ThemeName::system("Catppuccin Latte", "Nord");
    config.save_theme_path(&pair, &path)?;
    assert_eq!(Config::parse(&fs::read_to_string(&path)?)?.theme, pair);
    Ok(())
}

#[test]
fn discovery_lists_both_sides_given_as_paths() -> anyhow::Result<()> {
    let temp = TempDirectory::new()?;
    let light = temp.0.join("light").to_string_lossy().into_owned();
    let config = Config {
        theme: ThemeName::system(&light, "~/dark"),
        ..Config::default()
    };
    let names = config.available_themes_in(&[])?;
    assert!(names.contains(&light));
    assert!(names.contains(&"~/dark".to_owned()));
    assert!(!names.contains(&config.theme));
    Ok(())
}
