/** biome-ignore-all lint/correctness/noUndeclaredVariables: Some variables are global */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";
import started from "electron-squirrel-startup";
import { startProxy } from "./proxy";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
	app.quit();
}

const COOKIE_PATH = path.join(app.getPath("userData"), "cookie.json");

const createWindow = () => {
	startProxy();
	// Create the browser window.
	const mainWindow = new BrowserWindow({
		width: 1080,
		height: 720,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
		},
	});

	// and load the index.html of the app.
	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
	} else {
		mainWindow.loadFile(
			path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
		);
	}

	// Open the DevTools.
	mainWindow.webContents.openDevTools();
};

ipcMain.handle("login-youtube", async () => {
	return new Promise((resolve, _reject) => {
		const loginWindow = new BrowserWindow({
			width: 800,
			height: 600,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
			},
		});

		loginWindow.loadURL(
			"https://accounts.google.com/ServiceLogin?service=youtube",
		);

		const filter = {
			urls: ["*://*.youtube.com/*"],
		};

		loginWindow.webContents.session.webRequest.onBeforeSendHeaders(
			filter,
			(details, callback) => {
				const { requestHeaders } = details;
				const cookie = requestHeaders.Cookie || requestHeaders.cookie;

				if (
					cookie &&
					details.url.includes("youtube.com") &&
					cookie.includes("__Secure-3PSID")
				) {
					// Found the cookie
					fs.writeFileSync(COOKIE_PATH, JSON.stringify({ cookie }));
					loginWindow.close();
					resolve(cookie);
				}

				callback({ requestHeaders });
			},
		);

		loginWindow.on("closed", () => {
			// If closed without finding cookie, resolve with null or existing cookie
			try {
				if (fs.existsSync(COOKIE_PATH)) {
					const data = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
					resolve(data.cookie);
				} else {
					resolve(null);
				}
			} catch (_e) {
				resolve(null);
			}
		});
	});
});

ipcMain.handle("get-cookie", async () => {
	try {
		if (fs.existsSync(COOKIE_PATH)) {
			const data = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf-8"));
			return data.cookie;
		}
	} catch (e) {
		console.error("Error reading cookie:", e);
	}
	return null;
});

ipcMain.handle("logout-youtube", async () => {
	try {
		if (fs.existsSync(COOKIE_PATH)) {
			fs.unlinkSync(COOKIE_PATH);
		}
		session.defaultSession.clearStorageData();
		return true;
	} catch (e) {
		console.error("Error logging out:", e);
		return false;
	}
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
