import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
	FileAudio,
	Maximize,
	Pause,
	Play,
	Repeat,
	RotateCcw,
	RotateCw,
	Volume2,
	VolumeX,
	ExternalLink,
	AlertTriangle,
} from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { Spinner } from '../ui/Spinner';
import { formatElapsedTimeColon } from '../../../shared/formatters';
import { MEDIA_PLAYBACK_RATES, type MediaKind } from '../../../shared/mediaTypes';
import { useSettingsStore } from '../../stores/settingsStore';
import { useEventListener } from '../../hooks/utils/useEventListener';

interface MediaViewerProps {
	/** `maestro-media://` stream URL produced by the main process. */
	src: string;
	/** Whether to mount an <audio> or a <video> element. */
	kind: MediaKind;
	/** File name, used for the audio placeholder label. */
	name: string;
	/** Absolute path, used by the "open externally" fallback. */
	path: string;
	theme: any;
}

/** Seconds jumped by the skip buttons and the plain arrow keys. */
const SKIP_SECONDS = 10;
/** Seconds jumped by shift+arrow, for fine scrubbing. */
const FINE_SKIP_SECONDS = 5;

/** `formatElapsedTimeColon` expects whole seconds; media times are fractional. */
const formatTime = (seconds: number): string =>
	Number.isFinite(seconds) ? formatElapsedTimeColon(Math.floor(Math.max(0, seconds))) : '--:--';

/**
 * Audio/video player for the file preview.
 *
 * Wraps a native <audio>/<video> element - Electron ships Chromium with
 * proprietary codecs, so MP3/AAC/H.264 play without any bundled decoder - and
 * puts a themed transport on top of it. Bytes arrive over the
 * `maestro-media://` protocol with range support, so scrubbing a large file
 * does not load it into memory.
 *
 * Playback speed is read from and written back to the global settings store,
 * so the rate the user picks sticks across files and across restarts.
 */
