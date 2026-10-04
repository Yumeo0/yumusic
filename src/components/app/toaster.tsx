import { useEffect, useState } from "react";
import { subscribeToasts, type ToastItem } from "@/lib/stores/toast";

/** Bottom-center transient messages (e.g. copy confirmations). */
export function Toaster() {
	const [toasts, setToasts] = useState<ToastItem[]>([]);

	useEffect(() => subscribeToasts(setToasts), []);

	if (toasts.length === 0) return null;

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-28 z-90 flex flex-col items-center gap-2 px-4">
			{toasts.map((toast) => (
				<div
					className="animate-page-in rounded-full border border-foreground/10 bg-popover/95 px-4 py-2 text-sm text-popover-foreground shadow-lg backdrop-blur"
					key={toast.id}
				>
					{toast.message}
				</div>
			))}
		</div>
	);
}
