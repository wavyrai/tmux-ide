use super::*;
use std::io::Cursor;

const LIMITS: ScriptLimits = ScriptLimits {
    output: 1 << 20,
    idle: Duration::from_secs(10),
};

fn local(script: &str, input: &[u8], limits: ScriptLimits) -> (Result<u64>, Vec<u8>) {
    let mut output = Vec::new();
    let result = run_script(
        ScriptHost::Local,
        script,
        Cursor::new(input),
        &mut output,
        limits,
        &AtomicBool::new(false),
    );
    (result, output)
}

#[test]
fn streams_binary_input_through_to_output() {
    let data: Vec<u8> = (0..CHUNK * 3 + 7).map(|i| i as u8).collect();
    let (result, output) = local("cat", &data, LIMITS);
    assert_eq!(result.unwrap(), data.len() as u64);
    assert_eq!(output, data);
}

#[test]
fn quoting_keeps_hostile_words_literal() {
    let word = "a'$(touch INJECTED);`x` \"b\"";
    let (result, output) = local(&format!("printf %s {}", shell_quote(word)), &[], LIMITS);
    result.unwrap();
    assert_eq!(output, word.as_bytes());
}

#[test]
fn failing_exit_keeps_sanitized_stderr_tail() {
    let (result, _) = local(
        "printf 'x%.0s' $(seq 1 5000) >&2; printf '\\033[31mfatal: nope\\n' >&2; exit 3",
        &[],
        LIMITS,
    );
    let Err(Error::ScriptExit { status, stderr }) = result else {
        panic!("{result:?}");
    };
    assert_eq!(status.code(), Some(3));
    assert!(stderr.len() <= STDERR_TAIL, "{}", stderr.len());
    assert!(stderr.ends_with("[31mfatal: nope"), "{stderr:?}");
    assert!(!stderr.contains('\u{1b}'));
}

#[test]
fn unread_input_does_not_fail_a_successful_script() {
    let data = vec![0u8; CHUNK * 16];
    let (result, output) = local("printf done", &data, LIMITS);
    assert_eq!(result.unwrap(), 4);
    assert_eq!(output, b"done");
}

#[test]
fn output_limit_kills_the_script() {
    let limits = ScriptLimits {
        output: 1000,
        ..LIMITS
    };
    let (result, _) = local("yes", &[], limits);
    assert!(matches!(result, Err(Error::ScriptOutputLimit)), "{result:?}");
}

#[test]
fn idle_deadline_kills_a_silent_script() {
    let limits = ScriptLimits {
        idle: Duration::from_millis(200),
        ..LIMITS
    };
    let started = Instant::now();
    let (result, _) = local("sleep 30", &[], limits);
    assert!(matches!(result, Err(Error::ScriptTimeout)), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn cancellation_kills_the_script() {
    let cancelled = AtomicBool::new(true);
    let result = run_script(
        ScriptHost::Local,
        "sleep 30",
        io::empty(),
        io::sink(),
        LIMITS,
        &cancelled,
    );
    assert!(matches!(result, Err(Error::ScriptCancelled)), "{result:?}");
}

#[test]
fn output_write_failure_is_typed() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("disk full"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let result = run_script(
        ScriptHost::Local,
        "yes",
        io::empty(),
        Broken,
        LIMITS,
        &AtomicBool::new(false),
    );
    assert!(matches!(result, Err(Error::ScriptOutput(_))), "{result:?}");
}

#[test]
fn ssh_targets_are_validated_before_spawning() {
    let result = run_script(
        ScriptHost::Ssh("-oProxyCommand=x"),
        "true",
        io::empty(),
        io::sink(),
        LIMITS,
        &AtomicBool::new(false),
    );
    assert!(matches!(result, Err(Error::InvalidSshTarget)), "{result:?}");
}

#[test]
fn stopping_a_script_also_stops_its_children() {
    // `; true` keeps the shell from exec'ing `sleep`, so `sleep` is a child
    // holding the output pipe; stopping must not wait for it to exit.
    let limits = ScriptLimits {
        idle: Duration::from_millis(200),
        ..LIMITS
    };
    let started = Instant::now();
    let (result, _) = local("sleep 30; true", &[], limits);
    assert!(matches!(result, Err(Error::ScriptTimeout)), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}
