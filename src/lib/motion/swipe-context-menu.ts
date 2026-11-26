const CONTEXT_MENU_DELAY_MS = 700;

export function suppressSwipeContextMenu(
	row: HTMLElement | null,
	untilGestureEnds = false,
) {
	if (row)
		row.dataset.swipeContextUntil = String(
			untilGestureEnds ? Infinity : performance.now() + CONTEXT_MENU_DELAY_MS,
		);
}

export function allowSwipeContextMenu(row: HTMLElement | null) {
	if (row) delete row.dataset.swipeContextUntil;
}

export function isSwipeContextSuppressed(row: HTMLElement | null): boolean {
	return Number(row?.dataset.swipeContextUntil) > performance.now();
}

/** Native contextmenu events can arrive after the touch gesture has ended. */
export function preventSwipeContextMenu(
	open: boolean,
	details: { event: Event; cancel: () => void },
) {
	if (!open) return;
	const target = details.event.target;
	if (!(target instanceof Element)) return;
	const row = target.closest<HTMLElement>("[data-swipe-context-until]");
	if (isSwipeContextSuppressed(row)) details.cancel();
}
