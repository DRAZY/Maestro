/**
 * Pure classifiers for `gh` CLI failures.
 *
 * Kept import-free and apart from `cliDetection.ts` (which spawns processes and
 * is mocked wholesale by most tests) so every gh caller - the Cue GitHub poller,
 * Send Feedback - reads failures the same way.
 */

/**
 * Lowercased `message` + `stderr` of a `gh` CLI failure, joined for pattern
 * matching. `gh` reports the interesting detail (rate limits, HTTP status,
 * auth hints) in stderr text rather than in a structured error code, and
 * `execFile` rejections carry it on a separate property from the message, so
 * every classifier below has to look at both.
 */
export function ghErrorHaystack(err: unknown): string {
	const msg = (
		err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
			? err.message
			: String(err ?? '')
	).toLowerCase();
	const stderr =
		err &&
		typeof err === 'object' &&
		'stderr' in err &&
		typeof (err as { stderr: unknown }).stderr === 'string'
			? (err as { stderr: string }).stderr.toLowerCase()
			: '';
	return `${msg}\n${stderr}`;
}

/**
 * Detect GitHub CLI authentication failures - an expired, revoked, or missing
 * `gh` token.
 *
 * Deliberately NOT folded into `isGitHubConnectivityError`: that predicate is
 * documented and unit-tested as *not* matching auth/configuration failures, and
 * the two want different user-facing guidance ("GitHub is unreachable, we'll
 * retry" vs "re-authenticate `gh`"). What they share is that neither is a
 * Maestro bug, so neither should page Sentry. Without this, one install whose
 * token went stale files an event on every poll tick indefinitely - MAESTRO-KE
 * collected 924 of them from a single trigger.
 */
export function isGitHubAuthError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		/\bhttp\s+401\b/.test(haystack) ||
		haystack.includes('bad credentials') ||
		haystack.includes('gh auth login') ||
		haystack.includes('requires authentication') ||
		haystack.includes('authentication required') ||
		haystack.includes('not logged into any github hosts')
	);
}

/**
 * Detect an organization's OAuth App access restriction. The GitHub CLI signs in
 * as an OAuth app, so an org that restricts third-party apps refuses its token
 * even though the login itself is valid - `gh auth status` reports green and the
 * request still fails, with an error that reads like a broken login.
 */
export function isGitHubOAuthRestrictionError(err: unknown): boolean {
	return ghErrorHaystack(err).includes('oauth app access restrictions');
}

/** Detect a valid token that lacks a scope the request needs. */
export function isGitHubMissingScopeError(err: unknown): boolean {
	const haystack = ghErrorHaystack(err);
	return (
		haystack.includes('required scopes') ||
		/needs? the "?[a-z:_]+"? scope/.test(haystack) ||
		haystack.includes('missing required scope')
	);
}
