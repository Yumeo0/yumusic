import {
	detectTitleTags,
	joinArtists,
	remixAuthors,
	type TitleTag,
	useFormatTitle,
} from "@/lib/utils/title";

const GENERIC_TAG_PATTERNS: Record<string, RegExp> = {
	cover: /\bcover(?:ed|s)?\b|[歌弾踊叩]ってみた/i,
	remix: /\bremix(?:es|ed)?\b|\brmx\b|\bbootleg\b/i,
};

const TAG_LABELS: Record<TitleTag, string> = {
	cover: "Cover",
	remix: "Remix",
	edit: "Edit",
};

/**
 * Song title with the "feat. A, B & C" tail split off (it is rendered in the
 * artist row by <ArtistLinks>) and the remixer as a muted "X remix" tail
 * after the title — a remix never gets a pill of its own. Pills remain for
 * covers and edits, showing their author when the credit carries one;
 * generic keyword pills only appear when the cleanup removed the marker from
 * the title itself, so "… (Cover Version)" shows a Cover pill.
 */
export function SongTitle({
	title,
	artist,
}: {
	title: string;
	artist?: string;
}) {
	const formatTitle = useFormatTitle();
	const { main, credits } = formatTitle(title, artist);
	const remix = joinArtists(remixAuthors(credits));
	const generic = detectTitleTags(title).filter(
		(tag) =>
			!credits.some((credit) => credit.tag === tag) &&
			!GENERIC_TAG_PATTERNS[tag]?.test(main),
	);
	const pills: TitleTag[] = [
		...credits.map((credit) => credit.tag),
		...generic,
	].filter((tag) => tag !== "remix");
	if (pills.length === 0 && !remix) return <>{main}</>;
	return (
		<>
			{main}
			{remix && <span className="text-muted-foreground"> {remix} remix</span>}
			{pills.length > 0 && " "}
			{pills.map((pill, i) => (
				<span
					className="mr-0.5 inline-block rounded border border-foreground/15 px-1 align-middle font-mono text-[9px] leading-3.5 tracking-wider text-muted-foreground uppercase"
					// biome-ignore lint/suspicious/noArrayIndexKey: pill tags may repeat
					key={`${pill}-${i}`}
				>
					{TAG_LABELS[pill]}
					{credits.find((credit) => credit.tag === pill)?.author &&
						` · ${credits.find((credit) => credit.tag === pill)?.author}`}
				</span>
			))}
		</>
	);
}
