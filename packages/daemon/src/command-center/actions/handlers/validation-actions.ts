import { assertValidationStatus, validationReport } from "../../../lib/validation.ts";
import { broadcastValidationChanged as broadcastValidationChangedDefault } from "../../ws-events.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resolveProjectContext, type ProjectContextDeps } from "./_project-context.ts";

interface ValidationActionDeps extends ProjectContextDeps {
  broadcastValidationChanged?: (sessionName: string) => void;
}

export function validationAssertHandler(
  input: ActionInput<"validation.assert">,
  deps: ValidationActionDeps = {},
): ActionResult<"validation.assert"> {
  const context = resolveProjectContext(input, deps);
  try {
    const assertion = assertValidationStatus(
      context.dir,
      input.assertId,
      input.status,
      input.evidence,
    );
    (deps.broadcastValidationChanged ?? broadcastValidationChangedDefault)(context.sessionName);
    return { assertion };
  } catch (err) {
    throw new ActionError({
      code: "validation_assertion_not_found",
      message: (err as Error).message ?? String(err),
      details: { assertId: input.assertId },
      cause: err,
    });
  }
}

export function validationReportHandler(
  input: ActionInput<"validation.report">,
  deps: ValidationActionDeps = {},
): ActionResult<"validation.report"> {
  const context = resolveProjectContext(input, deps);
  return { report: validationReport(context.dir) };
}
