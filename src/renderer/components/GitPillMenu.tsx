/**
 * GitPillMenu - dropdown for the header git/branch pill.
 *
 * Clicking the pill used to jump straight to the git log. It now opens this
 * menu: log, pull, push, and branch switching, all from the one control that
 * already represents "this agent's repo".
 */

import { memo, useRef } from 'react';
import {
	ArrowDown,
	ArrowDownToLine,
	ArrowUp,
	ArrowUpFromLine,
	GitBranch,
	GitPullRequest,
	History,
} from 'lucide-react';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Theme } from '../types';

export interface GitPillMenuProps {
	theme: Theme;
	/** Ref of the pill button, so clicking it again toggles instead of re-opening. */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** Commits ahead of upstream - badged on Push. */
	ahead: number;
	/** Commits behind upstream - badged on Pull. */
	behind: number;
	onViewLog: () => void;
	onPull: () => void;
	onPush: () => void;
	onSwitchBranch: () => void;
	/** Omitted when the agent has no branch to open a PR from. */
	onCreatePR?: () => void;
	onClose: () => void;
}

interface MenuRowProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	badge?: React.ReactNode;
	onClick: () => void;
	testId: string;
}

function MenuRow({ theme, icon, label, badge, onClick, testId }: MenuRowProps) {
	return (
		<button
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors outline-none"
			style={{ color: theme.colors.textMain }}
			data-testid={testId}
		>
			{icon}
			{label}
			{badge}
		</button>
	);
}

export const GitPillMenu = memo(function GitPillMenu({
	theme,
	anchorRef,
	ahead,
	behind,
	onViewLog,
	onPull,
	onPush,
	onSwitchBranch,
	onCreatePR,
	onClose,
}: GitPillMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	// Escape closes the menu before any modal underneath it.
	useModalLayer(MODAL_PRIORITIES.GIT_PILL_MENU, 'Git Pill Menu', onClose);
	useClickOutside([menuRef, anchorRef], onClose, true, { delay: true, eventType: 'click' });

	const iconStyle = { color: theme.colors.textDim };

	return (
		<div
			ref={menuRef}
			className="absolute top-full left-0 mt-2 z-50 rounded shadow-xl overflow-hidden whitespace-nowrap select-none"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				minWidth: '12rem',
			}}
			role="menu"
			data-testid="git-pill-menu"
		>
			<div className="p-1">
				<MenuRow
					theme={theme}
					testId="git-pill-menu-log"
					icon={<History className="w-3.5 h-3.5" style={iconStyle} />}
					label="View Git Log"
					onClick={onViewLog}
				/>
				<MenuRow
					theme={theme}
					testId="git-pill-menu-pull"
					icon={<ArrowDownToLine className="w-3.5 h-3.5" style={iconStyle} />}
					label="Git Pull"
					badge={
						behind > 0 ? (
							<span className="ml-auto flex items-center gap-0.5 text-[10px] text-red-500">
								<ArrowDown className="w-3 h-3" />
								{behind}
							</span>
						) : undefined
					}
					onClick={onPull}
				/>
				<MenuRow
					theme={theme}
					testId="git-pill-menu-push"
					icon={<ArrowUpFromLine className="w-3.5 h-3.5" style={iconStyle} />}
					label="Git Push"
					badge={
						ahead > 0 ? (
							<span className="ml-auto flex items-center gap-0.5 text-[10px] text-green-500">
								<ArrowUp className="w-3 h-3" />
								{ahead}
							</span>
						) : undefined
					}
					onClick={onPush}
				/>
				<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
				<MenuRow
					theme={theme}
					testId="git-pill-menu-switch-branch"
					icon={<GitBranch className="w-3.5 h-3.5" style={iconStyle} />}
					label="Change Branch"
					onClick={onSwitchBranch}
				/>
				{onCreatePR && (
					<MenuRow
						theme={theme}
						testId="git-pill-menu-create-pr"
						icon={<GitPullRequest className="w-3.5 h-3.5" style={iconStyle} />}
						label="Create Pull Request"
						onClick={onCreatePR}
					/>
				)}
			</div>
		</div>
	);
});

export default GitPillMenu;
