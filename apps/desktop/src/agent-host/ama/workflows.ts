/**
 * `HostApi.workflows`: ama's `/workflow run` handed to the canvas engine
 * (multi-agent workflow design §2.9, contract §122).
 *
 * Only ever registered on an ama that has `workflows.provide` (host-api 1.5);
 * an older one keeps running its workflows itself. Version 1 hands over and
 * starts, nothing more:
 *
 *   * `scope: "project"` → `workflow-run --file <id> --hash <hash>`: the core
 *     reads `.ama/workflows/<id>.md` itself (ama's parsed document is not
 *     used to start anything) and answers `{ runId, url }`.
 *   * `user` / `config` → the file is not in the workspace the core can read,
 *     so `workflow-propose` puts the document on the board as a draft card for
 *     a person to confirm, and `run` is refused with `workflow_unsupported`
 *     (ama records `waiting`, exit code 10).
 *
 * There is no progress callback and no cancel: the run is watched on the
 * canvas, and **its gates are answered there by a person** — the handler never
 * answers one. A refusal keeps the core's code (`workflow_file_changed`, …)
 * so ama reports it as is.
 */

import type {
  HostApi,
  HostWorkflowHandler,
  HostWorkflowRunRequest,
  HostWorkflowStarted,
} from "@armadra/agent/host";
import { randomUUID } from "node:crypto";
import { workflowRunTimeoutMs } from "../../cli/armadra-hook/control.js";
import type { JsonValue } from "../../hook-client/json.js";
import { type ControlAnswer, callControl } from "./client.js";

/** The workflow file format version the canvas engine runs. */
export const HOSTED_WORKFLOW_VERSIONS = [2] as const;

/** An error ama reads `code` from. */
export class WorkflowRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRefusal";
  }
}

export interface WorkflowDeps {
  readonly control: typeof callControl;
  readonly log: HostApi["log"];
}

function refusal(answer: ControlAnswer): WorkflowRefusal {
  if (answer.kind === "refused") {
    return new WorkflowRefusal(answer.code, answer.message);
  }
  if (answer.kind === "unreachable") {
    return new WorkflowRefusal(
      "workflow_host_unreachable",
      `The canvas core did not answer: ${answer.error}`,
    );
  }
  return new WorkflowRefusal("workflow_host_error", "Unexpected answer.");
}

function startedOf(answer: ControlAnswer): HostWorkflowStarted {
  if (answer.kind !== "ok") throw refusal(answer);
  const result = answer.body["result"] as
    { runId?: unknown; url?: unknown } | undefined;
  if (typeof result?.runId !== "string" || result.runId === "") {
    throw new WorkflowRefusal(
      "workflow_host_error",
      "The canvas core answered without a run id.",
    );
  }
  return typeof result.url === "string" && result.url !== ""
    ? { runId: result.runId, url: result.url }
    : { runId: result.runId };
}

/** Why a project file is refused is easier to act on with the rule stated. */
const ROOT_HINT =
  " The workspace root's `.ama/workflows` file is the one the canvas runs; a copy under a worktree or sub-directory is not read.";

export function workflowHandler(deps: WorkflowDeps): HostWorkflowHandler {
  return {
    versions: HOSTED_WORKFLOW_VERSIONS,
    async run(request: HostWorkflowRunRequest): Promise<HostWorkflowStarted> {
      if (request.signal.aborted) {
        throw new WorkflowRefusal("workflow_aborted", "The run was aborted.");
      }
      // Cancelling after the verb is sent is out of scope in v1: the run is
      // watched and stopped on the canvas, there is no cancel to hand over.
      if (request.source.scope === "project") {
        const args: Record<string, JsonValue> = {
          file: request.workflowId,
          hash: request.source.hash,
          "run-id": randomUUID(),
        };
        if (Object.keys(request.params).length > 0) {
          args["params"] = { ...request.params };
        }
        // A fresh id per run: a deliberate rerun of the same workflow with
        // the same params must start a new run. The id is only reused for a
        // transport retry of this one call (the core answers the run it
        // already started).
        let answer = await deps.control(
          "workflow-run",
          args,
          workflowRunTimeoutMs(),
        );
        if (answer.kind === "unreachable" && !request.signal.aborted) {
          answer = await deps.control(
            "workflow-run",
            args,
            workflowRunTimeoutMs(),
          );
        }
        if (
          answer.kind === "refused" &&
          (answer.status === 404 || answer.status === 409)
        ) {
          throw new WorkflowRefusal(
            answer.code,
            `${answer.message}${ROOT_HINT}`,
          );
        }
        return startedOf(answer);
      }
      // user / config: a draft card for a person; the run itself is not ours.
      const proposed = await deps.control("workflow-propose", {
        draft: request.workflow as unknown as JsonValue,
      });
      if (proposed.kind !== "ok") {
        deps.log(
          "warn",
          `workflow ${request.workflowId} could not be proposed`,
          proposed,
        );
      }
      throw new WorkflowRefusal(
        "workflow_unsupported",
        proposed.kind === "ok"
          ? `The ${request.source.scope} workflow "${request.workflowId}" cannot run on the canvas from here; a draft card is on the board for a person to confirm and save as a template.`
          : `The ${request.source.scope} workflow "${request.workflowId}" cannot run on the canvas from here, and its draft card could not be put on the board.`,
      );
    },
  };
}

/**
 * Registers the handler when the runtime has `workflows.provide`; answers the
 * unregister function (a no-op on an older ama).
 */
export function provideWorkflows(
  api: Pick<HostApi, "workflows" | "log">,
  deps: Partial<WorkflowDeps> = {},
): () => void {
  const provide = api.workflows?.provide;
  if (typeof provide !== "function") return () => {};
  try {
    return api.workflows!.provide(
      workflowHandler({
        control: callControl,
        log: api.log,
        ...deps,
      }),
    );
  } catch (error) {
    // Another host already provides one (`workflow_handler_exists`).
    api.log("warn", "could not provide the workflow handler", error);
    return () => {};
  }
}
