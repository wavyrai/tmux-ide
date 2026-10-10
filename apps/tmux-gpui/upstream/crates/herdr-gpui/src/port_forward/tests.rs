use super::*;

fn port(port: u16) -> NonZeroU16 {
    NonZeroU16::new(port).unwrap()
}

#[test]
fn ports_are_whole_numbers_from_1_to_65535() {
    assert_eq!(parse_port(" 3000 ").unwrap().get(), 3000);
    assert_eq!(parse_port("65535").unwrap().get(), 65535);
    for text in [
        "",
        "0",
        "65536",
        "-1",
        "+80",
        "3000:4000",
        "localhost:3000",
        "8 0",
    ] {
        assert!(
            matches!(parse_port(text), Err(Error::ForwardPort)),
            "{text}"
        );
    }
}

#[test]
fn reports_move_a_forward_to_listening_then_ended_and_say_so() {
    let mut forward = Forward {
        target: "box".into(),
        remote_port: port(80),
        state: State::Starting,
        handle: None,
    };
    assert_eq!(forward.url(), None);
    let notice = forward.apply(ForwardEvent::Listening { local_port: 10080 });
    assert_eq!(notice.text(), "Forwarding port 80 to 127.0.0.1:10080");
    assert_eq!(forward.state, State::Listening { local_port: 10080 });
    assert_eq!(forward.url().unwrap().as_str(), "http://127.0.0.1:10080/");

    let notice = forward.apply(ForwardEvent::Ended(herdr_client::Error::ForwardSpawn(
        std::io::Error::new(std::io::ErrorKind::NotFound, "no ssh"),
    )));
    assert_eq!(
        notice.text(),
        "Port 80 forward ended: could not start SSH for the port forward: no ssh"
    );
    assert!(matches!(forward.state, State::Ended(_)));
    assert_eq!(forward.url(), None);
}

#[test]
fn a_running_port_is_not_forwarded_twice_but_an_ended_one_restarts() {
    let mut forwards = PortForwards::default();
    forwards.fixture("box", 3000, State::Starting);
    forwards.fixture("box", 4000, State::Ended("gone".into()));
    let never = || -> Result<PortForward> { unreachable!("must not start") };
    assert!(matches!(
        forwards.insert("box", port(3000), never),
        Err(Error::ForwardDuplicate(3000))
    ));
    // The ended entry is replaced by whatever the restart produced: here,
    // a failure to start, which leaves no entry behind.
    assert!(matches!(
        forwards.insert("box", port(4000), || Err(Error::ForwardPort)),
        Err(Error::ForwardPort)
    ));
    assert_eq!(forwards.for_host("box").count(), 1);
    // The same port on another host is another forward.
    assert!(
        forwards
            .insert("other", port(3000), || Err(Error::ForwardPort))
            .is_err()
    );
}

#[test]
fn the_number_of_forwards_is_bounded() {
    let mut forwards = PortForwards::default();
    for remote in 1..=LIMIT as u16 {
        forwards.fixture("box", remote, State::Starting);
    }
    assert!(matches!(
        forwards.insert("box", port(9999), || unreachable!()),
        Err(Error::ForwardLimit(LIMIT))
    ));
}

#[test]
fn stopping_removes_only_the_named_forward_and_hosts_that_leave_lose_theirs() {
    let mut forwards = PortForwards::default();
    forwards.fixture("box", 3000, State::Starting);
    forwards.fixture("box", 4000, State::Listening { local_port: 4000 });
    forwards.fixture("other", 3000, State::Starting);
    assert!(forwards.stop("box", port(3000)));
    assert!(!forwards.stop("box", port(3000)));
    let ports = |forwards: &PortForwards, host| {
        forwards
            .for_host(host)
            .map(|forward| forward.remote_port().get())
            .collect::<Vec<_>>()
    };
    assert_eq!(ports(&forwards, "box"), [4000]);
    assert!(!forwards.retain_hosts(|_| true));
    assert!(forwards.retain_hosts(|host| host == "other"));
    assert!(ports(&forwards, "box").is_empty());
    assert_eq!(ports(&forwards, "other"), [3000]);
    forwards.stop_all();
    assert!(ports(&forwards, "other").is_empty());
}
