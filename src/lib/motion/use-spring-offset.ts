import { useEffect, useRef, useState } from "react";
import { createSpring } from "./spring";

/** Direct tracking while held; a velocity-preserving spring on release. */
export function useSpringOffset() {
	const [value, setValue] = useState(0);
	const motion = useRef<ReturnType<typeof createSpring> | null>(null);
	if (!motion.current) motion.current = createSpring(0, setValue);
	const spring = motion.current;
	useEffect(() => () => spring.stop(), [spring]);
	return [value, spring.animate, spring] as const;
}
