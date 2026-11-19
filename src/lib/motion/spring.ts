export interface SpringState {
	position: number;
	velocity: number;
}

/** Exact spring integration stays stable even after a delayed frame. */
export function stepSpring(
	state: SpringState,
	target: number,
	seconds: number,
	response = 0.35,
	damping = 1,
): SpringState {
	const omega = (2 * Math.PI) / response;
	const offset = state.position - target;
	const decay = Math.exp(-damping * omega * seconds);
	if (damping >= 1) {
		const b = state.velocity + omega * offset;
		return {
			position: target + (offset + b * seconds) * decay,
			velocity: (state.velocity - omega * b * seconds) * decay,
		};
	}
	const frequency = omega * Math.sqrt(1 - damping * damping);
	const b = (state.velocity + damping * omega * offset) / frequency;
	const sin = Math.sin(frequency * seconds);
	const cos = Math.cos(frequency * seconds);
	const wave = offset * cos + b * sin;
	return {
		position: target + wave * decay,
		velocity:
			(-offset * frequency * sin +
				b * frequency * cos -
				damping * omega * wave) *
			decay,
	};
}

export function prefersReducedMotion() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Apple's exponential scroll projection; velocity is in units per second. */
export function projectMomentum(velocity: number, rate = 0.998) {
	return ((velocity / 1000) * rate) / (1 - rate);
}

export function rubberband(overshoot: number, dimension: number) {
	return (
		(overshoot * dimension * 0.55) / (dimension + 0.55 * Math.abs(overshoot))
	);
}

/** Short history avoids noisy last-event velocities and stale flicks after a hold. */
export class GestureVelocity {
	private samples: { position: number; time: number }[] = [];
	add(position: number, time = performance.now()) {
		this.samples = this.samples.filter((sample) => time - sample.time <= 100);
		if (this.samples.at(-1)?.time === time) this.samples.pop();
		this.samples.push({ position, time });
	}
	read(time = performance.now()) {
		const first = this.samples[0];
		const last = this.samples.at(-1);
		if (!first || !last || time - last.time > 100 || last.time === first.time)
			return 0;
		return ((last.position - first.position) * 1000) / (last.time - first.time);
	}
}

/** Re-targeting preserves the last presented position and its velocity. */
export function createSpring(
	initial: number,
	update: (position: number) => void,
	precision = 0.25,
) {
	let state: SpringState = { position: initial, velocity: 0 };
	let target = initial;
	let frame = 0;
	let time = 0;
	let damping = 1;
	let rest: (() => void) | undefined;
	const stop = () => {
		cancelAnimationFrame(frame);
		frame = 0;
		rest = undefined;
	};
	const finish = () => {
		state = { position: target, velocity: 0 };
		frame = 0;
		update(target);
		const done = rest;
		rest = undefined;
		done?.();
	};
	const tick = (now: number) => {
		state = stepSpring(
			state,
			target,
			Math.max(0, (now - time) / 1000),
			0.35,
			damping,
		);
		time = now;
		if (
			prefersReducedMotion() ||
			(Math.abs(target - state.position) < precision &&
				Math.abs(state.velocity) < precision * 8)
		) {
			finish();
			return;
		}
		update(state.position);
		frame = requestAnimationFrame(tick);
	};
	return {
		get position() {
			return state.position;
		},
		get velocity() {
			return state.velocity;
		},
		stop,
		jump(position: number, velocity = 0) {
			stop();
			state = { position, velocity };
			update(position);
		},
		animate(
			destination: number,
			options: {
				velocity?: number;
				momentum?: boolean;
				onRest?: () => void;
			} = {},
		) {
			target = destination;
			if (options.velocity !== undefined) state.velocity = options.velocity;
			damping =
				options.momentum && Math.abs(state.velocity) > precision * 8 ? 0.8 : 1;
			rest = options.onRest;
			if (prefersReducedMotion()) {
				cancelAnimationFrame(frame);
				finish();
			} else if (!frame) {
				time = performance.now();
				frame = requestAnimationFrame(tick);
			}
		},
	};
}
