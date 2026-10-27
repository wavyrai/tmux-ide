//! IBM Bob Bobcoin usage, read from the admin API with an API key from the
//! config or `BOBSHELL_API_KEY` (sent as `Apikey <key>`), or an IBM Cloud
//! bearer JWT in the `token` setting (sent as `Bearer <token>`); CodexBar
//! tells the two apart by looking inside the value, which a secret here never
//! allows. `admin/v1/profile` lists the subscription instances and teams, and
//! each team's budget is read from its instance's regional host, which must
//! be under `bob.ibm.com` before the key is sent there. Bob has no local
//! sign-in that CodexBar reads.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, plain},
    },
};
use serde::Deserialize;
use std::time::SystemTime;

const BASE: &str = "https://api.us-east.bob.ibm.com";
const BOB: &str = "bob.ibm.com";

pub(crate) struct Ibmbob;

static META: Meta = Meta::new("ibmbob", "IBM Bob")
    .dashboard("https://bob.ibm.com")
    .status_page("https://status.bob.ibm.com")
    .settings(&[
        Setting::new(
            "api_key",
            &["BOBSHELL_API_KEY"],
            "An IBM Bob API key that can read subscription usage, created at \
             https://bob.ibm.com (the same key Bob Shell uses as BOBSHELL_API_KEY).",
        ),
        Setting::new(
            "token",
            &[],
            "Instead of an API key, an IBM Cloud bearer token (a JWT) for your Bob account. \
             It is sent as \"Authorization: Bearer <token>\".",
        ),
    ]);

impl Service for Ibmbob {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let auth = match probe.setting("token") {
            Some(token) => Auth::Bearer(token),
            None => Auth::Key(probe.setting("api_key")?),
        };
        Some(read(probe, &auth))
    }
}

enum Auth {
    Key(Secret),
    Bearer(Secret),
}

impl Auth {
    fn request(&self, url: impl Into<String>) -> Request {
        let request = Request::get(url)
            .header("Accept", "application/json")
            .header("User-Agent", "CodexBar");
        match self {
            Self::Key(key) => request.secret_header("Authorization", "Apikey ", key),
            Self::Bearer(token) => request.bearer(token),
        }
    }
}

fn read(probe: &mut Probe, auth: &Auth) -> Result<Report> {
    let profile = probe.body(auth.request(format!("{BASE}/admin/v1/profile")))?;
    let mut teams = Vec::new();
    for target in parse_profile(&profile)? {
        let request = auth
            .request(&target.url)
            .header("x-instance-id", target.instance_id.as_str())
            .header("x-team-id", target.team_id.as_str());
        let body = probe.body(request)?;
        teams.push(target.usage(&body)?);
    }
    report(&teams)
}

/// One team budget to read, with where to read it.
#[derive(Debug)]
pub(crate) struct Target {
    url: String,
    instance_id: String,
    team_id: String,
    instance: String,
    team: String,
    plan: Option<String>,
    limit: Option<f64>,
    resets_at: Option<SystemTime>,
}

