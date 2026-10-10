use super::*;
use crate::usage::model::{Balance, Severity, Unit, countdown, group};

#[test]
fn labels_count_down_in_the_two_coarsest_units() {
    assert_eq!(countdown(Duration::ZERO), "0m");
    assert_eq!(countdown(Duration::from_secs(47 * 60 - 30)), "47m");
    assert_eq!(countdown(Duration::from_secs(2 * 3600 + 53 * 60)), "2h 53m");
    assert_eq!(
        countdown(Duration::from_secs(4 * 86_400 + 11 * 3600 + 59)),
        "4d 11h"
    );
    let now = at(1_000_000);
    let session = Window::new(
        Kind::Session,
        2.4,
        Some(now + Duration::from_secs(10_380)),
        None,
    );
    assert_eq!(session.label(now), "2% used 2h 53m");
    assert_eq!(
        session.label(now + Duration::from_secs(20_000)),
        "2% used 0m"
    );
    let named = Window::new(Kind::Named("Fable".into()), 0., Some(now), None);
    assert_eq!(named.label(now), "0% used Fable");
    for (kind, suffix) in [
        (Kind::Session, "5h"),
        (Kind::Daily, "day"),
        (Kind::Weekly, "wk"),
        (Kind::Monthly, "mo"),
    ] {
        assert_eq!(
            Window::new(kind, 1., None, None).label(now),
            format!("1% used {suffix}")
        );
    }
}

#[test]
fn pace_compares_use_with_an_even_spend() {
    let now = at(1_000_000);
    let window =
        |used, left: Duration| Window::new(Kind::Weekly, used, Some(now + left), Some(WEEK));
    let pace = window(20., WEEK / 2).pace(now).unwrap();
    assert_eq!(pace.describe(20.), "30% in reserve · Lasts until reset");
    let pace = window(50., WEEK * 3 / 4).pace(now).unwrap();
    assert_eq!(pace.runs_out, Some(WEEK / 4));
    assert_eq!(pace.describe(50.), "25% in deficit · Runs out in 1d 18h");
    assert_eq!(
        window(49.8, WEEK / 2).pace(now).unwrap().describe(49.8),
        "On pace · Lasts until reset"
    );
    assert_eq!(window(1., WEEK).pace(now), None);
    assert_eq!(window(1., WEEK / 2).pace(now + WEEK), None);
}

#[test]
fn balances_read_in_their_own_unit() {
    let usd = Balance::new("Credits", 12.3, Unit::Currency("USD".into()));
    assert_eq!(usd.text(), "$12.30");
    assert_eq!(usd.clone().out_of(50.).text(), "$12.30 of $50.00");
    assert_eq!(
        Balance::new("Left", 4.5, Unit::Currency("EUR".into())).text(),
        "4.50 EUR"
    );
    assert_eq!(
        Balance::new("Points", 1_250_000., Unit::Count("points".into())).text(),
        "1,250,000 points"
    );
    assert_eq!(group(-1234), "-1,234");
    assert_eq!(Severity::from(60.), Severity::Warning);
}
