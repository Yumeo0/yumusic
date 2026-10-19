import {
	ArrowUpRight,
	Disc3,
	History,
	ListMusic,
	Loader2,
	Play,
	Search,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayer } from "@/contexts/player-context";
import {
	clearRecentSearches,
	forgetSearch,
	rememberSearch,
	useRecentSearches,
} from "@/lib/stores/search-history";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import { cn } from "@/lib/utils/utils";
import type { FeedItem } from "@/lib/youtube/feed-items";
import { getSearchRecommendations } from "@/lib/youtube/search-recommendations";
import { getSearchCompletions } from "@/lib/youtube/youtube-client";

/** Quiet period before asking YouTube for completions. */
const COMPLETION_DELAY_MS = 180;
const LISTBOX_ID = "search-suggestions";

interface SearchBarProps {
	/** The committed query from the URL. */
	query: string;
	/** Commits a query; an empty string returns to the home feed. */
	onSearch: (query: string) => void;
}

type Suggestion =
	| { type: "search" | "recent" | "completion"; value: string; index: number }
	| { type: "recommendation"; item: FeedItem; index: number };

function recommendationTitle(item: FeedItem): string {
	if (item.kind === "song") return item.song.title;
	if (item.kind === "artist") return formatArtistName(item.name);
	if (item.kind === "navigation") return item.label;
	return item.title;
}

function recommendationSubtitle(item: FeedItem): string {
	if (item.kind === "song") return item.song.artist;
	if (item.kind === "navigation") return "Browse";
	return item.subtitle;
}

function recommendationThumbnail(item: FeedItem): string {
	if (item.kind === "song") return item.song.thumbnail;
	if (item.kind === "navigation") return "";
	return item.thumbnail;
}

/**
 * The home page's search field. Opening it shows recent searches and
 * personalised picks from the home feed; typing asks YouTube Music for
 * completions. The list is fully keyboard navigable (↑/↓, Enter, Escape) and
 * selecting a pick either searches its text or opens/plays the entity.
 */
