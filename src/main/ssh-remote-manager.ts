/**
 * SSH Remote Manager for Maestro.
 *
 * Manages SSH remote configurations and provides connection testing.
 * Used to execute AI agent commands on remote hosts via SSH.
 */

import { SshRemoteConfig, SshRemoteTestResult } from '../shared/types';
import { execFileNoThrow, ExecResult } from './utils/execFile';
import { expandTilde } from '../shared/pathUtils';
import { captureException } from './utils/sentry';
import { getPathAccessCache, defaultReadableProbe } from './utils/path-access-cache';

/**
 * Which non-POSIX shell answered the connection test, if any.
 */
export type NonPosixRemoteShell = 'powershell' | 'cmd';

/**
 * Signatures a Windows remote emits when its default OpenSSH shell rejects the
 * POSIX test command.
 *
 * Windows OpenSSH ships with cmd.exe as `DefaultShell` and is commonly switched
 * to Windows PowerShell 5.1, which has no `&&` operator (it arrived in
 * PowerShell 7). cmd.exe does understand `&&`, so it fails differently: it runs
 * the command but echoes the marker with its quotes intact, which the marker
 * check below catches.
 */
const POWERSHELL_SHELL_SIGNATURES = [
	'is not a valid statement separator in this version',
	'the ampersand (&) character is not allowed',
	'fullyqualifiederrorid',
	'parsererror',
];

const CMD_SHELL_SIGNATURES = [
	'was unexpected at this time',
	'is not recognized as an internal or external command',
];

/**
 * Classify a failed test response as a Windows shell rejecting POSIX syntax.
 *
 * @param output Combined stdout/stderr from the failed test command
 * @returns The shell family that answered, or undefined if unrecognized
 */
export function detectNonPosixRemoteShell(output: string): NonPosixRemoteShell | undefined {
	const lower = output.toLowerCase();
	if (POWERSHELL_SHELL_SIGNATURES.some((sig) => lower.includes(sig))) {
		return 'powershell';
	}
	if (CMD_SHELL_SIGNATURES.some((sig) => lower.includes(sig))) {
		return 'cmd';
	}
	return undefined;
}

/**
 * The failure message for a reachable host whose default SSH shell is not POSIX.
 *
 * Authentication and networking are fine in this case, so reporting a raw
 * PowerShell parser dump (or "Unexpected response from remote host") sends the
 * user hunting for a key or firewall problem that does not exist. Remote agent
 * execution pipes a POSIX script into `/bin/bash`, so the only fix is changing
 * the remote's shell.
 *
 * @param shell The shell family detected on the remote
 * @param hostname Remote hostname if the probe recovered one
 */
export function nonPosixRemoteShellMessage(shell: NonPosixRemoteShell, hostname?: string): string {
	const shellName = shell === 'powershell' ? 'Windows PowerShell' : 'cmd.exe';
	const target = hostname ? `Connected to ${hostname}, but its` : 'Connected, but the remote';
	return (
		`${target} default SSH shell is ${shellName}. Maestro runs remote agents by piping ` +
		`a POSIX script into /bin/bash, which Windows shells cannot execute. Set the remote's ` +
		`OpenSSH DefaultShell to a POSIX shell (Git Bash or WSL bash) and test again.`
	);
}

/**
 * Validation result for SSH remote configuration.
 */
export interface SshRemoteValidation {
	/** Whether the configuration is valid */
	valid: boolean;
	/** List of validation error messages */
	errors: string[];
}

/**
 * Dependencies that can be injected for testing.
 */
export interface SshRemoteManagerDeps {
	/** Function to check file accessibility */
	checkFileAccess: (filePath: string) => boolean;
	/** Function to execute SSH commands */
	execSsh: (command: string, args: string[]) => Promise<ExecResult>;
}

/**
 * Default dependencies using real implementations. `checkFileAccess` is
 * wrapped behind {@link PathAccessCache} so rapid re-validation (e.g.
 * consecutive Test Connection clicks) skips the duplicate stat. Test
 * deps mock `checkFileAccess` directly and bypass the cache entirely.
 */
const defaultDeps: SshRemoteManagerDeps = {
	checkFileAccess: (filePath: string): boolean => {
		return getPathAccessCache().check(filePath, defaultReadableProbe);
	},
	execSsh: (command: string, args: string[]): Promise<ExecResult> => {
		return execFileNoThrow(command, args);
	},
};

/**
 * Manager for SSH remote configurations and connections.
 *
 * Provides:
 * - Configuration validation
 * - Connection testing
 * - SSH argument building
 */
export class SshRemoteManager {
	private readonly deps: SshRemoteManagerDeps;

