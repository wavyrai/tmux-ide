//! The native macOS menu bar. A menu item that stands for a shortcut replays
//! that shortcut, as a fresh (never held) keystroke, through the window's
//! top-level key handler, so choosing the item and pressing the key take one
//! path with the same guards. No key bindings are registered here: typing
//! keeps the hand-matched path, auto-repeat guard included.
use super::SnapshotView;
use gpui::{prelude::*, *};

actions!(
    tmux_ide,
    [
        ChooseTheme,
        CommandPalette,
        SessionsAndPanes,
        ShowHome,
        ShowTerminals,
        ToggleSidebar,
        SplitRight,
        SplitDown,
        ZoomPane,
        ClosePane,
        FocusPaneLeft,
        FocusPaneRight,
        FocusPaneUp,
        FocusPaneDown,
        NewTerminalWindow,
        NextWindow,
        PreviousWindow,
        Minimize,
        Attention,
    ]
);

/// The keystroke each shortcut item stands for.
pub(super) fn keystroke(action: &dyn Action) -> Option<&'static str> {
    let any = action.as_any();
    let pairs: [(bool, &'static str); 16] = [
        (any.is::<CommandPalette>(), "f5"),
        (any.is::<SessionsAndPanes>(), "f6"),
        (any.is::<ShowHome>(), "f1"),
        (any.is::<ShowTerminals>(), "f2"),
        (any.is::<Attention>(), "f7"),
        (any.is::<ToggleSidebar>(), "f10"),
        (any.is::<SplitRight>(), "cmd-d"),
        (any.is::<SplitDown>(), "cmd-shift-d"),
        (any.is::<ZoomPane>(), "cmd-shift-enter"),
        (any.is::<ClosePane>(), "cmd-w"),
        (any.is::<FocusPaneLeft>(), "cmd-alt-left"),
        (any.is::<FocusPaneRight>(), "cmd-alt-right"),
        (any.is::<FocusPaneUp>(), "cmd-alt-up"),
        (any.is::<FocusPaneDown>(), "cmd-alt-down"),
        (any.is::<NewTerminalWindow>(), "cmd-t"),
        (any.is::<NextWindow>(), "cmd-}"),
    ];
    pairs
        .into_iter()
        .find_map(|(matched, key)| matched.then_some(key))
        .or_else(|| any.is::<PreviousWindow>().then_some("cmd-{"))
}

/// The app's menus. Titles carry no hand-typed shortcuts (PM, #674): real key
/// equivalents come with the keymap card.
pub(super) fn menus() -> Vec<Menu> {
    vec![
        Menu::new("tmux-ide").items([
            MenuItem::action("Choose Theme…", ChooseTheme),
            MenuItem::separator(),
            MenuItem::action("Quit tmux-ide", crate::Quit),
        ]),
        Menu::new("Edit").items([
            MenuItem::action("Cut", crate::actions::Cut),
            MenuItem::action("Copy", crate::actions::Copy),
            MenuItem::action("Paste", crate::actions::Paste),
            MenuItem::action("Select All", crate::actions::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Command Palette", CommandPalette),
            MenuItem::action("Sessions and Panes", SessionsAndPanes),
            MenuItem::action("Needs Attention", Attention),
            MenuItem::separator(),
            MenuItem::action("Home", ShowHome),
            MenuItem::action("Terminals", ShowTerminals),
            MenuItem::action("Show or Hide Sidebar", ToggleSidebar),
            MenuItem::separator(),
            MenuItem::action(
                "Enter Full Screen",
                crate::RunCommand {
                    command: crate::controls::Command::ToggleFullScreen,
                },
            ),
        ]),
        Menu::new("Pane").items([
            MenuItem::action("Split Right", SplitRight),
            MenuItem::action("Split Down", SplitDown),
            MenuItem::action("Zoom", ZoomPane),
            MenuItem::action("Close Pane…", ClosePane),
            MenuItem::separator(),
            MenuItem::action("Focus Left", FocusPaneLeft),
            MenuItem::action("Focus Right", FocusPaneRight),
            MenuItem::action("Focus Up", FocusPaneUp),
            MenuItem::action("Focus Down", FocusPaneDown),
        ]),
        Menu::new("Window").items([
            MenuItem::action("New Window", NewTerminalWindow),
            MenuItem::action("Next Window", NextWindow),
            MenuItem::action("Previous Window", PreviousWindow),
            MenuItem::separator(),
            MenuItem::action("Minimize", Minimize),
        ]),
    ]
}

/// Installs the menu bar, and nothing else: no key bindings.
pub(super) fn install(cx: &mut App) {
    cx.set_menus(menus());
}

/// The shortcut `key` as a fresh key press: never auto-repeat.
fn press(key: &str) -> Option<KeyDownEvent> {
    Keystroke::parse(key).ok().map(|keystroke| KeyDownEvent {
        keystroke,
        is_held: false,
        prefer_character_input: false,
        layout: None,
    })
}

impl SnapshotView {
    /// Replays `action`'s shortcut through the top-level key handler.
    pub(super) fn run_menu_action(
        &mut self,
        action: &dyn Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(event) = keystroke(action).and_then(press) {
            self.picker_key(&event, window, cx);
        }
    }

    /// The menu bar's handlers, on the element that holds the key handler.
    pub(super) fn menu_actions(&self, body: Div, cx: &mut Context<Self>) -> Div {
        macro_rules! replay {
            ($body:expr, $($action:ty),+) => {
                $body$(.on_action(cx.listener(|view, action: &$action, window, cx| {
                    view.run_menu_action(action, window, cx)
                })))+
            };
        }
        let body = replay!(
            body,
            CommandPalette,
            SessionsAndPanes,
            Attention,
            ShowHome,
            ShowTerminals,
            ToggleSidebar,
            SplitRight,
            SplitDown,
            ZoomPane,
            ClosePane,
            FocusPaneLeft,
            FocusPaneRight,
            FocusPaneUp,
            FocusPaneDown,
            NewTerminalWindow,
            NextWindow,
            PreviousWindow
        );
        body.on_action(
            cx.listener(|view, _: &ChooseTheme, window, cx| view.open_theme_picker(window, cx)),
        )
        .on_action(|_: &Minimize, window, _| window.minimize_window())
    }
}
