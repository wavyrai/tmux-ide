//! ElevenLabs subscription credits, read from `GET /v1/user/subscription`
//! with an API key sent as `xi-api-key`: the `api_key` setting (or
//! `ELEVENLABS_API_KEY` / `XI_API_KEY` here), else those variables on the
//! probed host. The key needs the `user_read` permission. Everything
//! CodexBar reads is ported: character credits with their reset, voice and
//! professional voice slots, and the plan tier and status.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Section, Window, group, title_case},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde::Deserialize;

const BASE: &str = "https://api.elevenlabs.io";

pub(crate) struct Elevenlabs;

static META: Meta = Meta::new("elevenlabs", "ElevenLabs")
    .dashboard("https://elevenlabs.io/app/subscription")
    .status_page("https://status.elevenlabs.io")
    .settings(&[
        Setting::new(
            "api_key",
            &["ELEVENLABS_API_KEY", "XI_API_KEY"],
            "An ElevenLabs API key with the user_read permission, from \
             https://elevenlabs.io/app/settings/api-keys.",
        ),
        Setting::new(
            "base_url",
            &["ELEVENLABS_API_URL"],
            "Optional HTTPS API origin for a proxy. Defaults to https://api.elevenlabs.io.",
        ),
    ]);

impl Service for Elevenlabs {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("ELEVENLABS_API_KEY"))
            .or_else(|| probe.env("XI_API_KEY"))?;
        let base = match values::https_base(probe.text_setting("base_url"), BASE) {
            Ok(base) => base,
            Err(error) => return Some(Err(error)),
        };
        let request = Request::get(format!("{base}/v1/user/subscription"))
            .secret_header("xi-api-key", "", &key)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let subscription: Subscription = json(body)?;
    let percent = |used: i64, limit: i64| used as f64 / limit as f64 * 100.;
    // Character credits renew with the billing month.
    let credits = Window::new(
        Kind::Monthly,
        if subscription.character_limit > 0 {
            percent(subscription.character_count, subscription.character_limit)
        } else {
            0.
        },
        subscription
            .next_character_count_reset_unix
            .as_ref()
            .and_then(Timestamp::time),
        Some(MONTH),
    );
    let slots = [
        (
            "Voice slots",
            subscription.voice_slots_used,
            subscription.voice_limit,
        ),
        (
            "Professional voices",
            subscription.professional_voice_slots_used,
            subscription.professional_voice_limit,
        ),
    ]
    .into_iter()
    .filter_map(|(title, used, limit)| {
        let (used, limit) = (used?, limit.filter(|limit| *limit > 0)?);
        Some((title, used, limit))
    })
    .collect::<Vec<_>>();
    let mut facts = vec![(
        "Credits".to_owned(),
        format!(
            "{} of {}",
            group(subscription.character_count),
            group(subscription.character_limit)
        ),
    )];
    facts.extend(
        slots
            .iter()
            .map(|(title, used, limit)| ((*title).to_owned(), format!("{used} of {limit}"))),
    );
    let tier = subscription
        .tier
        .as_deref()
        .map(str::trim)
        .filter(|tier| !tier.is_empty())
        .map(|tier| {
            tier.split('_')
                .filter(|word| !word.is_empty())
                .map(|word| title_case(&word.to_lowercase()))
                .collect::<Vec<_>>()
                .join(" ")
        });
    let status = subscription
        .status
        .as_deref()
        .map(str::trim)
        .filter(|status| !status.is_empty());
    let plan = match (tier, status) {
        (Some(tier), Some(status)) if !status.eq_ignore_ascii_case("active") => {
            Some(format!("{tier} · {status}"))
        }
        (Some(tier), _) => Some(tier),
        (None, status) => status.map(str::to_owned),
    };
    Ok(Report::new(
        Provider(&Elevenlabs),
        Account { email: None, plan },
        vec![credits],
    )
    .with_sections(
        slots
            .iter()
            .map(|(title, used, limit)| {
                Section::Limit(Window::new(
                    Kind::Named((*title).to_owned()),
                    percent(*used, *limit),
                    None,
                    None,
                ))
            })
            .chain([Section::Facts {
                title: "Usage".into(),
                facts,
            }])
            .collect::<Vec<_>>(),
    ))
}

#[derive(Deserialize)]
struct Subscription {
    character_count: i64,
    character_limit: i64,
    voice_slots_used: Option<i64>,
    voice_limit: Option<i64>,
    professional_voice_slots_used: Option<i64>,
    professional_voice_limit: Option<i64>,
    next_character_count_reset_unix: Option<Timestamp>,
    tier: Option<String>,
    status: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;
    use std::time::{Duration, SystemTime};

    /// Shaped like the documented subscription response.
    const SUBSCRIPTION: &str = r#"{
      "tier": "creator_annual",
      "character_count": 25000,
      "character_limit": 100000,
      "can_extend_character_limit": true,
      "voice_slots_used": 3,
      "voice_limit": 30,
      "professional_voice_slots_used": 1,
      "professional_voice_limit": 1,
      "next_character_count_reset_unix": 1790000000,
      "status": "active",
      "current_overage": null
    }"#;

    #[test]
    fn reads_credits_slots_and_plan() {
        let report = parse(SUBSCRIPTION).unwrap();
        assert_eq!(report.provider.id(), "elevenlabs");
        assert_eq!(report.account.plan.as_deref(), Some("Creator Annual"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert_eq!(window.percent(), 25);
        assert_eq!(
            window.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000))
        );
        let Section::Limit(voices) = &report.sections[0] else {
            panic!("expected a limit");
        };
        assert_eq!(voices.kind, Kind::Named("Voice slots".into()));
        assert_eq!(voices.percent(), 10);
        let Section::Limit(professional) = &report.sections[1] else {
            panic!("expected a limit");
        };
        assert_eq!(professional.percent(), 100);
        let Some(Section::Facts { facts, .. }) = report.sections.last() else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Credits".to_owned(), "25,000 of 100,000".to_owned())
        );
    }

    #[test]
    fn an_inactive_status_joins_the_plan() {
        let report =
            parse(r#"{"tier":"free","character_count":0,"character_limit":0,"status":"past_due"}"#)
                .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Free · past_due"));
        assert_eq!(report.windows[0].percent(), 0);
        assert_eq!(report.sections.len(), 1);
    }

    #[test]
    fn missing_counts_are_an_error() {
        assert!(matches!(
            parse(r#"{"tier":"free"}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
