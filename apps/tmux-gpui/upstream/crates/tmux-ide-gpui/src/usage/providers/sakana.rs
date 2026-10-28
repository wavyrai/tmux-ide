//! Sakana AI subscription windows and pay-as-you-go credit, read from the
//! console.sakana.ai billing page with the web session: the `cookie`
//! setting (or `SAKANA_COOKIE`), else (when listed) the console.sakana.ai
//! cookies from Chrome or Safari. Sakana has no JSON API, so the
//! server-rendered billing HTML is read, as CodexBar does.
//!
//! Everything CodexBar reads is ported. CodexBar imports no browser cookies
//! for Sakana; the automatic import here is an addition.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, SESSION, Section, Unit, WEEK, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting},
        values::invalid,
    },
};
use std::time::{Duration, SystemTime};

const BILLING_URL: &str = "https://console.sakana.ai/billing";
const PAYG_URL: &str = "https://console.sakana.ai/billing?tab=payAsYouGo";

pub(crate) struct Sakana;

static META: Meta = Meta::new("sakana", "Sakana AI")
    .dashboard("https://console.sakana.ai/billing")
    .settings(&[Setting::new(
        "cookie",
        &["SAKANA_COOKIE"],
        "Sign in to https://console.sakana.ai, open Developer Tools > Application > \
         Cookies for https://console.sakana.ai, and copy every cookie there (the \
         sign-in session cookies are required). Paste them as \"name=value; \
         name2=value2\"; the Cookie header of a request to console.sakana.ai/billing \
         in the Network tab also works.",
    )]);

impl Service for Sakana {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["console.sakana.ai", "sakana.ai"], &[])?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let page = |url: &str| {
        Request::get(url)
            .cookie(cookie)
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "en-US,en;q=0.9")
    };
    let response = probe.http(page(BILLING_URL))?;
    // The console redirects a signed-out session to its login page.
    if (300..400).contains(&response.status) {
        return Err(Error::UsageRejected);
    }
    let billing = response.ok()?;
    // Pay-as-you-go credit is optional; the subscription windows stand without it.
    let payg = probe
        .body(page(PAYG_URL).timeout(Duration::from_secs(5)))
        .ok();
    parse(&billing, payg.as_deref())
}

pub(crate) fn parse(billing: &str, payg: Option<&str>) -> Result<Report> {
    let nodes = nodes(billing);
    let windows: Vec<Window> = [
        ("5-hour", Kind::Session, SESSION),
        ("Weekly", Kind::Weekly, WEEK),
    ]
    .into_iter()
    .filter_map(|(label, kind, length)| window(&nodes, label, kind, length).transpose())
    .collect::<Result<_>>()?;
    if windows.is_empty() {
        // A page without usage windows is the login page or a changed layout.
        return Err(Error::UsageRejected);
    }
    let plan = plan(&nodes);
    let (balances, sections) = payg.and_then(pay_as_you_go).unwrap_or_default();
    Ok(
        Report::new(Provider(&Sakana), Account { email: None, plan }, windows)
            .with_balances(balances)
            .with_sections(sections),
    )
}

/// A window's body runs from its label to the next window label or card.
fn window(nodes: &[Node], label: &str, kind: Kind, length: Duration) -> Result<Option<Window>> {
    let Some(start) = nodes
        .iter()
        .position(|node| matches!(node, Node::Text(text) if text == label))
    else {
        return Ok(None);
    };
    let body = nodes.iter().skip(start + 1).take_while(|node| match node {
        Node::Text(text) => text != "5-hour" && text != "Weekly",
        Node::Tag(tag) => !is_card(tag),
    });
    let mut used = None;
    let mut resets_at = None;
    for node in body {
        let Node::Text(text) = node else { continue };
        if let Some(percent) = text.strip_suffix("% used") {
            used = percent.trim().parse::<f64>().ok();
            if used.is_none() {
                return Err(invalid());
            }
        } else if let Some(date) = text.strip_prefix("Resets on ") {
            resets_at = reset_time(date);
        }
    }
    let used = used
        .filter(|used| (0. ..=100.).contains(used))
        .ok_or_else(invalid)?;
    Ok(Some(Window::new(kind, used, resets_at, Some(length))))
}