export function SearchBar({ query, onSearch }: SearchBarProps) {
	const navigate = useNavigate();
	const { play } = usePlayer();
	const recent = useRecentSearches();
	const [value, setValue] = useState(query);
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [completions, setCompletions] = useState<string[]>([]);
	const [completionsLoading, setCompletionsLoading] = useState(false);
	/** Null until the personalised picks were requested once. */
	const [recommendations, setRecommendations] = useState<FeedItem[] | null>(
		null,
	);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	/** Invalidates completions that arrive after the query moved on. */
	const requestRef = useRef(0);
	const trimmed = value.trim();

	// The URL is the source of truth: back/forward and sidebar navigation
	// reset the field.
	useEffect(() => {
		setValue(query);
	}, [query]);

	// Personalised picks are loaded the first time the empty bar is opened.
	// Signed-out users simply get no picks (the request fails or is empty).
	useEffect(() => {
		if (!open || trimmed || recommendations !== null) return;
		let cancelled = false;
		getSearchRecommendations()
			.then((items) => {
				if (!cancelled) setRecommendations(items);
			})
			.catch((error) => {
				console.warn("[search] failed to load recommendations:", error);
				if (!cancelled) setRecommendations([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open, trimmed, recommendations]);

	// Debounced completions; stale responses are dropped.
	useEffect(() => {
		if (!trimmed || !open) {
			setCompletionsLoading(false);
			return;
		}
		requestRef.current += 1;
		const request = requestRef.current;
		setCompletionsLoading(true);
		const timer = window.setTimeout(() => {
			getSearchCompletions(trimmed).then((items) => {
				if (request !== requestRef.current) return;
				setCompletions(items);
				setCompletionsLoading(false);
			});
		}, COMPLETION_DELAY_MS);
		return () => {
			window.clearTimeout(timer);
			requestRef.current += 1;
		};
	}, [trimmed, open]);

	// Clicking anywhere else dismisses the panel.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
				setActiveIndex(-1);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const rows: Suggestion[] = [];
	if (trimmed) {
		rows.push({ type: "search", value: trimmed, index: rows.length });
		for (const completion of completions) {
			if (completion.toLowerCase() === trimmed.toLowerCase()) continue;
			rows.push({
				type: "completion",
				value: completion,
				index: rows.length,
			});
		}
	} else {
		for (const entry of recent) {
			rows.push({ type: "recent", value: entry, index: rows.length });
		}
		for (const item of recommendations ?? []) {
			rows.push({ type: "recommendation", item, index: rows.length });
		}
	}

	const recommendationsLoading = !trimmed && recommendations === null;
	const showPanel =
		open &&
		(trimmed
			? completionsLoading || rows.length > 0
			: rows.length > 0 || recommendationsLoading);

	const commit = (next: string) => {
		const cleaned = next.trim();
		if (!cleaned) return;
		rememberSearch(cleaned);
		setValue(cleaned);
		setOpen(false);
		setActiveIndex(-1);
		inputRef.current?.blur();
		onSearch(cleaned);
	};

	const openRecommendation = (item: FeedItem) => {
		setOpen(false);
		setActiveIndex(-1);
		inputRef.current?.blur();
		if (item.kind === "song") {
			play(item.song);
		} else if (item.kind === "artist") {
			navigate(`/artist/${item.id}`);
		} else if (item.kind === "navigation") {
			navigate(`/?q=${encodeURIComponent(item.label)}`);
		} else {
			navigate(`/playlists/${item.id}`);
		}
	};

	const activate = (row: Suggestion) => {
		if (row.type === "recommendation") openRecommendation(row.item);
		else commit(row.value);
	};

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (open && activeIndex >= 0) {
			const row = rows[activeIndex];
			if (row) {
				activate(row);
				return;
			}
		}
		commit(value);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			if (!open) {
				setOpen(true);
				setActiveIndex(-1);
				return;
			}
			if (rows.length === 0) return;
			setActiveIndex((index) => (index + 1) % rows.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (!open || rows.length === 0) return;
			setActiveIndex((index) => (index <= 0 ? rows.length - 1 : index - 1));
		} else if (event.key === "Enter") {
			if (open && activeIndex >= 0) {
				const row = rows[activeIndex];
				if (row) {
					event.preventDefault();
					activate(row);
				}
			}
		} else if (event.key === "Escape") {
			if (open) {
				event.preventDefault();
				setOpen(false);
				setActiveIndex(-1);
			}
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};

	const clear = () => {
		setValue("");
		setCompletions([]);
		setActiveIndex(-1);
		setOpen(true);
		if (query) onSearch("");
		inputRef.current?.focus();
	};

	const optionClass = (index: number, extra?: string) =>
		cn(
			"flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left transition-colors duration-100",
			index === activeIndex
				? "bg-foreground/8 text-foreground"
				: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
			extra,
		);

	const optionProps = (row: Suggestion) => ({
		"aria-selected": row.index === activeIndex,
		id: `search-option-${row.index}`,
		onClick: () => activate(row),
		onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
		onMouseEnter: () => setActiveIndex(row.index),
		role: "option",
	});

	const searchRows = rows.filter(
		(row): row is Extract<Suggestion, { value: string }> =>
			row.type !== "recommendation",
	);
	const recentRows = searchRows.filter((row) => row.type === "recent");
	const completionRows = searchRows.filter(
		(row) => row.type === "search" || row.type === "completion",
	);
	const recommendationRows = rows.filter(
		(row): row is Extract<Suggestion, { item: FeedItem }> =>
			row.type === "recommendation",
	);

	return (
		<form onSubmit={handleSubmit}>
			<div className="relative" ref={containerRef}>
				<div className="group relative flex items-center">
					<Search className="pointer-events-none absolute left-4.5 size-5 text-muted-foreground transition-colors group-focus-within:text-foreground" />
					<input
						aria-activedescendant={
							open && activeIndex >= 0
								? `search-option-${activeIndex}`
								: undefined
						}
						aria-autocomplete="list"
						aria-controls={LISTBOX_ID}
						aria-expanded={showPanel}
						aria-label="Search songs, artists, albums and videos"
						autoComplete="off"
						className="h-13 w-full rounded-xl border border-foreground/12 bg-foreground/4 pr-12 pl-12 text-base outline-none transition-colors duration-200 placeholder:text-muted-foreground/70 focus:border-primary/50 focus:bg-foreground/6"
						onChange={(event) => {
							setValue(event.target.value);
							setOpen(true);
							setActiveIndex(-1);
						}}
						onFocus={() => {
							setOpen(true);
							setActiveIndex(-1);
						}}
						onKeyDown={handleKeyDown}
						placeholder="Search songs, artists, videos…"
						ref={inputRef}
						role="combobox"
						spellCheck={false}
						type="text"
						value={value}
					/>
					<div className="absolute right-3 flex items-center gap-1">
						{completionsLoading && trimmed && (
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						)}
						{value && (
							<button
								aria-label="Clear search"
								className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
								onClick={clear}
								type="button"
							>
								<X className="size-4" />
							</button>
						)}
					</div>
				</div>

				{showPanel && (
					<div
						aria-label="Search suggestions"
						className="absolute inset-x-0 top-full z-50 mt-2 max-h-[min(70vh,26rem)] overflow-y-auto overscroll-contain rounded-xl border border-foreground/10 bg-popover/98 p-2 shadow-2xl shadow-black/40 backdrop-blur-xl"
						id={LISTBOX_ID}
						role="listbox"
					>
						{trimmed ? (
							<>
								{completionRows.map((row) => (
									<div
										className={optionClass(row.index, "h-10")}
										key={`${row.type}-${row.value}`}
										{...optionProps(row)}
									>
										<Search className="size-4 shrink-0" />
										<span className="min-w-0 flex-1 truncate">
											{row.type === "search"
												? `Search for “${row.value}”`
												: row.value}
										</span>
									</div>
								))}
								{completionsLoading && (
									<div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/70">
										<Loader2 className="size-3.5 animate-spin" />
										Looking for suggestions…
									</div>
								)}
							</>
						) : (
							<>
								{recentRows.length > 0 && (
									<div className="pb-1">
										<div className="flex items-center justify-between px-2 pt-1 pb-1.5">
											<span className="text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
												Recent searches
											</span>
											<button
												className="text-[11px] font-medium text-muted-foreground/70 uppercase transition-colors hover:text-foreground"
												onClick={clearRecentSearches}
												type="button"
											>
												Clear
											</button>
										</div>
										{recentRows.map((row) => (
											<div
												className={optionClass(row.index, "h-10 pr-1.5")}
												key={`recent-${row.value}`}
												{...optionProps(row)}
											>
												<History className="size-4 shrink-0" />
												<span className="min-w-0 flex-1 truncate">
													{row.value}
												</span>
												<button
													aria-label={`Remove “${row.value}” from recent searches`}
													className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
													onClick={(event) => {
														event.stopPropagation();
														forgetSearch(row.value);
													}}
													onMouseDown={(event) => event.stopPropagation()}
													type="button"
												>
													<X className="size-3.5" />
												</button>
											</div>
										))}
									</div>
								)}

								<div
									className={cn(
										recentRows.length > 0 &&
											"border-t border-foreground/6 pt-1",
									)}
								>
									<div className="flex items-center justify-between px-2 pt-1 pb-1.5">
										<span className="text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
											Recommended for you
										</span>
										{recommendationsLoading && (
											<Loader2 className="size-3.5 animate-spin text-muted-foreground/70" />
										)}
									</div>
									{recommendationsLoading ? (
										<div className="space-y-1">
											{[0, 1, 2].map((row) => (
												<div
													className="flex h-12 items-center gap-3 px-3"
													key={`recommendation-skeleton-${row}`}
												>
													<div className="shimmer-surface size-9 shrink-0 rounded-md" />
													<div className="min-w-0 flex-1 space-y-1.5">
														<div className="shimmer-surface h-3 w-2/5 rounded" />
														<div className="shimmer-surface h-2.5 w-1/4 rounded" />
													</div>
												</div>
											))}
										</div>
									) : recommendationRows.length > 0 ? (
										recommendationRows.map((row) => {
											const item = row.item;
											const title = recommendationTitle(item);
											const thumbnail = recommendationThumbnail(item);
											return (
												<div
													className={optionClass(row.index, "h-12")}
													key={`recommendation-${item.kind}-${
														item.kind === "song"
															? item.song.id
															: item.kind === "navigation"
																? item.label
																: item.id
													}`}
													{...optionProps(row)}
												>
													{thumbnail ? (
														<img
															alt=""
															className={cn(
																"size-9 shrink-0 border border-foreground/8 object-cover",
																item.kind === "artist"
																	? "rounded-full"
																	: "rounded-md",
															)}
															loading="lazy"
															src={proxiedImageUrl(thumbnail)}
														/>
													) : (
														<div
															className={cn(
																"size-9 shrink-0 bg-muted",
																item.kind === "artist"
																	? "rounded-full"
																	: "rounded-md",
															)}
														/>
													)}
													<div className="min-w-0 flex-1">
														<p className="truncate text-sm font-medium text-foreground">
															{title}
														</p>
														<p className="truncate text-xs text-muted-foreground">
															{recommendationSubtitle(item)}
														</p>
													</div>
													{item.kind === "song" ? (
														<Play className="size-3.5 shrink-0 fill-current opacity-60" />
													) : item.kind === "album" ? (
														<Disc3 className="size-4 shrink-0 opacity-60" />
													) : item.kind === "playlist" ? (
														<ListMusic className="size-4 shrink-0 opacity-60" />
													) : (
														<ArrowUpRight className="size-4 shrink-0 opacity-60" />
													)}
												</div>
											);
										})
									) : (
										<p className="px-2 py-2 text-xs text-muted-foreground/70">
											Log in to get personalised picks.
										</p>
									)}
								</div>
							</>
						)}
					</div>
				)}
			</div>
		</form>
	);
}
