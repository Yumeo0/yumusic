import { expect, test } from "bun:test";
import { handleAppBack } from "./app-back";

test("back closes one layer at a time before navigating", () => {
	const layers = [true, true, true, true];
	const visited: number[] = [];
	const consume = (index: number) => () => {
		visited.push(index);
		if (!layers[index]) return false;
		layers[index] = false;
		return true;
	};
	const actions = {
		dismissOverlay: consume(0),
		closeQueue: consume(1),
		closePlayer: consume(2),
		navigateBack: consume(3),
	};
	for (let i = 0; i < layers.length; i++) {
		visited.length = 0;
		expect(handleAppBack(actions)).toBe(true);
		expect(visited).toEqual(Array.from({ length: i + 1 }, (_, n) => n));
	}
	expect(handleAppBack(actions)).toBe(false);
});
