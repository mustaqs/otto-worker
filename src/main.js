/**
 * Wrangler's entry. The fetch handler is src/index.js, unchanged as the entry
 * for test.mjs and the benches; the Workflow class is re-exported beside it
 * from the one file that imports the platform (SPEC.md A82).
 */
export { default } from "./index.js";
export { OttoTask } from "./tasks/workflow.js";
