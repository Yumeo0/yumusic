import {
	PLAYER_SECONDARY_PAIRS,
	prepareArtworkMorph,
	prepareTitleMorph,
	projectPlayerItem,
	textRect,
} from "./player-items";

export {
	mergeTouchHandlers,
	type QueueGestureCheck,
	type TouchHandlers,
	useQueueDragGesture,
	useQueueSheetGesture,
} from "./queue-gesture";

/** Where the dismiss morph sends everything, measured at drag start. */
export interface DismissGeometry {
	page: HTMLElement | null;
	mini: HTMLElement;
	apply: (progress: number) => void;
	release: () => void;
	/** Finger travel that moves the artwork onto the mini-player thumbnail. */
	travel: number;
	/** Full page height: the overlay slides this far to be fully off-screen. */
	height: number;
}

/** Font-size ratio between two elements (the scale a text morph needs). */
function fontScale(from: Element, to: Element): number {
	const source = Number.parseFloat(getComputedStyle(from).fontSize) || 0;
	const target = Number.parseFloat(getComputedStyle(to).fontSize) || 0;
	if (source <= 0 || target <= 0) return 1;
	return Math.min(target / source, 1);
}

/**
 * Measures the mini player's geometry and writes the dismiss-morph targets
 * onto the morphing stage: where the artwork, title, artist, seek bar and
 * transport must land, and how far the artwork travels to get there. The
 * element transforms interpolate linearly with `--np-dismiss` and are pinned
 * by `--np-slide` while the page itself slides away. Returns null when the
 * mini player is not materialized. Visible pairs are measured across the
 * whole page, including the compact lyrics layout and desktop layout.
 */
