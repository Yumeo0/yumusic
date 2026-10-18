import { useSearchParams } from "react-router-dom";
import { HomeFeed } from "@/components/home/home-feed";
import { SearchBar } from "@/components/search/search-bar";
import { cn } from "@/lib/utils/utils";
import SearchResults from "../components/search/search-results";

export default function HomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const query = searchParams.get("q") || "";

	const handleSearch = (next: string) => {
		const cleaned = next.trim();
		if (cleaned) {
			setSearchParams({ q: cleaned });
		} else {
			setSearchParams({});
		}
	};

	return (
		<div
			className={cn(
				"mx-auto flex w-full flex-col px-6 pt-6 sm:px-8 sm:pt-10",
				query ? "max-w-3xl" : "max-w-5xl",
			)}
		>
			<SearchBar onSearch={handleSearch} query={query} />

			{query && (
				<div className="mt-10">
					<SearchResults key={query} query={query} />
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
