/**
 * Codex Usage Sampler
 *
 * Reads Codex CLI OAuth metadata from CODEX_HOME/auth.json and asks the
 * ChatGPT quota metadata endpoint for the account's active rate-limit windows.
 * This is intentionally isolated from the renderer so auth tokens never leave
 * the main process.
 */

import type { CodexUsageSnapshot } from '../stores/codexUsageStore';
import { resolveCodexHomeKey } from '../stores/codexUsageStore';
import { codexAuthHeaders, readCodexAuth } from './codex-auth';
import { captureMessage } from '../utils/sentry';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * HTTP statuses from the Codex quota endpoint that say nothing about Maestro.
 *
 * - 401/403: this CODEX_HOME isn't logged in. Surfaced to the UI as
 *   `unauthenticated`.
 * - 408/429/5xx: the upstream is throttling us or is degraded. The sampler runs
 *   on a timer, so a single ChatGPT outage reports once per tick per install -
 *   the dominant source of MAESTRO-RR volume.
 *
 * Anything else (a 4xx that implies we sent a malformed request) still reports,
 * because that would be our bug.
 */
function isExpectedQuotaStatus(status: number): boolean {
	return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export interface SampleCodexUsageOptions {
	codexHome: string;
	timeoutMs?: number;
}

interface WhamUsageWindow {
	used_percent?: unknown;
	reset_at?: unknown;
}

interface WhamUsageResponse {
	email?: unknown;
	plan_type?: unknown;
	rate_limit?: {
		limit_reached?: unknown;
		primary_window?: WhamUsageWindow;
		secondary_window?: WhamUsageWindow;
	};
	additional_rate_limits?: Array<{
		limit_name?: unknown;
		metered_feature?: unknown;
		rate_limit?: {
			primary_window?: WhamUsageWindow;
		};
	}>;
	/**
	 * Reset-credit inventory, which the usage payload already carries - so the
	 * count beside the bars costs no extra request. The full per-credit list
	 * (ids, titles, expiry) needs the dedicated read in `codex-reset-credits.ts`.
	 */
	rate_limit_reset_credits?: {
		available_count?: unknown;
		applicable_available_count?: unknown;
	};
}

export async function sampleCodexUsage(opts: SampleCodexUsageOptions): Promise<CodexUsageSnapshot> {
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: opts.codexHome });
	const sampledAt = new Date().toISOString();

	const auth = await readCodexAuth(codexHomeKey);
	if (!auth.ok) {
		return {
			sampledAt,
			codexHomeKey,
			authState: auth.kind,
			...(auth.email ? { email: auth.email } : {}),
			error: auth.error,
		};
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(
			CODEX_USAGE_ENDPOINT,
			{ headers: codexAuthHeaders(auth) },
			opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
		);
	} catch {
		// A thrown fetch means the request never completed: the user is offline,
		// DNS/TLS failed, the endpoint is unreachable, or our own abort timeout
		// fired. All are expected, recoverable, user-environment conditions - not
		// Maestro bugs - so don't report them to Sentry. The UI still reflects the
		// failure via the returned `error` field. (MAESTRO-RR)
		return {
			sampledAt,
			codexHomeKey,
			authState: 'error',
			email: auth.email,
			error: 'Failed to request Codex quota metadata.',
		};
	}

	if (!response.ok) {
		const status = response.status;
		// Un-logged-in CODEX_HOMEs and a throttled or degraded upstream are
		// expected, recoverable states we surface through the returned snapshot,
		// not failures worth a Sentry breadcrumb. Only report genuinely
		// unexpected HTTP errors. See isExpectedQuotaStatus (MAESTRO-RR).
		if (!isExpectedQuotaStatus(status)) {
			void reportCodexUsageFailure(codexHomeKey, `http ${status}`);
		}
		return {
			sampledAt,
			codexHomeKey,
			authState: status === 401 || status === 403 ? 'unauthenticated' : 'error',
			email: auth.email,
			error:
				status === 401 || status === 403
					? 'Codex auth token was rejected. Run `codex login` for this CODEX_HOME.'
					: `Codex quota endpoint returned HTTP ${status}.`,
		};
	}

	let body: WhamUsageResponse;
	try {
		body = (await response.json()) as WhamUsageResponse;
	} catch (err) {
		void reportCodexUsageFailure(codexHomeKey, `json: ${formatError(err)}`);
		return {
			sampledAt,
			codexHomeKey,
			authState: 'error',
			email: auth.email,
			error: 'Codex quota endpoint returned malformed JSON.',
		};
	}

	const rateLimit = body.rate_limit ?? {};
	const session = parseWindow(rateLimit.primary_window);
	const weekly = parseWindow(rateLimit.secondary_window);

	return {
		sampledAt,
		codexHomeKey,
		authState: 'authenticated',
		email: typeof body.email === 'string' && body.email.length > 0 ? body.email : auth.email,
		planType: typeof body.plan_type === 'string' ? body.plan_type : undefined,
		session: session ?? undefined,
		weekly: weekly ?? undefined,
		additionalLimits: parseAdditionalLimits(body.additional_rate_limits),
		resetCredits: parseResetCreditCounts(body.rate_limit_reset_credits),
	};
}

/**
 * The two reset-credit counts, kept apart deliberately.
 *
 * `available` is inventory; `applicable` is how many would take effect right
 * now, which the API reports as 0 whenever no window is consumed enough for a
 * reset to change anything. An absent `applicable` stays `undefined` rather
 * than becoming 0 - see `CodexResetCreditCounts`, where unknown and zero drive
 * different verdicts.
 */
function parseResetCreditCounts(
	raw: WhamUsageResponse['rate_limit_reset_credits']
): CodexUsageSnapshot['resetCredits'] {
	if (!raw || typeof raw !== 'object') return undefined;
	const available = readCount(raw.available_count);
	if (available === undefined) return undefined;
	return { available, applicable: readCount(raw.applicable_available_count) };
}

function readCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseWindow(window: WhamUsageWindow | undefined): CodexUsageSnapshot['session'] | null {
	if (!window) return null;
	if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) {
		return null;
	}
	const resetsAt = parseResetAt(window.reset_at);
	if (!resetsAt) return null;
	return {
		percent: window.used_percent,
		resetsAt,
	};
}

function parseAdditionalLimits(
	limits: WhamUsageResponse['additional_rate_limits']
): CodexUsageSnapshot['additionalLimits'] {
	if (!Array.isArray(limits)) return [];
	const parsed: NonNullable<CodexUsageSnapshot['additionalLimits']> = [];
	for (const limit of limits) {
		const name =
			typeof limit.limit_name === 'string'
				? limit.limit_name
				: typeof limit.metered_feature === 'string'
					? limit.metered_feature
					: null;
		const window = parseWindow(limit.rate_limit?.primary_window);
		if (!name || !window) continue;
		parsed.push({ name, percent: window.percent, resetsAt: window.resetsAt });
	}
	return parsed;
}

function parseResetAt(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const milliseconds = value > 10_000_000_000 ? value : value * 1000;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function reportCodexUsageFailure(codexHomeKey: string, reason: string): Promise<void> {
	await captureMessage('codex usage sample failed', 'warning', {
		codexHomeKey,
		reason,
	});
}
