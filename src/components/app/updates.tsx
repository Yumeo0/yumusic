import { CircleCheck, Download, Loader2, RotateCw } from "@lucide/solid";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import { createSignal, onSettled, Show } from "solid-js";
import {
	checkForUpdate,
	type DownloadProgress,
	installUpdate,
	updaterSupported,
} from "@/lib/services/updater";
import { showToast } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";

type UpdateStatus =
	| "idle"
	| "checking"
	| "current"
	| "available"
	| "installing"
	| "error";

/**
 * Silent startup check: when a newer release exists, nudge the user towards
 * Settings → Updates. Only runs in release desktop builds.
 */
export function UpdateNotifier() {
	onSettled(() => {
		if (!import.meta.env.PROD || !updaterSupported()) return;
		let cancelled = false;
		checkForUpdate()
			.then((update) => {
				if (cancelled || !update) return;
				showToast(
					`YuMusic ${update.version} is available — install it from Settings`,
				);
				void update.close();
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	});
	return null;
}

/** Settings card: shows the app version and checks/installs updates. */
export function UpdatesSection() {
	const [current, setCurrent] = createSignal<string | null>(null);
	const [status, setStatus] = createSignal<UpdateStatus>("idle");
	const [update, setUpdate] = createSignal<Update | null>(null);
	const [progress, setProgress] = createSignal<DownloadProgress>({
		downloaded: 0,
		total: null,
	});

	onSettled(() => {
		getVersion()
			.then(setCurrent)
			.catch(() => undefined);
	});

	const check = async () => {
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
	};

	const install = async () => {
		const target = update();
		if (!target) return;
		setStatus("installing");
		setProgress({ downloaded: 0, total: null });
		try {
			// The app relaunches into the new build; on Windows the installer
			// may exit it first, so this promise never resolves.
			await installUpdate(target, setProgress);
		} catch (error) {
			console.error("[YuMusic] update failed:", error);
			setStatus("error");
			showToast("Could not install the update");
		}
	};

	const percent = () => {
		const { downloaded, total } = progress();
		return total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
	};

	const statusText = () =>
		({
			idle: "Check for a newer release.",
			checking: "Checking for updates…",
			current: "You're on the latest version.",
			available: `Version ${update()?.version ?? ""} is ready to install.`,
			installing:
				percent() === null
					? "Downloading the update…"
					: `Downloading the update… ${percent()}%`,
			error: "Couldn't check for updates — try again later.",
		})[status()];

	return (
		<section class="mt-10">
			<h2 class="mb-3 text-sm font-semibold text-foreground">Updates</h2>
			<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
				<div class="flex items-center justify-between gap-6 p-4">
					<div class="min-w-0">
						<p class="text-sm font-medium">
							App version{current() ? ` — v${current()}` : ""}
						</p>
						<p class="mt-0.5 text-xs text-muted-foreground">{statusText()}</p>
					</div>
					<button
						class={cn(
							"flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-200",
							status() === "current"
								? "border-primary/40 text-primary"
								: "border-foreground/12 text-muted-foreground hover:border-primary/40 hover:text-primary",
						)}
						disabled={status() === "checking" || status() === "installing"}
						onClick={() => void check()}
						type="button"
					>
						<Show
							fallback={
								<Show
									fallback={<RotateCw class="size-4" />}
									when={status() === "current"}
								>
									<CircleCheck class="size-4" />
								</Show>
							}
							when={status() === "checking"}
						>
							<Loader2 class="size-4 animate-spin" />
						</Show>
						{status() === "checking"
							? "Checking"
							: status() === "current"
								? "Up to date"
								: "Check for updates"}
					</button>
				</div>

				<Show when={status() === "available" ? update() : null}>
					{(target) => (
						<div class="p-4">
							<div class="flex items-center justify-between gap-6">
								<div class="min-w-0">
									<p class="text-sm font-medium">YuMusic {target().version}</p>
									<Show when={target().date}>
										{(date) => (
											<p class="mt-0.5 text-xs text-muted-foreground">
												Released {new Date(date()).toLocaleDateString()}
											</p>
										)}
									</Show>
								</div>
								<button
									class="flex h-9 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95"
									onClick={() => void install()}
									type="button"
								>
									<Download class="size-4" />
									Install and restart
								</button>
							</div>
							<Show when={target().body}>
								{(body) => (
									<pre class="mt-3 max-h-40 overflow-y-auto font-sans text-xs whitespace-pre-wrap text-muted-foreground">
										{body()}
									</pre>
								)}
							</Show>
						</div>
					)}
				</Show>

				<Show when={status() === "installing"}>
					<div class="p-4">
						<p class="text-sm font-medium">Installing update…</p>
						<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10">
							<div
								class="h-full rounded-full bg-primary transition-[width] duration-200"
								style={{ width: `${percent() ?? 5}%` }}
							/>
						</div>
						<p class="mt-1.5 text-xs text-muted-foreground">
							The app will restart when the update is ready.
						</p>
					</div>
				</Show>
			</div>
		</section>
	);
}
