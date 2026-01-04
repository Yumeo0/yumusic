import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface HomePageProps {
	onSearch: (query: string) => void;
}

export default function HomePage({ onSearch }: HomePageProps) {
	const [searchQuery, setSearchQuery] = useState("");

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		if (searchQuery.trim()) {
			onSearch(searchQuery);
			setSearchQuery("");
		}
	};

	return (
		<div className="container mx-auto p-6 flex flex-col items-center justify-center min-h-screen">
			<div className="w-full max-w-3xl">
				<h1 className="text-5xl font-bold mb-4 text-center">YuMusic</h1>
				<p className="text-lg text-center mb-12 text-muted-foreground">
					Search and extract metadata from YouTube videos
				</p>

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
		</div>
	);
}
