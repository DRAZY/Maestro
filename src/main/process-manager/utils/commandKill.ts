// src/main/process-manager/utils/commandKill.ts

import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import { isWindows } from '../../../shared/platformDetection';

/**
 * How long to wait after the polite stop before escalating to SIGKILL.
 *
 * Short, because this only runs when a user has explicitly pressed Stop - they
 * have already decided they don't want the command. It is still non-zero so a
 * well-behaved program gets a chance to clean up (restore the terminal, flush
 * output) rather than being torn down mid-write.
 */
export const COMMAND_KILL_ESCALATION_MS = 1500;

/**
 * Last-resort deadline. If the process still has not reported an exit this long
 * after Stop, the caller gives up waiting and settles anyway, so the UI can
 * never sit on "Stopping..." forever. See LocalCommandRunner.
 */
export const COMMAND_KILL_DEADLINE_MS = 3000;

/**
 * Signal a pid, swallowing "already gone" / "not permitted".
 * Returns true when the signal was delivered.
 */
function killQuiet(target: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(target, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Signal every descendant of `pid` (children, grandchildren, ...).
 *
 * Async and best-effort: it shells out to `ps` to read the whole pid/ppid table
 * and walks it. Used in addition to the group signal because a job-control
 * shell puts each job in its OWN process group, so descendants are frequently
 * unreachable via the parent's group.
 */
function signalDescendants(pid: number, signal: NodeJS.Signals): void {
	void execFileNoThrow('ps', ['-eo', 'pid=,ppid=']).then(({ stdout }) => {
		if (!stdout) return;

		const childrenByParent = new Map<number, number[]>();
		for (const line of stdout.split('\n')) {
			const [childRaw, parentRaw] = line.trim().split(/\s+/);
			const child = Number(childRaw);
			const parent = Number(parentRaw);
			if (!child || Number.isNaN(parent)) continue;
			const siblings = childrenByParent.get(parent);
			if (siblings) siblings.push(child);
			else childrenByParent.set(parent, [child]);
		}

		// Breadth-first walk. `seen` guards against a malformed table looping.
		const seen = new Set<number>([pid]);
		const queue = [pid];
		while (queue.length > 0) {
			const current = queue.shift()!;
			for (const child of childrenByParent.get(current) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				queue.push(child);
				// The child, and its group in case it leads one of its own.
				killQuiet(child, signal);
				killQuiet(-child, signal);
			}
		}
	});
}

/**
 * Send `signal` to a process, its process group, AND everything it spawned.
 *
 * All three, deliberately - they cover different escapes and none subsumes the
 * others:
 *
 *  - **The group** (negative pid) catches children that stayed in the parent's
 *    group, which is the common case for a plain `sh -c 'cmd'`.
 *  - **The pid itself** is NOT an else-branch. `kill(-pid)` succeeding only
 *    means *something* in that group was signalled; an interactive shell with
 *    job control puts each job in its own process group, so the group kill can
 *    report success against the shell while the actual command survives
 *    untouched. Skipping this was why Stop did nothing for `top`.
 *  - **Descendants** catch anything that changed process group after starting,
 *    which no signal aimed at the original group can reach.
 *
 * On Windows there are no process groups in this sense, so `taskkill /t` walks
 * the tree instead.
 */
export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (!pid || pid <= 0) return;

	if (isWindows()) {
		// /t = tree, /f = force. Non-zero exit just means it was already gone,
		// which execFileNoThrow reports rather than throwing.
		void execFileNoThrow('taskkill', ['/pid', String(pid), '/t', '/f']);
		return;
	}

	killQuiet(-pid, signal);
	killQuiet(pid, signal);
	signalDescendants(pid, signal);
}

export interface TerminateOptions {
	sessionId: string;
	/**
	 * Deliver an interrupt through the terminal itself (write `\x03` to the pty).
	 *
	 * This is the *correct* way to stop a foreground job: the tty line discipline
	 * turns Ctrl+C into SIGINT for whichever process group the kernel currently
	 * has in the foreground. That is exactly the job the user is looking at, even
	 * when job control gave it a process group we cannot derive from the shell's
	 * pid - and it is what full-screen programs like `top` expect, so they get to
	 * restore the terminal on the way out.
	 */
	interrupt?: () => void;
}

/**
 * Terminate a one-off command: interrupt, then SIGTERM, then SIGKILL.
 *
 * SIGTERM rather than node-pty's default SIGHUP: an interactive login shell
 * (which is what these commands run under, so aliases resolve) survives SIGHUP
 * on macOS, so the default signal makes Stop silently do nothing.
 *
 * @returns a function that cancels the pending SIGKILL. **Call it when the
 * process exits.** Otherwise a late SIGKILL can land on a recycled pid and
 * take down an unrelated process.
 */
export function terminateProcessTree(pid: number, options: TerminateOptions): () => void {
	const { sessionId, interrupt } = options;

	// Ctrl+C first so a TUI can restore the terminal, then the signal for
	// anything that does not have a tty attached or ignores the interrupt.
	try {
		interrupt?.();
	} catch {
		// A dead pty throws on write - the signals below still apply.
	}
	signalProcessTree(pid, 'SIGTERM');

	const escalationTimer = setTimeout(() => {
		logger.warn(
			'[CommandKill] Command did not exit after SIGTERM, escalating to SIGKILL',
			'ProcessManager',
			{ sessionId, pid }
		);
		signalProcessTree(pid, 'SIGKILL');
	}, COMMAND_KILL_ESCALATION_MS);

	return () => clearTimeout(escalationTimer);
}
