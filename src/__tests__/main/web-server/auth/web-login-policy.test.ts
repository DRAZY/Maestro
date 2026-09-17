import { describe, it, expect, beforeEach, vi } from 'vitest';

const { settings, sessions } = vi.hoisted(() => ({
	settings: new Map<string, unknown>(),
	sessions: new Map<string, { id: string; username: string; displayName: string }>(),
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (k: string) => settings.get(k) }),
}));
vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({
		resolveSession: (sid: string | undefined) => (sid ? sessions.get(sid) : undefined),
	}),
}));

import {
	isLoopbackRequest,
	isWebLoginEnabled,
	isWebRequestAuthorized,
	parseCookies,
	readSessionCookie,
	resolveWebRequestAuth,
} from '../../../../main/web-server/auth/web-login-policy';

const user = { id: 'u1', username: 'pedram', displayName: 'Pedram' };

function req(opts: { cookie?: string; ip?: string }) {
	return {
		headers: opts.cookie ? { cookie: opts.cookie } : {},
		ip: opts.ip ?? '192.168.1.20',
		socket: { remoteAddress: opts.ip ?? '192.168.1.20' },
	} as never;
}

beforeEach(() => {
	settings.clear();
	sessions.clear();
});

describe('parseCookies / readSessionCookie', () => {
	it('parses a header with several cookies and decodes values', () => {
		expect(parseCookies('a=1; maestro_web_session=abc%3D; b = 2')).toEqual({
			a: '1',
			maestro_web_session: 'abc=',
			b: '2',
		});
		expect(parseCookies(undefined)).toEqual({});
		expect(parseCookies('junk; =nope')).toEqual({});
	});

	it('reads the session cookie by name', () => {
		expect(readSessionCookie(req({ cookie: 'x=1; maestro_web_session=sid' }))).toBe('sid');
		expect(readSessionCookie(req({}))).toBeUndefined();
	});
});

describe('isLoopbackRequest', () => {
	it('recognizes v4, v6 and mapped loopback', () => {
		expect(isLoopbackRequest(req({ ip: '127.0.0.1' }))).toBe(true);
		expect(isLoopbackRequest(req({ ip: '::1' }))).toBe(true);
		expect(isLoopbackRequest(req({ ip: '::ffff:127.0.0.1' }))).toBe(true);
		expect(isLoopbackRequest(req({ ip: '10.0.0.5' }))).toBe(false);
	});
});

describe('isWebLoginEnabled', () => {
	it('reads the Encore flag, defaulting off', () => {
		expect(isWebLoginEnabled()).toBe(false);
		settings.set('encoreFeatures', { webLogin: true });
		expect(isWebLoginEnabled()).toBe(true);
	});
});

describe('resolveWebRequestAuth / isWebRequestAuthorized', () => {
	it('authorizes everything when the flag is off, but still names a signed-in user', () => {
		sessions.set('sid', user);
		const auth = resolveWebRequestAuth(req({ cookie: 'maestro_web_session=sid' }));
		expect(auth).toEqual({ required: false, user, loopback: false });
		expect(isWebRequestAuthorized(auth)).toBe(true);
		expect(isWebRequestAuthorized(resolveWebRequestAuth(req({})))).toBe(true);
	});

	it('requires a valid session when the flag is on', () => {
		settings.set('encoreFeatures', { webLogin: true });
		expect(isWebRequestAuthorized(resolveWebRequestAuth(req({})))).toBe(false);
		expect(
			isWebRequestAuthorized(resolveWebRequestAuth(req({ cookie: 'maestro_web_session=bogus' })))
		).toBe(false);
		sessions.set('sid', user);
		const auth = resolveWebRequestAuth(req({ cookie: 'maestro_web_session=sid' }));
		expect(auth.user).toEqual(user);
		expect(isWebRequestAuthorized(auth)).toBe(true);
	});

	it('never gates loopback (maestro-cli)', () => {
		settings.set('encoreFeatures', { webLogin: true });
		const auth = resolveWebRequestAuth(req({ ip: '127.0.0.1' }));
		expect(auth.loopback).toBe(true);
		expect(isWebRequestAuthorized(auth)).toBe(true);
	});
});
