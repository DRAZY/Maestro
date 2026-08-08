/**
 * Tests for commandKill - how a one-off command is actually terminated.
 *
 * Two things here are load-bearing and were the bug:
 *  - the SIGNAL: node-pty's default is SIGHUP, which an interactive login shell
 *    (what these commands run under, so aliases resolve) survives on macOS, so
 *    Stop silently did nothing.
 *  - the TARGET: signalling only the shell leaves the actual command running,
 *    and a surviving grandchild holds the pty slave open so no exit is ever
 *    reported - the card sits on "Running..." forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecFile, mockIsWindows } = vi.hoisted(() => ({
	mockExecFile: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
	mockIsWindows: vi.fn(() => false),
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: mockExecFile,
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mockIsWindows,
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
	signalProcessTree,
	terminateProcessTree,
	COMMAND_KILL_ESCALATION_MS,
} from '../../../../main/process-manager/utils/commandKill';

const PID = 4242;

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mockIsWindows.mockReturnValue(false);
	killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
	killSpy.mockRestore();
	vi.useRealTimers();
});

describe('signalProcessTree', () => {
	it('signals BOTH the process group and the pid itself', () => {
		// Not either/or. `kill(-pid)` succeeding only proves *something* in that
		// group was signalled; a job-control shell keeps the shell in that group
		// while the actual job runs in its own, so the group kill can report
		// success while the command survives. Skipping the direct pid was why
		// Stop did nothing for `top`.
		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
		expect(killSpy).toHaveBeenCalledWith(PID, 'SIGTERM');
	});

	it('still signals the pid when the group signal fails', () => {
		killSpy.mockImplementationOnce(() => {
			throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
		});

		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).toHaveBeenNthCalledWith(1, -PID, 'SIGTERM');
		expect(killSpy).toHaveBeenNthCalledWith(2, PID, 'SIGTERM');
	});

	it('sweeps descendants, which no group signal can reach once they re-group', async () => {
		// The sweep is async (it shells out to `ps`), so this one needs real timers.
		vi.useRealTimers();
		// pid 4242 -> 5000 -> 6000
		mockExecFile.mockResolvedValueOnce({
			stdout: `${PID} 1\n5000 ${PID}\n6000 5000\n7777 1\n`,
			stderr: '',
			code: 0,
		});

		signalProcessTree(PID, 'SIGKILL');
		await new Promise((r) => setTimeout(r, 0));

		expect(killSpy).toHaveBeenCalledWith(5000, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(6000, 'SIGKILL');
		// An unrelated process must never be touched.
		expect(killSpy).not.toHaveBeenCalledWith(7777, 'SIGKILL');
	});

	it('swallows a fully-dead process', () => {
		killSpy.mockImplementation(() => {
			throw Object.assign(new Error('gone'), { code: 'ESRCH' });
		});

		expect(() => signalProcessTree(PID, 'SIGKILL')).not.toThrow();
	});

	it('ignores a missing or invalid pid', () => {
		signalProcessTree(0, 'SIGTERM');
		signalProcessTree(-1, 'SIGTERM');

		expect(killSpy).not.toHaveBeenCalled();
	});

	it('uses taskkill /t /f on Windows, which has no process groups', () => {
		mockIsWindows.mockReturnValue(true);

		signalProcessTree(PID, 'SIGTERM');

		expect(killSpy).not.toHaveBeenCalled();
		expect(mockExecFile).toHaveBeenCalledWith('taskkill', ['/pid', String(PID), '/t', '/f']);
	});
});

describe('terminateProcessTree', () => {
	it('sends SIGTERM immediately - NOT SIGHUP, which shells survive', () => {
		terminateProcessTree(PID, { sessionId: 's1' });

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
		expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGHUP');
		expect(killSpy).not.toHaveBeenCalledWith(PID, 'SIGHUP');
	});

	it('escalates to SIGKILL when the process ignores SIGTERM', () => {
		terminateProcessTree(PID, { sessionId: 's1' });
		expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL');

		vi.advanceTimersByTime(COMMAND_KILL_ESCALATION_MS);

		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGKILL');
		expect(killSpy).toHaveBeenCalledWith(PID, 'SIGKILL');
	});

	it('sends Ctrl+C through the pty before signalling', () => {
		// The tty turns this into SIGINT for the kernel's foreground process
		// group - the right target for a full-screen program like `top`, and
		// reachable even when job control moved it to its own group.
		const interrupt = vi.fn();
		terminateProcessTree(PID, { sessionId: 's1', interrupt });

		expect(interrupt).toHaveBeenCalled();
	});

	it('still signals when the pty write throws', () => {
		const interrupt = vi.fn(() => {
			throw new Error('pty is gone');
		});

		expect(() => terminateProcessTree(PID, { sessionId: 's1', interrupt })).not.toThrow();
		expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
	});

	it('does not escalate once the caller reports the process exited', () => {
		// Critical: a late SIGKILL against a recycled pid would kill an unrelated
		// process, so the exit handler must be able to call this off.
		const cancel = terminateProcessTree(PID, { sessionId: 's1' });
		cancel();

		vi.advanceTimersByTime(COMMAND_KILL_ESCALATION_MS * 4);

		expect(killSpy).not.toHaveBeenCalledWith(-PID, 'SIGKILL');
		expect(killSpy).not.toHaveBeenCalledWith(PID, 'SIGKILL');
	});

	it('escalates promptly - Stop should not feel like it hung', () => {
		expect(COMMAND_KILL_ESCALATION_MS).toBeLessThanOrEqual(2000);
	});
});
