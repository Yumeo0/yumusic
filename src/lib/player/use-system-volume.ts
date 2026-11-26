import { isTauri } from "@tauri-apps/api/core";
import { IS_MOBILE } from "../utils/tauri";
import { useMediaQuery } from "../utils/viewport";

/** Phones/tablets use hardware volume, including touch browser development. */
export function useSystemVolume(): boolean {
	const touchBrowser = useMediaQuery("(pointer: coarse)");
	return IS_MOBILE || (!isTauri() && touchBrowser);
}
