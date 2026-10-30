//! Card #666 mockup: the main window rebuilt on Bezel, with static fake data
//! and no daemon. Not part of the app; it exists for the owner's review.
//!
//! ```sh
//! cargo run -p tmux-ide-gpui --features mockup --example bezel_mockup -- --appearance dark
//! ```
//!
//! Flags: `--appearance dark|light`, `--vibrancy auto|on|off`, `--no-palette`,
//! `--palette-surface glass|material`, `--capture <png>` (saves the frame straight from the renderer, then quits;
//! no screen-recording permission needed). A capture opens a borderless
//! window, since macOS clamps a titled one to a smaller screen, and paints
//! stand-ins for the traffic lights, which the renderer does not draw.

use std::{borrow::Cow, ops::Not as _};

use bezel_theme::{
    AppExt as _, Brand, Glass, Material, SurfaceStyle, TextStyle, Theme, Typeset as _, Vibrancy,
    appearance::{self, AppearanceMode},
};
use bezel_ui::{
    icons::{Icon, icon},
    popover,
    surface::Surfaced as _,
    tabs, titlebar,
    tooltip::Tooltip,
    widgets::{ButtonStyle, Buttons as _, Content as _, Status as _, status_dot},
    window,
};
use gpui::{
    App, AssetSource, Bounds, Context, FontWeight, Hsla, IntoElement, ParentElement, Render,
    SharedString, Styled, TitlebarOptions, Window, WindowBounds, WindowKind, WindowOptions, div,
    point, prelude::*, px, size,
};

const WIDTH: f32 = 1440.0;
const HEIGHT: f32 = 900.0;
const SIDEBAR_WIDTH: f32 = 248.0;

/// The floating controls' glass, named once, as Cydonia does.
const GLASS: SurfaceStyle = SurfaceStyle::Glass(Glass::Regular);

struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "icons/plus.svg" => include_bytes!("../../../assets/icons/plus.svg"),
            "icons/search.svg" => include_bytes!("../../../assets/icons/search.svg"),
            "icons/panel-left.svg" => include_bytes!("../../../assets/icons/panel-left.svg"),
            "icons/split.svg" => include_bytes!("../../../assets/icons/split.svg"),
            "icons/terminal.svg" => include_bytes!("../../../assets/icons/terminal.svg"),
            "icons/globe.svg" => include_bytes!("../../../assets/icons/globe.svg"),
            "icons/settings.svg" => include_bytes!("../../../assets/icons/settings.svg"),
            "icons/theme.svg" => include_bytes!("../../../assets/icons/theme.svg"),
            "icons/devices.svg" => include_bytes!("../../../assets/icons/devices.svg"),
            "icons/sessions.svg" => include_bytes!("../../../assets/icons/sessions.svg"),
            "icons/tmux-home.svg" => include_bytes!("../../../assets/icons/tmux-home.svg"),
            "icons/git-branch.svg" => include_bytes!("../../../assets/icons/git-branch.svg"),
            "icons/zoom.svg" => include_bytes!("../../../assets/icons/zoom.svg"),
            "icons/more.svg" => include_bytes!("../../../assets/icons/more.svg"),
            "icons/close.svg" => include_bytes!("../../../assets/icons/close.svg"),
            "icons/bell.svg" => include_bytes!("../../../assets/icons/bell.svg"),
            "icons/fan-out.svg" => include_bytes!("../../../assets/icons/fan-out.svg"),
            "icons/keyboard.svg" => include_bytes!("../../../assets/icons/keyboard.svg"),
            "icons/agent-claude.svg" => include_bytes!("../../../assets/icons/agent-claude.svg"),
            "icons/agent-codex.svg" => include_bytes!("../../../assets/icons/agent-codex.svg"),
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

fn asset(name: &'static str) -> Icon {
    Icon::asset(format!("icons/{name}.svg"))
}

struct Args {
    mode: AppearanceMode,
    vibrancy: Vibrancy,
    palette: bool,
    capture: Option<std::path::PathBuf>,
    material_palette: bool,
}

