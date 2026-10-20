import json
import pathlib
import statistics
import sys

base = pathlib.Path(sys.argv[1])
rows = [json.loads((base / f"pair-{i}-{scenario}.json").read_text())
        for i in range(1, 6) for scenario in ["quiet", "busy"]]
assert all(row["passed"] and row["cleanup"] and row["inputVerified"]
           and row["sourcePreserved"] and row["hashesUnchanged"] for row in rows)
assert all(row["hashes"] == rows[0]["hashes"] for row in rows)
metrics = ["firstRetainedMs", "firstFreshMs", "firstInputReadyMs", "bytes", "retainedFrames", "publications"]
summary = {
    "payloadSourceCommit": rows[0]["payloadSourceCommit"],
    "independentRunsPerScenario": 5,
    "correlatedSwitchesPerRun": 3,
    "passedRuns": 10,
    "failedRuns": 0,
    "nativeUi": False,
    "cpuMeasured": False,
    "rssMeasured": False,
    "retainedFramesMeaning": "retained snapshot publications, not unique images or native renders",
    "allArtifactHashesEqual": True,
    "hashes": rows[0]["hashes"],
    "scenarios": {},
}
for scenario in ["quiet", "busy"]:
    samples = [row for row in rows if row["scenario"] == scenario]
    result = {}
    for metric in metrics:
        values = [statistics.median(switch[metric] for switch in row["switches"]) for row in samples]
        result[metric] = {"runMedians": values, "medianOfRunMedians": statistics.median(values),
                          "minRunMedian": min(values), "maxRunMedian": max(values)}
    result["totalEmptyPublications"] = sum(switch["emptyFrames"] for row in samples for switch in row["switches"])
    result["hostLoads"] = [row["hostLoad"] for row in samples]
    summary["scenarios"][scenario] = result
(base / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
