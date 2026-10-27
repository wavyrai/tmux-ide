//! JetBrains AI Assistant credits, read from the quota file the IDE keeps in
//! its config directory (`options/AIAssistantQuotaManager2.xml`), as CodexBar
//! does. Nothing is sent over the network: the IDE refreshes the file.
//!
//! The IDE is found among the JetBrains and Android Studio config
//! directories (`~/Library/Application Support/{JetBrains,Google}` on a Mac,
//! `~/.config/{JetBrains,Google}` and `~/.local/share/JetBrains` elsewhere),
//! taking the most recently written quota file, or set with `ide_path`.

use crate::{
    Result,
    usage::{
        model::{
            Account, Balance, DAY, Kind, MONTH, Provider, Report, Section, Unit, WEEK, Window,
            group,
        },
        probe::{HostPath, Probe},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::Duration;

const QUOTA_FILE: &str = "AIAssistantQuotaManager2.xml";
/// Lists every IDE's quota file, newest first. The unmatched patterns of
/// other platforms only print to the discarded standard error.
const FIND: &str = r#"ls -1t "$HOME/Library/Application Support/JetBrains"/*/options/AIAssistantQuotaManager2.xml "$HOME/Library/Application Support/Google"/*/options/AIAssistantQuotaManager2.xml "$HOME/.config/JetBrains"/*/options/AIAssistantQuotaManager2.xml "$HOME/.local/share/JetBrains"/*/options/AIAssistantQuotaManager2.xml "$HOME/.config/Google"/*/options/AIAssistantQuotaManager2.xml 2>/dev/null"#;
const IDES: &[(&str, &str)] = &[
    ("IntelliJIdea", "IntelliJ IDEA"),
    ("PyCharm", "PyCharm"),
    ("WebStorm", "WebStorm"),
    ("GoLand", "GoLand"),
    ("CLion", "CLion"),
    ("DataGrip", "DataGrip"),
    ("RubyMine", "RubyMine"),
    ("Rider", "Rider"),
    ("PhpStorm", "PhpStorm"),
    ("AppCode", "AppCode"),
    ("Fleet", "Fleet"),
    ("AndroidStudio", "Android Studio"),
    ("RustRover", "RustRover"),
    ("Aqua", "Aqua"),
    ("DataSpell", "DataSpell"),
];

pub(crate) struct Jetbrains;

static META: Meta = Meta::new("jetbrains", "JetBrains AI").settings(&[Setting::new(
    "ide_path",
    &[],
    "The config directory of the IDE to read, when the most recently used one is not \
         the right one, e.g. \"~/Library/Application Support/JetBrains/IntelliJIdea2025.3\" \
         on a Mac or \"~/.config/JetBrains/PyCharm2025.3\" on Linux. Its \
         options/AIAssistantQuotaManager2.xml appears once AI Assistant has been used.",
)]);

impl Service for Jetbrains {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let (path, ide) = match probe.text_setting("ide_path") {
            Some(base) => {
                let base = base.trim_end_matches('/');
                let file = format!("{base}/options/{QUOTA_FILE}");
                let path = match file.strip_prefix("~/") {
                    Some(rest) => HostPath::home(rest),
                    None => HostPath::absolute(file.as_str()),
                };
                (path, ide(base))
            }
            None => {
                let listing = probe
                    .command("sh", &["-c", FIND], Duration::from_secs(10))
                    .ok()?;
                let (file, ide) = listing.stdout.lines().find_map(|line| {
                    let line = line.trim();
                    let base = line.strip_suffix(&format!("/options/{QUOTA_FILE}"))?;
                    Some((line.to_owned(), Some(ide(base)?)))
                })?;
                (HostPath::absolute(file), ide)
            }
        };
        let xml = probe.read(&path)?;
        Some(parse(&xml, ide))
    }
}

/// An IDE named by its config directory, e.g. `IntelliJIdea2025.3`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Ide {
    name: &'static str,
    version: String,
}

fn ide(base: &str) -> Option<Ide> {
    let directory = base.rsplit('/').next()?;
    IDES.iter().find_map(|&(prefix, name)| {
        let head = directory.get(..prefix.len())?;
        head.eq_ignore_ascii_case(prefix).then(|| Ide {
            name,
            version: directory[prefix.len()..].to_owned(),
        })
    })
}

