use super::*;
fn row(n: u128) -> Row {
    Row {
        id: uuid::Uuid::from_u128(n).to_string(),
        label: "Duplicate".into(),
        host_label: "Machine".into(),
        server_label: None,
        available: true,
        unread: false,
        activity: None,
        activate: uuid::Uuid::from_u128(n + 10).to_string(),
        close: uuid::Uuid::from_u128(n + 20).to_string(),
    }
}
fn publication() -> Publication {
    Publication {
        request: 7,
        revision: 1,
        rows: vec![row(1), row(2)],
        active: Some(row(1).id),
        pending: None,
        next: Some(row(2).activate),
        previous: Some(row(2).activate),
        close_active: Some(row(1).close),
    }
}
#[test]
fn bounded_exact_tab_references_and_unique_capabilities() {
    let p = publication();
    assert!(p.valid());
    let mut p = publication();
    p.rows[1].id = p.rows[0].id.clone();
    assert!(!p.valid());
    let mut p = publication();
    p.rows[1].activate = p.rows[0].close.clone();
    assert!(!p.valid());
    let mut p = publication();
    p.pending = Some(uuid::Uuid::nil().to_string());
    assert!(!p.valid());
    let mut p = publication();
    p.close_active = Some(p.rows[1].close.clone());
    assert!(!p.valid());
    let mut p = publication();
    p.next = Some(uuid::Uuid::nil().to_string());
    assert!(!p.valid());
    let mut p = publication();
    p.rows[0].label = "界".repeat(161);
    assert!(!p.valid());
    let mut p = publication();
    p.rows[0].host_label = "bad\nlabel".into();
    assert!(!p.valid());
    let mut p = publication();
    p.rows = (1..=9).map(row).collect();
    assert!(!p.valid());
    let mut p = publication();
    p.revision = 0;
    assert!(!p.valid());
}
