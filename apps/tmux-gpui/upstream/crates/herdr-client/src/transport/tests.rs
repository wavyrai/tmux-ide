use super::*;
use interprocess::local_socket::{
    GenericNamespaced, ListenerOptions, ToNsName, traits::Listener as _,
};
use std::{
    io::{Read, Write},
    time::Duration,
};

#[test]
fn windows_socket_path_connects_and_exchanges_bytes() {
    // A daemon-style path is a pipe name, not a file to open. Include a drive
    // letter, spaces and Unicode rather than testing only a short pipe name.
    let path = std::env::temp_dir()
        .join(format!("herdr-pipe-path-test-{}", std::process::id()))
        .join("Windows 用户")
        .join("herdr-client.sock");
    let name = path.to_string_lossy().into_owned();
    let listener = ListenerOptions::new()
        .name(name.to_ns_name::<GenericNamespaced>().unwrap())
        .create_sync()
        .unwrap();
    let mut client = Stream::connect(&path).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut server = listener.accept().unwrap();
    client.write_all(b"client").unwrap();
    let mut request = [0; 6];
    server.read_exact(&mut request).unwrap();
    assert_eq!(&request, b"client");
    server.write_all(b"daemon").unwrap();
    let mut response = [0; 6];
    client.read_exact(&mut response).unwrap();
    assert_eq!(&response, b"daemon");
    assert!(!path.exists());
}
