import { useSyncExternalStore } from "react";
import type { DeviceHub, DeviceState } from "./hub";

const offline: DeviceState = {
	id: "",
	devices: [],
	status: "offline",
	error: null,
	busy: false,
};
const listeners = new Set<() => void>();
let hub: DeviceHub | null = null;
let unsubscribe: (() => void) | undefined;
const notify = () => {
	for (const fn of listeners) fn();
};
export const getDeviceHub = () => hub;
export function attachDeviceHub(next: DeviceHub | null) {
	unsubscribe?.();
	hub = next;
	unsubscribe = hub?.subscribe(notify);
	notify();
}
const subscribe = (fn: () => void) => {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
};
export function useDevices() {
	return useSyncExternalStore(subscribe, () => hub?.getSnapshot() ?? offline);
}