pub(crate) fn parse(xml: &str, ide: Option<Ide>) -> Result<Report> {
    let component = component(xml).ok_or_else(invalid)?;
    let quota: Quota = json(&decode(
        &option(component, "quotaInfo").ok_or_else(invalid)?,
    ))?;
    let refill = option(component, "nextRefill")
        .and_then(|raw| serde_json::from_str::<Refill>(&decode(&raw)).ok());

    let maximum = quota.maximum.unwrap_or(0.).max(0.);
    let used = quota.current.unwrap_or(0.).max(0.);
    let available = quota
        .tariff_quota
        .as_ref()
        .and_then(|tariff| tariff.available)
        .unwrap_or((maximum - used).max(0.));
    let percent = if maximum > 0. {
        used / maximum * 100.
    } else {
        0.
    };

    let resets_at = refill
        .as_ref()
        .and_then(|refill| refill.next.as_ref())
        .and_then(Timestamp::time);
    let period = refill.as_ref().and_then(|refill| {
        refill
            .duration
            .as_deref()
            .or_else(|| refill.tariff.as_ref()?.duration.as_deref())
            .and_then(hours)
    });
    let kind = match period {
        Some(length) if length.abs_diff(DAY) < Duration::from_secs(3600) => Kind::Daily,
        Some(length) if length.abs_diff(WEEK) < Duration::from_secs(3600) => Kind::Weekly,
        _ => Kind::Monthly,
    };
    let window = Window::new(kind, percent, resets_at, Some(period.unwrap_or(MONTH)));

    let mut facts = Vec::new();
    if let Some(ide) = &ide {
        facts.push(("IDE".to_owned(), format!("{} {}", ide.name, ide.version)));
    }
    if let Some(kind) = quota.kind.filter(|kind| !kind.trim().is_empty()) {
        facts.push(("Quota".to_owned(), kind));
    }
    let amount = refill.as_ref().and_then(|refill| {
        refill
            .amount
            .or(refill.tariff.as_ref().and_then(|tariff| tariff.amount))
    });
    if let Some(amount) = amount {
        let every = period.map_or_else(String::new, |period| {
            format!(" every {} days", (period.as_secs() / 86_400).max(1))
        });
        facts.push((
            "Refill".to_owned(),
            format!("{} credits{every}", group(amount.round() as i64)),
        ));
    }

    Ok(
        Report::new(Provider(&Jetbrains), Account::default(), vec![window])
            .with_balances([
                Balance::new("Credits left", available, Unit::Count("credits".into()))
                    .out_of(maximum),
            ])
            .with_sections((!facts.is_empty()).then(|| Section::Facts {
                title: "AI Assistant".into(),
                facts,
            })),
    )
}

/// The body of `<component name="AIAssistantQuotaManager2">`.
fn component(xml: &str) -> Option<&str> {
    let mut rest = xml;
    loop {
        let start = rest.find("<component")?;
        let tag_end = start + rest[start..].find('>')?;
        let tag = &rest[start..tag_end];
        let after = &rest[tag_end + 1..];
        if attribute(tag, "name") == Some("AIAssistantQuotaManager2") {
            let end = after.find("</component>").unwrap_or(after.len());
            return Some(&after[..end]);
        }
        rest = after;
    }
}

/// The raw `value` of `<option name="…" value="…"/>`.
fn option(component: &str, name: &str) -> Option<String> {
    let mut rest = component;
    while let Some(start) = rest.find("<option") {
        let tag_end = start + rest[start..].find('>')?;
        let tag = &rest[start..tag_end];
        if attribute(tag, "name") == Some(name) {
            return attribute(tag, "value").map(str::to_owned);
        }
        rest = &rest[tag_end + 1..];
    }
    None
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = tag;
    while let Some(at) = rest.find(name) {
        let preceded = rest[..at]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
        let after = rest[at + name.len()..].trim_start();
        rest = &rest[at + name.len()..];
        let Some(after) = after.strip_prefix('=').map(str::trim_start) else {
            continue;
        };
        if !preceded {
            continue;
        }
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let value = &after[1..];
        return value.find(quote).map(|end| &value[..end]);
    }
    None
}

