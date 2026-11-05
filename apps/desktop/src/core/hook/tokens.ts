import { hookService } from "./service";

/**
 * Mints `<dataDir>/node-tokens/<nodeId>` through the running hook service.
 *
 * The terminal domain calls this when it creates an agent terminal, and it is
 * the one statement of the hook domain that runs outside it. The token is
 * derived from the instance secret, which lives in the secret store, so only
 * the service that has loaded it can mint one: there is no path that reads the
 * secret again by itself. The service is installed (and its secret loaded)
 * before the core accepts a terminal, so this stays synchronous.
 *
 * Contract §5, item 5: the token itself never travels in the environment. Any
 * process of the same user can read another process' environ, so the PTY is
 * told only where the endpoint file is.
 */
export function issueNodeToken(dataDir: string, nodeId: string): string {
  const service = hookService();
  if (service === undefined || service.dataDir !== dataDir) {
    throw new Error("the hook service is not running for this data directory");
  }
  return service.issueNodeToken(nodeId);
}
