/**
 * Tests for the AutoRunInline editor lock during a paused run.
 *
 * @file src/web/mobile/AutoRunInline.tsx
 *
 * A run that is parked on an agent error or a MAESTRO:HITL gate is waiting on
 * the user, not driving the document. Holding the read-only lock there makes
 * the gate unanswerable on the web surface: the user cannot tick the box the
 * marker is asking about, or fix the step that stalled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AutoRunInline } from '../../../web/mobile/AutoRunInline';
import type { AutoRunState } from '../../../web/hooks/useWebSocket';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentForeground: '#ffffff',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

// remark/rehype is irrelevant to the lock and slows the boot considerably.
vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: () => null,
	TaskAwareMarkdown: () => null,
}));

vi.mock('../../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: () => null,
}));

// One document so the component auto-selects it and renders the editor chrome.
// The returned object and its callbacks must keep a STABLE identity: the
// component resets its selection whenever `loadDocuments` changes, and a fresh
// function per render fights the auto-pick effect into an infinite loop.
const autoRunHook = vi.hoisted(() => ({
	documents: [{ filename: 'PHASE-01', path: 'PHASE-01' }],
	isLoadingDocs: false,
	loadDocuments: vi.fn(),
	saveDocumentContent: vi.fn().mockResolvedValue(true),
	resetDocumentTasks: vi.fn().mockResolvedValue(true),
	stopAutoRun: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../web/hooks/useAutoRun', () => ({
	useAutoRun: () => autoRunHook,
}));

const runState = (overrides: Partial<AutoRunState> = {}) =>
	({
		isRunning: true,
		isStopping: false,
		...overrides,
	}) as AutoRunState;

const renderInline = (autoRunState: AutoRunState | null) =>
	render(
		<AutoRunInline
			sessionId="session-1"
			autoRunState={autoRunState}
			sendRequest={vi.fn().mockResolvedValue({ content: '- [ ] Tick me\n' })}
			send={vi.fn()}
			onOpenSetup={vi.fn()}
		/>
	);

describe('AutoRunInline - editor lock vs a paused run', () => {
	beforeEach(() => {
		// clearAllMocks wipes the resolved values the hook double hands back.
		vi.clearAllMocks();
		autoRunHook.saveDocumentContent.mockResolvedValue(true);
		autoRunHook.resetDocumentTasks.mockResolvedValue(true);
		autoRunHook.stopAutoRun.mockResolvedValue(true);
	});

	it('locks the editor while the run is driving the document', async () => {
		renderInline(runState());

		await waitFor(() =>
			expect(screen.getByTitle('Editing disabled while Auto Run active')).toBeDisabled()
		);
	});

	it('hands the editor back once the run pauses', async () => {
		renderInline(runState({ errorPaused: true }));

		const toggle = await screen.findByTitle('Switch to edit');
		expect(toggle).toBeEnabled();
		expect(screen.queryByTitle('Editing disabled while Auto Run active')).not.toBeInTheDocument();

		fireEvent.click(toggle);
		const textarea = await screen.findByPlaceholderText('Capture notes and tasks in Markdown.');
		expect(textarea).not.toHaveAttribute('readonly');
	});
});
