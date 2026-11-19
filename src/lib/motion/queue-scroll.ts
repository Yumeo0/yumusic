/** Center a queue row in the visible part of its translated scroll container. */
export function queueScrollOffset(
	row: { start: number; size: number },
	viewport: {
		height: number;
		hiddenHeight: number;
		paddingTop: number;
		scrollHeight: number;
	},
) {
	const visibleHeight = Math.max(0, viewport.height - viewport.hiddenHeight);
	const center = row.start + row.size / 2 + viewport.paddingTop;
	const max = Math.max(0, viewport.scrollHeight - viewport.height);
	return Math.min(max, Math.max(0, center - visibleHeight / 2));
}
