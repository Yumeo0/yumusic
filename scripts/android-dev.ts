// `bun android` — runs `bun tauri android dev` with TAURI_DEV_HOST set to
// this machine's IPv4 that reaches the connected Android device, so the
// app's HMR websocket works over the network (see vite.config.ts).
// Without it the app still runs on the device, but hot reload cannot
// connect: the WebView would try localhost — itself, not this PC.
import { execFileSync, spawn } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import path from "node:path";

const adbLocal = path.join(
	process.env.LOCALAPPDATA ?? "",
	"Android/Sdk/platform-tools/adb.exe",
);
const adb = existsSync(adbLocal) ? adbLocal : "adb";

function phoneIp(): string | null {
	try {
		const out = execFileSync(
			adb,
			["shell", "ip", "-f", "inet", "addr", "show", "wlan0"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
			},
		);
		return /inet (\d+(?:\.\d+){3})/.exec(out)?.[1] ?? null;
	} catch {
		return null;
	}
}

// UDP "connect" sends no packets — the OS just picks the source address
// it would use to reach the remote, which is exactly what we need.
function sourceIpFor(remote: string): Promise<string | null> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket("udp4");
		const done = (value: string | null) => {
			try {
				socket.close();
			} catch {
				// already closed
			}
			resolve(value);
		};
		socket.on("error", () => done(null));
		socket.connect(80, remote, () => {
			const address = socket.address();
			done(typeof address === "object" ? address.address : null);
		});
	});
}

const phone = phoneIp();
if (!phone) {
	console.warn(
		"[android-dev] No device reachable via adb — HMR on the device will not work.",
	);
} else {
	const local = await sourceIpFor(phone);
	if (local) {
		process.env.TAURI_DEV_HOST = local;
		console.log(`[android-dev] phone ${phone} | TAURI_DEV_HOST = ${local}`);
	} else {
		console.warn(
			"[android-dev] Could not resolve a source IP toward the device — HMR will not work.",
		);
	}
}

const child = spawn(process.execPath, ["tauri", "android", "dev"], {
	env: process.env,
	stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
