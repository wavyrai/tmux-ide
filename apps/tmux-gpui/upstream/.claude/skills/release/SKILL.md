---
name: release
description: Publish a herdr-gpui release. Use when the user asks to cut, push, ship, or publish a release, or to approve, verify, or GPG-sign one that is already running. Covers `just release`, the protected environments the run stops at, and the local verification and signing steps that are not part of CI.
---

# Releasing herdr-gpui

The owner has given standing authorization to approve the release run's protected
environments when they ask for a release. Do not wait to be asked again per run.
Everything else on this page still applies: the preconditions are hard gates, and
the local GPG step needs a physical YubiKey tap that only the owner can give.

Releases go out to real users through the in-app updater and Homebrew. Never
dispatch one that was not asked for.

## Choose the version? No.

You do not pick a version and you cannot. The workflow derives
`vYYYYMMDD.COUNTER` from today's UTC date and the tags already published. A
second release on the same day becomes `.2`, then `.3`. Do not invent a tag, do
not pass one, and do not create a tag locally.

## Dispatch

```sh
just release          # -> bash scripts/release/dispatch.sh
```

`dispatch.sh` refuses unless every one of these holds. Check them first so a
failure is not a surprise:

| Precondition | Command |
| --- | --- |
| Working tree clean **including untracked files** | `git status --porcelain --untracked-files=all` |
| On `main` | `git symbolic-ref --quiet --short HEAD` |
| `origin` is `penso/herdr-gpui` | `git remote get-url origin` |
| `gh` authenticated as `penso` | `gh api user --jq .login` |
| Local HEAD == `origin/main` on GitHub | compare `git rev-parse HEAD` with `gh api repos/penso/herdr-gpui/git/ref/heads/main --jq .object.sha` |

The script never fetches or checks out for you: if HEAD does not match, stop and
tell the owner rather than pulling on their behalf.

Untracked files block a release. If you have added files to the repo (a skill, a
scratch script), they must be committed or ignored before `just release` will run.

Show the owner what is about to ship before dispatching. `just
changelog-unreleased` is the same text users will read on the release page; the
raw log is the fallback when `git-cliff` is not installed locally:

```sh
just changelog-unreleased          # only the commits since the last tag
just changelog                     # the whole generated changelog
just changelog-release 20260920.3 out/   # exactly the two files CI publishes
git log --oneline "$(gh api repos/penso/herdr-gpui/releases/latest --jq .tag_name)"..HEAD
```

`just changelog*` needs `git-cliff` locally (`cargo install --locked --version
2.12.0 git-cliff`); CI installs the same pinned version.

Dispatch is long-running. Run it with `run_in_background` so a slow build does
not hit a foreground timeout.

## The run stops for approvals

Jobs run roughly: `audit` (shown as "Release Workflow Security") and `validate`,
then `macos-checks`, `macos-build` (arm64 + x86_64), `linux` (aarch64 + x86_64),
`windows` (x86_64 MSVC), `metadata` and `changelog`, then `sign`, `attest`, `publish`,
and finally `homebrew`.

`sign`, `attest` and `publish` use the **`release`** environment; `homebrew` uses
the **`homebrew`** environment. Both have required reviewers, so the run pauses
at each and waits. `sign` is additionally gated on the actor being `penso`.

Approve a pending gate:

```sh
run=<run-id>
gh api repos/penso/herdr-gpui/actions/runs/$run/pending_deployments \
  --jq '.[] | "\(.environment.name) id=\(.environment.id) can_approve=\(.current_user_can_approve)"'

gh api repos/penso/herdr-gpui/actions/runs/$run/pending_deployments -X POST --input - <<'JSON'
{"environment_ids":[<id>],"state":"approved","comment":"<why>"}
JSON
```

Use `--input` with real JSON. `-f "environment_ids[]=<id>"` sends the id as a
string and the API rejects it with `422 ... "<id>" is not an integer`.

A job sitting in `waiting` is not proof a gate is open — it is also the state
while a runner is being assigned. Check `pending_deployments` (empty means no
gate) and `.../approvals` for who approved what, and read those before telling
the owner anything about approval state.

## `gh run watch` dying is not a failed release

`dispatch.sh` ends by watching the run, and that watch is a local poll against
`api.github.com`. A network blip kills it with `error connecting to
api.github.com` and `just release` exits 1 **while the release keeps going
server-side**. Never report a failed release on the strength of that exit code.
Re-check the truth:

```sh
gh run view <run-id> --repo penso/herdr-gpui --json status,conclusion,jobs
```

Because the watcher owns the final summary, losing it also means nothing local
will print the published tag. Confirm with
`gh api repos/penso/herdr-gpui/releases/latest --jq .tag_name`.

## The release notes write themselves

`changelog` generates the release body from git history with `git-cliff`
(`cliff.toml`) and `publish` passes it to `gh release create --notes-file`. Do
not hand-write notes, and do not edit a published body to add them: fix the
commit subjects instead, since those are the entries. The standing preamble
about GUI-only DMG, experimental Linux packages and Windows zips, and the required daemon lives in
`scripts/release/generate-changelog.sh`.

`CHANGELOG.md` is generated too, but it is **not** a release asset — the asset
set is fixed by `artifact-manifest.py` and each asset is checksummed, signed and
attested. Both files are uploaded as the run's `release-notes` workflow artifact.

## After it publishes

Both of these are local and deliberately **not** CI steps.

Verify the published artifacts — the exact asset set, both checksums, Sigstore,
and GitHub provenance. Pin the commit with `--sha`; it is recommended:

```sh
just verify-release --version vYYYYMMDD.COUNTER --sha <release-commit-sha>
```

Supplemental detached GPG signatures, which the release does not otherwise carry:

```sh
just sign-release vYYYYMMDD.COUNTER <output-dir> <full-signing-fingerprint>
```

Four things to get right here:

- The output directory **must not already exist**; the script creates it `700`.
- The fingerprint must be the **full** 40- or 64-hex signing subkey fingerprint,
  not a short key ID. It is not recorded in this repo — ask the owner, or read it
  from their GPG config. Never guess it.
- Signing touches the YubiKey, so **the owner must tap it**. Say so before
  starting rather than leaving them staring at a stalled command.
- Nothing is uploaded. The signatures land in `<output-dir>/gpg/` and the release
  on GitHub is untouched, so this cannot damage a published release.

## Before touching release machinery itself

If the change is to the scripts or workflow rather than a normal release:

```sh
just release-check    # bash -n, mocked release tests, security tests, actionlint, zizmor
```

It dispatches and publishes nothing. `just dmg $VERSION` builds a local signed
universal DMG and also publishes nothing.

## Never

- Dispatch a release the owner did not ask for.
- Invent, pass, or locally create a version tag.
- Report success from a queue state, or failure from a dead watcher.
- Run `just sign-release` expecting to complete it without the owner's tap.
- Edit the vendored protocol crate, the workflow pins, or `NOTICE.md` as
  incidental release cleanup.
