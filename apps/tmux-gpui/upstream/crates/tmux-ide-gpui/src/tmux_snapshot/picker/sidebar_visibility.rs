use super::*;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_hidden = !self.sidebar_hidden;
        self.sidebar_keyboard.active = false;
        cx.notify();
    }
}