export function measureDismissGeometry(
	overlay: HTMLElement,
): DismissGeometry | null {
	const visible = (selector: string) =>
		Array.from(overlay.querySelectorAll<HTMLElement>(selector)).find(
			(element) => element.getBoundingClientRect().width > 0,
		) ?? null;
	const stage = visible("[data-np-morph-stage]");
	const cover = visible("[data-np-cover]");
	const thumb = document.querySelector<HTMLElement>("[data-mini-thumb]");
	const mini = document.querySelector<HTMLElement>("[data-mini-player]");
	if (!cover || !thumb || !mini) return null;
	const targets = new Set<Element>();
	const extras = new Set<Element>();
	const own = (element: Element) => {
		element.setAttribute("data-player-morph-target", "");
		targets.add(element);
	};
	const miniVisible = (selector: string) =>
		Array.from(mini.querySelectorAll<HTMLElement>(selector)).find(
			(element) => element.getBoundingClientRect().width > 0,
		) ?? null;

	const stageRect = (stage ?? overlay).getBoundingClientRect();
	const thumbRect = thumb.getBoundingClientRect();
	const artwork = cover.querySelector<HTMLElement>("[data-np-cover-art]");
	const miniArtwork = thumb.querySelector<HTMLElement>("[data-mini-cover-art]");
	const artworkMorph =
		artwork && miniArtwork
			? prepareArtworkMorph(cover, artwork, miniArtwork, !stage)
			: null;
	own(thumb);
	overlay.style.setProperty(
		"--np-min-cover-left",
		`${thumbRect.left - stageRect.left}px`,
	);
	overlay.style.setProperty(
		"--np-min-cover-top",
		`${thumbRect.top - stageRect.top}px`,
	);
	overlay.style.setProperty("--np-min-cover-size", `${thumbRect.width}px`);

	/**
	 * Writes the translate/scale pair that lands `source`'s center on
	 * `target`'s center: with `translate(t * d) scale(1 + (s - 1) * d)` about
	 * the wrapper's top-left, t = target - origin - s * (source - origin).
	 */
	const pair = (
		wrapper: Element | null,
		source: DOMRect | null,
		target: DOMRect | null,
		prefix: string,
		scale: number,
		text = false,
	) => {
		if (!wrapper || !source || !target) return;
		const origin = wrapper.getBoundingClientRect();
		const position = Math.min(Math.max(scale, 0.05), 1.5);
		const projected = projectPlayerItem(
			origin,
			source,
			target,
			position,
			text ? "start" : "center",
		);
		overlay.style.setProperty(`${prefix}-tx`, `${projected.x}px`);
		overlay.style.setProperty(`${prefix}-ty`, `${projected.y}px`);
		overlay.style.setProperty(`${prefix}-s`, String(position));
		if (text)
			overlay.style.setProperty(
				`${prefix}-cut`,
				`${origin.width - (source.x - origin.x + target.width / position)}px`,
			);
	};

	if (!stage) {
		if (artworkMorph) {
			overlay.style.setProperty("--np-cover-tx", `${artworkMorph.x}px`);
			overlay.style.setProperty("--np-cover-ty", `${artworkMorph.y}px`);
			overlay.style.setProperty("--np-cover-s", "1");
		} else {
			const rect = cover.getBoundingClientRect();
			pair(cover, rect, thumbRect, "--np-cover", thumbRect.width / rect.width);
		}
	}

	const titleLine = visible("[data-np-title-line]");
	const title = titleLine;
	const miniTitle = miniVisible("[data-mini-title-line]");
	let titleMorph: ReturnType<typeof prepareTitleMorph> | null = null;
	if (title && miniTitle) {
		const scale = fontScale(title, miniTitle);
		own(miniTitle);
		pair(
			titleLine,
			textRect(title),
			textRect(miniTitle),
			"--np-title",
			scale,
			true,
		);
		titleMorph = prepareTitleMorph(title, miniTitle, scale);
	}

	const artistLine = visible("[data-np-artist-line]");
	const artist = artistLine?.firstElementChild ?? null;
	const miniArtist = miniVisible("[data-mini-artist]");
	if (artist && miniArtist) {
		own(miniArtist);
		pair(
			artistLine,
			textRect(artist),
			textRect(miniArtist),
			"--np-artist",
			fontScale(artist, miniArtist),
			true,
		);
	}

	/**
	 * Morphs one fullscreen transport button onto its mini-player counterpart
	 * (per button, so Previous/Play/Next land on the exact mini positions
	 * instead of the row being scaled as a block, whose gaps differ).
	 */
	const control = (from: string, to: string, prefix: string) => {
		const source = visible(from);
		const target = miniVisible(to);
		if (!source) return;
		if (!target) {
			overlay.style.setProperty(`${prefix}-tx`, "0px");
			overlay.style.setProperty(`${prefix}-ty`, "64px");
			overlay.style.setProperty(`${prefix}-s`, "1");
			return;
		}
		own(target);
		const a = source.getBoundingClientRect();
		const b = target.getBoundingClientRect();
		pair(source, a, b, prefix, b.height / Math.max(a.height, 1));
	};
	control("[data-np-prev]", "[data-mini-prev]", "--np-prev");
	control("[data-np-play]", "[data-mini-play]", "--np-play");
	control("[data-np-next]", "[data-mini-next]", "--np-next");

	// Anything without a visible destination drifts down and fades; paired
	// metadata and controls stay live all the way to their measured endpoint.
	for (const element of overlay.querySelectorAll<HTMLElement>(
		"[data-np-secondary]",
	)) {
		element.style.setProperty("--np-item-tx", "0px");
		element.style.setProperty("--np-item-ty", "64px");
		element.style.setProperty("--np-item-s", "1");
		element.style.setProperty("--np-item-fade", "1");
		element.setAttribute("data-np-unpaired", "");
		element.style.setProperty("--np-item-cut", "0px");
	}
	for (const entry of PLAYER_SECONDARY_PAIRS) {
		const source = visible(entry.selector);
		const target = miniVisible(entry.target);
		if (!source) {
			if (target) {
				target.setAttribute("data-player-morph-extra", "");
				extras.add(target);
			}
			continue;
		}
		source.setAttribute("data-np-secondary", "");
		const text = "text" in entry && entry.text;
		const content = source.querySelector("[data-motion-text]") ?? source;
		const from = text ? textRect(content) : source.getBoundingClientRect();
		const to =
			target && (text ? textRect(target) : target.getBoundingClientRect());
		if (!target || !to || to.width <= 0 || to.height <= 0) {
			source.setAttribute("data-np-unpaired", "");
			source.style.setProperty("--np-item-tx", "0px");
			source.style.setProperty("--np-item-ty", "64px");
			source.style.setProperty("--np-item-s", "1");
			source.style.setProperty("--np-item-fade", "1");
			continue;
		}
		const scale = text
			? fontScale(content, target)
			: to.height / Math.max(from.height, 1);
		const projected = projectPlayerItem(
			source.getBoundingClientRect(),
			from,
			to,
			scale,
			text ? "start" : "center",
		);
		if (text) {
			source.setAttribute("data-np-text-motion", "");
			const origin = source.getBoundingClientRect();
			source.style.setProperty(
				"--np-item-cut",
				`${Math.max(0, origin.width - (from.x - origin.x + to.width / scale))}px`,
			);
		}
		source.style.setProperty("--np-item-tx", `${projected.x}px`);
		source.style.setProperty("--np-item-ty", `${projected.y}px`);
		source.style.setProperty("--np-item-s", String(scale));
		source.style.setProperty("--np-item-fade", "0");
		source.removeAttribute("data-np-unpaired");
		own(target);
	}

	const seek = visible("[data-np-seek-bar]");
	const miniProgress = document.querySelector("[data-mini-progress]");
	if (seek && miniProgress) {
		own(miniProgress);
		// Stretch horizontally only, without the clamp `pair` applies: the
		// desktop mini strip spans the whole window (~3x the seek bar), and
		// a clamped scale made the bar snap to full width at the very end.
		// Both bars share a height, so the track keeps its thickness.
		const source = seek.getBoundingClientRect();
		const target = miniProgress.getBoundingClientRect();
		const sx = target.width / Math.max(source.width, 1);
		// translate(t·d) scaleX(1 + (sx − 1)·d) about the bar's top-left
		// lands its center on the strip's center at d = 1.
		overlay.style.setProperty(
			"--np-seek-tx",
			`${target.x + target.width / 2 - source.x - (sx * source.width) / 2}px`,
		);
		overlay.style.setProperty(
			"--np-seek-ty",
			`${target.y + target.height / 2 - source.y - source.height / 2}px`,
		);
		overlay.style.setProperty("--np-seek-sx", String(sx));
	}

	const coverRect = cover.getBoundingClientRect();
	const travel =
		thumbRect.top +
		thumbRect.height / 2 -
		(coverRect.top + coverRect.height / 2);
	const height = overlay.offsetHeight || window.innerHeight;
	return {
		height,
		mini,
		apply: (progress) => {
			titleMorph?.apply(progress);
			artworkMorph?.apply(progress);
		},
		release: () => {
			titleMorph?.release();
			artworkMorph?.release();
			for (const target of targets)
				target.removeAttribute("data-player-morph-target");
			for (const extra of extras)
				extra.removeAttribute("data-player-morph-extra");
			mini.style.removeProperty("--player-reveal");
		},
		page: overlay.querySelector<HTMLElement>("[data-np-page]"),
		travel: travel > 40 ? travel : height * 0.6,
	};
}
