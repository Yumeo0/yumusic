import { expect, test } from "bun:test";
import type { Session } from "@supabase/supabase-js";
import { AccountDeviceDiscovery, deviceId } from "./lifecycle";

const session = (id: string) => ({ user: { id } }) as Session;

test("device identity survives restarts and stays separate for each account and installation", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const pc = deviceId("account", storage);
	expect(deviceId("account", storage)).toBe(pc);
	expect(deviceId("other-account", storage)).not.toBe(pc);
	expect(deviceId("account", { ...storage, getItem: () => null })).not.toBe(pc);
});

test("discovery starts when identity is ready without a mounted modal or settings view", () => {
	let ready = false;
	let starts = 0;
	let stops = 0;
	const discovery = new AccountDeviceDiscovery({
		eligible: () => ready,
		create: () => ({
			start: async () => {
				starts++;
			},
			stop: () => {
				stops++;
			},
		}),
		attach: () => undefined,
	});
	discovery.setSession(session("owner"));
	expect(starts).toBe(0);
	ready = true;
	discovery.reconcile();
	expect(starts).toBe(1);
	discovery.setSession(session("owner"));
	discovery.reconcile();
	expect(starts).toBe(1);
	expect(stops).toBe(0);
	ready = false;
	discovery.reconcile();
	expect(stops).toBe(1);
	ready = true;
	discovery.reconcile();
	expect(starts).toBe(2);
	discovery.stop();
	discovery.setSession(session("owner"));
	expect(starts).toBe(2);
});

test("sign out and account changes replace discovery while token refresh keeps the same peer", () => {
	const starts: string[] = [];
	const stops: string[] = [];
	const discovery = new AccountDeviceDiscovery({
		eligible: () => true,
		create: (s) => ({
			start: async () => {
				starts.push(s.user.id);
			},
			stop: () => {
				stops.push(s.user.id);
			},
		}),
		attach: () => undefined,
	});
	discovery.setSession(session("first"));
	discovery.setSession(session("first"));
	discovery.setSession(session("second"));
	discovery.setSession(null);
	expect(starts).toEqual(["first", "second"]);
	expect(stops).toEqual(["first", "second"]);
	discovery.stop();
});
