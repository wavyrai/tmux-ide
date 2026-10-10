use super::*;

mod fallback_paste;
mod reservations;
mod uploads;

fn reserve(client: &Client) -> ClipboardImageUpload {
    client
        .handle
        .reserve_clipboard_image("boot-v1", ClientClipboardImageTarget::Pane("w1:p1".into()))
        .unwrap()
}

fn ready() -> (Client, Stream, thread::JoinHandle<Result<()>>) {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    (client, server, worker)
}

fn no_command(server: &mut Stream) {
    server
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    assert!(matches!(
        server.read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ));
    server
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
}
