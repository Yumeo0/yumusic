import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SearchResults from "../components/search-results";

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
		<div className="container mx-auto p-6 flex flex-col min-h-full">
			<div className="w-full max-w-3xl mx-auto mb-8">
				<form className="w-full" onSubmit={handleSearch}>
					<div className="flex gap-3 items-center">
						<Input
							className="h-14 text-lg px-6"
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search for music videos..."
							type="text"
							value={searchQuery}
						/>
						<Button className="h-14 px-8" size="lg" type="submit">
							Search
						</Button>
					</div>
				</form>
			</div>

			{query && (
				<div className="w-full">
					<SearchResults query={query} />
				</div>
			)}
		</div>
	);
}
