import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { dismissTopOverlay } from "@/lib/player/app-back";
import {
	getNowPlayingOpen,
	getQueueOpen,
	setNowPlayingOpen,
	setQueueOpen,
} from "@/lib/player/player-ui";

export function NativeBackNavigation() {
	const navigate = useNavigate();
	const location = useLocation();
	useEffect(() => {
		const back = () => {
			if (dismissTopOverlay()) return true;
			if (getQueueOpen()) {
				setQueueOpen(false);
				return true;
			}
			if (getNowPlayingOpen()) {
				setNowPlayingOpen(false);
				return true;
			}
			if ((window.history.state?.idx ?? 0) > 0) {
				navigate(-1);
				return true;
			}
			if (location.pathname !== "/" && location.pathname !== "/home") {
				navigate("/", { replace: true });
				return true;
			}
			return false;
		};
		window.__yumusicBack = back;
		return () => {
			if (window.__yumusicBack === back) delete window.__yumusicBack;
		};
	}, [navigate, location.pathname]);
	return null;
}