export const MediaViewer = memo(function MediaViewer({
	src,
	kind,
	name,
	path,
	theme,
}: MediaViewerProps) {
	const mediaRef = useRef<HTMLMediaElement | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const rateMenuRef = useRef<HTMLDivElement>(null);

	const playbackRate = useSettingsStore((s) => s.mediaPlaybackRate);
	const setPlaybackRate = useSettingsStore((s) => s.setMediaPlaybackRate);

	const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
	const [playing, setPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolume] = useState(1);
	const [muted, setMuted] = useState(false);
	const [looping, setLooping] = useState(false);
	const [rateMenuOpen, setRateMenuOpen] = useState(false);

	const isVideo = kind === 'video';

	// Reset transport state when the tab switches to a different file.
	useEffect(() => {
		setLoadState('loading');
		setPlaying(false);
		setCurrentTime(0);
		setDuration(0);
	}, [src]);

	// Apply the persisted rate to the element on mount and on every change. The
	// element resets playbackRate to 1 whenever a new source loads, so this also
	// has to run after 'loadedmetadata'. preservesPitch keeps a 2x podcast
	// listenable instead of chipmunked.
	useEffect(() => {
		const el = mediaRef.current;
		if (!el) return;
		el.preservesPitch = true;
		el.playbackRate = playbackRate;
	}, [playbackRate, loadState, src]);

	const handleLoadedMetadata = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		// Live/unknown-length streams report Infinity; treat them as unseekable.
		setDuration(Number.isFinite(el.duration) ? el.duration : 0);
		el.playbackRate = playbackRate;
		setLoadState('ready');
	}, [playbackRate]);

	const handleTimeUpdate = useCallback(() => {
		const el = mediaRef.current;
		if (el) setCurrentTime(el.currentTime);
	}, []);

	const togglePlay = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		if (el.paused) {
			// play() rejects when the element is torn down mid-request (tab switch)
			// or the source failed; the 'error' handler already surfaces that state.
			void el.play().catch(() => undefined);
		} else {
			el.pause();
		}
	}, []);

	const seekBy = useCallback((delta: number) => {
		const el = mediaRef.current;
		if (!el || !Number.isFinite(el.duration)) return;
		el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + delta));
	}, []);

	const seekTo = useCallback((seconds: number) => {
		const el = mediaRef.current;
		if (!el) return;
		el.currentTime = seconds;
		setCurrentTime(seconds);
	}, []);

	const changeVolume = useCallback((next: number) => {
		const el = mediaRef.current;
		const clamped = Math.min(1, Math.max(0, next));
		setVolume(clamped);
		setMuted(clamped === 0);
		if (el) {
			el.volume = clamped;
			el.muted = clamped === 0;
		}
	}, []);

	const toggleMute = useCallback(() => {
		const el = mediaRef.current;
		setMuted((prev) => {
			const next = !prev;
			if (el) el.muted = next;
			return next;
		});
	}, []);

	const toggleLoop = useCallback(() => {
		const el = mediaRef.current;
		setLooping((prev) => {
			const next = !prev;
			if (el) el.loop = next;
			return next;
		});
	}, []);

	/** Step to the next/previous rate in the preset ladder. */
	const stepRate = useCallback(
		(direction: 1 | -1) => {
			const index = MEDIA_PLAYBACK_RATES.indexOf(
				playbackRate as (typeof MEDIA_PLAYBACK_RATES)[number]
			);
			// An off-ladder rate (set via CLI) falls back to the nearest 1x anchor.
			const from = index === -1 ? MEDIA_PLAYBACK_RATES.indexOf(1) : index;
			const next = Math.min(MEDIA_PLAYBACK_RATES.length - 1, Math.max(0, from + direction));
			setPlaybackRate(MEDIA_PLAYBACK_RATES[next]);
		},
		[playbackRate, setPlaybackRate]
	);

	const enterFullscreen = useCallback(() => {
		const el = mediaRef.current;
		if (el && 'requestFullscreen' in el) void el.requestFullscreen().catch(() => undefined);
	}, []);

	const openExternally = useCallback(() => {
		void window.maestro.shell.openPath(path);
	}, [path]);

	// Close the speed menu on any outside click.
	useEventListener(
		'mousedown',
		(e) => {
			if (rateMenuRef.current?.contains(e.target as Node)) return;
			setRateMenuOpen(false);
		},
		{ enabled: rateMenuOpen }
	);

	/**
	 * Transport keyboard shortcuts. Scoped to the player container and stopped
	 * from bubbling so they never collide with the FilePreview shortcuts.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			// Let the range inputs keep their own arrow-key behavior.
			if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

			switch (e.key) {
				case ' ':
				case 'k':
					togglePlay();
					break;
				case 'ArrowLeft':
					seekBy(e.shiftKey ? -FINE_SKIP_SECONDS : -SKIP_SECONDS);
					break;
				case 'ArrowRight':
					seekBy(e.shiftKey ? FINE_SKIP_SECONDS : SKIP_SECONDS);
					break;
				case 'ArrowUp':
					changeVolume(volume + 0.1);
					break;
				case 'ArrowDown':
					changeVolume(volume - 0.1);
					break;
				case 'm':
					toggleMute();
					break;
				case 'l':
					toggleLoop();
					break;
				case ',':
				case '<':
					stepRate(-1);
					break;
				case '.':
				case '>':
					stepRate(1);
					break;
				case 'f':
					if (isVideo) enterFullscreen();
					break;
				default:
					return;
			}
			e.preventDefault();
			e.stopPropagation();
		},
		[
			togglePlay,
			seekBy,
			changeVolume,
			volume,
			toggleMute,
			toggleLoop,
			stepRate,
			isVideo,
			enterFullscreen,
		]
	);

	const mediaProps = useMemo(
		() => ({
			src,
			preload: 'metadata' as const,
			onLoadedMetadata: handleLoadedMetadata,
			onTimeUpdate: handleTimeUpdate,
			onDurationChange: handleTimeUpdate,
			onPlay: () => setPlaying(true),
			onPause: () => setPlaying(false),
			onEnded: () => setPlaying(false),
			onError: () => setLoadState('error'),
		}),
		[src, handleLoadedMetadata, handleTimeUpdate]
	);

	const rateLabel = `${playbackRate}x`;
	const seekable = duration > 0;

	if (loadState === 'error') {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 select-none">
				<AlertTriangle className="w-12 h-12" style={{ color: theme.colors.textDim }} />
				<div className="text-center">
					<p className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
						Cannot Play This File
					</p>
					<p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
						The codec inside this container is not supported.
					</p>
					<button
						onClick={openExternally}
						className="mt-4 px-3 py-1.5 rounded text-sm inline-flex items-center gap-2 transition-colors hover:opacity-90"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						<ExternalLink className="w-4 h-4" />
						Open in Default App
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="flex flex-col h-full select-none outline-none"
			tabIndex={0}
			onKeyDown={handleKeyDown}
			onClick={() => containerRef.current?.focus()}
		>
			{/* Stage */}
			<div
				className="flex-1 min-h-0 flex items-center justify-center relative"
				style={{ backgroundColor: isVideo ? '#000' : 'transparent' }}
			>
				{isVideo ? (
					<video
						ref={mediaRef as React.RefObject<HTMLVideoElement>}
						{...mediaProps}
						className="max-w-full max-h-full"
						onDoubleClick={enterFullscreen}
					/>
				) : (
					<>
						<audio ref={mediaRef as React.RefObject<HTMLAudioElement>} {...mediaProps} />
						<div className="flex flex-col items-center gap-3">
							<FileAudio className="w-16 h-16" style={{ color: theme.colors.accent }} />
							<span
								className="text-sm max-w-md truncate px-4"
								style={{ color: theme.colors.textDim }}
							>
								{name}
							</span>
						</div>
					</>
				)}

				{loadState === 'loading' && (
					<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
						<Spinner size={32} color={theme.colors.accent} />
					</div>
				)}
			</div>

			{/* Transport */}
			<div
				className="shrink-0 border-t px-3 py-2 flex flex-col gap-1.5"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Scrubber */}
				<div className="flex items-center gap-2">
					<span
						className="text-[11px] font-mono tabular-nums shrink-0"
						style={{ color: theme.colors.textDim }}
					>
						{formatTime(currentTime)}
					</span>
					<input
						type="range"
						min={0}
						max={seekable ? duration : 1}
						step={0.01}
						value={seekable ? Math.min(currentTime, duration) : 0}
						disabled={!seekable}
						onChange={(e) => seekTo(Number(e.target.value))}
						aria-label="Seek"
						className="flex-1 h-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
						style={{ accentColor: theme.colors.accent }}
					/>
					<span
						className="text-[11px] font-mono tabular-nums shrink-0"
						style={{ color: theme.colors.textDim }}
					>
						{formatTime(duration)}
					</span>
				</div>

				{/* Controls */}
				<div className="flex items-center gap-1">
					<GhostIconButton
						onClick={() => seekBy(-SKIP_SECONDS)}
						title={`Back ${SKIP_SECONDS}s (Left arrow)`}
						ariaLabel={`Back ${SKIP_SECONDS} seconds`}
						color={theme.colors.textDim}
					>
						<RotateCcw className="w-4 h-4" />
					</GhostIconButton>

					<GhostIconButton
						onClick={togglePlay}
						title={playing ? 'Pause (Space)' : 'Play (Space)'}
						ariaLabel={playing ? 'Pause' : 'Play'}
						color={theme.colors.textMain}
						padding="p-1.5"
					>
						{playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
					</GhostIconButton>

					<GhostIconButton
						onClick={() => seekBy(SKIP_SECONDS)}
						title={`Forward ${SKIP_SECONDS}s (Right arrow)`}
						ariaLabel={`Forward ${SKIP_SECONDS} seconds`}
						color={theme.colors.textDim}
					>
						<RotateCw className="w-4 h-4" />
					</GhostIconButton>

					<div className="flex items-center gap-1 ml-2">
						<GhostIconButton
							onClick={toggleMute}
							title={muted ? 'Unmute (M)' : 'Mute (M)'}
							ariaLabel={muted ? 'Unmute' : 'Mute'}
							color={theme.colors.textDim}
						>
							{muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
						</GhostIconButton>
						<input
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={muted ? 0 : volume}
							onChange={(e) => changeVolume(Number(e.target.value))}
							aria-label="Volume"
							className="w-20 h-1 cursor-pointer"
							style={{ accentColor: theme.colors.accent }}
						/>
					</div>

					<div className="flex-1" />

					<GhostIconButton
						onClick={toggleLoop}
						title={looping ? 'Looping on (L)' : 'Loop (L)'}
						ariaLabel="Toggle loop"
						color={looping ? theme.colors.accent : theme.colors.textDim}
					>
						<Repeat className="w-4 h-4" />
					</GhostIconButton>

					{/* Speed - persisted globally, so it carries to the next file */}
					<div className="relative" ref={rateMenuRef}>
						<button
							onClick={() => setRateMenuOpen((o) => !o)}
							title="Playback speed (, and . to step). Persists across files."
							aria-label="Playback speed"
							className="px-2 py-1 rounded text-xs font-mono hover:bg-white/10 transition-colors min-w-[3rem]"
							style={{
								color: playbackRate === 1 ? theme.colors.textDim : theme.colors.accent,
							}}
						>
							{rateLabel}
						</button>
						{rateMenuOpen && (
							<div
								className="absolute bottom-full right-0 mb-1 py-1 rounded shadow-lg border z-10 max-h-64 overflow-y-auto"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
								}}
							>
								{MEDIA_PLAYBACK_RATES.map((rate) => (
									<button
										key={rate}
										onClick={() => {
											setPlaybackRate(rate);
											setRateMenuOpen(false);
										}}
										className="block w-full text-left px-3 py-1 text-xs font-mono hover:bg-white/10 transition-colors"
										style={{
											color: rate === playbackRate ? theme.colors.accent : theme.colors.textMain,
										}}
									>
										{rate}x
									</button>
								))}
							</div>
						)}
					</div>

					{isVideo && (
						<GhostIconButton
							onClick={enterFullscreen}
							title="Fullscreen (F)"
							ariaLabel="Fullscreen"
							color={theme.colors.textDim}
						>
							<Maximize className="w-4 h-4" />
						</GhostIconButton>
					)}

					<GhostIconButton
						onClick={openExternally}
						title="Open in default app"
						ariaLabel="Open in default app"
						color={theme.colors.textDim}
					>
						<ExternalLink className="w-4 h-4" />
					</GhostIconButton>
				</div>
			</div>
		</div>
	);
});
