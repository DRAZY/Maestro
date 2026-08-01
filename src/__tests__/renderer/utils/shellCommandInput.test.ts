/**
 * Tests for src/renderer/utils/shellCommandInput.ts
 * Command-mode (`!command`) detection and escaping for the AI composer.
 */

import { describe, test, expect } from 'vitest';
import {
	parseShellCommandInput,
	stripShellCommandEscape,
} from '../../../renderer/utils/shellCommandInput';

describe('parseShellCommandInput', () => {
	test('returns the command for a bang-prefixed input', () => {
		expect(parseShellCommandInput('!git status')).toBe('git status');
	});

	test('trims surrounding whitespace', () => {
		expect(parseShellCommandInput('  !ls -la  ')).toBe('ls -la');
	});

	test('keeps the command body intact, including pipes and quotes', () => {
		expect(parseShellCommandInput('!grep -rn "foo bar" src | head -5')).toBe(
			'grep -rn "foo bar" src | head -5'
		);
	});

	test('handles no space after the bang', () => {
		expect(parseShellCommandInput('!ls')).toBe('ls');
	});

	test('returns null for an ordinary message', () => {
		expect(parseShellCommandInput('fix the login bug')).toBeNull();
	});

	test('returns null when the bang is not leading', () => {
		expect(parseShellCommandInput('do it now! please')).toBeNull();
	});

	test('returns null for a bare bang with no command', () => {
		expect(parseShellCommandInput('!')).toBeNull();
		expect(parseShellCommandInput('!   ')).toBeNull();
	});

	test('returns null for the escape form', () => {
		expect(parseShellCommandInput('\\!important message')).toBeNull();
	});

	test('returns null for empty input', () => {
		expect(parseShellCommandInput('')).toBeNull();
	});
});

describe('stripShellCommandEscape', () => {
	test('unwraps a leading escaped bang', () => {
		expect(stripShellCommandEscape('\\!important message')).toBe('!important message');
	});

	test('preserves leading whitespace while unwrapping', () => {
		expect(stripShellCommandEscape('  \\!hey')).toBe('  !hey');
	});

	test('leaves ordinary messages untouched', () => {
		expect(stripShellCommandEscape('fix the login bug')).toBe('fix the login bug');
	});

	test('leaves a real bang command untouched', () => {
		expect(stripShellCommandEscape('!git status')).toBe('!git status');
	});

	test('only strips the leading escape, not later ones', () => {
		expect(stripShellCommandEscape('\\!a and \\!b')).toBe('!a and \\!b');
	});

	test('leaves a non-leading backslash-bang untouched', () => {
		expect(stripShellCommandEscape('echo \\!x')).toBe('echo \\!x');
	});
});
