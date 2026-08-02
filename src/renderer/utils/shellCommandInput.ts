/**
 * Bang commands ("command mode") for the AI chat composer.
 *
 * A message that starts with `!` is not sent to the agent at all. Maestro
 * strips the bang and runs the rest as a shell command in the agent's working
 * directory, streaming the output back into the transcript. This is the
 * "check something without leaving the chat" escape hatch - `!git pull`,
 * `!ls`, `!npm test`.
 *
 * Escaping: a message that starts with `\!` is a literal message for the agent
 * whose first character is `!`. The backslash is removed before sending.
 */

/** The prefix that switches the AI composer into command mode. */
export const SHELL_COMMAND_PREFIX = '!';

/** The escape that sends a literal leading `!` to the agent instead. */
export const SHELL_COMMAND_ESCAPE = '\\!';

/**
 * True while a draft is in command mode - it starts with `!` (and is not the
 * `\!` escape). Unlike `parseShellCommandInput`, this is true for a bare `!`
 * with nothing typed after it yet, because the composer switches into its
 * CLI affordances (the `$` prefix, Tab completion over files/dirs/branches)
 * the moment you type the bang, before there is a command to run.
 */
export function isShellCommandDraft(raw: string): boolean {
	return raw.trimStart().startsWith(SHELL_COMMAND_PREFIX);
}

/**
 * Strips the command-mode prefix from a draft, returning the command body as
 * typed (leading whitespace removed, but NOT trailing - a trailing space is
 * what tells completion the user has finished a word and wants the next one).
 * Returns null when the draft is not in command mode.
 */
export function getShellCommandBody(raw: string): string | null {
	const trimmed = raw.trimStart();
	if (!trimmed.startsWith(SHELL_COMMAND_PREFIX)) return null;
	return trimmed.slice(SHELL_COMMAND_PREFIX.length);
}

/**
 * Returns the shell command for a bang-prefixed input, or null when the input
 * is an ordinary message for the agent.
 *
 * Leading/trailing whitespace is trimmed first, so ` !ls ` is command mode.
 * A bare `!` with nothing after it is NOT command mode - there is no command
 * to run, so it falls through as a normal message.
 */
export function parseShellCommandInput(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith(SHELL_COMMAND_PREFIX)) return null;
	const command = trimmed.slice(SHELL_COMMAND_PREFIX.length).trim();
	return command.length > 0 ? command : null;
}

/**
 * Removes the command-mode escape from a message bound for the agent, so
 * `\!important` reaches the agent as `!important`. Any other input is
 * returned unchanged.
 */
export function stripShellCommandEscape(raw: string): string {
	const leadingWhitespace = raw.slice(0, raw.length - raw.trimStart().length);
	const rest = raw.trimStart();
	if (!rest.startsWith(SHELL_COMMAND_ESCAPE)) return raw;
	return leadingWhitespace + rest.slice(1);
}
