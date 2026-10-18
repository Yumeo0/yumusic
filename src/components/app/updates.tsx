import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import { CircleCheck, Download, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	checkForUpdate,
	type DownloadProgress,
	installUpdate,
	updaterSupported,
} from "@/lib/services/updater";
import { dismissToast, showToast, updateToast } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";

type UpdateStatus =
	| "idle"
	| "checking"
	| "current"
	| "available"
	| "installing"
	| "error";

/** How long the startup notification waits for a click before fading out. */
const NOTIFICATION_DURATION_MS = 30_000;

/** Download completion percentage, or null while the total size is unknown. */
function downloadPercent({
	downloaded,
	total,
}: DownloadProgress): number | null {
	if (!total) return null;
	return Math.min(100, Math.round((downloaded / total) * 100));
}

/**
 * Downloads and installs a release announced by the startup notification,
 * reporting progress in the notification itself.
 */
async function installFromNotification(update: Update, toastId: number) {
	updateToast(toastId, {
		message: `Downloading YuMusic ${update.version}…`,
		onClick: undefined,
		durationMs: null,
	});
	try {
		await installUpdate(update, (progress) => {
			const percent = downloadPercent(progress);
			updateToast(toastId, {
				message:
					percent === null
						? `Downloading YuMusic ${update.version}…`
						: `Downloading YuMusic ${update.version}… ${percent}%`,
			});
		});
		// installUpdate relaunches into the new build; on Windows the installer
		// may exit the app first, so nothing after this runs.
	} catch (error) {
		console.error("[YuMusic] update failed:", error);
		dismissToast(toastId);
		showToast("Could not install the update");
	}
}

/**
 * Silent startup check: when a newer release exists, announce it in a toast
 * that downloads, installs and relaunches into it when clicked. Only runs in
 * release desktop builds.
 */
export function UpdateNotifier() {
	useEffect(() => {
		if (!import.meta.env.PROD || !updaterSupported()) return;
		let cancelled = false;
		let update: Update | null = null;

		checkForUpdate()
			.then((next) => {
				if (cancelled || !next) {
					void next?.close();
					return;
				}
				update = next;
				const id = showToast(
					`YuMusic ${next.version} is available — click to install`,
					{
						durationMs: NOTIFICATION_DURATION_MS,
						onClick: () => {
							// The install consumes the update handle; keep the
							// unmount cleanup below from closing it mid-download.
							update = null;
							void installFromNotification(next, id);
						},
					},
				);
			})
			.catch(() => undefined);

		return () => {
			cancelled = true;
			void update?.close();
		};
	}, []);
	return null;
}

/** Settings card: shows the app version and checks/installs updates. */
export function UpdatesSection() {
	const [current, setCurrent] = useState<string | null>(null);
	const [status, setStatus] = useState<UpdateStatus>("idle");
	const [update, setUpdate] = useState<Update | null>(null);
	const [progress, setProgress] = useState<DownloadProgress>({
		downloaded: 0,
		total: null,
	});

	useEffect(() => {
		getVersion()
			.then(setCurrent)
			.catch(() => undefined);
	}, []);

	const check = useCallback(async () => {
		setStatus("checking");
		try {
			const next = await checkForUpdate();
			setUpdate(next);
			setStatus(next ? "available" : "current");
			showToast(
				next ? `YuMusic ${next.version} is available` : "YuMusic is up to date",
			);
		} catch (error) {
			console.error("[YuMusic] update check failed:", error);
			setStatus("error");
		}
	}, []);

	const install = useCallback(async () => {
		if (!update) return;
		setStatus("installing");
		setProgress({ downloaded: 0, total: null });
		try {
			// The app relaunches into the new build; on Windows the installer
			// may exit it first, so this promise never resolves.
			await installUpdate(update, setProgress);
		} catch (error) {
			console.error("[YuMusic] update failed:", error);
			setStatus("error");
			showToast("Could not install the update");
		}
	}, [update]);

	const percent = downloadPercent(progress);

	const statusText = {
		idle: "Check for a newer release.",
		checking: "Checking for updates…",
		current: "You're on the latest version.",
		available: `Version ${update?.version ?? ""} is ready to install.`,
		installing:
			percent === null
				? "Downloading the update…"
				: `Downloading the update… ${percent}%`,
		error: "Couldn't check for updates — try again later.",
	}[status];

	return (
		<section className="mt-10">
			<h2 className="mb-3 text-sm font-semibold text-foreground">Updates</h2>
			<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
				<div className="flex items-center justify-between gap-6 p-4">
					<div className="min-w-0">
						<p className="text-sm font-medium">
							App version{current ? ` — v${current}` : ""}
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">{statusText}</p>
					</div>
					<button
						className={cn(
							"flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-200",
							status === "current"
								? "border-primary/40 text-primary"
								: "border-foreground/12 text-muted-foreground hover:border-primary/40 hover:text-primary",
						)}
						disabled={status === "checking" || status === "installing"}
						onClick={() => void check()}
						type="button"
					>
						{status === "checking" ? (
							<Loader2 className="size-4 animate-spin" />
						) : status === "current" ? (
							<CircleCheck className="size-4" />
						) : (
							<RotateCw className="size-4" />
						)}
						{status === "checking"
							? "Checking"
							: status === "current"
								? "Up to date"
								: "Check for updates"}
					</button>
				</div>

				{status === "available" && update && (
					<div className="p-4">
						<div className="flex items-center justify-between gap-6">
							<div className="min-w-0">
								<p className="text-sm font-medium">YuMusic {update.version}</p>
								{update.date && (
									<p className="mt-0.5 text-xs text-muted-foreground">
										Released {new Date(update.date).toLocaleDateString()}
									</p>
								)}
							</div>
							<button
								className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95"
								onClick={() => void install()}
								type="button"
							>
								<Download className="size-4" />
								Install and restart
							</button>
						</div>
						{update.body && (
							<pre className="mt-3 max-h-40 overflow-y-auto font-sans text-xs whitespace-pre-wrap text-muted-foreground">
								{update.body}
							</pre>
						)}
					</div>
				)}

				{status === "installing" && (
					<div className="p-4">
						<p className="text-sm font-medium">Installing update…</p>
						<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10">
							<div
								className="h-full rounded-full bg-primary transition-[width] duration-200"
								style={{ width: `${percent ?? 5}%` }}
							/>
						</div>
						<p className="mt-1.5 text-xs text-muted-foreground">
							The app will restart when the update is ready.
						</p>
					</div>
				)}
			</div>
		</section>
	);
}
