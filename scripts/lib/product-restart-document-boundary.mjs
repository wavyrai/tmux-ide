/** Retain a restart boundary outside the renderer that may be destroyed. */
export function observeRestartDocumentBoundary(page) {
  let navigationCount = 0;
  let baseline = null;
  const navigated = (frame) => {
    if (frame === page.mainFrame()) navigationCount = Math.min(9, navigationCount + 1);
  };
  page.on("framenavigated", navigated);
  return Object.freeze({
    capture(observation, generation) {
      const runtime = observation?.runtimeReplacement;
      if (
        navigationCount !== 0 ||
        observation?.workspaceEvidence?.phase !== "live" ||
        observation.workspaceEvidence.target?.daemon.instanceId !== generation ||
        observation.workspaceEvidence.authority?.generation !== generation ||
        !Number.isFinite(runtime?.documentEpoch) ||
        runtime.documentEpoch <= 0 ||
        !Number.isSafeInteger(runtime.acceptedCount) ||
        runtime.acceptedCount < 1 ||
        !Number.isSafeInteger(runtime.socketEventCount) ||
        runtime.socketEventCount < 1
      ) {
        throw new Error("Restart document baseline is not a stable live predecessor");
      }
      baseline = Object.freeze({
        epoch: runtime.documentEpoch,
        generation,
        acceptedCount: runtime.acceptedCount,
        socketEventCount: runtime.socketEventCount,
      });
    },
    evidence(observation) {
      return {
        before: baseline,
        navigationCount,
        after: {
          epoch: observation?.runtimeReplacement?.documentEpoch,
          acceptedCount: observation?.runtimeReplacement?.acceptedCount,
          generation: observation?.workspaceEvidence?.target?.daemon.instanceId,
        },
      };
    },
    dispose() {
      page.off("framenavigated", navigated);
    },
  });
}