	/**
	 * Default SSH options used for all connections.
	 * These options ensure non-interactive key-based authentication.
	 */
	private readonly defaultSshOptions: Record<string, string> = {
		BatchMode: 'yes', // Disable password prompts (key-only)
		StrictHostKeyChecking: 'accept-new', // Auto-accept new host keys
		ConnectTimeout: '10', // Connection timeout in seconds
		ClearAllForwardings: 'yes', // Disable port forwarding from SSH config (avoids "Address already in use" errors)
		RequestTTY: 'no', // Don't request a TTY for command execution (avoids shell rc issues)
	};

	/**
	 * Create a new SshRemoteManager.
	 *
	 * @param deps Optional dependencies for testing. Uses real implementations if not provided.
	 */
	constructor(deps?: Partial<SshRemoteManagerDeps>) {
		this.deps = { ...defaultDeps, ...deps };
	}

	/**
	 * Validate an SSH remote configuration.
	 *
	 * Checks:
	 * - Required fields are present
	 * - Port is in valid range (1-65535)
	 * - Private key file exists and is readable (unless using SSH config)
	 *
	 * When useSshConfig is true, username and privateKeyPath are optional
	 * as they can be inherited from ~/.ssh/config.
	 *
	 * @param config The SSH remote configuration to validate
	 * @returns Validation result with any error messages
	 */
	validateConfig(config: SshRemoteConfig): SshRemoteValidation {
		const errors: string[] = [];

		// Note: id is intentionally NOT validated here. It is a storage concern,
		// not a connection concern, and the save handler always assigns one
		// (crypto.randomUUID) before persisting. Requiring it here would break
		// "Test Connection" before saving a brand-new remote, which has no id yet.

		if (!config.name || config.name.trim() === '') {
			errors.push('Name is required');
		}

		if (!config.host || config.host.trim() === '') {
			errors.push('Host is required');
		}

		// Username and privateKeyPath are always optional - SSH will use:
		// 1. Values from ~/.ssh/config if the host matches a Host pattern
		// 2. ssh-agent for key authentication
		// 3. System defaults (current user, default keys)
		// The connection test will verify if the configuration actually works.

		// Port validation
		if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
			errors.push('Port must be between 1 and 65535');
		}

