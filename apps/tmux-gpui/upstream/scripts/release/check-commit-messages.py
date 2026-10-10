#!/usr/bin/env python3
"""Commit subjects are the release changelog, so they are checked like code.

`cliff.toml` turns each subject into one line of the GitHub release body: the
type picks the section, the subject text is printed verbatim, and `chore`, `ci`,
`build`, `style` and `test` are dropped entirely. Every rule here exists because
breaking it either loses a user-visible change or prints something wrong.

  check-commit-messages.py message .git/COMMIT_EDITMSG   # the commit-msg hook
  check-commit-messages.py range origin/main..HEAD       # every commit in a range
"""

import argparse
import re
import subprocess
import sys

# Sections in cliff.toml, and the types that never reach a release page.
PUBLISHED_TYPES = {"feat": "Added", "fix": "Fixed", "perf": "Changed",
                   "refactor": "Changed", "revert": "Changed", "docs": "Documentation"}
HIDDEN_TYPES = ("chore", "ci", "build", "style", "test")
# Only these types: cliff.toml routes anything else through its catch-all, so a
# near miss like `feature:` would be published under the wrong section.
SUBJECT = re.compile(
    r"^(?P<type>" + "|".join([*PUBLISHED_TYPES, *HIDDEN_TYPES]) + r")"
    r"(?:\((?P<scope>[a-z0-9][a-z0-9._-]*)\))?(?P<breaking>!)?: (?P<description>.+)$")
# Git's own generated subjects, and marks that disappear before the branch lands.
EXEMPT = re.compile(r"^(Merge |Revert \"|fixup! |squash! |amend! )")
SCISSORS = "# ------------------------ >8 ------------------------"
MAX_SUBJECT = 80
MIN_DESCRIPTION = 8


def strip_comments(text):
    """Drop what git itself strips: comment lines and the verbose diff below."""
    lines = []
    for line in text.splitlines():
        if line.rstrip() == SCISSORS:
            break
        if not line.startswith("#"):
            lines.append(line.rstrip())
    return "\n".join(lines).strip("\n")


def problems(message):
    """Every rule the message breaks, worded so the fix is obvious."""
    body = strip_comments(message)
    if not body.strip():
        return ["The commit message is empty."]
    lines = body.splitlines()
    subject = lines[0]
    if EXEMPT.match(subject):
        return []

    found = []
    match = SUBJECT.match(subject)
    if not match:
        found.append(
            "The subject must be `type: description`, or `type(scope): description`.\n"
            "    Published: " + ", ".join(f"{name} -> {section}"
                                          for name, section in PUBLISHED_TYPES.items()) + "\n"
            "    Never published: " + ", ".join(HIDDEN_TYPES) + "\n"
            "    A user-visible change may not ship under a type that is never published.")
    else:
        description = match["description"]
        if description.endswith("."):
            found.append("Drop the full stop: the subject is a bullet on the release page.")
        if len(description) < MIN_DESCRIPTION:
            found.append(f"Say what changed in at least {MIN_DESCRIPTION} characters; "
                         "the subject is all a user reads.")
    if len(subject) > MAX_SUBJECT:
        found.append(f"The subject is {len(subject)} characters; keep it within {MAX_SUBJECT}.")
    if len(lines) > 1 and lines[1].strip():
        found.append("Leave line 2 blank: everything below it is the body, which users never see.")
    for line in lines[1:]:
        # Only a footer-shaped line: prose may start with the words themselves.
        if re.match(r"(?i)^breaking[ -]change\s*:", line) and not re.match(r"^BREAKING[ -]CHANGE: ", line):
            found.append("Spell a breaking footer `BREAKING CHANGE: <what breaks>`; "
                         "any other spelling is not recognised and the change is published "
                         "as an ordinary entry.")
    return found


def report(entries):
    """Print every offending commit; return the process exit status."""
    failed = 0
    for name, message in entries:
        found = problems(message)
        if not found:
            continue
        failed += 1
        print(f"\n{name}", file=sys.stderr)
        for problem in found:
            print(f"  - {problem}", file=sys.stderr)
    if failed:
        print(f"\n{failed} commit message(s) would damage the generated changelog.\n"
              "See the Changelog section of AGENTS.md; preview with `just changelog-unreleased`.",
              file=sys.stderr)
        return 1
    return 0


def range_entries(revisions):
    """Non-merge commits in a range, newest first, as (label, message) pairs."""
    # `%x00` is expanded by git; a literal NUL cannot be passed in an argument.
    log = subprocess.run(["git", "log", "--no-merges", "--format=%H %s%n%n%b%x00", revisions],
                         capture_output=True, text=True, check=True).stdout
    entries = []
    for block in log.split("\x00"):
        text = block.strip("\n")
        if text:
            commit, message = text.split(" ", 1)
            entries.append((commit, message))
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("message", "range"))
    parser.add_argument("target")
    arguments = parser.parse_args()
    if arguments.mode == "message":
        with open(arguments.target, encoding="utf-8", errors="replace") as source:
            return report([("The commit message:", source.read())])
    return report(range_entries(arguments.target))


if __name__ == "__main__":
    sys.exit(main())
