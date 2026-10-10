# Usage providers

The status bar shows plan usage for every AI service signed in on the
selected host, and clicking one opens its panel. Each service is a
*provider*: one module in `crates/herdr-gpui/src/usage/providers/` with a
unit struct implementing `Service`, listed once in
`crates/herdr-gpui/src/usage/registry.rs`. Providers are ported from
[CodexBar](https://github.com/steipete/CodexBar) (MIT), whose
`docs/<id>.md` and `Sources/CodexBarCore/Providers/<Name>/` document each
service's sign-in, endpoints, and response shapes.

Detection, local and remote fetching, caching, refresh timing, the status
bar, and the panel all work from the trait. A provider only says how to
find its sign-in, how to ask its service, and how to read the answer.

## The trait

```rust
pub(crate) trait Service: Sync {
    fn meta(&self) -> &'static Meta;
    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>>;
    fn render(&self, report: &Report, ui: &Ui, cx: &App) -> AnyElement {
        ui.standard(report)
    }
}
```

What a provider is lives in one `static`:

```rust
static META: Meta = Meta::new("openrouter", "OpenRouter")
    .dashboard("https://openrouter.ai/settings/credits")
    .status_page("https://status.openrouter.ai")
    .settings(&[Setting::new("api_key", &["OPENROUTER_API_KEY"], "…")]);

impl Service for Openrouter {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        Some(probe.body(Request::get(URL).bearer(&key)).and_then(|body| parse(&body)))
    }
}
```

`id` is lowercase ASCII and stable (config tables use it). The icon is
`assets/icons/providers/<id>.svg` when that exists; `.icon(path)` sets
another embedded SVG. `.dashboard(url)` and `.status_page(url)` must be
HTTPS.

`fetch` returns `None` when the probed host has no sign-in and the config
sets none: the provider is then left out, unless the user lists it in
`[usage] show_providers`, in which case the panel shows its settings as a
setup guide. It returns `Some(Err(..))` when a sign-in exists but reading
failed, and `Some(Ok(report))` otherwise. Never block without a bound:
every probe call has a timeout.

## Settings

A provider declares every config value it reads. Users set them in
`config-gpui.local.toml`:

```toml
[usage.providers.openrouter]
api_key = "sk-or-…"
```

```rust
.settings(&[Setting::new(
    "api_key",
    &["OPENROUTER_API_KEY"],
    "An API key from https://openrouter.ai/settings/keys.",
)])
```

- `name` is the key in the table. Use `api_key`, `cookie`, `base_url`,
  `token`, and for anything else a short snake_case name.
- `env` lists environment variables read when the config has no value, in
  CodexBar's names. Apps launched from the Dock see few variables, so the
  config is the dependable place.
- `help` tells the user what the value is and exactly how to get it. For a
  `cookie`: which site to sign in to, that it is under Developer Tools →
  Application → Cookies, which cookie names to copy, and that the value is
  the full `name=value; name2=value2` header. The panel shows this text
  when the provider is listed but not signed in.
- Unknown provider ids and setting names in the config are ignored and named
  in the GUI config warning, so every name a provider reads must be declared.

## Probe

`Probe` is the only way a provider touches the host, the config, or the
network. The same calls work locally and on a remote host, where each runs
in one SSH shell session. A `Secret` read on a remote host stays there as a
shell variable; requests using it run there with `curl`. Never turn a
secret into a `String` except through `text` for values that are not
secret (emails, plan names, ids shown to the user).

| Call | Returns | Use |
| --- | --- | --- |
| `setting(name)` | `Option<Secret>` | A declared setting from config or its env vars (this machine). |
| `text_setting(name)` | `Option<String>` | A non-secret setting such as `base_url`. |
| `env(name)` | `Option<Secret>` | An environment variable on the probed host. |
| `file(&HostPath)` | `Option<Secret>` | A whole file on the host, e.g. a credentials JSON; trailing newlines dropped. |
| `read(&HostPath)` | `Option<String>` | A non-secret file brought back, e.g. an XML quota report. |
| `exists(&HostPath)` | `bool` | Whether a path exists on the host. |
| `file_text(&HostPath, &[key])` | `Option<String>` | A non-secret JSON field of a file (an email) without bringing the file back. |
| `keychain(service, account)` | `Option<Secret>` | A macOS keychain password on the host (`security -w`), for items `security` itself may read without asking, such as Claude Code's. |
| `field(&secret, &[key])` | `Option<Secret>` | A string/number at a JSON path inside a secret (array steps are indices as strings). |
| `text(&secret, &[key])` | `Option<String>` | A non-secret JSON field revealed, e.g. a plan name. |
| `cookies(&[domain], &[name])` | `Option<Secret>` | The `cookie` setting, else (only for providers the user listed and allowed in the panel) those cookies from Chrome/Safari. Pass the cookie names the service needs; `&[]` takes all cookies of the domains. |
| `cookies_any(&[domain], &[name])` | `Option<Secret>` | Like `cookies`, satisfied by whichever of the names exists (renamed session cookies). |
| `cookie_value(&[domain], name)` | `Option<Secret>` | One cookie's bare value, for a service that wants it as a bearer or in a header. |
| `foreign_keychain(service, account)`, `foreign_keychain_internet(server, account)` | `Option<Secret>` | A keychain item another app owns, such as Zed's sign-in. Reading it makes macOS ask, so it is read only for a listed provider after the user presses Allow in its panel; until then the provider shows a lock in the status bar. A denial is remembered and takes the grant back. |
| `env_text(name)` | `Option<String>` | A host environment variable that is not secret, e.g. a local server URL. |
| `body(Request)` | `Result<String>` | The body of a successful answer; failures become typed usage errors. Most providers need only this. |
| `http(Request)` | `Result<Response>` | The whole answer, for a provider that reads the status itself; runs where its secrets are. |
| `exchange(Request, &[key])` | `Result<Secret>` | A request whose JSON answer holds a new credential (token refresh or exchange); the new credential stays where the request ran. |
| `command(program, &[arg], timeout)` | `Result<Output>` | Runs a CLI on the host (`~/.local/bin`, Homebrew and similar are on PATH). Its stdout comes back, so only for commands that print no secrets. |
| `is_remote()`, `is_macos()` | `bool` | Where the probe runs. |

`HostPath::home(".codex/auth.json")` is `~/.codex/auth.json` on the host;
`HostPath::env_or("CODEX_HOME", ".codex", "auth.json")` honors the
variable; `HostPath::absolute("/etc/x")`.

`Request::get(url)` / `Request::post(url)` with `.header(name, value)`,
`.bearer(&secret)`, `.cookie(&secret)`, `.secret_header(name, prefix,
&secret)`, `.json(body)` (a body without secrets), `.body(vec![Part::Text(..),
Part::Secret(..)])` (a body that contains a secret, e.g. a form login),
and `.timeout(duration)`. A request may not mix this machine's settings with
secrets read on a remote host.

`Response { status, body }`: `response.ok()?` maps 401/403 to
`UsageRejected`, 429 to `UsageRateLimited`, other failures to typed errors,
and returns the body; `response.json::<T>()?` also parses it. Parse with
serde structs; `service::json(body)` maps parse errors without echoing the
body. `service::Timestamp` accepts seconds, milliseconds, numeric strings,
and RFC 3339; `service::number` deserializes numbers sent as strings.

Shared readings live in `usage::values`: `number` (a JSON number or
numeric string), `decimal` (a strict money string), `https_base` (a
configured service address, HTTPS only, before sending a key there),
`gateway` (a self-hosted proxy address, HTTP only on private networks),
`encode` (a URL component), `invalid()` (the error for a response that
lacks what the service documents), and fact formats `usd`, `plain`,
`count`, `trimmed`. Use them rather than writing another.

Errors: use `crate::Error::Usage*` variants (`UsageRejected`,
`UsageRateLimited`, `UsageStatus`, `UsageJson`, `UsageConnect`,
`UsageCommand(&'static str)` for a CLI that failed). Never build an error
from response text.

## Report

```rust
Report::new(Provider(&MyService), Account { email, plan }, windows)
    .with_balances([Balance::new("Credits", 12.5, Unit::Currency("USD".into())).out_of(50.)])
    .with_sections([Section::Facts { title, facts }, Section::Shares { .. }, Section::Limit(window)])
    .with_detail(MyDetail { .. })   // provider-specific, for its own render
```

- `Window::new(kind, used_percent, resets_at, length)`. `Kind` is
  `Session` (5 h), `Daily`, `Weekly`, `Monthly`, or `Named(String)` for a
  window the service names itself. `length` is `kind.length()` for the
  standard kinds, or the service's own window length, so the panel can show
  the pace. The status bar shows the two windows closest to their limits as
  `N% used <time to reset>`, or, with `[status_bar] usage = "compact"`, only
  the tightest share; the panel lists every window.
- `Balance` is money or credits: `Unit::Currency("USD")` or
  `Unit::Count("credits")`, with `out_of(total)` when there is a limit.
  A provider with no windows shows its first balance in the status bar.
- Prefer windows and balances; use sections for anything else worth seeing.
- `Provider(&MyService)` builds the report's provider from the unit struct.

## Rendering

The default `render` draws windows, balances, and sections. A provider with
richer data stores it with `with_detail` and overrides `render`, reading it
back with `report.detail::<MyDetail>()` and composing `Ui` pieces:
`ui.limit(&window)`, `ui.balances(&[..])`, `ui.facts(title, &facts)`,
`ui.shares(title, &shares)`, `ui.bar(fill, used, None)`, `ui.block()`,
`ui.heading(..)`, `ui.rule()`, with `ui.theme`, `ui.small()`, `ui.muted()`.

## Tests

Every provider module ends with `#[cfg(test)] mod tests` that parses a
fixture response shaped like the real one (take it from CodexBar's tests
or docs) and checks the windows, balances, and account it produces. Keep
parsing in a pure `fn parse(body: &str, ..) -> Result<Report>` so it can be
tested without a network.

## What is not supported yet

Sources that need more than the probe offers are left out and noted in the
module doc: reading a browser's localStorage or IndexedDB, local SQLite
databases, WebView sessions, gRPC-web, interactive logins, and signing
requests (AWS SigV4, Google service accounts).
