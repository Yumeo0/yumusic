import { createMemo, For, Show } from "solid-js";
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
export function SongTitle(props: {
	title: string;
	artist?: string;
	/** Uploader video: show the raw title without dual-language parsing. */
	keepTitle?: boolean;
}) {
	const formatTitle = useFormatTitle();
	const formatted = createMemo(() =>
		formatTitle(props.title, props.artist, props.keepTitle),
	);
	const remix = createMemo(() =>
		joinArtists(remixAuthors(formatted().credits)),
	);
	const pills = createMemo(() => {
		const generic = detectTitleTags(props.title).filter(
			(tag) =>
				!formatted().credits.some((credit) => credit.tag === tag) &&
				!GENERIC_TAG_PATTERNS[tag]?.test(formatted().main),
		);
		return (
			[...formatted().credits.map((credit) => credit.tag), ...generic]
				.filter((tag) => tag !== "remix")
				// Pair each pill with its index so repeated tags stay distinct rows.
				.map((tag, index) => ({ index, tag }))
		);
	});

	return (
		<Show fallback={formatted().main} when={pills().length > 0 || remix()}>
			{formatted().main}
			<Show when={remix()}>
				<span class="text-muted-foreground"> {remix()} remix</span>
			</Show>
			<Show when={pills().length > 0}> </Show>
			<For each={pills()} keyed={(pill) => pill.index}>
				{(pill) => {
					const credit = () =>
						formatted().credits.find((entry) => entry.tag === pill().tag);
					return (
						<span class="mr-0.5 inline-block rounded border border-foreground/15 px-1 align-middle font-mono text-[9px] leading-3.5 tracking-wider text-muted-foreground uppercase">
							{TAG_LABELS[pill().tag]}
							{credit()?.author && ` · ${credit()?.author}`}
						</span>
					);
				}}
			</For>
		</Show>
	);
}
