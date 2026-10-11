import { GithubApiError } from "../../api/github";

/**
 * Display model for the GitHub credential settings: a client failure becomes
 * the one sentence that says what to do next.
 */
export function failureKey(error: unknown): string {
  if (!(error instanceof GithubApiError)) return "github.error.network";
  if (error.outcomeUnknown) return "github.error.unknownOutcome";
  return `github.error.${error.failure}`;
}
