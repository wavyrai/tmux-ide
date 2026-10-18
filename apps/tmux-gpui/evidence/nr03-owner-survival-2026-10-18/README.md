# NR03 canonical owner survival prerequisite

Base61371792. Read-only qualification, no scroll restoration claim.

A private stock tmux3.8 server was instantiated via createNativeTmuxServerOwner and its real sessionRuntimeRegistry. After closing all consumers, canonical/raw listener counts were zero while upstream remained one. An owned shell command containing NR03_OWNER_ALIVE was sent through tmux send-keys during that interval. Revision advanced0→1; a new consumer received the same incarnation and updated state hash/marker. The marker may include shell input echo: this proves terminal bytes were processed while unsubscribed, not a standalone command-execution oracle. Quiet baseline also passed.

This verifies existing owner retention and upstream processing, not completed A/B/A GUI history restoration or performance. No connection pool or lifetime extension was added. The private socket was killed and list-sessions failure checked; this does not claim a per-PID cleanup inventory. No production socket/daemon, protected CLI build or UI input.

Original run script lives at .tasks/native-reliability-mission/nr03-owner-survival/run.mts with relative imports resolved there; retained copy requires the same location or adjusted imports. Actual receipts accompany it. Full plan remains .tasks/native-reliability-mission/nr03-history-identity-plan.md.
