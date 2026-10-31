import { ThumbsDown, ThumbsUp } from "lucide-react";
import { loadSongRating, useSongRating } from "@/lib/stores/song-ratings";
import { cn } from "@/lib/utils/utils";

/**
 * Like/dislike pair for one song. The rating lives on the YouTube account: a
 * press applies it, and pressing the active one clears it again (the same
 * toggle YouTube Music offers). While the request is in flight the buttons
 * are disabled so rapid presses cannot race each other.
 *
 * `lazy` leaves the initial YouTube lookup to the caller (song rows load it
 * on hover), so rendering a long list does not fire a request per row.
 */
export function RatingButtons({
	songId,
	className,
	lazy = false,
	compact = false,
	collapse = false,
}: {
	songId: string | null | undefined;
	className?: string;
	lazy?: boolean;
	/** Smaller pair for inline use next to a track's duration. */
	compact?: boolean;
	/**
	 * Show only the rating that applies first (like, or dislike when the song
	 * is disliked); the other thumb slides in while the pair is hovered or
	 * focused.
	 */
	collapse?: boolean;
}) {
	const { rating, busy, loaded, rate } = useSongRating(songId, {
		eager: !lazy,
	});
	const buttonClass = (active: boolean) =>
		cn(
			"grid place-items-center rounded-full transition-all duration-200 active:scale-90 disabled:pointer-events-none disabled:opacity-40",
			compact ? "size-7" : "size-9",
			active
				? "bg-primary/15 text-primary"
				: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
			// The state is still being read: dim the pair instead of showing a
			// misleading "not rated" while the request is in flight.
			!loaded && "opacity-60",
		);
	const iconClass = compact ? "size-4" : "size-4.5";

	const button = (kind: "like" | "dislike", hidden: boolean) => {
		const active = rating === kind;
		const isLike = kind === "like";
		return (
			<button
				aria-label={
					isLike
						? active
							? "Remove like"
							: "Like"
						: active
							? "Remove dislike"
							: "Dislike"
				}
				aria-pressed={active}
				className={cn(
					buttonClass(active),
					hidden &&
						"hidden group-hover/rating:grid group-focus-within/rating:grid",
				)}
				data-rating={kind}
				disabled={busy || !songId}
				key={kind}
				onClick={() => rate(kind)}
				title={isLike ? "Like" : "Dislike"}
				type="button"
			>
				{isLike ? (
					<ThumbsUp className={cn(iconClass, active && "fill-current")} />
				) : (
					<ThumbsDown className={cn(iconClass, active && "fill-current")} />
				)}
			</button>
		);
	};

	// Expanded pairs always read like → dislike. Collapsed, only the thumb
	// that matches the current state (or the like when unrated) is shown; the
	// other joins it while the pair is hovered or focused.
	const primary: "like" | "dislike" =
		collapse && rating === "dislike" ? "dislike" : "like";

	return (
		<div
			className={cn("group/rating flex items-center gap-1", className)}
			onFocusCapture={() => {
				if (lazy) loadSongRating(songId);
			}}
			onMouseEnter={() => {
				if (lazy) loadSongRating(songId);
			}}
		>
			{(["like", "dislike"] as const).map((kind) =>
				button(kind, collapse && kind !== primary),
			)}
		</div>
	);
}