fn is_card(tag: &str) -> bool {
    tag.starts_with("div")
        && [
            "data-slot=\"card\"",
            "data-slot='card'",
            "data-slot=\"card-title\"",
            "data-slot='card-title'",
        ]
        .iter()
        .any(|slot| tag.contains(slot))
}

/// The page renders "Resets on June 23, 2026 at 2:53 PM" in UTC; only the
/// browser localizes it after hydration.
fn reset_time(text: &str) -> Option<SystemTime> {
    let at = chrono::NaiveDateTime::parse_from_str(text.trim(), "%B %d, %Y at %I:%M %p").ok()?;
    let seconds = u64::try_from(at.and_utc().timestamp()).ok()?;
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

/// The plan card title holds the plan name and its price, e.g. `Standard $20/mo`.
fn plan(nodes: &[Node]) -> Option<String> {
    let title = nodes.iter().position(|node| match node {
        Node::Tag(tag) => tag.starts_with("div") && tag.contains("data-slot=\"card-title\""),
        Node::Text(_) => false,
    })?;
    let mut spans = Vec::new();
    let mut in_span = false;
    for node in nodes.iter().skip(title + 1) {
        match node {
            Node::Tag(tag) if tag.starts_with("span") => in_span = true,
            Node::Tag(tag) if tag.starts_with("/span") => in_span = false,
            Node::Tag(tag) if tag.starts_with("/div") => break,
            Node::Text(text) if in_span => spans.push(text.as_str()),
            _ => {}
        }
        if spans.len() == 2 {
            break;
        }
    }
    (!spans.is_empty()).then(|| spans.join(" "))
}

/// The pay-as-you-go tab: the credit balance and the selected range's spend.
fn pay_as_you_go(html: &str) -> Option<(Vec<Balance>, Vec<Section>)> {
    let nodes = nodes(html);
    let heading = nodes
        .iter()
        .position(|node| matches!(node, Node::Text(text) if text == "Credit balance"))?;
    let balance = nodes
        .iter()
        .skip(heading + 1)
        .take(12)
        .scan(false, |amount_next, node| {
            let found = match node {
                Node::Tag(tag) => {
                    *amount_next = tag.starts_with('p') && tag.contains("tabular-nums");
                    None
                }
                Node::Text(text) if *amount_next => money(text),
                Node::Text(_) => None,
            };
            Some(found)
        })
        .flatten()
        .next()?;
    let usd = || Unit::Currency("USD".into());
    let mut balances = vec![Balance::new("Credit balance", balance, usd())];
    let usage = nodes
        .iter()
        .position(|node| matches!(node, Node::Text(text) if text == "Usage"))
        .and_then(|index| {
            nodes
                .iter()
                .skip(index + 1)
                .take(4)
                .find_map(|node| match node {
                    Node::Text(text) => money(text.strip_prefix("Total")?.trim_start_matches(':')),
                    Node::Tag(_) => None,
                })
        });
    let range = nodes
        .iter()
        .position(|node| matches!(node, Node::Tag(tag) if tag.contains("aria-label=\"Usage date range\"")))
        .and_then(|index| match nodes.get(index + 1) {
            Some(Node::Text(text)) => Some(text.clone()),
            _ => None,
        });
    let mut sections = Vec::new();
    if let Some(spent) = usage {
        balances.push(Balance::new("Pay-as-you-go usage", spent, usd()));
        if let Some(range) = range {
            sections.push(Section::Facts {
                title: "Pay as you go".into(),
                facts: vec![("Usage period".into(), range)],
            });
        }
    }
    Some((balances, sections))
}

/// `$1,234.50` as 1234.5.
fn money(text: &str) -> Option<f64> {
    let text = text.trim();
    let text = text.strip_prefix('$').unwrap_or(text).replace(',', "");
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

#[derive(Debug, PartialEq)]
enum Node {
    /// A tag's inside, without the angle brackets, e.g. `p class="x"` or `/p`.
    Tag(String),
    /// Text between tags, with entities for `&`, `<`, `>`, quotes, and spaces
    /// decoded, whitespace collapsed, and React's `<!-- -->` separators joined.
    Text(String),
}

/// Splits HTML into tags and non-empty text. Comments are dropped and the
/// text around them joined; scripts and styles are skipped.
fn nodes(html: &str) -> Vec<Node> {
    let mut nodes = Vec::new();
    let mut text = String::new();
    let mut rest = html;
    let flush = |text: &mut String, nodes: &mut Vec<Node>| {
        let collapsed = decode(&text.split_whitespace().collect::<Vec<_>>().join(" "));
        if !collapsed.is_empty() {
            nodes.push(Node::Text(collapsed));
        }
        text.clear();
    };
    while let Some(open) = rest.find('<') {
        text.push_str(&rest[..open]);
        rest = &rest[open..];
        if let Some(comment) = rest.strip_prefix("<!--") {
            rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
            continue;
        }
        let Some(close) = rest.find('>') else {
            rest = "";
            break;
        };
        let tag = rest[1..close].trim();
        rest = &rest[close + 1..];
        flush(&mut text, &mut nodes);
        let name = tag
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name == "script" || name == "style" {
            let end = format!("</{name}");
            rest = rest.find(&end).map_or("", |at| &rest[at..]);
        }
        nodes.push(Node::Tag(tag.to_owned()));
    }
    text.push_str(rest);
    flush(&mut text, &mut nodes);
    nodes
}

fn decode(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const BILLING: &str = r#"
    <main>
      <div data-slot="card-title"><span>Standard</span><span>$20/mo</span></div>
      <div data-slot="card-title">Usage limit</div>
      <p class="font-medium text-sm">5-hour</p>
      <p class="text-muted-foreground text-xs tabular-nums">Resets on June 23, 2026 at 2:53 PM</p>
      <button aria-label="The 5-hour window starts with your first request."></button>
      <p class="text-muted-foreground text-sm">92% used</p>
      <p class="font-medium text-sm">Weekly</p>
      <p class="text-muted-foreground text-xs tabular-nums">Resets on June 29, 2026 at 12:00 AM</p>
      <button aria-label="Weekly usage resets every Monday at 00:00 UTC."></button>
      <p class="text-muted-foreground text-sm">32% used</p>
    </main>
    "#;

    const PAYG: &str = r#"
    <main>
      <h2 class="font-semibold text-base">Credit balance</h2>
      <button aria-label="Credit updates may be delayed."></button>
      <p class="font-semibold text-3xl tabular-nums">$12.34</p>
      <button aria-label="Usage date range">Jun 02, 2026<!-- --> -<!-- --> <!-- -->Jul 01, 2026</button>
      <h2 class="font-semibold">Usage</h2>
      <span class="text-muted-foreground text-sm">Total<!-- -->: <!-- -->$5.67</span>
    </main>
    "#;

    fn utc(text: &str) -> SystemTime {
        let at = chrono::DateTime::parse_from_rfc3339(text).unwrap();
        SystemTime::UNIX_EPOCH + Duration::from_secs(at.timestamp() as u64)
    }

    #[test]
    fn billing_page_maps_windows_and_plan() {
        let report = parse(BILLING, None).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Standard $20/mo"));
        assert_eq!(
            report.windows,
            vec![
                Window::new(
                    Kind::Session,
                    92.,
                    Some(utc("2026-06-23T14:53:00Z")),
                    Some(SESSION)
                ),
                Window::new(
                    Kind::Weekly,
                    32.,
                    Some(utc("2026-06-29T00:00:00Z")),
                    Some(WEEK)
                ),
            ]
        );
        assert!(report.balances.is_empty());
    }

    #[test]
    fn pay_as_you_go_tab_adds_credit() {
        let report = parse(BILLING, Some(PAYG)).unwrap();
        let usd = Unit::Currency("USD".into());
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Credit balance", 12.34, usd.clone()),
                Balance::new("Pay-as-you-go usage", 5.67, usd),
            ]
        );
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Pay as you go".into(),
                facts: vec![("Usage period".into(), "Jun 02, 2026 - Jul 01, 2026".into())],
            }]
        );
    }

    #[test]
    fn invalid_percentages_and_login_pages_fail() {
        let over = BILLING.replace("92% used", "101% used");
        assert!(matches!(parse(&over, None), Err(Error::UsageJson(_))));
        assert!(matches!(
            parse("<html><body>Sign in</body></html>", None),
            Err(Error::UsageRejected)
        ));
    }
}