		// Private key file existence check (only if path is provided)
		if (config.privateKeyPath && config.privateKeyPath.trim() !== '') {
			const keyPath = expandTilde(config.privateKeyPath);
			if (!this.deps.checkFileAccess(keyPath)) {
				errors.push(`Private key not readable: ${config.privateKeyPath}`);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Test SSH connection to a remote host.
	 *
	 * Executes a simple command on the remote to verify:
	 * - SSH connection can be established
	 * - Authentication succeeds
	 * - Remote shell is accessible
	 *
	 * Optionally checks if the specified agent command is available.
	 *
	 * @param config The SSH remote configuration to test
	 * @param agentCommand Optional agent command to check availability (e.g., 'claude')
	 * @returns Test result with success status and remote info
	 */
	async testConnection(
		config: SshRemoteConfig,
		agentCommand?: string
	): Promise<SshRemoteTestResult> {
		// First validate the config
		const validation = this.validateConfig(config);
		if (!validation.valid) {
			return {
				success: false,
				error: validation.errors.join('; '),
			};
		}

		// Build SSH command for connection test
		const sshArgs = this.buildSshArgs(config);

		// Test command: echo marker, get hostname, optionally check agent
		let testCommand = 'echo "SSH_OK" && hostname';
		if (agentCommand) {
			testCommand += ` && which ${agentCommand} 2>/dev/null || echo "AGENT_NOT_FOUND"`;
		}
		sshArgs.push(testCommand);

		try {
			const result = await this.deps.execSsh('ssh', sshArgs);

			if (result.exitCode !== 0) {
				// A Windows shell rejecting `&&` means SSH itself worked; say so
				// rather than surfacing the PowerShell parser dump as a connection error.
				const shell = detectNonPosixRemoteShell(`${result.stdout}\n${result.stderr}`);
				if (shell) {
					return {
						success: false,
						error: nonPosixRemoteShellMessage(shell, await this.probeHostname(config)),
					};
				}

				// Parse common SSH error patterns
				const errorMessage = this.parseSSHError(result.stderr) || 'Connection failed';
				return { success: false, error: errorMessage };
			}

			const lines = result.stdout.trim().split('\n');

			// Verify we got our marker
			if (lines[0] !== 'SSH_OK') {
				// cmd.exe honors `&&` but does not strip the quotes around the marker,
				// so a quoted marker identifies the shell rather than a broken host.
				if (lines[0] === '"SSH_OK"') {
					return {
						success: false,
						error: nonPosixRemoteShellMessage('cmd', lines[1] || undefined),
					};
				}
				return { success: false, error: 'Unexpected response from remote host' };
			}

			// Extract hostname and agent info
			const hostname = lines[1] || 'unknown';
			let agentVersion: string | undefined;

			if (agentCommand && lines[2]) {
				if (lines[2] !== 'AGENT_NOT_FOUND') {
					agentVersion = 'installed'; // Path found = agent installed
				}
			}

			return {
				success: true,
				remoteInfo: {
					hostname,
					agentVersion,
				},
			};
		} catch (err) {
			void captureException(err);
			return {
				success: false,
				error: `Connection test failed: ${String(err)}`,
			};
		}
	}

	/**
	 * Ask a remote for its hostname with a command every shell understands.
	 *
	 * `hostname` is a bare executable on Windows and a builtin or binary on
	 * POSIX systems, so it survives the shell mismatch that broke the main test
	 * command. Used only to name the host in the non-POSIX shell error.
	 *
	 * @param config The SSH remote configuration
	 * @returns The remote hostname, or undefined if the probe failed
	 */
	private async probeHostname(config: SshRemoteConfig): Promise<string | undefined> {
		try {
			const args = this.buildSshArgs(config);
			args.push('hostname');
			const result = await this.deps.execSsh('ssh', args);
			if (result.exitCode !== 0) {
				return undefined;
			}
			return result.stdout.trim().split('\n')[0]?.trim() || undefined;
		} catch {
			// The caller already has a failure to report; a missing hostname only
			// costs the error message some specificity.
			return undefined;
		}
	}

	/**
	 * Build SSH command-line arguments for a remote connection.
	 *
	 * Constructs the argument array needed for spawning SSH with
	 * proper authentication and connection options.
	 *
	 * When config.useSshConfig is true, the arguments are minimal,
	 * allowing SSH to use settings from ~/.ssh/config.
	 *
	 * @param config The SSH remote configuration
	 * @returns Array of SSH command-line arguments
	 */
	buildSshArgs(config: SshRemoteConfig): string[] {
		const args: string[] = [];

		// Force disable TTY allocation - this helps prevent shell rc files from being sourced
		args.push('-T');

		// Private key - only add if explicitly provided
		// SSH will use ~/.ssh/config or ssh-agent if no key is specified
		if (config.privateKeyPath && config.privateKeyPath.trim()) {
			args.push('-i', expandTilde(config.privateKeyPath));
		}

		// Default SSH options
		for (const [key, value] of Object.entries(this.defaultSshOptions)) {
			args.push('-o', `${key}=${value}`);
		}

		// Port (only add if not using SSH config, or if non-default)
		if (!config.useSshConfig || config.port !== 22) {
			args.push('-p', config.port.toString());
		}

		// Build destination - use user@host if username provided, otherwise just host
		// SSH will use current user or ~/.ssh/config User directive if no username specified
		if (config.username && config.username.trim()) {
			args.push(`${config.username}@${config.host}`);
		} else {
			args.push(config.host);
		}

		return args;
	}

	/**
	 * Parse SSH error messages to provide user-friendly descriptions.
	 *
	 * @param stderr The stderr output from SSH
	 * @returns Human-readable error message, or undefined if not recognized
	 */
	private parseSSHError(stderr: string): string | undefined {
		const lowerStderr = stderr.toLowerCase();

		if (lowerStderr.includes('permission denied')) {
			return 'Authentication failed. Check username and private key.';
		}

		if (lowerStderr.includes('connection refused')) {
			return 'Connection refused. Check host and port.';
		}

		if (lowerStderr.includes('connection timed out') || lowerStderr.includes('timed out')) {
			return 'Connection timed out. Check host and network.';
		}

		if (lowerStderr.includes('no route to host')) {
			return 'No route to host. Check host address and network.';
		}

		if (
			lowerStderr.includes('could not resolve hostname') ||
			lowerStderr.includes('name or service not known')
		) {
			return 'Could not resolve hostname. Check the host address.';
		}

		if (lowerStderr.includes('remote host identification has changed')) {
			return 'SSH host key changed. Verify server identity and update known_hosts.';
		}

		if (lowerStderr.includes('passphrase')) {
			return 'Private key has a passphrase. Key-based auth requires passphrase-less keys.';
		}

		if (lowerStderr.includes('no such file')) {
			return 'Private key file not found.';
		}

		// Return the raw stderr if we don't recognize the pattern
		if (stderr.trim()) {
			return stderr.trim();
		}

		return undefined;
	}
}

/**
 * Singleton instance of SshRemoteManager.
 * Use this for all SSH remote operations.
 */
export const sshRemoteManager = new SshRemoteManager();
