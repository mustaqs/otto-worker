/**
 * The one Workflow (SPEC.md A82). THE ONLY FILE THAT IMPORTS A PLATFORM
 * MODULE: everything it does is in run.js, which test.mjs drives without this
 * file. Bench/check-task-path.sh asserts that `cloudflare:` appears here and
 * nowhere else under src/tasks/.
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runTask } from "./run.js";

export class OttoTask extends WorkflowEntrypoint {
  async run(event, step) {
    return runTask({ event, step, env: this.env, NonRetryableError });
  }
}
