/**
 * Tests for GitPillMenu - the header git pill dropdown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitPillMenu } from '../../../renderer/components/GitPillMenu';
import { mockTheme } from '../../helpers/mockTheme';

// Mock the LayerStackContext (Escape handling is covered by its own tests)
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

function renderMenu(overrides: Partial<React.ComponentProps<typeof GitPillMenu>> = {}) {
	const props = {
		theme: mockTheme,
		anchorRef: { current: null },
		ahead: 0,
		behind: 0,
		onViewLog: vi.fn(),
		onPull: vi.fn(),
		onPush: vi.fn(),
		onSwitchBranch: vi.fn(),
		onCreatePR: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
	render(<GitPillMenu {...props} />);
	return props;
}

describe('GitPillMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders all five actions', () => {
		renderMenu();
		expect(screen.getByText('View Git Log')).toBeInTheDocument();
		expect(screen.getByText('Git Pull')).toBeInTheDocument();
		expect(screen.getByText('Git Push')).toBeInTheDocument();
		expect(screen.getByText('Change Branch')).toBeInTheDocument();
		expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
	});

	it('omits Create Pull Request when no handler is supplied', () => {
		renderMenu({ onCreatePR: undefined });
		expect(screen.queryByTestId('git-pill-menu-create-pr')).not.toBeInTheDocument();
		// The rest of the menu is unaffected.
		expect(screen.getByText('Change Branch')).toBeInTheDocument();
	});

	it('calls the matching handler for each action', () => {
		const props = renderMenu();

		fireEvent.click(screen.getByTestId('git-pill-menu-log'));
		expect(props.onViewLog).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-pull'));
		expect(props.onPull).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-push'));
		expect(props.onPush).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-switch-branch'));
		expect(props.onSwitchBranch).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-create-pr'));
		expect(props.onCreatePR).toHaveBeenCalled();
	});

	it('badges pull and push with behind/ahead counts', () => {
		renderMenu({ ahead: 3, behind: 2 });
		expect(screen.getByTestId('git-pill-menu-pull')).toHaveTextContent('2');
		expect(screen.getByTestId('git-pill-menu-push')).toHaveTextContent('3');
	});

	it('omits the counts when in sync with upstream', () => {
		renderMenu();
		expect(screen.getByTestId('git-pill-menu-pull')).toHaveTextContent(/^Git Pull$/);
		expect(screen.getByTestId('git-pill-menu-push')).toHaveTextContent(/^Git Push$/);
	});
});
