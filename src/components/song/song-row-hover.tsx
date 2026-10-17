import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { RatingButtons } from "@/components/player/rating-buttons";
import { loadSongRating, useSongRating } from "@/lib/stores/song-ratings";

/** How long the pointer must rest on a row before its rating is fetched. */
const HOVER_DELAY_MS = 180;

/** Whether the row this rating belongs to is hovered or focused. */
const RowHoverContext = createContext(false);

/**
 * Hover/focus shell for a song row. It owns the `group` class the row's hover
 * styles rely on, tracks whether the row is hovered/focused (so the rating
 * pair can react to the row rather than to its own hover), and reads the
 * account's rating only once the pointer rests on the row — sweeping across a
 * long tracklist must not fire a request per entry.
 */
export function SongRowHover({
	songId,
	children,
}: {
	songId: string;
	children: ReactNode;
}) {
	const timerRef = useRef<number | null>(null);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);

	const cancel = () => {
		if (timerRef.current === null) return;
		window.clearTimeout(timerRef.current);
		timerRef.current = null;
	};

	const schedule = () => {
		if (timerRef.current !== null) return;
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			loadSongRating(songId);
		}, HOVER_DELAY_MS);
	};

	const enterMouse = () => {
		setHovered(true);
		schedule();
	};

	const leaveMouse = () => {
		setHovered(false);
		cancel();
	};

	const enterFocus = () => {
		setFocused(true);
		schedule();
	};

	const leaveFocus = () => {
		setFocused(false);
	};

	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);

	return (
		<RowHoverContext.Provider value={hovered || focused}>
			<div
				className="group relative rounded-lg transition-colors duration-150 hover:bg-foreground/5"
				onBlurCapture={leaveFocus}
				onFocusCapture={enterFocus}
				onMouseEnter={enterMouse}
				onMouseLeave={leaveMouse}
			>
				{children}
			</div>
		</RowHoverContext.Provider>
	);
}

/**
 * The row's like/dislike pair, beside the duration. A liked song keeps its
 * (filled) like thumb visible at rest so the playlist shows what is already
 * liked. Hovering or focusing the row reveals both thumbs; other rows show
 * nothing until then.
 */
export function SongRowRating({ songId }: { songId: string }) {
	const hovered = useContext(RowHoverContext);
	const { rating } = useSongRating(songId, { eager: false });
	if (!hovered && rating !== "like") return null;
	return (
		<div className="flex shrink-0 items-center">
			<RatingButtons
				collapse={!hovered}
				compact
				lazy
				songId={songId}
			/>
		</div>
	);
}