/// XML character references, decoded once so `&amp;lt;` stays `&lt;`.
fn decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| Some((reference(&rest[1..end])?, end)));
        match entity {
            Some((character, end)) => {
                out.push(character);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn reference(name: &str) -> Option<char> {
    match name {
        "quot" => Some('"'),
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "apos" => Some('\''),
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// `PT720H` as thirty days; only the hour form the IDE writes is read.
fn hours(duration: &str) -> Option<Duration> {
    let hours: u64 = duration
        .strip_prefix("PT")?
        .strip_suffix('H')?
        .parse()
        .ok()?;
    (hours > 0).then(|| Duration::from_secs(hours * 3600))
}

#[derive(Deserialize)]
struct Quota {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "number")]
    current: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    maximum: Option<f64>,
    #[serde(rename = "tariffQuota")]
    tariff_quota: Option<TariffQuota>,
}

#[derive(Deserialize)]
struct TariffQuota {
    #[serde(default, deserialize_with = "number")]
    available: Option<f64>,
}

#[derive(Deserialize)]
struct Refill {
    next: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    amount: Option<f64>,
    duration: Option<String>,
    tariff: Option<Tariff>,
}

#[derive(Deserialize)]
struct Tariff {
    #[serde(default, deserialize_with = "number")]
    amount: Option<f64>,
    duration: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    /// CodexBar's real-world fixture: HTML-encoded JSON in XML attributes.
    const FIXTURE: &str = concat!(
        r#"<?xml version="1.0" encoding="UTF-8"?>"#,
        "\n<application>\n  <component name=\"AIAssistantQuotaManager2\">\n    <option\n      name=\"quotaInfo\"\n      value=\"",
        "{&#10;  &quot;type&quot;: &quot;Available&quot;,",
        "&#10;  &quot;current&quot;: &quot;7478.3&quot;,",
        "&#10;  &quot;maximum&quot;: &quot;1000000&quot;,",
        "&#10;  &quot;until&quot;: &quot;2026-11-09T21:00:00Z&quot;,",
        "&#10;  &quot;tariffQuota&quot;: {",
        "&#10;    &quot;current&quot;: &quot;7478.3&quot;,",
        "&#10;    &quot;maximum&quot;: &quot;1000000&quot;,",
        "&#10;    &quot;available&quot;: &quot;992521.7&quot;",
        "&#10;  }&#10;}",
        "\" />\n    <option\n      name=\"nextRefill\"\n      value=\"",
        "{&#10;  &quot;type&quot;: &quot;Known&quot;,",
        "&#10;  &quot;next&quot;: &quot;2026-01-16T14:00:54.939Z&quot;,",
        "&#10;  &quot;tariff&quot;: {",
        "&#10;    &quot;amount&quot;: &quot;1000000&quot;,",
        "&#10;    &quot;duration&quot;: &quot;PT720H&quot;",
        "&#10;  }&#10;}",
        "\" />\n  </component>\n</application>\n"
    );

    #[test]
    fn reads_the_monthly_quota() {
        let ide = ide("/Users/me/Library/Application Support/JetBrains/IntelliJIdea2025.3");
        assert_eq!(
            ide,
            Some(Ide {
                name: "IntelliJ IDEA",
                version: "2025.3".into(),
            })
        );
        let report = parse(FIXTURE, ide).unwrap();
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert_eq!(window.length, Some(MONTH));
        assert!((window.used - 0.74783).abs() < 1e-4);
        let reset = SystemTime::UNIX_EPOCH + Duration::from_millis(1_768_572_054_939);
        assert_eq!(window.resets_at, Some(reset));
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Credits left", 992_521.7, Unit::Count("credits".into()))
                    .out_of(1_000_000.)
            ]
        );
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "AI Assistant".into(),
                facts: vec![
                    ("IDE".into(), "IntelliJ IDEA 2025.3".into()),
                    ("Quota".into(), "Available".into()),
                    ("Refill".into(), "1,000,000 credits every 30 days".into()),
                ],
            }]
        );
    }

    #[test]
    fn falls_back_to_maximum_minus_current() {
        let xml = concat!(
            "<application><component name='AIAssistantQuotaManager2'>",
            "<option name='quotaInfo' value='{&quot;type&quot;:&quot;paid&quot;,",
            "&quot;current&quot;:&quot;50000&quot;,&quot;maximum&quot;:&quot;100000&quot;}'/>",
            "</component></application>"
        );
        let report = parse(xml, None).unwrap();
        assert_eq!(report.windows[0].percent(), 50);
        assert_eq!(report.windows[0].resets_at, None);
        assert_eq!(report.balances[0].amount, 50_000.);
    }

    #[test]
    fn ignores_directories_of_other_apps() {
        assert_eq!(ide("/home/me/.config/Google/Chrome"), None);
        assert_eq!(
            ide("/home/me/.config/Google/AndroidStudio2025.1").map(|ide| ide.name),
            Some("Android Studio")
        );
    }

    #[test]
    fn decodes_each_reference_once() {
        assert_eq!(decode("a&amp;lt;b&#10;&quot;&bogus"), "a&lt;b\n\"&bogus");
    }

    #[test]
    fn rejects_a_file_without_quota() {
        assert!(parse("<application/>", None).is_err());
    }
}
