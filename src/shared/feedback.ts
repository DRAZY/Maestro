/**
 * Shared contract for in-app feedback (GitHub issues filed via `gh`).
 *
 * Three callers speak it: the desktop Feedback modal (over IPC), the preload
 * bridge, and `maestro-cli feedback` (over the WS bridge). The limits live here
 * so the CLI refuses exactly what the modal refuses, instead of letting the
 * main process reject a payload the caller already spent an upload on.
 */

export type FeedbackCategory =
	| 'bug_report'
	| 'feature_request'
	| 'improvement'
	| 'general_feedback';

export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
	'bug_report',
	'feature_request',
	'improvement',
	'general_feedback',
];

/** Short spellings the CLI accepts for `--category`. */
export const FEEDBACK_CATEGORY_ALIASES: Readonly<Record<string, FeedbackCategory>> = {
	bug: 'bug_report',
	feature: 'feature_request',
	improvement: 'improvement',
	general: 'general_feedback',
};

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
	return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** Resolve a full category id or a short alias; `null` when neither matches. */
export function resolveFeedbackCategory(value: string): FeedbackCategory | null {
	const needle = value.trim().toLowerCase();
	if (isFeedbackCategory(needle)) return needle;
	return FEEDBACK_CATEGORY_ALIASES[needle] ?? null;
}

/** Screenshot limits enforced by the modal's drop zone and the CLI's `--attach`. */
export const MAX_FEEDBACK_ATTACHMENTS = 5;
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Field limits enforced by the main process before anything is filed. */
export const MAX_FEEDBACK_SUMMARY_LENGTH = 120;
export const MAX_FEEDBACK_FIELD_LENGTH = 5000;

export interface FeedbackAuthResponse {
	authenticated: boolean;
	message?: string;
}

export interface FeedbackSubmitResponse {
	success: boolean;
	error?: string;
	issueUrl?: string;
}

export interface FeedbackAttachmentPayload {
	name: string;
	/** `data:image/<type>;base64,...` */
	dataUrl: string;
}

/** Legacy one-shot form (`feedback:submit`). */
export interface FeedbackSubmissionPayload {
	sessionId: string;
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	details: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
}

/** What the conversational modal and `maestro-cli feedback submit` file. */
export interface FeedbackConversationSubmitPayload {
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
	/** Generate a support package and link it from the issue. */
	includeDebugPackage?: boolean;
}

/** One possible duplicate returned by the issue search. */
export interface FeedbackIssueMatch {
	number: number;
	title: string;
	url: string;
	state: string;
	labels: string[];
	createdAt: string;
	author: string;
	commentCount: number;
}

export interface FeedbackIssueSearchResponse {
	issues: FeedbackIssueMatch[];
}
