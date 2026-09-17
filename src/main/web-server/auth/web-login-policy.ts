/**
 * Web Login policy - is a login required, and who is this request?
 *
 * Every enforcement point (the served index, the REST routes, the media and
 * image routes, the WebSocket upgrade) asks these two questions and nothing
 * else, so they cannot drift on what "logged in" means.
 */

import type { FastifyRequest } from 'fastify';
import { resolveEncoreFeatures } from '../../../shared/encoreFeatureDefaults';
import { WEB_LOGIN_COOKIE, type WebActingUser } from '../../../shared/webLogin';
import { getSettingsStore } from '../../stores/getters';
import { getWebUserStore } from './web-user-store';

/** The `webLogin` Encore flag, read live so a toggle takes effect on the next request. */
export function isWebLoginEnabled(): boolean {
	try {
		return resolveEncoreFeatures(getSettingsStore().get('encoreFeatures')).webLogin === true;
	} catch {
		// Stores not initialized (tests, very early boot): no gate.
		return false;
	}
}

/** Minimal cookie header parse - the request carries at most a handful of cookies. */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!name) continue;
		try {
			out[name] = decodeURIComponent(value);
		} catch {
			out[name] = value;
		}
	}
	return out;
}

export function readSessionCookie(request: Pick<FastifyRequest, 'headers'>): string | undefined {
	const header = request.headers.cookie;
	return parseCookies(Array.isArray(header) ? header.join('; ') : header)[WEB_LOGIN_COOKIE];
}

/**
 * Loopback callers are never gated: `maestro-cli` connects to
 * `ws://127.0.0.1:<port>/<token>/ws` with no cookie, and a login wall there
 * would silently break every CLI command the moment the flag is turned on.
 * A browser on the same machine is exempt too, which is the desktop owner.
 */
export function isLoopbackRequest(request: Pick<FastifyRequest, 'ip' | 'socket'>): boolean {
	const ip = request.ip || request.socket?.remoteAddress || '';
	return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export interface WebRequestAuth {
	/** The `webLogin` Encore flag at the time of the request. */
	required: boolean;
	/** The account behind a valid session cookie, whether or not one is required. */
	user: WebActingUser | undefined;
	/** Loopback callers (maestro-cli, a browser on the same machine) are never gated. */
	loopback: boolean;
}

/**
 * One answer per request. `user` is set whenever a valid session cookie is
 * present, even when login is not required, so attribution keeps working for
 * a browser that signed in before the gate was switched off. A request is
 * AUTHORIZED when `!required || loopback || user`.
 */
export function resolveWebRequestAuth(
	request: Pick<FastifyRequest, 'headers' | 'ip' | 'socket'>
): WebRequestAuth {
	return {
		required: isWebLoginEnabled(),
		user: getWebUserStore().resolveSession(readSessionCookie(request)),
		loopback: isLoopbackRequest(request),
	};
}

export function isWebRequestAuthorized(auth: WebRequestAuth): boolean {
	return !auth.required || auth.loopback || auth.user !== undefined;
}
