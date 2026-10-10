use super::*;

fn host_theme(appearance: ClientHostAppearance) -> HostTheme {
    let rgb = |value: u8| ClientHostColor {
        r: value,
        g: value,
        b: value,
    };
    HostTheme {
        foreground: rgb(0xee),
        background: rgb(0x11),
        palette: std::array::from_fn(|index| rgb(index as u8)),
        appearance,
    }
}

fn receive_host_theme(stream: &mut Stream) -> ClientHostThemeUpdate {
    let ClientMessage::ClientShellHostTheme { update } = receive(stream) else {
        panic!("expected host theme")
    };
    update
}

/// Ends a check that nothing else was written: the next frame is this focus.
fn assert_next_is_focus(client: &Client, server: &mut Stream) {
    client.handle.set_focus("boot-v1", true).unwrap();
    assert_eq!(
        receive(server),
        ClientMessage::ClientShellFocus { focused: true }
    );
}

#[test]
fn host_theme_is_sent_in_full_once_then_as_ordered_diffs() {
    let (client, mut server, _worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let dark = host_theme(ClientHostAppearance::Dark);
    client.handle.set_host_theme("boot-v1", &dark).unwrap();
    assert_eq!(
        receive_host_theme(&mut server),
        ClientHostThemeUpdate::Appearance(ClientHostAppearance::Dark)
    );
    assert!(matches!(
        receive_host_theme(&mut server),
        ClientHostThemeUpdate::DefaultColor {
            kind: ClientHostDefaultColorKind::Foreground,
            color: ClientHostColor { r: 0xee, .. },
        }
    ));
    assert!(matches!(
        receive_host_theme(&mut server),
        ClientHostThemeUpdate::DefaultColor {
            kind: ClientHostDefaultColorKind::Background,
            color: ClientHostColor { r: 0x11, .. },
        }
    ));
    let ClientHostThemeUpdate::PaletteColors(palette) = receive_host_theme(&mut server) else {
        panic!("expected palette")
    };
    assert_eq!(palette.len(), 256);
    assert!(
        palette
            .iter()
            .enumerate()
            .all(|(i, (index, color))| { usize::from(*index) == i && color.r == *index })
    );

    // Repeats queue nothing.
    client.handle.set_host_theme("boot-v1", &dark).unwrap();
    client.handle.set_host_theme("boot-v1", &dark).unwrap();
    assert_next_is_focus(&client, &mut server);

    // A system appearance flip is one update, ordered with other commands.
    let light = host_theme(ClientHostAppearance::Light);
    client.handle.set_host_theme("boot-v1", &light).unwrap();
    client.handle.set_focus("boot-v1", false).unwrap();
    assert_eq!(
        receive_host_theme(&mut server),
        ClientHostThemeUpdate::Appearance(ClientHostAppearance::Light)
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );

    let mut recolored = light.clone();
    recolored.palette[1] = ClientHostColor { r: 1, g: 2, b: 3 };
    client.handle.set_host_theme("boot-v1", &recolored).unwrap();
    assert_eq!(
        receive_host_theme(&mut server),
        ClientHostThemeUpdate::PaletteColors(vec![(1, ClientHostColor { r: 1, g: 2, b: 3 })])
    );
    assert_next_is_focus(&client, &mut server);
}

#[test]
fn each_connection_reports_the_whole_theme_again() {
    let theme = host_theme(ClientHostAppearance::Dark);
    // A reconnect is a new connection with its own handle, as is each SSH host.
    for remote in [false, true] {
        let (client, mut server, _worker) = test_client_mode(true, remote);
        if remote {
            server
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            receive(&mut server);
            let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
            welcome["methods"] = json!(["client_shell.surface.set"]);
            welcome["capabilities"] = json!([
                "surface_interest",
                "presentation_effects_fence",
                "health_check"
            ]);
            for (kind, data) in [
                (ENDPOINT_WELCOME_KIND, welcome.to_string()),
                (ENDPOINT_SNAPSHOT_KIND, SNAPSHOT.into()),
            ] {
                send(
                    &mut server,
                    ServerMessage::EndpointControl {
                        kind: kind.into(),
                        data,
                    },
                );
            }
        } else {
            handshake(&mut server);
        }
        event(&client);
        event(&client);
        client.handle.set_host_theme("boot-v1", &theme).unwrap();
        let updates: Vec<_> = (0..4).map(|_| receive_host_theme(&mut server)).collect();
        assert_eq!(updates, theme.updates(None));
        assert_next_is_focus(&client, &mut server);
    }
}

#[test]
fn host_theme_is_boot_fenced_and_a_failed_queue_resends_in_full() {
    let theme = host_theme(ClientHostAppearance::Dark);
    let (client, mut server, _worker) = test_client();
    // Before the first snapshot there is no boot to report against.
    assert!(matches!(
        client.handle.set_host_theme("", &theme),
        Err(Error::MissingBootId)
    ));
    handshake(&mut server);
    event(&client);
    event(&client);
    // The failed call recorded nothing, so this one still sends everything.
    client.handle.set_host_theme("boot-v1", &theme).unwrap();
    let updates: Vec<_> = (0..4).map(|_| receive_host_theme(&mut server)).collect();
    assert_eq!(updates, theme.updates(None));

    let disconnected = connect_with_connector(
        ConnectTarget::Local,
        ConnectOptions::default(),
        true,
        |_, _| Err::<Stream, _>(io::Error::other("offline")),
    )
    .unwrap();
    disconnected.handle.disconnect();
    assert!(matches!(
        disconnected.handle.set_host_theme("boot-v1", &theme),
        Err(Error::Disconnected)
    ));
}