fn args() -> Args {
    let mut parsed = Args {
        mode: AppearanceMode::Dark,
        vibrancy: Vibrancy::On,
        palette: true,
        capture: None,
        material_palette: false,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--appearance" => {
                parsed.mode = match iter.next().as_deref() {
                    Some("light") => AppearanceMode::Light,
                    Some("system") => AppearanceMode::System,
                    _ => AppearanceMode::Dark,
                }
            }
            "--vibrancy" => {
                parsed.vibrancy = match iter.next().as_deref() {
                    Some("auto") => Vibrancy::Auto,
                    Some("off") => Vibrancy::Off,
                    _ => Vibrancy::On,
                }
            }
            "--no-palette" => parsed.palette = false,
            "--palette-surface" => {
                parsed.material_palette = iter.next().as_deref() == Some("material")
            }
            "--capture" => parsed.capture = iter.next().map(Into::into),
            other => eprintln!("bezel_mockup: ignoring {other}"),
        }
    }
    parsed
}

fn main() {
    let args = args();
    gpui_platform::application()
        .with_assets(Assets)
        .run(move |cx: &mut App| {
            cx.set_brand(Brand {
                vibrancy: args.vibrancy,
                glass: true,
                ..cx.brand()
            });
            if args.material_palette {
                cx.set_palette(|appearance| {
                    let mut theme = Theme::for_appearance(appearance);
                    theme.popover_surface = SurfaceStyle::Material(Material::Thick);
                    theme
                });
            }
            appearance::init(args.mode, cx);
            cx.on_window_closed(|cx, _| cx.quit()).detach();

            let capturing = args.capture.is_some();
            let theme = Theme::of(cx);
            let bounds = Bounds::centered(None, size(px(WIDTH), px(HEIGHT)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: capturing.not().then(|| TitlebarOptions {
                    title: Some("tmux-ide (Bezel mockup)".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(16.0), px(13.0))),
                }),
                kind: match capturing {
                    true => WindowKind::PopUp,
                    false => WindowKind::Normal,
                },
                window_background: theme.window_background_appearance(),
                window_background_blur: theme.window_blur.into(),
                app_id: Some("com.tmux-ide.bezel-mockup".into()),
                ..Default::default()
            };
            let palette = args.palette;
            let handle = cx
                .open_window(options, move |window, cx| {
                    appearance::observe_window(window, cx).detach();
                    cx.new(|_| Mockup {
                        palette,
                        lights: capturing,
                    })
                })
                .expect("open the mockup window");
            cx.activate(true);
            if let Some(path) = args.capture.clone() {
                capture(handle, path, cx);
            }
        });
}

