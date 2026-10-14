import { Search } from "@lucide/solid";
import { useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { HomeFeed } from "@/components/home/home-feed";
import { cn } from "@/lib/utils/utils";
import SearchResults from "../components/search/search-results";

export default function HomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const query = () => {
		const q = searchParams.q;
		return typeof q === "string" ? q : "";
	};
	// Snapshot the initial query untracked; the effect below keeps it in sync.
	const [searchQuery, setSearchQuery] = createSignal(untrack(query));

	createEffect(
		() => query(),
		(q) => {
			setSearchQuery(q);
		},
	);

	const handleSearch = (event: SubmitEvent) => {
		event.preventDefault();
		if (searchQuery().trim()) {
			setSearchParams({ q: searchQuery() });
		}
	};

	return (
		<div
			class={cn(
				"mx-auto flex w-full flex-col px-6 pt-6 sm:px-8 sm:pt-10",
				query() ? "max-w-3xl" : "max-w-5xl",
			)}
		>
			{/* Search */}
			<form onSubmit={handleSearch}>
				<div class="group relative flex items-center">
					<Search class="pointer-events-none absolute left-4.5 size-5 text-muted-foreground transition-colors group-focus-within:text-foreground" />
					<input
						class="h-13 w-full rounded-xl border border-foreground/12 bg-foreground/4 pr-4 pl-12 text-base outline-none transition-colors duration-200 placeholder:text-muted-foreground/70 focus:border-primary/50 focus:bg-foreground/6"
						onInput={(event) => {
							setSearchQuery(event.target.value);
						}}
						placeholder="Search songs, artists, videos…"
						type="text"
						value={searchQuery()}
					/>
				</div>
			</form>

			<Show keyed when={query() || undefined}>
				{(q) => (
					<div class="mt-10">
						<SearchResults query={q} />
					</div>
				)}
			</Show>

			<Show when={query() === ""}>
				<div class="mt-14 pb-4">
					<HomeFeed />
				</div>
			</Show>
		</div>
	);
}
