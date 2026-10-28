//! Normal mode suppresses only known routine guidance, never unknown failures.
//! Authority still comes from the bridge; presentation cannot enable input.
pub(super) fn visible(status: &str, developer_mode: bool, input_ready: bool) -> bool {
    developer_mode
        || !input_ready
        || !matches!(
            status,
            "Connected" | "Keyboard ready" | "Keyboard ready — click terminal to type"
        )
}

#[cfg(test)]
mod tests;
