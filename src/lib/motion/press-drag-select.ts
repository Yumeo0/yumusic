interface PressDragOptions<Value> {
	events: EventTarget;
	pointerId: number;
	x: number;
	y: number;
	hitTest: (x: number, y: number) => Value | null;
	onHighlight: (value: Value | null) => void;
	onSelect: (value: Value) => void;
	onEnd: (dragged: boolean, cancelled: boolean) => void;
}

/** Touch retains its implicit pointer capture on the trigger. Hit-test the
 * actual finger position rather than relying on item enter/up events. */
export function beginPressDragSelect<Value>(options: PressDragOptions<Value>) {
	let dragged = false;
	const move = (raw: Event) => {
		const event = raw as PointerEvent;
		if (event.pointerId !== options.pointerId) return;
		if (event.cancelable) event.preventDefault();
		dragged ||=
			Math.hypot(event.clientX - options.x, event.clientY - options.y) >= 8;
		options.onHighlight(
			dragged ? options.hitTest(event.clientX, event.clientY) : null,
		);
	};
	const finish = (raw: Event) => {
		const event = raw as PointerEvent;
		if (event.pointerId !== options.pointerId) return;
		const cancelled = event.type === "pointercancel";
		dragged ||=
			Math.hypot(event.clientX - options.x, event.clientY - options.y) >= 8;
		const value =
			!cancelled && dragged
				? options.hitTest(event.clientX, event.clientY)
				: null;
		dispose();
		options.onHighlight(null);
		if (value !== null) options.onSelect(value);
		options.onEnd(dragged, cancelled);
	};
	const dispose = () => {
		options.events.removeEventListener("pointermove", move, true);
		options.events.removeEventListener("pointerup", finish, true);
		options.events.removeEventListener("pointercancel", finish, true);
	};
	options.events.addEventListener("pointermove", move, {
		capture: true,
		passive: false,
	});
	options.events.addEventListener("pointerup", finish, true);
	options.events.addEventListener("pointercancel", finish, true);
	return dispose;
}
