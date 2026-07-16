import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

/** Resolve and canonicalize a caller-supplied execution cwd before it is used or persisted. */
export function canonicalizeWorkflowCwd(cwd: string, options: { persisted?: boolean } = {}): string {
  if (options.persisted && !isAbsolute(cwd)) {
    throw new WorkflowError(
      `Invalid persisted workflow working directory "${cwd}": expected an absolute path`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  try {
    return realpathSync(resolve(cwd));
  } catch (error) {
    throw new WorkflowError(
      `Invalid workflow working directory "${cwd}": workflow cwd does not exist or is not accessible`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
        details: error,
      },
    );
  }
}
