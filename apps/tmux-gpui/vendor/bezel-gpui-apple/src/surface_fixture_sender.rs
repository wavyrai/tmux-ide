//! Test-only identity exchange over the exact spawned child's private stdout.
use super::{Duration, TestChild};
use crate::surface_inbox::SenderIdentity;
use std::io::{BufRead, BufReader, Read};

pub(super) fn fixture_sender(
    child: &mut TestChild,
) -> (
    SenderIdentity,
    BufReader<std::io::Take<std::process::ChildStdout>>,
) {
    let output = child.0.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        // Include libtest's banner, but never consume an unbounded diagnostic.
        let mut output = BufReader::new(output.take(2048));
        let token = output
            .by_ref()
            .lines()
            .map_while(Result::ok)
            .find_map(|line| {
                let words = line.strip_prefix("TMUX_SURFACE_SENDER=")?;
                let words: Vec<u32> = words
                    .split(',')
                    .map(str::parse)
                    .collect::<Result<_, _>>()
                    .ok()?;
                let token: [u32; 8] = words.try_into().ok()?;
                SenderIdentity::from_authenticated_token(token).ok()
            });
        let _ = sender.send((token, output));
    });
    let token = receiver.recv_timeout(Duration::from_secs(5));
    if token.is_err() {
        // Unblock the exact reader before joining; never leave a fixture thread
        // or producer waiting for retirement when identity exchange fails.
        let _ = child.0.kill();
        let _ = child.0.wait();
    }
    reader.join().unwrap();
    let (token, output) = token.unwrap();
    // Keep the read end alive through child exit: libtest writes its bounded
    // result after the producer receives retirement, and must not see EPIPE.
    (
        token.expect("owned producer did not report its audit identity"),
        output,
    )
}
