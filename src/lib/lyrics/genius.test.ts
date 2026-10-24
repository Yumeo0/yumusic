import { afterEach, describe, expect, test } from "bun:test";
import { fetchGeniusLyrics, parseGeniusLyrics } from "./genius";

const PAGE =
	'<div data-lyrics-container="true">First line<br>Second line</div>';
const SONG = {
	id: 14474384,
	title: "1% Battery Girl",
	url: "https://genius.com/Z-san-z-and-hoyo-mix-1-battery-girl-lyrics",
	lyrics_state: "complete",
	primary_artist_names: "三Z (Sān-Z) & HOYO-MiX",
	primary_artists: [{ name: "三Z (Sān-Z)" }, { name: "HOYO-MiX" }],
};

function searchResponse(songs: unknown[]): Response {
	return Response.json({
		response: {
			sections: [
				{
					type: "song",
					hits: songs.map((result) => ({ type: "song", result })),
				},
				{
					type: "artist",
					hits: [{ type: "artist", result: { name: "Not a song" } }],
				},
			],
		},
	});
}

describe("parseGeniusLyrics", () => {
	test("joins lyric sections and keeps line breaks, verses, and annotation text", async () => {
		expect(
			await parseGeniusLyrics(`
			<h1>Page title</h1><div>Unrelated description</div>
			<div data-lyrics-container="true"><div data-exclude-from-selection="true">
				<button>Contributors</button><h2>Song Lyrics</h2></div>
				[Verse 1]<br>One &amp; <a href="/annotations/1"><span>two</span></a><br><br>Three
				<script>window.bad = true</script><span aria-hidden="true">Ad</span>
			</div><div>Advertisement</div><div data-lyrics-container="true"></div>
			<div data-lyrics-container="true">[Chorus]<br>四 &#x4e94; &#39;six&#39;&nbsp;seven</div>
		`),
		).toBe("[Verse 1]\nOne & two\n\nThree\n\n[Chorus]\n四 五 'six' seven");
	});
	test("handles nested blocks and legacy pages without surrounding metadata", async () => {
		expect(
			await parseGeniusLyrics(
				'<div class="lyrics"><p>One<br>Two</p><p>Three</p></div><footer>Embed</footer>',
			),
		).toBe("One\nTwo\n\nThree");
	});
	test("a challenge page or an empty lyrics container has no lyrics", async () => {
		expect(
			await parseGeniusLyrics("<h1>Please verify you are human</h1>"),
		).toBeNull();
		expect(
			await parseGeniusLyrics(
				'<div data-lyrics-container="true"><button>Share</button></div>',
			),
		).toBeNull();
	});
});

describe("fetchGeniusLyrics", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("encodes percent signs and returns the artist-matched song's plain lyrics", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			urls.push(url);
			return url.includes("/api/search/")
				? searchResponse([SONG])
				: new Response(PAGE);
		}) as typeof fetch;
		expect(
			await fetchGeniusLyrics("1% Battery Girl", "HOYO-MiX - Topic"),
		).toEqual({
			synced: null,
			plain: "First line\nSecond line",
			confirmed: true,
		});
		expect(urls).toHaveLength(2);
		expect(new URL(urls[0]).searchParams.get("q")).toBe(
			"1% Battery Girl HOYO-MiX",
		);
		expect(new URL(urls[0]).searchParams.get("per_page")).toBe("5");
		expect(urls[1]).toBe(SONG.url);
	});

	test("prefers the matching artist over a same-title song by another artist", async () => {
		let fetched = "";
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/api/search/"))
				return searchResponse([
					{
						...SONG,
						url: "https://genius.com/Other-artist-lyrics",
						primary_artists: [],
						primary_artist_names: "Other Artist",
					},
					SONG,
				]);
			fetched = url;
			return new Response(PAGE);
		}) as typeof fetch;
		expect((await fetchGeniusLyrics(SONG.title, "HOYO-MiX"))?.confirmed).toBe(
			true,
		);
		expect(fetched).toBe(SONG.url);
	});

	test("ignores unrelated titles, instrumental hits, hidden pages, and external URLs", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			urls.push(String(input));
			return searchResponse([
				{ ...SONG, title: "Different Song" },
				{ ...SONG, instrumental: true },
				{ ...SONG, hidden: true },
				{ ...SONG, url: "https://example.com/song-lyrics" },
			]);
		}) as typeof fetch;
		expect(await fetchGeniusLyrics(SONG.title, "HOYO-MiX")).toBeNull();
		expect(urls.every((url) => url.includes("/api/search/"))).toBe(true);
	});

	test("falls back to title search and marks an unverified artist as a loose match", async () => {
		const queries: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			const url = new URL(String(input));
			if (url.pathname.includes("/api/search/")) {
				const query = url.searchParams.get("q") ?? "";
				queries.push(query);
				return searchResponse(query === SONG.title ? [SONG] : []);
			}
			return new Response(PAGE);
		}) as typeof fetch;
		expect(
			(await fetchGeniusLyrics(SONG.title, "Cover Singer"))?.confirmed,
		).toBe(false);
		expect(queries).toEqual([
			"1% Battery Girl Cover Singer",
			"1% Battery Girl",
		]);
	});

	test("skips unavailable lyrics and deduplicates repeated song hits", async () => {
		const pages: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/api/search/"))
				return searchResponse([
					SONG,
					SONG,
					{ ...SONG, url: "https://genius.com/Second-version-lyrics" },
				]);
			pages.push(url);
			return url === SONG.url
				? new Response("", { status: 403 })
				: new Response(PAGE);
		}) as typeof fetch;
		expect((await fetchGeniusLyrics(SONG.title, "HOYO-MiX"))?.plain).toBe(
			"First line\nSecond line",
		);
		expect(pages).toEqual([
			SONG.url,
			"https://genius.com/Second-version-lyrics",
		]);
	});

	test("empty titles and failed requests settle without breaking other providers", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await fetchGeniusLyrics("", "Artist")).toBeNull();
		expect(requests).toBe(0);
		expect(await fetchGeniusLyrics(SONG.title, "HOYO-MiX")).toBeNull();
		expect(requests).toBe(1);
	});
});
