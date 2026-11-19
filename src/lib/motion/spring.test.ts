import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	createSpring,
	GestureVelocity,
	projectMomentum,
	rubberband,
	stepSpring,
} from "./spring";

test("default spring settles without overshoot at different refresh rates", () => {
	for (const hz of [30, 60, 120]) {
		let state = { position: 0, velocity: 0 };
		let previous = 0;
		for (let frame = 0; frame < hz; frame++) {
			state = stepSpring(state, 100, 1 / hz);
			expect(state.position).toBeGreaterThanOrEqual(previous);
			expect(state.position).toBeLessThanOrEqual(100);
			previous = state.position;
		}
		expect(state.position).toBeCloseTo(100, 3);
	}
});

test("projection respects flick direction and soft boundaries keep responding", () => {
	expect(projectMomentum(1000)).toBeCloseTo(499);
	expect(projectMomentum(-1000)).toBeCloseTo(-499);
	expect(rubberband(20, 400)).toBeGreaterThan(0);
	expect(rubberband(100, 400)).toBeGreaterThan(rubberband(20, 400));
	expect(rubberband(100, 400)).toBeLessThan(100);
	expect(rubberband(-100, 400)).toBe(-rubberband(100, 400));
});

test("release velocity follows reversals and expires after a hold", () => {
	const history = new GestureVelocity();
	history.add(0, 0);
	history.add(40, 40);
	expect(history.read(40)).toBe(1000);
	history.add(80, 120);
	history.add(20, 160);
	expect(history.read(160)).toBe(-1500);
	expect(history.read(300)).toBe(0);
});

describe("interruptible motion driver", () => {
	let frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	let now = 0;
	let reduced = false;
	const saved = new Map<string, PropertyDescriptor | undefined>();
	beforeEach(() => {
		frames = new Map();
		now = performance.now();
		reduced = false;
		for (const [key, value] of Object.entries({
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				frames.set(++id, callback);
				return id;
			},
			cancelAnimationFrame: (frame: number) => frames.delete(frame),
			window: { matchMedia: () => ({ matches: reduced }) },
		})) {
			saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, {
				configurable: true,
				writable: true,
				value,
			});
		}
	});
	afterEach(() => {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	const advance = (ms: number) => {
		now += ms;
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(now);
	};

	test("reversal preserves the presentation value and velocity; grabbing cancels its old completion", () => {
		let presented = 0;
		let completed = false;
		const spring = createSpring(0, (position) => {
			presented = position;
		});
		spring.animate(100, {
			onRest: () => {
				completed = true;
			},
		});
		advance(70);
		const position = spring.position,
			velocity = spring.velocity;
		spring.animate(0);
		expect(spring.position).toBe(position);
		expect(spring.velocity).toBe(velocity);
		advance(10);
		expect(presented).toBeGreaterThan(position);
		spring.stop();
		advance(1000);
		expect(completed).toBe(false);
		expect(frames.size).toBe(0);
		spring.jump(50, -500);
		expect(presented).toBe(50);
		spring.animate(0, { velocity: -500, momentum: true });
		advance(16);
		expect(presented).toBeLessThan(50);
	});

	test("reduced motion settles immediately and also takes effect during a spring", () => {
		let presented = 0;
		const spring = createSpring(0, (position) => {
			presented = position;
		});
		reduced = true;
		spring.animate(100);
		expect(presented).toBe(100);
		expect(frames.size).toBe(0);
		reduced = false;
		spring.animate(0);
		advance(16);
		reduced = true;
		advance(16);
		expect(presented).toBe(0);
		expect(frames.size).toBe(0);
	});
});
