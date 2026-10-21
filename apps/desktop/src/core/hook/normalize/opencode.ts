import {
  type AgentEvent,
  BLOCKED,
  DONE,
  type Payload,
  WORKING,
  field,
  sessionEvent,
  stateEvent,
  summaryOfInput,
  text,
  truncate,
} from "./event";

/**
 * opencode plugin payloads.
 *
 * opencode has no hook configuration: a plugin subscribes to one `event` bus
 * and receives `{ type | event, properties }`. That means there is no "before
 * the turn starts" signal — the closest thing is a `message.updated` whose
 * message has `role: "user"`, which is why the new-turn detection here looks
 * inside `properties` instead of at the topic alone.
 *
 * Topics are matched by prefix (`tool.`) where the bus is known to add
 * variants, and exactly elsewhere, so a future `tool.execute.retry` still
 * reads as `working` while an unrelated topic stays ignored.
 */
export function normalize(
  nodeId: string,
  agentId: string,
  payload: Payload,
): AgentEvent | undefined {
  // The plugin forwards the bus event verbatim; opencode has used both `type`
  // and `event` for the topic across versions.
  const topic =
    text(payload, "event", "type") ?? text(payload, "type", "event");
  if (topic === undefined || topic === "") return undefined;
  const raw = field(payload, "properties", "properties");
  const properties =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw
      : undefined;

  let event: AgentEvent;
  switch (topic) {
    case "session.idle":
      event = stateEvent(nodeId, agentId, DONE);
      event.hookEvent = "Stop";
      break;
    case "session.error":
      event = stateEvent(nodeId, agentId, DONE);
      event.errored = true;
      event.lastMessage = text(properties, "error", "error");
      event.hookEvent = "Stop";
      break;
    case "message.updated":
      // Only the user's own message opens a turn; the assistant's stream
      // updates the same topic dozens of times per turn.
      if (!isUserMessage(properties)) return undefined;
      event = stateEvent(nodeId, agentId, WORKING);
      event.newTurn = true;
      event.hookEvent = "UserPromptSubmit";
      break;
    case "message.part.updated": {
      // A user message never arrives as a part. A tool part that is starting
      // says what the node is doing; one that has finished says nothing
      // (an aborted tool is updated around `session.idle`, and reporting
      // `working` there could outlive the idle).
      const tool = startingTool(properties);
      if (tool === undefined) return undefined;
      event = stateEvent(nodeId, agentId, WORKING);
      event.hookEvent = "PreToolUse";
      event.toolName = tool.name;
      event.toolUseId = tool.callId;
      event.toolSummary = tool.summary;
      break;
    }
    case "permission.asked":
    case "permission.updated":
    case "permission.replied":
      event = stateEvent(nodeId, agentId, BLOCKED);
      event.pendingId = permissionId(properties);
      event.askKind = text(properties, "type", "kind") ?? "permission";
      event.lastMessage = text(properties, "title", "title");
      event.hookEvent =
        topic === "permission.replied" ? "PostToolUse" : "PermissionRequest";
      event.toolName = event.askKind;
      event.toolSummary = event.lastMessage;
      break;
    case "session.deleted":
      event = sessionEvent(nodeId, agentId, "end");
      break;
    default:
      if (!topic.startsWith("tool.")) return undefined;
      event = stateEvent(nodeId, agentId, WORKING);
      if (topic === "tool.execute.before") {
        event.hookEvent = "PreToolUse";
        event.toolName = text(properties, "tool", "toolName");
        event.toolUseId = text(properties, "callID", "callId");
        event.toolSummary = summaryOfInput(field(properties, "args", "input"));
      } else if (topic === "tool.execute.after") {
        event.hookEvent = "PostToolUse";
        event.toolName = text(properties, "tool", "toolName");
        event.toolUseId = text(properties, "callID", "callId");
      }
      break;
  }

  event.sessionId = sessionId(properties);
  return event;
}

/**
 * A `message.part.updated` whose part is a tool that has not finished: its
 * name, call id and a one-line summary of the input. Anything else (text,
 * reasoning, a finished tool) is not worth a report.
 */
function startingTool(
  properties: Payload,
): { name: string; callId?: string; summary?: string } | undefined {
  const part = field(properties, "part", "part");
  if (typeof part !== "object" || part === null || Array.isArray(part)) {
    return undefined;
  }
  if (text(part, "type", "type") !== "tool") return undefined;
  const state = field(part, "state", "state");
  const status = text(state, "status", "status");
  if (status !== "pending" && status !== "running") return undefined;
  const name = text(part, "tool", "tool");
  if (name === undefined) return undefined;
  const callId = text(part, "callID", "callId");
  const summary = summaryOfInput(field(state, "input", "input"));
  return {
    name,
    ...(callId !== undefined ? { callId } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

/**
 * `message.updated` nests the message under `info` in current opencode, and
 * used to inline it; both shapes are read.
 *
 * Only the message as first created opens a turn. opencode 1.19 publishes the
 * user message a second time once the diff summary is computed (`info.summary`
 * set) — in the TUI that lands *after* `session.idle`, so counting it as a new
 * turn flipped a finished node back to working until the next turn.
 */
function isUserMessage(properties: Payload): boolean {
  const info = field(properties, "info", "info");
  const role = field(info, "role", "role") ?? field(properties, "role", "role");
  if (typeof role !== "string" || role.toLowerCase() !== "user") return false;
  return field(info, "summary", "summary") === undefined;
}

function sessionId(properties: Payload): string | undefined {
  const info = field(properties, "info", "info");
  const part = field(properties, "part", "part");
  const found =
    (info === undefined ? undefined : text(info, "sessionID", "sessionId")) ??
    (part === undefined ? undefined : text(part, "sessionID", "sessionId")) ??
    text(properties, "sessionID", "sessionId") ??
    text(properties, "session_id", "sessionID");
  return found === undefined ? undefined : truncate(found, 200);
}

function permissionId(properties: Payload): string | undefined {
  const found =
    text(properties, "id", "permissionID") ??
    text(properties, "permissionID", "permissionId");
  return found === undefined ? undefined : truncate(found, 200);
}