/// Saves the frame as GPUI last drew it, after the palette's entrance has run.
fn capture(handle: gpui::WindowHandle<Mockup>, path: std::path::PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        // The opening frame is clamped to the screen; a borderless window
        // takes the full size once it is up.
        handle
            .update(cx, |_, window, _| {
                window.resize(size(px(WIDTH), px(HEIGHT)))
            })
            .ok();
        cx.background_executor()
            .timer(std::time::Duration::from_millis(1500))
            .await;
        // With the display asleep no frame follows the resize, so draw one.
        // The window, not the view: drawing renders the view, which must not
        // be leased to this closure.
        let image = cx.update_window(handle.into(), |_, window, cx| {
            window.bounds_changed(cx);
            window.draw(cx).clear(cx);
            window.render_to_image()
        });
        match image {
            Ok(Ok(image)) => match image.save(&path) {
                Ok(()) => println!("bezel_mockup: captured {}", path.display()),
                Err(error) => eprintln!("bezel_mockup: save failed: {error}"),
            },
            Ok(Err(error)) => eprintln!("bezel_mockup: render failed: {error:#}"),
            Err(error) => eprintln!("bezel_mockup: window closed: {error:#}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

struct Mockup {
    palette: bool,
    /// Paint stand-in traffic lights, for a capture.
    lights: bool,
}

fn traffic_lights() -> impl IntoElement {
    div()
        .absolute()
        .top(px(16.0))
        .left(px(16.0))
        .flex()
        .gap(px(8.0))
        .children(
            [0xff5f57, 0xfebc2e, 0x28c840]
                .map(|color| div().size(px(12.0)).rounded_full().bg(gpui::rgb(color))),
        )
}

impl Render for Mockup {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let viewport = window.viewport_size();
        let root = div()
            .size_full()
            .flex()
            .flex_row()
            .bg(theme.sidebar_bg())
            .text_color(theme.text)
            .font_family(theme.font_sans.clone())
            .child(sidebar(&theme, window))
            .child(main_column(&theme, window, cx))
            .when(self.lights, |root| root.child(traffic_lights()))
            .when(self.palette, |root| {
                root.child(popover::modal_glass(
                    "palette",
                    viewport,
                    palette(&theme).into_any_element(),
                    |_, _, _| {},
                ))
            });
        window::frame(root, window, cx)
    }
}

// ---- sidebar ---------------------------------------------------------------

struct Session {
    name: &'static str,
    path: &'static str,
    windows: usize,
    agent: Option<(&'static str, Tone)>,
    attention: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum Tone {
    Working,
    Waiting,
    Idle,
}

impl Tone {
    fn color(self, theme: &Theme) -> Hsla {
        match self {
            Tone::Working => theme.success,
            Tone::Waiting => theme.warning,
            Tone::Idle => theme.text_faint,
        }
    }
}

const SESSIONS: &[Session] = &[
    Session {
        name: "tmux-ide",
        path: "~/Developer/tmux-ide",
        windows: 4,
        agent: Some(("agent-claude", Tone::Working)),
        attention: None,
    },
    Session {
        name: "sfora-web",
        path: "~/Developer/sfora",
        windows: 3,
        agent: Some(("agent-codex", Tone::Waiting)),
        attention: Some("2"),
    },
    Session {
        name: "cydonia-notes",
        path: "~/Developer/references",
        windows: 1,
        agent: None,
        attention: None,
    },
    Session {
        name: "dotfiles",
        path: "~/.config",
        windows: 2,
        agent: Some(("agent-claude", Tone::Idle)),
        attention: None,
    },
];

const MACHINES: &[(&str, &str, Tone)] = &[
    ("This Mac", "4 sessions", Tone::Working),
    ("devbox", "ssh · 2 sessions", Tone::Idle),
];

fn sidebar(theme: &Theme, window: &Window) -> impl IntoElement {
    div()
        .w(px(SIDEBAR_WIDTH))
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .child(
            titlebar::titlebar("sidebar-band", true, window)
                .h(px(Theme::HEADER_HEIGHT))
                .justify_end()
                .pr(px(8.0))
                .child(
                    theme
                        .icon_button(asset("panel-left"), ButtonStyle::Ghost, None)
                        .id("toggle-sidebar")
                        .tooltip(|window, cx| Tooltip::text("Hide sidebar", window, cx)),
                ),
        )
        .child(
            div().px(px(8.0)).pb(px(8.0)).child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .h(px(30.0))
                    .rounded(px(Theme::control_radius()))
                    .bg(theme.input_glass_bg())
                    .border_1()
                    .border_color(theme.border_faint)
                    .text_style(TextStyle::Callout)
                    .text_color(theme.text_faint)
                    .child(
                        icon(asset("search"))
                            .size(px(13.0))
                            .text_color(theme.text_faint),
                    )
                    .child(div().flex_1().child("Search sessions"))
                    .child(popover::kbd_hint(theme, "⌘K")),
            ),
        )
        .child(section_heading(theme, "Sessions", Some("4")))
        .child(
            div().flex().flex_col().px(px(8.0)).gap(px(2.0)).children(
                SESSIONS
                    .iter()
                    .enumerate()
                    .map(|(index, session)| session_row(theme, session, index == 0)),
            ),
        )
        .child(section_heading(theme, "Machines", None))
        .child(
            div()
                .flex()
                .flex_col()
                .px(px(8.0))
                .gap(px(2.0))
                .children(MACHINES.iter().map(|(name, meta, tone)| {
                    sidebar_row(theme, false)
                        .child(
                            icon(asset("devices"))
                                .size(px(15.0))
                                .text_color(theme.text_muted),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().truncate().child(*name))
                                .child(
                                    div()
                                        .text_style(TextStyle::Caption)
                                        .text_color(theme.text_faint)
                                        .child(*meta),
                                ),
                        )
                        .child(status_dot(tone.color(theme)))
                })),
        )
        .child(div().flex_1())
        .child(
            div()
                .m(px(8.0))
                .p(px(4.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(2.0))
                .rounded(px(Theme::surface_radius()))
                .child(theme.icon_button(asset("plus"), ButtonStyle::Ghost, None))
                .child(theme.icon_button(asset("theme"), ButtonStyle::Ghost, None))
                .child(theme.icon_button(asset("bell"), ButtonStyle::Ghost, None))
                .child(div().flex_1())
                .child(theme.icon_button(asset("settings"), ButtonStyle::Ghost, None))
                .surface(theme, GLASS),
        )
}

fn section_heading(
    theme: &Theme,
    label: &'static str,
    count: Option<&'static str>,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .px(px(18.0))
        .pt(px(14.0))
        .pb(px(6.0))
        .text_style(TextStyle::Subheadline)
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text_faint)
        .child(div().flex_1().child(label))
        .children(count.map(|count| {
            div()
                .text_style(TextStyle::Caption)
                .text_color(theme.text_faint)
                .child(count)
        }))
}

/// `widgets::Layout::nav_row`'s look, spelled out so the static mockup needs
/// no hover fade: selected is the card wash, the rest stays clear.
fn sidebar_row(theme: &Theme, selected: bool) -> gpui::Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .px(px(10.0))
        .py(px(6.0))
        .rounded(px(Theme::control_radius()))
        .text_style(TextStyle::Body)
        .text_color(theme.row_text(selected, false))
        .when(selected, |row| {
            row.bg(theme.card_selected_bg())
                .shadow(bezel_theme::glass_selected_shadows())
        })
}

fn session_row(theme: &Theme, session: &Session, selected: bool) -> impl IntoElement {
    sidebar_row(theme, selected)
        .child(match session.agent {
            Some((agent, _)) => icon(asset(agent)).size(px(16.0)).text_color(theme.text),
            None => icon(asset("terminal"))
                .size(px(16.0))
                .text_color(theme.text_muted),
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().truncate().child(session.name))
                .child(
                    div()
                        .truncate()
                        .text_style(TextStyle::Caption)
                        .text_color(theme.text_faint)
                        .child(format!("{} · {} windows", session.path, session.windows)),
                ),
        )
        .children(session.attention.map(|count| theme.badge(count)))
        .children(session.agent.map(|(_, tone)| status_dot(tone.color(theme))))
}

// ---- titlebar, tabs and the pane ------------------------------------------

const WINDOWS: &[(&str, &str)] = &[
    ("1", "editor"),
    ("2", "agents"),
    ("3", "server"),
    ("4", "logs"),
];

fn main_column(theme: &Theme, window: &Window, cx: &App) -> impl IntoElement {
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(
            titlebar::titlebar("main-band", false, window)
                .h(px(Theme::HEADER_HEIGHT))
                .gap(px(4.0))
                .pr(px(10.0))
                .child(
                    tabs::bar("window-tabs").children(WINDOWS.iter().enumerate().map(
                        |(index, (number, name))| {
                            let key = format!("win-{number}");
                            let state = match index {
                                1 => tabs::State::Focused,
                                _ => tabs::State::Resting,
                            };
                            tabs::tab(
                                theme,
                                key.clone(),
                                tabs::Label::new(*name)
                                    .with_icon(asset("terminal"))
                                    .with_badge(format!("⌘{number}")),
                                state,
                            )
                            .child(tabs::close(
                                theme,
                                key,
                                tabs::Close::OnHover,
                            ))
                        },
                    )),
                )
                .child(theme.icon_button(asset("plus"), ButtonStyle::Ghost, None))
                .child(div().flex_1().h_full())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_style(TextStyle::Callout)
                        .text_color(theme.text_muted)
                        .child(
                            icon(asset("git-branch"))
                                .size(px(13.0))
                                .text_color(theme.text_muted),
                        )
                        .child("main"),
                )
                .child(theme.icon_button(asset("split"), ButtonStyle::Ghost, None))
                .child(theme.icon_button(asset("globe"), ButtonStyle::Ghost, None))
                .child(theme.button("New session", ButtonStyle::Prominent, None)),
        )
        .child(
            window::content(true, cx)
                .flex_1()
                .min_h_0()
                .mt_0()
                .flex()
                .flex_col()
                .child(pane_header(theme))
                .child(terminal(theme))
                .child(status_line(theme)),
        )
}

