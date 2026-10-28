use super::visible;

#[test]
fn routine_ready_guidance_is_opt_in() {
    for message in [
        "Connected",
        "Keyboard ready",
        "Keyboard ready — click terminal to type",
    ] {
        assert!(!visible(message, false, true));
        assert!(visible(message, true, true));
        assert!(visible(message, false, false));
    }
}

#[test]
fn failures_and_interactions_remain_visible() {
    for message in [
        "Connection unavailable — refresh the catalog",
        "Reconnecting terminal",
        "Connection recovery paused — refresh or select the session again",
        "Input interrupted; click terminal when ready, then retype — Keyboard ready",
        "Selecting captured frame — Cmd-C copies; Escape or click resumes",
        "Copy failed",
        "Unrecognized future status",
    ] {
        assert!(visible(message, false, true), "{message}");
        assert!(visible(message, false, false), "{message}");
    }
}
