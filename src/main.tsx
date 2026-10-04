import "./globals.css";
import "./lib/utils/tauri";
import "./app";

window.addEventListener("contextmenu", (event) => {
	const target = event.target;
	if (
		target instanceof Element &&
		target.closest(
			'input, textarea, [contenteditable]:not([contenteditable="false"])',
		)
	) {
		return;
	}
	event.preventDefault();
});
