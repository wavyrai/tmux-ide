# Source-only post-run diagnostic flag correction

Run36603159793 remains workflow FAIL. Container exit0 and parser18 gate/full postclosure passed; finally-block Docker logs collection used invalid --parser because lane renaming replaced external --tail. Exact-owned cleanup still completed in nested finally and independent continuation; only container-log.txt is absent. Raw run/archive never modified. No CI rerun or push is requested.

Correct external option to --tail and exercise actual launcher argv AST with an exact-owned dummy CID; no subprocess or fixture starts. Audit of every changed string constant versus accepted tail runner/launch/cleanup found only lane descriptions, private directory/name/label paths, lane identifier, input filenames and this CLI option. Docker create/wait/inspect/rm/ps flags, limits and ownership checks unchanged. Docstrings corrected from accidental quiet-parser wording. No measured code/input/oracle changes.
