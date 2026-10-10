//! Window navigation is derived only from verified pane choices.
use super::browser::Choice;

pub(super) struct WindowChoice {
    pub id: String,
    pub label: String,
    pub pane: String,
    pub selected: bool,
}

pub(super) fn windows(panes: &[Choice], selected: Option<&str>) -> Vec<WindowChoice> {
    let mut windows: Vec<WindowChoice> = Vec::new();
    for pane in panes {
        let Some(id) = &pane.window_id else {
            continue;
        };
        let is_selected = selected == Some(pane.id.as_str());
        if let Some(window) = windows.iter_mut().find(|window| window.id == *id) {
            if is_selected {
                window.pane = pane.id.clone();
                window.selected = true;
            }
        } else {
            windows.push(WindowChoice {
                id: id.clone(),
                label: pane.window_label.clone().unwrap_or_else(|| "Window".into()),
                pane: pane.id.clone(),
                selected: is_selected,
            });
        }
    }
    windows
}

#[cfg(test)]
mod tests;
