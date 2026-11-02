import { Field } from "@base-ui/react/field";
import { Popover } from "@base-ui/react/popover";
import { Separator } from "@base-ui/react/separator";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { ListEnd, Moon, Music2, Timer, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	sleepTimer,
	sleepTimerLabel,
	useSleepTimer,
} from "@/lib/player/sleep-timer";
import { cn } from "@/lib/utils/utils";

export function SleepTimerButton() {
	const timer = useSleepTimer();
	const [open, setOpen] = useState(false);
	const [minutes, setMinutes] = useState("30");
	const [songs, setSongs] = useState("5");
	const [, setClock] = useState(0);
	const minutesId = useId();
	const songsId = useId();
	useEffect(() => {
		if (!open || timer?.mode !== "duration") return;
		const interval = setInterval(() => setClock((clock) => clock + 1), 1000);
		return () => clearInterval(interval);
	}, [open, timer?.mode]);
	const start = (action: () => void) => {
		action();
		setOpen(false);
	};
	return (
		<Popover.Root onOpenChange={setOpen} open={open}>
			<Popover.Trigger
				aria-label={
					timer ? `Sleep timer: ${sleepTimerLabel(timer)}` : "Sleep timer"
				}
				className={cn(
					"grid size-9 place-items-center rounded-full transition-colors hover:bg-foreground/8 hover:text-foreground",
					timer ? "text-primary bg-primary/10" : "text-muted-foreground",
				)}
				data-swipe-dismiss-ignore
				title="Sleep timer"
				type="button"
			>
				<Moon aria-hidden className="size-5" />
				{timer && <span className="sr-only">Active</span>}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					className="z-[160]"
					side="bottom"
					sideOffset={8}
				>
					<Popover.Popup
						className="w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl outline-none"
						data-swipe-dismiss-ignore
					>
						<div className="mb-3 flex items-center justify-between">
							<Popover.Title className="flex items-center gap-2 text-sm font-semibold">
								<Moon className="size-4 text-primary" />
								Sleep timer
							</Popover.Title>
							<Popover.Close
								aria-label="Close sleep timer"
								className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-foreground/8"
							>
								<X className="size-4" />
							</Popover.Close>
						</div>
						<Popover.Description className="mb-3 text-xs leading-relaxed text-muted-foreground">
							Stop playback at a song’s end. The current song counts toward the
							song limit.
						</Popover.Description>
						{timer && (
							<div
								className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary"
								role="status"
							>
								<span>{sleepTimerLabel(timer)}</span>
								<button
									className="shrink-0 font-medium underline underline-offset-2"
									onClick={() => sleepTimer.cancel()}
									type="button"
								>
									Cancel
								</button>
							</div>
						)}
						<button
							className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-foreground/5"
							onClick={() => start(sleepTimer.finishQueue)}
							type="button"
						>
							<ListEnd className="size-4 text-muted-foreground" />
							Finish queue
						</button>
						<Separator className="my-3 h-px bg-foreground/10" />
						<form
							onSubmit={(event) => {
								event.preventDefault();
								start(() => sleepTimer.afterMinutes(Number(minutes)));
							}}
						>
							<Field.Root>
								<Field.Label
									className="mb-2 flex items-center gap-2 text-xs font-medium"
									htmlFor={minutesId}
								>
									<Timer className="size-4 text-muted-foreground" />
									Duration in minutes
								</Field.Label>
								<ToggleGroup
									aria-label="Duration presets"
									className="mb-2 flex gap-1.5"
									onValueChange={(values) => {
										if (values[0]) setMinutes(values[0]);
									}}
									value={[minutes]}
								>
									{[15, 30, 60].map((value) => (
										<Toggle
											className="flex-1 rounded-md bg-foreground/5 py-1.5 text-xs hover:bg-foreground/10 data-pressed:bg-primary/15 data-pressed:text-primary"
											key={value}
											value={String(value)}
										>
											{value} min
										</Toggle>
									))}
								</ToggleGroup>
								<div className="flex gap-2">
									<Input
										id={minutesId}
										max={1440}
										min={1}
										onChange={(event) => setMinutes(event.target.value)}
										required
										step={1}
										type="number"
										value={minutes}
									/>
									<Button size="sm" type="submit">
										Set timer
									</Button>
								</div>
							</Field.Root>
						</form>
						<Separator className="my-3 h-px bg-foreground/10" />
						<form
							onSubmit={(event) => {
								event.preventDefault();
								start(() => sleepTimer.afterSongs(Number(songs)));
							}}
						>
							<Field.Root>
								<Field.Label
									className="mb-2 flex items-center gap-2 text-xs font-medium"
									htmlFor={songsId}
								>
									<Music2 className="size-4 text-muted-foreground" />
									Number of songs
								</Field.Label>
								<div className="flex gap-2">
									<Input
										id={songsId}
										max={999}
										min={1}
										onChange={(event) => setSongs(event.target.value)}
										required
										step={1}
										type="number"
										value={songs}
									/>
									<Button size="sm" type="submit">
										Set timer
									</Button>
								</div>
							</Field.Root>
						</form>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
