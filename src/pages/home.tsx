import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HomeFeed } from "@/components/home/home-feed";
import { cn } from "@/lib/utils/utils";
import SearchResults from "../components/search/search-results";

export default function HomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const query = searchParams.get("q") || "";
	const [searchQuery, setSearchQuery] = useState(query);

	useEffect(() => {
		setSearchQuery(query);
	}, [query]);

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		if (searchQuery.trim()) {
			setSearchParams({ q: searchQuery });
		}
	};

	return (
		<div
			className={cn(
				"mx-auto flex w-full flex-col px-6 pt-6 sm:px-8 sm:pt-10",
				query ? "max-w-3xl" : "max-w-5xl",
			)}
		>
			{/* Search */}
			<form onSubmit={handleSearch}>
				<div className="group relative flex items-center">
					<Search className="pointer-events-none absolute left-4.5 size-5 text-muted-foreground transition-colors group-focus-within:text-foreground" />
					<input
						className="h-13 w-full rounded-xl border border-foreground/12 bg-foreground/4 pr-4 pl-12 text-base outline-none transition-colors duration-200 placeholder:text-muted-foreground/70 focus:border-primary/50 focus:bg-foreground/6"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search songs, artists, videos…"
						type="text"
						value={searchQuery}
					/>
				</div>
			</form>

			{query && (
				<div className="mt-10">
					<SearchResults query={query} />
				</div>
			)}

			{!query && (
				<div className="mt-14 pb-4">
					<HomeFeed />
				</div>
			)}
		</div>
	);
}
