/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared audio-reactive glow math for voice-mode input decorations. The main
 * window's `ChatViewPane` and the Agents window surfaces render an identical
 * glow; this is the single source of truth for the easy-to-drift intensity and
 * box-shadow math. Callers own their own animation loop, target, and gating.
 */

import { Color, HSLA } from '../../../../../base/common/color.js';
import { IColorTheme } from '../../../../../platform/theme/common/themeService.js';
import { chatVoiceGlowBaseColor, chatVoiceListeningGlow, chatVoiceSpeakingGlow } from '../../common/widget/chatColors.js';

export type VoiceGlowState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

/**
 * Glow states that actually render a border/box-shadow. Connected-idle voice
 * mode deliberately renders NO glow, so callers gate their animation loop on
 * these states only.
 */
export function isGlowingVoiceState(voiceState: VoiceGlowState): boolean {
	return voiceState === 'listening' || voiceState === 'speaking';
}

/**
 * Reduce an analyser's frequency data to a normalized [0, 1] intensity. Returns
 * a small resting value when no analyser is available (before capture/playback).
 * `dataArray` is a ref-cell reused across frames, lazily sized to the bin count.
 */
export function readVoiceGlowIntensity(analyser: AnalyserNode | null, dataArray: { value: Uint8Array | undefined }): number {
	if (!analyser) {
		return 0.3;
	}
	if (!dataArray.value || dataArray.value.length !== analyser.frequencyBinCount) {
		dataArray.value = new Uint8Array(analyser.frequencyBinCount);
	}
	analyser.getByteFrequencyData(dataArray.value as Uint8Array<ArrayBuffer>);
	let sum = 0;
	for (let i = 0; i < dataArray.value.length; i++) {
		sum += dataArray.value[i];
	}
	return Math.min(1, (sum / dataArray.value.length) / 80);
}

export interface IVoiceGlowStyle {
	readonly borderColor: string;
	readonly boxShadow: string;
}

/**
 * Compute the glow border color and box-shadow. Blue while listening (a little
 * stronger when the transcript is hidden) and purple while speaking. The glow is
 * intentionally subtle. Connected-idle voice mode renders no glow and never
 * reaches this function.
 */
export function computeVoiceGlowStyle(voiceState: VoiceGlowState, intensity: number, transcriptHidden: boolean): IVoiceGlowStyle {
	// Blue when listening, purple when speaking.
	const rgb = voiceState === 'speaking' ? '163,113,247' : '88,166,255';
	const flashy = voiceState === 'listening' && transcriptHidden;
	let borderAlpha: number;
	let shadowSpread: number;
	let shadowAlpha: number;
	if (flashy) {
		// Slightly stronger audio-reactive glow while listening with no transcript visible.
		borderAlpha = 0.4 + intensity * 0.3;
		shadowSpread = 4 + intensity * 10;
		shadowAlpha = 0.15 + intensity * 0.3;
	} else {
		// Standard subtle glow (transcript visible or TTS playback).
		borderAlpha = 0.3 + intensity * 0.3;
		shadowSpread = 3 + intensity * 6;
		shadowAlpha = 0.1 + intensity * 0.2;
	}
	const borderColor = `rgba(${rgb},${borderAlpha})`;
	const boxShadow = `0 0 ${shadowSpread}px rgba(${rgb},${shadowAlpha}), inset 0 0 ${shadowSpread * 0.4}px rgba(${rgb},${shadowAlpha * 0.3})`;
	return { borderColor, boxShadow };
}

// --- Theme-derived colors ------------------------------------------------

/** Resolved base color for each voice state that carries an accent. */
export interface IVoiceGlowColors {
	readonly listening: Color;
	readonly speaking: Color;
}

/**
 * Hue rotation (degrees) applied to the base accent for speaking, so the two
 * talking states read as a related-but-distinct pair from whatever accent the
 * theme uses. Exported so it can be tuned in one place.
 */
export const VOICE_GLOW_SPEAKING_HUE_SHIFT = 80;

/** The historical hardcoded accent, used when no theme color resolves. */
const VOICE_GLOW_FALLBACK = Color.fromHex('#58A6FF');

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function shiftHue(base: Color, degrees: number, saturationMul: number = 1, lightnessAdd: number = 0): Color {
	const hsla = base.hsla;
	return new Color(new HSLA((hsla.h + degrees + 360) % 360, clamp01(hsla.s * saturationMul), clamp01(hsla.l + lightnessAdd), 1));
}

