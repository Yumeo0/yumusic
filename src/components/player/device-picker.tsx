import { Dialog } from "@base-ui/react/dialog";
import {
	Check,
	Laptop,
	Loader2,
	MonitorSpeaker,
	Pause,
	Play,
	RefreshCw,
	SkipBack,
	SkipForward,
	Smartphone,
	X,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type DeviceCommand, deviceStatus } from "@/lib/connect/protocol";
import { getDeviceHub, useDevices } from "@/lib/connect/store";
import { cn } from "@/lib/utils/utils";
import { DEVICE_NAME_KEY, defaultDeviceName } from "./device-bridge";

const deviceDialog = Dialog.createHandle();
export function DeviceButton() {
	const state = useDevices();
	const available = state.devices.filter(
		(device) => device.id !== state.id,
	).length;
	const label = available
		? `Connect to a device, ${available} available`
		: "Connect to a device";
	return (
		<Dialog.Trigger
			aria-label={label}
			className="player-ctl relative grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
			data-swipe-dismiss-ignore
			handle={deviceDialog}
			onClick={(e) => e.stopPropagation()}
			title={label}
			type="button"
		>
			<MonitorSpeaker aria-hidden className="size-5" />
			{available > 0 && (
				<span
					aria-hidden
					className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground"
				>
					{available}
				</span>
			)}
		</Dialog.Trigger>
	);
}

export function DevicePanel() {
	const state = useDevices();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState(
		() => localStorage.getItem(DEVICE_NAME_KEY) || defaultDeviceName(),
	);
	const run = async (action: () => Promise<unknown> | undefined) => {
		setError("");
		setBusy(true);
		try {
			await action();
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "The device could not be reached.",
			);
		} finally {
			setBusy(false);
		}
	};
	const source =
		state.devices.find(
			(d) => deviceStatus(d.state).playing && !deviceStatus(d.state).room,
		) ??
		state.devices.find(
			(d) =>
				d.id === state.id &&
				deviceStatus(d.state).title &&
				!deviceStatus(d.state).room,
		) ??
		state.devices.find(
			(d) => deviceStatus(d.state).title && !deviceStatus(d.state).room,
		);
	const command = (id: string, action: DeviceCommand) =>
		void run(() => getDeviceHub()?.control(id, action));
	return (
		<div className="flex flex-col gap-5">
			{state.status === "offline" ? (
				<p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
					Enable sync in Settings using the same YouTube Google account on each
					device.
				</p>
			) : (
				<>
					<div className="flex items-center gap-2">
						<label className="sr-only" htmlFor="device-name">
							This device's name
						</label>
						<Input
							aria-label="This device's name"
							id="device-name"
							maxLength={80}
							onBlur={() => void getDeviceHub()?.refresh()}
							onChange={(e) => {
								setName(e.target.value);
								localStorage.setItem(
									DEVICE_NAME_KEY,
									e.target.value.trim().slice(0, 80),
								);
							}}
							value={name}
						/>
						<Button
							aria-label="Refresh devices"
							disabled={busy}
							onClick={() => void run(() => getDeviceHub()?.refresh())}
							size="icon"
							variant="ghost"
						>
							<RefreshCw />
						</Button>
					</div>
					<section
						aria-label="Available devices"
						className="flex flex-col gap-2"
					>
						{state.devices.map((d) => {
							const status = deviceStatus(d.state);
							const self = d.id === state.id;
							const Icon = d.kind === "phone" ? Smartphone : Laptop;
							return (
								<div
									className={cn(
										"rounded-xl border p-4 transition-colors",
										status.playing
											? "border-primary/30 bg-primary/5"
											: "border-border",
									)}
									key={d.id}
								>
									<div className="flex items-center gap-3">
										<Icon
											aria-hidden
											className={cn(
												"size-6 shrink-0",
												status.playing
													? "text-primary"
													: "text-muted-foreground",
											)}
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium">
												{d.name}
												{self && (
													<span className="ml-2 text-xs text-muted-foreground">
														This device
													</span>
												)}
											</p>
											<p className="mt-1 truncate text-xs text-muted-foreground">
												{status.room
													? "In a Listen together room"
													: status.title
														? `${status.playing ? "Playing" : "Paused"} · ${status.title}${status.artist ? ` · ${status.artist}` : ""}`
														: "Ready to play"}
											</p>
										</div>
										{source?.id === d.id ? (
											<Check
												aria-label="Current playback device"
												className="size-4 shrink-0 text-primary"
											/>
										) : (
											source &&
											!status.room && (
												<Button
													disabled={busy || state.busy}
													onClick={() =>
														void run(() =>
															getDeviceHub()?.move(source.id, d.id),
														)
													}
													size="sm"
													variant="outline"
												>
													{busy || state.busy ? (
														<Loader2 className="animate-spin" />
													) : self ? (
														"Play here"
													) : (
														"Transfer"
													)}
												</Button>
											)
										)}
									</div>
									{status.title && !status.room && (
										<div className="mt-3 flex items-center justify-end gap-1">
											<Button
												aria-label={`Previous on ${d.name}`}
												disabled={busy}
												onClick={() => command(d.id, "previous")}
												size="icon-sm"
												variant="ghost"
											>
												<SkipBack />
											</Button>
											<Button
												aria-label={`${status.playing ? "Pause" : "Resume"} on ${d.name}`}
												disabled={busy}
												onClick={() =>
													command(d.id, status.playing ? "pause" : "resume")
												}
												size="icon-sm"
												variant="ghost"
											>
												{status.playing ? <Pause /> : <Play />}
											</Button>
											<Button
												aria-label={`Next on ${d.name}`}
												disabled={busy}
												onClick={() => command(d.id, "next")}
												size="icon-sm"
												variant="ghost"
											>
												<SkipForward />
											</Button>
										</div>
									)}
								</div>
							);
						})}
					</section>
					{state.devices.length < 2 && (
						<p className="text-xs text-muted-foreground">
							Open YuMusic and enable sync on another device to see it here.
						</p>
					)}
				</>
			)}
			{(error || state.error) && (
				<Alert variant="destructive">
					<AlertDescription>{error || state.error}</AlertDescription>
				</Alert>
			)}
		</div>
	);
}

export function DeviceActivity() {
	return (
		<Dialog.Root handle={deviceDialog}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/60 backdrop-blur-sm" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 max-h-[calc(100dvh-3rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-popover p-5 shadow-2xl">
					<div className="mb-5 flex items-center justify-between gap-3">
						<Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
							<MonitorSpeaker aria-hidden className="size-5 text-primary" />{" "}
							Connect to a device
						</Dialog.Title>
						<Dialog.Close
							aria-label="Close devices"
							className="rounded-full p-2 text-muted-foreground hover:bg-muted"
						>
							<X className="size-4" />
						</Dialog.Close>
					</div>
					<DevicePanel />
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
