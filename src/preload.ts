import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
	login: () => ipcRenderer.invoke("login-youtube"),
	getCookie: () => ipcRenderer.invoke("get-cookie"),
	logout: () => ipcRenderer.invoke("logout-youtube"),
});
