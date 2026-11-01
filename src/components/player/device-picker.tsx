import { Popover } from "@base-ui/react/popover";
import {
	Check,
	Circle,
	Headphones,
	Laptop,
	Loader2,
	MonitorSpeaker,
	Music2,
	Pause,
	Play,
	RefreshCw,
	SkipBack,
	SkipForward,
	Smartphone,
	X,
} from "lucide-react";
import { useId, useState } from "react";
import { ArtistLinks } from "@/components/song/artist-link";
import { CoverImage } from "@/components/song/cover-image";
import { SongTitle } from "@/components/song/song-title";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type DeviceCommand, deviceStatus } from "@/lib/connect/protocol";
import { getDeviceHub, useDevices } from "@/lib/connect/store";
import { useSystemVolume } from "@/lib/utils/hooks";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import { audioPanelHandle } from "./audio-panel-handle";
import { DEVICE_NAME_KEY, defaultDeviceName } from "./device-bridge";
import { VolumeSlider } from "./volume-control";

export function DeviceButton() {
	const systemVolume = useSystemVolume();
	const state = useDevices();
	const available = state.devices.filter(
		(device) => device.id !== state.id,
	).length;
	const title = systemVolume ? "Devices" : "Volume and devices";
	const label = available ? `${title}, ${available} available` : title;
	return (
		<Popover.Trigger
			aria-label={label}
			className="player-ctl relative grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
			closeDelay={300}
			data-swipe-dismiss-ignore
			delay={200}
			handle={audioPanelHandle}
			onClick={(e) => e.stopPropagation()}
			openOnHover
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
		</Popover.Trigger>
	);
}

export function DevicePanel() {
	const nameId = useId();
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
					<div className="flex flex-col gap-2">
						<label className="text-sm font-medium" htmlFor={nameId}>
							Device name
						</label>
						<div className="flex items-center gap-2">
							<Input
								aria-label="This device's name"
								id={nameId}
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
					</div>
					<section
						aria-label="Available devices"
						className="flex flex-col gap-2"
					>
						{state.devices.map((d) => {
							const status = deviceStatus(d.state);
							const self = d.id === state.id;
							const Icon = d.kind === "phone" ? Smartphone : Laptop;
							const StatusIcon = status.room
								? Headphones
								: status.title
									? status.playing
										? Play
										: Pause
									: Circle;
							const statusLabel = status.room
								? "In a Listen together room"
								: status.title
									? status.playing
										? "Playing"
										: "Paused"
									: "Ready to play";
							const song = {
								id: "",
								title: status.title,
								artist: status.artist,
								thumbnail: status.thumbnail ?? "",
								upload: status.upload,
							};
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
									<div className="flex items-center gap-2.5">
										<Icon
											aria-hidden
											className="size-4 shrink-0 text-muted-foreground"
										/>
										<p className="min-w-0 flex-1 truncate text-sm font-medium">
											{d.name}
											{self && (
												<span className="ml-2 text-xs text-muted-foreground">
													This device
												</span>
											)}
										</p>
										{source?.id === d.id && (
											<Check
												aria-label="Current playback device"
												className="size-3.5 text-primary"
											/>
										)}
									</div>
									<div className="mt-3 flex min-w-0 items-center gap-3">
										<div className="relative size-11 shrink-0">
											{status.thumbnail ? (
												<CoverImage
													alt=""
													className="size-full rounded-md object-cover"
													src={proxiedImageUrl(status.thumbnail, 96)}
												/>
											) : (
												<div className="grid size-full place-items-center rounded-md bg-muted">
													<Music2
														aria-hidden
														className="size-5 text-muted-foreground"
													/>
												</div>
											)}
											<span
												aria-label={statusLabel}
												className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border border-border bg-popover shadow-sm"
												role="img"
												title={statusLabel}
											>
												<StatusIcon
													aria-hidden
													className={cn(
														"size-3",
														status.playing
															? "text-primary"
															: "text-muted-foreground",
													)}
												/>
											</span>
										</div>
										<div className="min-w-0 flex-1">
											{status.title && (
												<>
													<p className="truncate text-sm font-medium">
														<SongTitle
															artist={status.artist}
															keepTitle={status.upload}
															title={status.title}
														/>
													</p>
													<p className="mt-0.5 truncate text-xs text-muted-foreground">
														<ArtistLinks song={song} />
													</p>
												</>
											)}
										</div>
										{source && source.id !== d.id && !status.room ? (
											<Button
												disabled={busy || state.busy}
												onClick={() =>
													void run(() => getDeviceHub()?.move(source.id, d.id))
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
										) : (
											status.title &&
											!status.room && (
												<div className="flex shrink-0 items-center gap-0.5">
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
											)
										)}
									</div>
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
	const systemVolume = useSystemVolume();
	return (
		<Popover.Root handle={audioPanelHandle}>
			<Popover.Portal className="relative z-100">
				<Popover.Positioner
					align="end"
					className="outline-none"
					collisionPadding={12}
					side="top"
					sideOffset={10}
				>
					<Popover.Popup className="max-h-[min(36rem,var(--available-height))] w-96 max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
						<div className="mb-5 flex items-center justify-between gap-3">
							<Popover.Title className="flex items-center gap-2 text-base font-semibold">
								<MonitorSpeaker aria-hidden className="size-5 text-primary" />{" "}
								{systemVolume ? "Devices" : "Volume & devices"}
							</Popover.Title>
							<Popover.Close
								aria-label={
									systemVolume ? "Close devices" : "Close volume and devices"
								}
								className="rounded-full p-2 text-muted-foreground hover:bg-muted"
							>
								<X className="size-4" />
							</Popover.Close>
						</div>
						{!systemVolume && <VolumeSlider />}
						<div
							className={cn(
								!systemVolume && "mt-4 border-t border-border pt-4",
							)}
						>
							<DevicePanel />
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