fn pane_header(theme: &Theme) -> impl IntoElement {
    div()
        .h(px(36.0))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .px(px(8.0))
        .border_b_1()
        .border_color(theme.border_faint)
        .child(
            tabs::bar("pane-tabs")
                .child(
                    tabs::tab(
                        theme,
                        "pane-claude",
                        tabs::Label::new("claude").with_icon(asset("agent-claude")),
                        tabs::State::Front,
                    )
                    .child(tabs::close(
                        theme,
                        "pane-claude",
                        tabs::Close::Always,
                    )),
                )
                .child(tabs::tab(
                    theme,
                    "pane-zsh",
                    tabs::Label::new("zsh · cargo test").with_icon(asset("terminal")),
                    tabs::State::Resting,
                ))
                .child(tabs::tab(
                    theme,
                    "pane-web",
                    tabs::Label::new("localhost:5173").with_icon(asset("globe")),
                    tabs::State::Resting,
                )),
        )
        .child(div().flex_1())
        .child(theme.icon_button(asset("zoom"), ButtonStyle::Ghost, None))
        .child(theme.icon_button(asset("more"), ButtonStyle::Ghost, None))
}

/// One line of fake terminal output: (ANSI colour index or None, text) runs.
type Line = &'static [(Option<usize>, &'static str)];

