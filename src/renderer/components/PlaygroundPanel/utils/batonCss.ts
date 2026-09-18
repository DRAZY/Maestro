export const BATON_DEFAULTS = {
	duration: 3,
	fadeOutStart: 35,
	fadeInStart: 65,
	translateAmount: 0.5,
	staggerOffset: 0.5,
	easing: 'ease-in-out' as const,
};

export const EASING_OPTIONS = [
	'ease-in-out',
	'ease-in',
	'ease-out',
	'linear',
	'cubic-bezier(0.4, 0, 0.2, 1)',
] as const;

export type EasingOption = (typeof EASING_OPTIONS)[number];

export interface BatonSettings {
	duration: number;
	fadeOutStart: number;
	fadeInStart: number;
	translateAmount: number;
	staggerOffset: number;
	easing: EasingOption;
}

const STAGGER_MULTIPLIERS = [0, 1, 2, 3, 1.4, 2.4];

export function getBatonStaggerDelays(staggerOffset: number): string[] {
	return STAGGER_MULTIPLIERS.map((multiplier) => (multiplier * staggerOffset).toFixed(2));
}

export function buildBatonAnimationCss(settings: BatonSettings): string {
	const staggerDelays = getBatonStaggerDelays(settings.staggerOffset);

	return `
@keyframes playground-wand-sparkle {
	0%, 100% {
		opacity: 1;
		transform: translate(0, 0);
	}
	${settings.fadeOutStart}% {
		opacity: 0;
		transform: translate(${settings.translateAmount}px, ${-settings.translateAmount}px);
	}
	${settings.fadeInStart}% {
		opacity: 0;
		transform: translate(${-settings.translateAmount}px, ${settings.translateAmount}px);
	}
}

/* Target sparkle paths (3rd through 8th children are sparkle decorations) */
svg.baton-sparkle-active path:nth-child(n+3) {
	animation: playground-wand-sparkle ${settings.duration}s ${settings.easing} infinite;
}

${staggerDelays.map((delay, i) => `svg.baton-sparkle-active path:nth-child(${i + 3}) { animation-delay: ${delay}s; }`).join('\n')}

@media (prefers-reduced-motion: reduce) {
	svg.baton-sparkle-active path:nth-child(n+3) {
		animation: none;
	}
}`;
}

export function buildBatonCopyCss(settings: BatonSettings): string {
	const staggerDelays = getBatonStaggerDelays(settings.staggerOffset);

	return `/* Baton sparkle animation - sparkle paths vanish/reappear with subtle movement.

   WARNING: this is Playground output for tuning the baton, NOT the CSS the Left
   Bar wand ships. Do not paste it into index.css. Animating <path> children is
   the pattern the shipped wand was moved OFF, because Chrome cannot composite
   opacity or transform on an SVG sub-element: a Sep 2026 field trace measured
   27,353 main-thread style invalidations in 53 seconds from exactly these six
   paths, and the \`transform\` below additionally forces layout every frame.
   The wand now animates opacity on the <svg> ROOT, which the compositor runs
   off-thread. See the comment above \`wand-breathe\` in index.css. */
@keyframes wand-sparkle {
  0%, 100% {
    opacity: 1;
    transform: translate(0, 0);
  }
  ${settings.fadeOutStart}% {
    opacity: 0;
    transform: translate(${settings.translateAmount}px, ${-settings.translateAmount}px);
  }
  ${settings.fadeInStart}% {
    opacity: 0;
    transform: translate(${-settings.translateAmount}px, ${settings.translateAmount}px);
  }
}

svg.wand-sparkle-active path:nth-child(n+3) {
  animation: wand-sparkle ${settings.duration}s ${settings.easing} infinite;
}

/* Stagger each sparkle for organic feel */
${staggerDelays.map((delay, i) => `svg.wand-sparkle-active path:nth-child(${i + 3}) { animation-delay: ${delay}s; }`).join('\n')}

@media (prefers-reduced-motion: reduce) {
  svg.wand-sparkle-active path:nth-child(n+3) {
    animation: none;
  }
}`;
}
