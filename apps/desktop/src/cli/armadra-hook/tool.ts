/**
 * `armadra-hook tool <name>` — one canvas, context or browser tool call for
 * an agent that registers the tools in-process (the omp extension, contract
 * §110). The tool's arguments are a JSON object on stdin; the answer is the
 * runtime's prose on stdout, exit 0, or its refusal on stderr, exit 1.
 *
 * It is `tools/call` of `armadra-hook mcp` without the protocol around it:
 * the same {@link callTool}, so the core sees exactly the request
 * `armadra-hook canvas ...` makes.
 */

import { toolByName } from "../../hook-client/verbs.js";
import { callTool } from "./mcp.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** `armadra-hook tool <name>` */
export async function run(args: string[]): Promise<number> {
  const name = args[0];
  const tool = name === undefined ? undefined : toolByName(name);
  if (args.length !== 1 || tool === undefined) {
    process.stderr.write("armadra-hook: `tool` takes one known tool name\n");
    return 1;
  }
  let input: unknown = {};
  const raw = (await readStdin()).trim();
  if (raw !== "") {
    try {
      input = JSON.parse(raw);
    } catch {
      process.stderr.write("armadra-hook: tool arguments are not JSON\n");
      return 1;
    }
  }
  const result = await callTool(tool, input);
  const body = result.content.map((part) => part.text).join("\n");
  if (result.isError === true) {
    process.stderr.write(`${body}\n`);
    return 1;
  }
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  return 0;
}
