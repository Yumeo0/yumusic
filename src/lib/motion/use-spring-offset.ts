import { useCallback, useEffect, useRef, useState } from "react";

/** A damped spring that keeps velocity as the finger changes its target. */
export function useSpringOffset() {
	const [value, setValue] = useState(0);
	const motion = useRef({
		position: 0,
		velocity: 0,
		target: 0,
		time: 0,
		frame: 0,
	});
	useEffect(() => () => cancelAnimationFrame(motion.current.frame), []);
	const move = useCallback((target: number) => {
		const state = motion.current;
		state.target = target;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			cancelAnimationFrame(state.frame);
			state.frame = 0;
			state.position = target;
			state.velocity = 0;
			setValue(target);
			return;
		}
		if (state.frame) return;
		state.time = performance.now();
		const tick = (now: number) => {
			const elapsed = Math.min(
				0.032,
				Math.max(0.001, (now - state.time) / 1000),
			);
			state.time = now;
			const steps = Math.ceil(elapsed / 0.008);
			const dt = elapsed / steps;
			for (let step = 0; step < steps; step++) {
				state.velocity +=
					((state.target - state.position) * 520 - state.velocity * 30) * dt;
				state.position += state.velocity * dt;
			}
			if (
				Math.abs(state.target - state.position) < 0.25 &&
				Math.abs(state.velocity) < 2
			) {
				state.position = state.target;
				state.velocity = 0;
				state.frame = 0;
			} else state.frame = requestAnimationFrame(tick);
			setValue(state.position);
		};
		state.frame = requestAnimationFrame(tick);
	}, []);
	return [value, move] as const;
}
