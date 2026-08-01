/**
 * Tests for useGitAgentActions - the single source of truth behind both git
 * menus (header branch pill dropdown, Left Bar right-click menu).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useGitAgentActions,
	resolveGitCwd,
	resolveGitSshRemoteId,
} from '../../../../renderer/hooks/git/useGitAgentActions';
import type { Session } from '../../../../renderer/types';

const DEFAULT_BRANCH_INFO = { branch: 'feature/login', remote: '', ahead: 4, behind: 1 };
const mockGetBranchInfo = vi.fn(() => DEFAULT_BRANCH_INFO);
vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({ getBranchInfo: mockGetBranchInfo }),
}));

const mockOpenModal = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: Object.assign(
		vi.fn((selector) => selector({ openModal: mockOpenModal })),
		{ getState: () => ({ openModal: mockOpenModal }) }
	),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/test/repo',
		fullPath: '/test/repo',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: true,
		...overrides,
	} as Session;
}

describe('resolveGitCwd', () => {
	it('uses cwd for an AI-mode agent', () => {
		expect(resolveGitCwd(makeSession())).toBe('/test/repo');
	});

	it('prefers the live shell cwd for a terminal-mode agent', () => {
		expect(
			resolveGitCwd(makeSession({ inputMode: 'terminal', shellCwd: '/test/repo/packages/app' }))
		).toBe('/test/repo/packages/app');
	});

	it('falls back to cwd when a terminal agent has no shell cwd yet', () => {
		expect(resolveGitCwd(makeSession({ inputMode: 'terminal' }))).toBe('/test/repo');
	});
});

describe('resolveGitSshRemoteId', () => {
	it('returns undefined for a local agent', () => {
		expect(resolveGitSshRemoteId(makeSession())).toBeUndefined();
	});

	it('reads the top-level id', () => {
		expect(resolveGitSshRemoteId(makeSession({ sshRemoteId: 'remote-1' }))).toBe('remote-1');
	});

	it('reads the per-session config when enabled', () => {
		expect(
			resolveGitSshRemoteId(
				makeSession({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' },
				} as Partial<Session>)
			)
		).toBe('remote-2');
	});

	it('ignores a disabled per-session config', () => {
		expect(
			resolveGitSshRemoteId(
				makeSession({
					sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-2' },
				} as Partial<Session>)
			)
		).toBeUndefined();
	});
});

describe('useGitAgentActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBranchInfo.mockReturnValue(DEFAULT_BRANCH_INFO);
	});

	it('surfaces the polled branch and ahead/behind counts', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.isGitRepo).toBe(true);
		expect(result.current.branch).toBe('feature/login');
		expect(result.current.ahead).toBe(4);
		expect(result.current.behind).toBe(1);
		expect(result.current.canCreatePR).toBe(true);
	});

	it('reports a non-git agent so callers can render nothing', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession({ isGitRepo: false })));

		expect(result.current.isGitRepo).toBe(false);
		expect(result.current.canCreatePR).toBe(false);
	});

	it('tolerates a null session without throwing', () => {
		const { result } = renderHook(() => useGitAgentActions(null));

		expect(result.current.isGitRepo).toBe(false);
		result.current.pull();
		expect(mockOpenModal).not.toHaveBeenCalled();
	});

	it('falls back to the worktree branch when polling has no data yet', () => {
		mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
		const { result } = renderHook(() =>
			useGitAgentActions(makeSession({ worktreeBranch: 'feature/x' }))
		);

		expect(result.current.branch).toBe('feature/x');
		expect(result.current.canCreatePR).toBe(true);
	});

	it('cannot open a PR when no branch is known from either source', () => {
		mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.canCreatePR).toBe(false);
	});

	it('opens the log with an explicit repo target', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.viewLog();

		expect(mockOpenModal).toHaveBeenCalledWith('gitLog', {
			cwd: '/test/repo',
			sshRemoteId: undefined,
		});
	});

	it('opens the streaming runner for pull and push', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		result.current.pull();
		expect(mockOpenModal).toHaveBeenLastCalledWith(
			'gitCommandRunner',
			expect.objectContaining({ operation: 'pull', branch: 'feature/login' })
		);

		result.current.push();
		expect(mockOpenModal).toHaveBeenLastCalledWith(
			'gitCommandRunner',
			expect.objectContaining({ operation: 'push' })
		);
	});

	it('opens the branch switcher seeded with the current branch', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.switchBranch();

		expect(mockOpenModal).toHaveBeenCalledWith(
			'branchSwitcher',
			expect.objectContaining({ sessionId: 'session-1', currentBranch: 'feature/login' })
		);
	});

	it('passes the live branch to the PR modal', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.createPR();

		expect(mockOpenModal).toHaveBeenCalledWith(
			'createPR',
			expect.objectContaining({ sourceBranch: 'feature/login' })
		);
	});

	it('threads the SSH remote into every action', () => {
		const session = makeSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		} as Partial<Session>);
		const { result } = renderHook(() => useGitAgentActions(session));

		result.current.viewLog();
		result.current.pull();
		result.current.switchBranch();

		for (const call of mockOpenModal.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({ sshRemoteId: 'remote-1' }));
		}
	});
});
