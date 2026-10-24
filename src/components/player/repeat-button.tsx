import { Repeat, Repeat1 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlayer } from "@/contexts/player-context";
import { cn } from "@/lib/utils/utils";

const MODES = ["off", "all", "one"] as const;
const LABELS = {
	off: "No loop",
	all: "Loop playlist",
	one: "Loop single song",
};

export function RepeatButton({ className }: { className?: string }) {
	const { repeatMode, setRepeatMode } = usePlayer();
	const nextMode = MODES[(MODES.indexOf(repeatMode) + 1) % MODES.length];
	const Icon = repeatMode === "one" ? Repeat1 : Repeat;
	return (
		<Button
			aria-label={LABELS[repeatMode]}
			aria-pressed={repeatMode !== "off"}
			className={cn(
				"player-ctl relative",
				repeatMode !== "off" && "text-primary",
				className,
			)}
			onClick={(event) => {
				event.stopPropagation();
				setRepeatMode(nextMode);
			}}
			size="icon"
			title={`${LABELS[repeatMode]} · Click for ${LABELS[nextMode].toLowerCase()}`}
			variant="ghost"
		>
			<Icon />
			{repeatMode !== "off" && (
				<span className="absolute bottom-1 size-1 rounded-full bg-current" />
			)}
		</Button>
	);
}