/**
 * Fallback colors matching the historical hardcoded glow (blue listening /
 * purple speaking), used when no theme is available (unit tests) or before
 * colors are resolved.
 */
export const DEFAULT_VOICE_GLOW_COLORS: IVoiceGlowColors = {
	listening: VOICE_GLOW_FALLBACK,
	speaking: shiftHue(VOICE_GLOW_FALLBACK, VOICE_GLOW_SPEAKING_HUE_SHIFT),
};

/**
 * Resolve the per-state glow colors from the active theme. Listening derives from
 * `chat.voiceGlowBaseColor` (default `focusBorder`) and speaking is hue-shifted
 * from it, unless the theme explicitly sets that state's token — so the glow
 * always harmonizes with the theme while staying overridable.
 */
export function resolveVoiceGlowColors(theme: Pick<IColorTheme, 'getColor'>): IVoiceGlowColors {
	const base = theme.getColor(chatVoiceGlowBaseColor) ?? VOICE_GLOW_FALLBACK;
	return {
		listening: theme.getColor(chatVoiceListeningGlow) ?? base,
		speaking: theme.getColor(chatVoiceSpeakingGlow) ?? shiftHue(base, VOICE_GLOW_SPEAKING_HUE_SHIFT),
	};
}

/**
 * The accent for the current state. Only the talking states carry one; anything
 * else renders no glow, so it never reaches this.
 */
export function voiceGlowStateColor(voiceState: VoiceGlowState, colors: IVoiceGlowColors): Color {
	return voiceState === 'speaking' ? colors.speaking : colors.listening;
}

// --- The rim accent ----------------------------------------------------------

/** Which of the two talking states a rim is showing. */
export type VoiceRimMood = 'cool' | 'warm';

/** Whether the surrounding surface is light or dark. */
export type GlowThemeKind = 'light' | 'dark';

/** Saturation (%) bounds for an active (listening / speaking) rim. */
const RIM_SAT_MIN = 70;
const RIM_SAT_MAX = 96;

/**
 * The rim's lightness, per theme and mood. The warm (speaking) rim needs a little
 * more lightness than the cool one to read at the same weight, since a
 * blue-violet edge sits darker than a cyan one at equal lightness.
 */
const RIM_LIGHTNESS = {
	dark: { cool: 56, warm: 72 },
	light: { cool: 72, warm: 72 },
} as const;

/**
 * The rim reads a touch off the raw accent: a hair of teal on the cool side keeps
 * listening from looking like a plain blue focus ring, and a hair of magenta on
 * the warm side widens the contrast between "you are talking" and "the agent is
 * talking".
 */
const RIM_HUE_SHIFT = { cool: -10, warm: 7 } as const;

/**
 * Tune a raw accent into the color a rim actually paints with: hue nudged off the
 * accent, saturation bounded so a washed-out or neon theme color still reads as
 * light, and lightness pinned so the rim carries the same weight in any theme.
 *
 * Shared with the dictation microphone glow, so an open microphone is the same
 * color whichever feature opened it.
 */
export function resolveVoiceRimAccent(accent: Color, mood: VoiceRimMood, theme: GlowThemeKind): IVoiceRimAccent {
	const { h, s } = accent.hsla;
	return {
		hue: (h + RIM_HUE_SHIFT[mood] + 360) % 360,
		saturation: Math.round(Math.min(RIM_SAT_MAX, Math.max(RIM_SAT_MIN, s * 100))),
		lightness: RIM_LIGHTNESS[theme][mood],
	};
}

/** The HSL parts a rim paints with, as resolved by {@link resolveVoiceRimAccent}. */
export interface IVoiceRimAccent {
	readonly hue: number;
	readonly saturation: number;
	readonly lightness: number;
}

/**
 * Box-shadow for a voice mic/icon button glow, shared by surfaces that light up
 * the microphone glyph in addition to the input border.
 */
export function computeVoiceMicGlowBoxShadow(voiceState: VoiceGlowState, intensity: number, colors: IVoiceGlowColors = DEFAULT_VOICE_GLOW_COLORS): string {
	const { r, g, b } = voiceGlowStateColor(voiceState, colors).rgba;
	const shadowSpread = 3 + intensity * 8;
	const shadowAlpha = 0.2 + intensity * 0.45;
	return `0 0 ${shadowSpread}px rgba(${r},${g},${b},${shadowAlpha})`;
}
