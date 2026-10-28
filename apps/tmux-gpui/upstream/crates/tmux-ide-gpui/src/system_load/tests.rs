#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::{
    HISTORY, Reading, Source, Stop, SystemLoad,
    render::gigabytes,
    sample::{Memory, Os, Sample, parse},
};
use crate::{Error, usage::Host};
use std::{
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

const LINUX: &str = "cores 8
loadavg 0.52 0.48 0.40 2/913 123456
cpu  1000 0 500 8000 500 0 0 0 0 0
MemTotal:       16384000 kB
MemAvailable:    4096000 kB
";

const LINUX_LATER: &str = "cores 8
loadavg 0.60 0.50 0.41 3/913 123460
cpu  1300 0 600 8500 600 0 0 0 0 0
MemTotal:       16384000 kB
MemAvailable:    4096000 kB
";

const MACOS: &str = "cores 16
memsize 68719476736
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    14344.
Pages active:                                1169532.
Pages inactive:                              1175118.
Pages speculative:                               562.
Pages wired down:                             408598.
Pages purgeable:                               41357.
Pages occupied by compressor:                1529872.
iostat  15  4 81  6.42 7.46 9.90
";

#[test]
fn linux_cpu_is_measured_between_two_answers() {
    let first = parse(LINUX, None).unwrap();
    assert_eq!(first.sample.cpu, None, "one answer has nothing to compare");
    assert_eq!(first.sample.cores, Some(8));
    assert_eq!(first.sample.load, Some([0.52, 0.48, 0.40]));
    assert_eq!(
        first.sample.memory,
        Some(Memory {
            used: 12_288_000 * 1024,
            total: 16_384_000 * 1024,
        })
    );
    let second = parse(LINUX_LATER, first.ticks).unwrap();
    // 300 user + 100 system busy of 1000 ticks; iowait counts as idle.
    let cpu = second.sample.cpu.unwrap();
    assert!((cpu - 40.).abs() < 0.01, "{cpu}");
}

#[test]
fn linux_counters_that_went_backwards_measure_nothing() {
    let later = parse(LINUX_LATER, None).unwrap();
    let rebooted = parse(LINUX, later.ticks).unwrap();
    assert_eq!(rebooted.sample.cpu, None);
}

#[test]
fn macos_counts_memory_as_sysinfo_does() {
    let answer = parse(MACOS, None).unwrap();
    assert_eq!(answer.sample.cpu, Some(19.));
    assert_eq!(answer.sample.cores, Some(16));
    assert_eq!(answer.sample.load, Some([6.42, 7.46, 9.90]));
    let pages = 1_169_532 + 408_598 + 1_529_872 + 562;
    assert_eq!(
        answer.sample.memory,
        Some(Memory {
            used: pages * 16384,
            total: 68_719_476_736,
        })
    );
    assert_eq!(answer.ticks, None);
}

#[test]
fn macos_memory_needs_every_counter() {
    let missing = MACOS.replace("Pages wired down:", "Pages wired:");
    let answer = parse(&missing, None).unwrap();
    assert_eq!(answer.sample.memory, None);
    assert_eq!(answer.sample.cpu, Some(19.));
}

#[test]
fn unexpected_output_is_a_typed_error() {
    for text in [
        "",
        "sh: getconf: not found\n",
        "iostat 1 2 300\n",
        "cpu  x y z\nMemTotal: 10 kB\n",
    ] {
        assert!(
            matches!(parse(text, None), Err(Error::SystemLoadOutput)),
            "{text:?}"
        );
    }
}

#[test]
fn malformed_fields_are_dropped_not_trusted() {
    let text = "cores 0\nloadavg 1 nan 3\nMemTotal: 0 kB\nMemAvailable: 0 kB\niostat 10 10 80\n";
    let answer = parse(text, None).unwrap();
    assert_eq!(answer.sample.cores, None);
    assert_eq!(answer.sample.load, None);
    assert_eq!(answer.sample.memory, None);
    assert_eq!(answer.sample.cpu, Some(20.));
}

#[test]
fn memory_share_is_bounded() {
    assert_eq!(Memory { used: 1, total: 0 }.percent(), 0.);
    assert_eq!(Memory { used: 3, total: 2 }.percent(), 100.);
    assert_eq!(Memory { used: 1, total: 4 }.percent(), 25.);
    assert_eq!(gigabytes(3 << 29), "1.5 GB");
}

#[test]
fn uname_selects_the_command() {
    assert_eq!(Os::from_uname("Linux\n"), Some(Os::Linux));
    assert_eq!(Os::from_uname("Darwin"), Some(Os::MacOs));
    assert_eq!(Os::from_uname("FreeBSD"), None);
    assert!(Os::Linux.command().contains("/proc/stat"));
    assert!(Os::MacOs.command().contains("vm_stat"));
}

#[test]
fn a_stopped_worker_wakes_at_once() {
    let stop = Arc::new(Stop::default());
    assert!(stop.wait(Instant::now()), "a due sample is taken");
    let waiter = {
        let stop = stop.clone();
        thread::spawn(move || stop.wait(Instant::now() + Duration::from_secs(3600)))
    };
    stop.stop();
    assert!(!waiter.join().unwrap());
    assert!(!stop.wait(Instant::now()), "stopped stays stopped");
}

#[test]
fn history_is_bounded_and_a_failure_keeps_the_last_sample() {
    let mut reading = Reading::default();
    for index in 0..HISTORY + 3 {
        reading.apply(Ok(Sample {
            cpu: Some(index as f32),
            ..Sample::default()
        }));
    }
    assert_eq!(reading.history().len(), HISTORY);
    assert_eq!(reading.history().next(), Some(3.));
    let shown = reading.latest().copied();
    reading.apply(Err(Error::SystemLoadRemote(Box::new(
        Error::UsageUnreachable,
    ))));
    assert_eq!(
        reading.latest().copied(),
        shown,
        "the last good sample stays"
    );
    let error = reading.error().unwrap();
    assert!(
        error.starts_with("Could not read CPU and memory"),
        "{error}"
    );
    assert!(error.contains("SSH"), "the cause is kept: {error}");
    reading.apply(Ok(Sample::default()));
    assert_eq!(reading.error(), None);
}

#[test]
fn a_wanted_host_is_sampled_and_a_dropped_one_forgotten() {
    // Only this machine: a remote host would start a real `ssh`.
    let mut load = SystemLoad::default();
    let local = Host::Local;
    // Starting a worker shows nothing new by itself, but a fast machine can
    // answer before this same poll drains it, which is a change.
    let changed = load.poll([local.clone()]);
    let reading = load.get(&local).unwrap();
    assert_eq!(
        changed,
        reading.latest().is_some() || reading.error().is_some()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while load.get(&local).and_then(Reading::latest).is_none() {
        assert!(Instant::now() < deadline, "this machine never answered");
        load.poll([local.clone()]);
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        load.poll(std::iter::empty()),
        "dropping a host changes what is shown"
    );
    assert!(load.get(&local).is_none());
    assert!(!load.poll(std::iter::empty()));
}

#[test]
fn this_machine_answers_with_memory_then_cpu() {
    let mut source = Source::open(&Host::Local).unwrap();
    let first = source.sample().unwrap();
    assert_eq!(first.cpu, None);
    let memory = first.memory.expect("this machine reports memory");
    assert!(memory.used <= memory.total);
    thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    let second = source.sample().unwrap();
    assert!(second.cpu.is_some_and(|cpu| (0.0..=100.).contains(&cpu)));
}

#[cfg(unix)]
#[test]
fn a_remote_shell_is_sampled_with_the_host_command() {
    // A local `sh` stands in for SSH, as the usage shell tests do.
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-s")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let shell = crate::usage::Shell::start(command).unwrap();
    let mut source = Source::Remote {
        shell,
        os: if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        },
        ticks: None,
    };
    let sample = source.sample().unwrap();
    assert!(sample.memory.is_some_and(|memory| memory.total > 0));
    assert!(sample.cores.is_some());
}
