/** Native contextmenu events can arrive after the touch gesture has ended. */
export function preventSwipeContextMenu(
	open: boolean,
	details: { event: Event; cancel: () => void },
) {
	if (!open) return;
	const target = details.event.target;
	if (!(target instanceof Element)) return;
	const row = target.closest<HTMLElement>("[data-swipe-context-until]");
	if (row && Number(row.dataset.swipeContextUntil) > performance.now())
		details.cancel();
}
