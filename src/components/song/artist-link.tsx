import { useNavigate } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import type { Song } from "@/contexts/player-context";
import { closeNowPlaying } from "@/lib/player/player-ui";
import {
	formatArtistName,
	mergeArtistNames,
	useFormatTitle,
} from "@/lib/utils/title";
import { cn } from "@/lib/utils/utils";

interface ArtistLinkProps {
	id?: string;
	name: string;
	class?: string;
}

/**
 * Clickable artist name that opens the artist page (closing the fullscreen
 * lyrics view). Renders as plain text when no channel id is known.
 * Anchor-based so it can live inside other buttons without invalid nesting
 * (navigation goes through the hash router).
 */
export function ArtistLink(props: ArtistLinkProps) {
	const navigate = useNavigate();
	const displayName = () => formatArtistName(props.name);

	return (
		<Show
			fallback={<span class={props.class}>{displayName()}</span>}
			when={props.id}
		>
			{(id) => (
				<a
					class={cn(
						"cursor-pointer underline-offset-2 transition-colors hover:text-foreground hover:underline",
						props.class,
					)}
					href={`#/artist/${id()}`}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						closeNowPlaying();
						navigate(`/artist/${id()}`);
					}}
				>
					{displayName()}
				</a>
			)}
		</Show>
	);
}

/** Folds a name for duplicate comparison: lowercase, trimmed. */
function foldName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Renders every artist of a song as its own clickable link, followed by the
 * "feat. …" credit parsed from the title and the cover performers parsed from
 * a cover credit ("… /Cover A/B"). Featured names already present in the
 * artist list are skipped so the row never repeats a name.
 */
export function ArtistLinks(props: { song: Song; class?: string }) {
	const formatTitle = useFormatTitle();

	const model = createMemo(() => {
		const song = props.song;
		const list = (song.artists ?? []).filter((a) => a.name);
		const { feats, coverArtists } = formatTitle(song.title, song.artist);
		const primaries =
			list.length > 0 ? list : [{ name: song.artist, id: song.artistId }];
		// Cover performers lack channel ids, so they render as plain names after
		// the song's own artists. Cross-script duplicates ("Minato Aqua" /
		// "湊あくあ") merge to the original-script name; placeholder credits
		// ("Unknown Artist") step aside when there are real names to show.
		const covers = coverArtists.filter((name) => name.trim() !== "");
		const isPlaceholder = (name: string) =>
			name.trim() === "" || /^unknown artist$/i.test(name.trim());
		const merged = mergeArtistNames(primaries, covers);
		const hasRealPrimary = primaries.some((a) => !isPlaceholder(a.name));
		const artists = hasRealPrimary
			? merged
			: merged.filter((a) => !isPlaceholder(a.name));
		if (artists.length === 0) artists.push({ name: "Unknown Artist" });
		const known = new Set<string>();
		for (const artist of artists) {
			known.add(foldName(artist.name));
			for (const part of artist.name.split(/[,，&]/)) known.add(foldName(part));
		}
		const extras = feats.filter((feat) => !known.has(foldName(feat)));
		/** Channel id recorded for a credited name, when the description linked one. */
		const creditId = (name: string): string | undefined => {
			const wanted = foldName(formatArtistName(name));
			return song.creditIds?.find(
				(credit) => foldName(formatArtistName(credit.name)) === wanted,
			)?.id;
		};
		return {
			// Key each row stably: the arrays are rebuilt whenever the song
			// object changes, and keying by identity would rebuild the DOM.
			artists: artists.map((artist, index) => ({
				...artist,
				key: `${artist.id ?? artist.name}#${index}`,
			})),
			creditId,
			extras: extras.map((name, index) => ({ key: `${name}#${index}`, name })),
		};
	});

	return (
		<>
			<For each={model().artists} keyed={(artist) => artist.key}>
				{(artist, index) => (
					<span>
						<ArtistLink
							class={props.class}
							id={artist().id}
							name={artist().name}
						/>
						{index() < model().artists.length - 1 ? ", " : ""}
					</span>
				)}
			</For>
			<Show when={model().extras.length > 0}>
				<span class="text-muted-foreground/70">
					{model().artists.length > 0 ? " " : ""}
					feat.{" "}
					<For each={model().extras} keyed={(extra) => extra.key}>
						{(extra, index) => (
							<>
								{index() === 0
									? ""
									: index() === model().extras.length - 1
										? " & "
										: ", "}
								<ArtistLink
									id={model().creditId(extra().name)}
									name={extra().name}
								/>
							</>
						)}
					</For>
				</span>
			</Show>
		</>
	);
}
