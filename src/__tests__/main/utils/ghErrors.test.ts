import { describe, expect, it } from 'vitest';

import {
	isGitHubAuthError,
	isGitHubMissingScopeError,
	isGitHubOAuthRestrictionError,
} from '../../../main/utils/ghErrors';

const OAUTH_RESTRICTION =
	'GraphQL: Although you appear to have the correct authorization credentials, the `RunMaestro` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these policies, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/ (createIssue)';

describe('gh error classifiers', () => {
	it('reads an expired or revoked token as an auth error', () => {
		expect(isGitHubAuthError('HTTP 401: Bad credentials (https://api.github.com/user)')).toBe(true);
		expect(
			isGitHubAuthError({
				message: 'failed',
				stderr: 'To get started with GitHub CLI, please run:  gh auth login',
			})
		).toBe(true);
		expect(isGitHubAuthError('HTTP 404: Not Found')).toBe(false);
	});

	it('reads an org OAuth app restriction apart from a broken login', () => {
		expect(isGitHubOAuthRestrictionError(OAUTH_RESTRICTION)).toBe(true);
		expect(isGitHubAuthError(OAUTH_RESTRICTION)).toBe(false);
		expect(isGitHubOAuthRestrictionError('HTTP 401: Bad credentials')).toBe(false);
	});

	it('reads a token without a needed scope', () => {
		expect(
			isGitHubMissingScopeError(
				'GraphQL: Your token has not been granted the required scopes to execute this query.'
			)
		).toBe(true);
		expect(
			isGitHubMissingScopeError(
				'error: your authentication token is missing required scopes [repo]'
			)
		).toBe(true);
		expect(isGitHubMissingScopeError('HTTP 401: Bad credentials')).toBe(false);
	});
});
