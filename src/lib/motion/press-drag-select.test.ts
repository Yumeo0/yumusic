import { expect, test } from "bun:test";
import { beginPressDragSelect } from "./press-drag-select";

function gesture() {
	const events = new EventTarget();
	const selected: string[] = [];
	const highlights: (string | null)[] = [];
	const endings: boolean[][] = [];
	const dispose = beginPressDragSelect({
		events,
		pointerId: 1,
		x: 10,
		y: 10,
		hitTest: (_x, y) =>
			y >= 50 && y < 100 ? "first" : y >= 100 && y < 150 ? "second" : null,
		onHighlight: (value) => highlights.push(value),
		onSelect: (value) => selected.push(value),
		onEnd: (...values) => endings.push(values),
	});
	const send = (type: string, y: number, pointerId = 1) =>
		events.dispatchEvent(
			Object.assign(new Event(type, { cancelable: true }), {
				clientX: 10,
				clientY: y,
				pointerId,
			}),
		);
	return { selected, highlights, endings, send, dispose };
}

test("touch capture can stay on the trigger while dragging selects the row under the finger", () => {
	const g = gesture();
	g.send("pointermove", 65);
	g.send("pointermove", 120);
	expect(g.highlights).toEqual(["first", "second"]);
	expect(g.selected).toEqual([]);
	g.send("pointerup", 120);
	expect(g.selected).toEqual(["second"]);
	expect(g.endings).toEqual([[true, false]]);
	g.send("pointerup", 65);
	expect(g.selected).toEqual(["second"]);
});

test("a tap keeps the picker open and cancellation or releasing outside never selects", () => {
	const tap = gesture();
	tap.send("pointerup", 12);
	expect(tap.endings).toEqual([[false, false]]);
	expect(tap.selected).toEqual([]);
	const cancel = gesture();
	cancel.send("pointermove", 65);
	cancel.send("pointercancel", 65);
	expect(cancel.selected).toEqual([]);
	expect(cancel.endings).toEqual([[true, true]]);
	const outside = gesture();
	outside.send("pointermove", 65);
	outside.send("pointerup", 200);
	expect(outside.selected).toEqual([]);
	expect(outside.highlights.at(-1)).toBeNull();
});

test("other fingers and events after cleanup cannot commit a provider", () => {
	const g = gesture();
	g.send("pointerup", 65, 2);
	expect(g.endings).toEqual([]);
	g.dispose();
	g.send("pointermove", 120);
	g.send("pointerup", 120);
	expect(g.selected).toEqual([]);
	expect(g.highlights).toEqual([]);
});
