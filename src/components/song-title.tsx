import { detectTitleTags, type TitleTag, useFormatTitle } from "@/lib/title";

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
 * artist row by <ArtistLinks>), plus small pills for covers, remixes and
 * edits. Author-carrying credits ("(Pat B remix)", "[TOZA Edit]", "(cover
 * by …)") are pulled out of the title into their pill; generic keyword pills
 * only appear when the cleanup removed the marker from the title itself, so
 * "flos (Remix ver.)" isn't tagged while "… (Cover Version)" shows a Cover
 * pill.
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
	const generic = detectTitleTags(title).filter(
		(tag) =>
			!credits.some((credit) => credit.tag === tag) &&
			!GENERIC_TAG_PATTERNS[tag]?.test(main),
	);
	const pills: TitleTag[] = [
		...credits.map((credit) => credit.tag),
		...generic,
	];
	if (pills.length === 0) return <>{main}</>;
	return (
		<>
			{main}{" "}
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
