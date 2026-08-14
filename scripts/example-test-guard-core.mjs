/** Return the precise zero-coverage failure, or null when both floors are met. */
export function exampleCoverageFailure(registered, assertions) {
  if (registered === 0) return "registered 0 tests";
  if (assertions === 0) return "executed 0 assertions";
  return null;
}
