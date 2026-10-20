"""Print compact tables from pipeline-bench JSON results."""
import json
import sys

ROLES = ["tmux-server", "tmux-control-client", "daemon", "live", "browser", "preview-launcher", "fake-gui"]
for path in sys.argv[1:]:
    d = json.load(open(path))
    print(f"## {path} grid={d['grid']} panes={d['panes']}")
    print("anatomy", d.get("publicationAnatomy"))
    for name, w in d["workloads"].items():
        g = w["gui"]
        extra = {k: v for k, v in w.items() if k not in ("roles", "gui", "elapsedMs")}
        print(f"\n### {name} elapsed={w['elapsedMs']}ms gui: {g['bytes']/1e6:.2f} MB in {g['lines']} lines, parse {g['nodeParseMs']} ms, max line {g['maxLine']/1e6:.2f} MB")
        if extra:
            print("   ", json.dumps(extra))
        print(f"    {'role':22}{'cpu ms':>9}{'in MB':>9}{'out MB':>9}{'lines':>7}{'strfy MB':>9}{'strfy ms':>9}{'parse MB':>9}{'parse ms':>9}{'gc ms':>7}{'rss MB':>8}")
        for role in ROLES:
            r = w["roles"].get(role)
            if not r:
                continue
            inb = r.get("tmuxControlBytes", 0) + r.get("netRead", 0) + r.get("stdinBytes", 0)
            if role == "daemon":
                inb = r.get("tmuxControlBytes", 0)
            outb = r.get("stdoutBytes", 0) + (r.get("netWritten", 0) if role == "daemon" else 0)
            print(f"    {role:22}{r.get('cpuMs',0):9.0f}{inb/1e6:9.2f}{outb/1e6:9.2f}{r.get('stdoutLines',0):7.0f}{r.get('stringifyBytes',0)/1e6:9.1f}{r.get('stringifyMs',0):9.0f}{r.get('parseBytes',0)/1e6:9.1f}{r.get('parseMs',0):9.0f}{r.get('gcMs',0):7.0f}{r.get('rss',0)/1e6:8.0f}")
    print("\nprocesses", d.get("processes"))