const TERMINAL: &[Line] = &[
    &[
        (Some(8), "~/Developer/tmux-ide "),
        (Some(5), "main"),
        (None, " ❯ claude"),
    ],
    &[],
    &[
        (Some(3), "● "),
        (
            None,
            "Reading apps/tmux-gpui/upstream/crates/tmux-ide-gpui/src/tmux_snapshot/sidebar.rs",
        ),
    ],
    &[
        (Some(3), "● "),
        (
            None,
            "Reading ~/.cargo/registry/src/…/bezel-ui-0.2.16/src/widgets/layout.rs",
        ),
    ],
    &[(
        Some(8),
        "  ⎿  nav_row(icon, label, selected, fade) — the shipped sidebar row",
    )],
    &[],
    &[
        (Some(2), "● "),
        (None, "Update(src/tmux_snapshot/sidebar.rs)"),
    ],
    &[(
        Some(8),
        "  ⎿  Updated sidebar.rs with 18 additions and 41 removals",
    )],
    &[
        (Some(2), "      + "),
        (
            None,
            "theme.nav_row(Some(agent.icon()), &row.name, selected, fade)",
        ),
    ],
    &[
        (Some(1), "      - "),
        (
            Some(8),
            "div().px(px(10.)).bg(rgba((theme.foreground << 8) | 0x18))",
        ),
    ],
    &[],
    &[
        (Some(2), "● "),
        (None, "Bash(cargo test -p tmux-ide-gpui sidebar)"),
    ],
    &[(Some(8), "  ⎿  running 37 tests")],
    &[
        (
            Some(8),
            "     test tmux_snapshot::sidebar::tests::selected_row_uses_card_wash ... ",
        ),
        (Some(2), "ok"),
    ],
    &[
        (
            Some(8),
            "     test tmux_snapshot::sidebar::tests::attention_badge_counts ... ",
        ),
        (Some(2), "ok"),
    ],
    &[
        (Some(8), "     test result: "),
        (Some(2), "ok"),
        (Some(8), ". 37 passed; 0 failed"),
    ],
    &[],
    &[
        (Some(6), "✻ "),
        (None, "Swapping the session rows onto Layout::nav_row… "),
        (Some(8), "(42s · esc to interrupt)"),
    ],
];

