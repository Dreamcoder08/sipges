"""Resolve append-only doc conflicts (CHANGELOG, ODD logs) after merging main into a feature branch.

Keeps main's side first, then the branch's side, and renumbers the branch's first ODD log
entry (`- L<n> `) after main's last one. Run from the repository root with repo-relative paths.
"""

import re
import sys

CONFLICT = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
LOG_ENTRY = re.compile(r"^- L(\d+) ", re.M)


def resolve(path: str, text: str) -> tuple[str, int]:
    def merge(match: re.Match) -> str:
        ours, theirs = match.group(1), match.group(2)
        if path.startswith("odd/"):
            last = max([int(n) for n in LOG_ENTRY.findall(theirs)] or [0])
            if last:
                ours = LOG_ENTRY.sub(f"- L{last + 1} ", ours, count=1)
        return theirs + ours

    return CONFLICT.subn(merge, text)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as handle:
            text, count = resolve(path, handle.read())
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(path, count)
