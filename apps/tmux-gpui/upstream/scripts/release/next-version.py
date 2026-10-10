#!/usr/bin/env python3
"""Derive the next calendar release version from the tags already published.

Versions are `YYYYMMDD.COUNTER`: the UTC release date and a same-day counter
starting at 1. Existing tag names arrive on stdin, one per line, as either
`v20260920.1` or `refs/tags/v20260920.1`; anything else is ignored so unrelated
tags cannot influence publication. The result is always strictly greater than
every published version, so the updater's ordering stays monotonic.
"""

import re
import sys

TAG = re.compile(r"(?:refs/tags/)?v([1-9][0-9]{7})\.([1-9][0-9]*)$")
DATE = re.compile(r"[1-9][0-9]{7}$")


def published(lines):
    for line in lines:
        match = TAG.fullmatch(line.strip())
        if match:
            yield int(match[1]), int(match[2])


def next_version(today, lines):
    if not DATE.fullmatch(today):
        raise ValueError("today must be an eight-digit YYYYMMDD date")
    date = int(today)
    versions = sorted(published(lines))
    if versions and versions[-1][0] > date:
        raise ValueError(f"v{versions[-1][0]}.{versions[-1][1]} is newer than {today}")
    counter = max((version[1] for version in versions if version[0] == date), default=0) + 1
    if counter > 2**64 - 1:
        raise ValueError("same-day counter must fit an unsigned 64-bit integer")
    return f"{date}.{counter}"


def main(argv):
    if len(argv) != 2:
        raise SystemExit("Usage: python3 scripts/release/next-version.py YYYYMMDD < tags")
    try:
        print(next_version(argv[1], sys.stdin))
    except ValueError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main(sys.argv)
