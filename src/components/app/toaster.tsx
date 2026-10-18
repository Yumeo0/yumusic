import { useEffect, useState } from "react";
import { subscribeToasts, type ToastItem } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";

const TOAST_CLASS =
	"animate-page-in rounded-full border border-foreground/10 bg-popover/95 px-4 py-2 text-sm text-popover-foreground shadow-lg backdrop-blur";

/** Bottom-center transient messages (e.g. copy confirmations). */
export function Toaster() {
	const [toasts, setToasts] = useState<ToastItem[]>([]);

	useEffect(() => subscribeToasts(setToasts), []);

	if (toasts.length === 0) return null;

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-28 z-90 flex flex-col items-center gap-2 px-4">
			{toasts.map((toast) =>
				toast.onClick ? (
					<button
						className={cn(
							TOAST_CLASS,
							"pointer-events-auto cursor-pointer transition-colors duration-150 hover:border-primary/40 hover:text-primary",
						)}
						key={toast.id}
						onClick={toast.onClick}
						type="button"
					>
						{toast.message}
					</button>
				) : (
					<div className={TOAST_CLASS} key={toast.id}>
						{toast.message}
					</div>
				),
			)}
		</div>
	);
}
