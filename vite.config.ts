import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set by scripts/android-dev.ps1: this machine's IPv4 that the Android
// device can reach. The WebView loads the app through Tauri's proxy
// scheme, so it can't derive the dev-server host for the HMR websocket
// and needs it spelled out.
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
			// @mjba/lyrics imports Node built-ins for its (optional) token
			// cache; point them at no-op browser shims so the package can run
			// in the webview. See src/lib/node-shims.ts.
			"node:os": path.resolve(import.meta.dirname, "./src/lib/node-shims.ts"),
			"node:path": path.resolve(import.meta.dirname, "./src/lib/node-shims.ts"),
			"node:fs/promises": path.resolve(
				import.meta.dirname,
				"./src/lib/node-shims.ts",
			),
			"node:fs": path.resolve(import.meta.dirname, "./src/lib/node-shims.ts"),
		},
	},
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		// Listen on all addresses so Android devices/emulators can reach
		// the dev server over the network (required by `tauri android dev`)
		host: true,
		hmr: devHost ? { protocol: "ws", host: devHost } : undefined,
		watch: {
			ignored: ["**/src-tauri/**", "**/dist/**", "**/electron/**"],
		},
	},
	envPrefix: ["VITE_", "TAURI_"],
	build: {
		target: "esnext",
	},
});