impl Target {
    pub(crate) fn usage(self, body: &str) -> Result<Team> {
        let budget: Budget = json(body)?;
        Ok(Team {
            instance: self.instance,
            team: self.team,
            plan: self.plan,
            used: budget.usage.max(0.),
            limit: budget
                .budget_limit
                .or(self.limit)
                .filter(|limit| *limit >= 0.),
            resets_at: self.resets_at,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Team {
    instance: String,
    team: String,
    plan: Option<String>,
    used: f64,
    limit: Option<f64>,
    resets_at: Option<SystemTime>,
}

pub(crate) fn parse_profile(body: &str) -> Result<Vec<Target>> {
    let profile: Profile = json(body)?;
    let mut targets = Vec::new();
    for instance in profile.instances {
        let Some(user) = non_empty(instance.user_id.as_deref()) else {
            continue;
        };
        // A host outside Bob's domain must never receive the key.
        let base = regional_base(instance.region_domain.as_deref()).ok_or_else(invalid)?;
        let name = non_empty(instance.instance_name.as_deref())
            .or_else(|| non_empty(instance.name.as_deref()))
            .unwrap_or(&instance.instance_id)
            .to_owned();
        let plan = non_empty(instance.plan_name.as_deref()).map(str::to_owned);
        let resets_at = instance.refresh_at.as_ref().and_then(Timestamp::time);
        for team in instance.teams {
            if team.id.is_empty() {
                continue;
            }
            let mut url = base.clone();
            url.path_segments_mut().map_err(|()| invalid())?.extend([
                "admin",
                "v1",
                "teams",
                team.id.as_str(),
                "users",
                user,
            ]);
            targets.push(Target {
                url: url.to_string(),
                instance_id: instance.instance_id.clone(),
                team: non_empty(team.name.as_deref())
                    .unwrap_or(&team.id)
                    .to_owned(),
                team_id: team.id,
                instance: name.clone(),
                plan: plan.clone(),
                limit: team.budget_limit,
                resets_at,
            });
        }
    }
    Ok(targets)
}

/// `us-east.bob.ibm.com` as `https://api.us-east.bob.ibm.com`, or None when
/// the host is not Bob's.
fn regional_base(domain: Option<&str>) -> Option<url::Url> {
    let Some(domain) = non_empty(domain) else {
        return url::Url::parse(BASE).ok();
    };
    let host = if domain.to_ascii_lowercase().starts_with("api.") {
        domain.to_owned()
    } else {
        format!("api.{domain}")
    };
    let url = url::Url::parse(&format!("https://{host}")).ok()?;
    let parsed = url.host_str()?.to_ascii_lowercase();
    let trusted = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && (parsed == BOB || parsed.ends_with(".bob.ibm.com"));
    trusted.then_some(url)
}

pub(crate) fn report(teams: &[Team]) -> Result<Report> {
    if teams.is_empty() {
        // The key reads no subscription at all.
        return Err(invalid());
    }
    let used: f64 = teams.iter().map(|team| team.used).sum();
    let limit = teams
        .iter()
        .map(|team| team.limit)
        .sum::<Option<f64>>()
        .filter(|limit| *limit > 0.);
    let resets_at = teams.iter().filter_map(|team| team.resets_at).min();
    let windows = limit
        .map(|limit| Window::new(Kind::Monthly, used / limit * 100., resets_at, Some(MONTH)))
        .into_iter()
        .collect();
    let mut balance = Balance::new("Bobcoins used", used, Unit::Count("Bobcoins".into()));
    if let Some(limit) = limit {
        balance = balance.out_of(limit);
    }
    let mut plans: Vec<&str> = teams
        .iter()
        .filter_map(|team| team.plan.as_deref())
        .collect();
    plans.sort_unstable();
    plans.dedup();
    let facts = teams
        .iter()
        .map(|team| {
            let label = if team.team == team.instance {
                team.team.clone()
            } else {
                format!("{} · {}", team.instance, team.team)
            };
            let value = match team.limit {
                Some(limit) => format!("{} / {} Bobcoins", plain(team.used), plain(limit)),
                None => format!("{} Bobcoins used", plain(team.used)),
            };
            (label, value)
        })
        .collect();
    Ok(Report::new(
        Provider(&Ibmbob),
        Account {
            email: None,
            plan: (!plans.is_empty()).then(|| plans.join(", ")),
        },
        windows,
    )
    .with_balances([balance])
    .with_sections([Section::Facts {
        title: "Bobcoin usage".into(),
        facts,
    }]))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[derive(Deserialize)]
struct Profile {
    instances: Vec<Instance>,
}

#[derive(Deserialize)]
struct Instance {
    instance_id: String,
    instance_name: Option<String>,
    name: Option<String>,
    user_id: Option<String>,
    plan_name: Option<String>,
    refresh_at: Option<Timestamp>,
    region_domain: Option<String>,
    #[serde(default)]
    teams: Vec<ProfileTeam>,
}

#[derive(Deserialize)]
struct ProfileTeam {
    id: String,
    name: Option<String>,
    budget_limit: Option<f64>,
}

#[derive(Deserialize)]
struct Budget {
    usage: f64,
    budget_limit: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PROFILE: &str = r#"{
      "instances": [
        {
          "instance_id": "instance-one",
          "name": "Personal",
          "user_id": "user-one",
          "plan_name": "Pro+",
          "refresh_at": "2026-09-01T00:00:00Z",
          "region_domain": "us-east.bob.ibm.com",
          "teams": [{"id": "team-one", "name": "Solo", "budget_limit": 40}]
        },
        {
          "instance_id": "instance-two",
          "name": "Work",
          "user_id": "user-two",
          "plan_name": "Enterprise",
          "refresh_at": "2026-09-05T00:00:00.000Z",
          "region_domain": "api.eu-de.bob.ibm.com",
          "teams": [{"id": "team-two", "name": "Platform", "budget_limit": 160}]
        }
      ]
    }"#;

    #[test]
    fn reads_regional_team_budgets() {
        let targets = parse_profile(PROFILE).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].url,
            "https://api.us-east.bob.ibm.com/admin/v1/teams/team-one/users/user-one"
        );
        assert_eq!(
            targets[1].url,
            "https://api.eu-de.bob.ibm.com/admin/v1/teams/team-two/users/user-two"
        );
        let mut targets = targets.into_iter();
        let teams = [
            targets.next().unwrap().usage(r#"{"usage":10}"#).unwrap(),
            targets.next().unwrap().usage(r#"{"usage":25}"#).unwrap(),
        ];
        let report = report(&teams).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Enterprise, Pro+"));
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert!((report.windows[0].used - 17.5).abs() < 0.001);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_788_220_800))
        );
        assert_eq!(report.balances[0].amount, 35.);
        assert_eq!(report.balances[0].total, Some(200.));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Personal · Solo".into(), "10 / 40 Bobcoins".into())
        );
    }

    #[test]
    fn prefers_the_budget_limit_and_numeric_refresh() {
        let body = r#"{"instances": [{
            "instance_id": "instance-one", "instance_name": "Personal", "user_id": "user-one",
            "plan_name": "Pro+", "refresh_at": 1788220800, "region_domain": "us-east.bob.ibm.com",
            "teams": [{"id": "team-one", "name": "Solo", "budget_limit": 40, "usage": 10}]}]}"#;
        let target = parse_profile(body).unwrap().pop().unwrap();
        let team = target.usage(r#"{"usage":12.5,"budget_limit":80}"#).unwrap();
        assert_eq!(team.used, 12.5);
        assert_eq!(team.limit, Some(80.));
        assert_eq!(
            team.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_788_220_800))
        );
    }

    #[test]
    fn refuses_untrusted_regions() {
        for domain in [
            "evil.example.com",
            "bob.ibm.com.evil.com",
            "x.bob.ibm.com:8443",
        ] {
            let body = format!(
                r#"{{"instances": [{{"instance_id": "i", "user_id": "u",
                   "region_domain": "{domain}", "teams": [{{"id": "t"}}]}}]}}"#
            );
            assert!(parse_profile(&body).is_err(), "{domain}");
        }
        assert!(regional_base(None).is_some());
    }

    #[test]
    fn no_teams_is_an_error() {
        assert!(report(&[]).is_err());
    }
}