fn terminal(theme: &Theme) -> impl IntoElement {
    let ansi = theme.terminal_ansi;
    div()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .px(px(16.0))
        .py(px(12.0))
        .font_family(theme.font_mono.clone())
        .text_size(px(13.0))
        .line_height(px(20.0))
        .text_color(theme.text)
        .children(TERMINAL.iter().map(move |line| {
            div()
                .h(px(20.0))
                .flex()
                .flex_row()
                .whitespace_nowrap()
                .children(line.iter().map(move |(color, text)| {
                    div()
                        .when_some(*color, |run, index| run.text_color(ansi[index]))
                        .child(*text)
                }))
        }))
        .child(
            div()
                .mt(px(12.0))
                .px(px(12.0))
                .py(px(8.0))
                .rounded(px(Theme::control_radius()))
                .border_1()
                .border_color(theme.border)
                .flex()
                .flex_row()
                .items_center()
                .child(div().text_color(theme.text_muted).child("> "))
                .child(div().w(px(8.0)).h(px(16.0)).bg(theme.caret)),
        )
}

fn status_line(theme: &Theme) -> impl IntoElement {
    theme
        .status_bar()
        .border_t_1()
        .border_color(theme.border_faint)
        .px(px(12.0))
        .gap(px(12.0))
        .text_style(TextStyle::Caption)
        .text_color(theme.text_faint)
        .child(status_dot(theme.success))
        .child("Connected · tmux 3.5a · session tmux-ide")
        .child(div().flex_1())
        .child("pane 2.1 · 182×46")
        .child("UTF-8")
}

// ---- command palette -------------------------------------------------------

const COMMANDS: &[(&str, &str, &str)] = &[
    ("split", "Split pane right", "⌘D"),
    ("split", "Split pane down", "⇧⌘D"),
    ("fan-out", "Fan out agent to new worktree", "⌥⌘N"),
    ("zoom", "Zoom pane", "⇧⌘↩"),
];

const JUMPS: &[(&str, &str, &str)] = &[
    ("sessions", "sfora-web", "2 waiting"),
    ("globe", "localhost:5173 — open in browser pane", ""),
];

fn palette(theme: &Theme) -> impl IntoElement {
    // `modal_glass` centres the card and mounts it on the popover surface.
    popover::popover_card(theme)
        .w(px(600.0))
        .child(popover::search_line(
            theme,
            div()
                .flex()
                .flex_row()
                .items_center()
                .child(div().text_color(theme.text).child("spl"))
                .child(div().w(px(1.5)).h(px(16.0)).bg(theme.caret))
                .into_any_element(),
        ))
        .child(popover::menu_heading(theme, "Commands"))
        .children(
            COMMANDS
                .iter()
                .enumerate()
                .map(|(index, (glyph, label, keys))| {
                    popover::menu_row(theme, index == 0, None)
                        .child(
                            icon(asset(glyph))
                                .size(px(15.0))
                                .text_color(theme.text_muted),
                        )
                        .child(div().flex_1().child(*label))
                        .child(popover::kbd_hint(theme, *keys))
                }),
        )
        .child(popover::menu_section(theme).child(popover::menu_heading(theme, "Go to")))
        .children(JUMPS.iter().map(|(glyph, label, meta)| {
            popover::menu_row(theme, false, None)
                .child(
                    icon(asset(glyph))
                        .size(px(15.0))
                        .text_color(theme.text_muted),
                )
                .child(div().flex_1().child(*label))
                .child(
                    div()
                        .text_style(TextStyle::Caption)
                        .text_color(theme.text_faint)
                        .child(*meta),
                )
        }))
        .child(
            div()
                .mt(px(6.0))
                .pt(px(8.0))
                .px(px(8.0))
                .border_t_1()
                .border_color(theme.border_faint)
                .flex()
                .flex_row()
                .gap(px(14.0))
                .child(popover::key_hint_text(theme, "↩", "Run"))
                .child(popover::key_hint_text(theme, "↑↓", "Move"))
                .child(popover::key_hint_text(theme, "⇥", "Filter"))
                .child(popover::key_hint_text(theme, "esc", "Close")),
        )
}
