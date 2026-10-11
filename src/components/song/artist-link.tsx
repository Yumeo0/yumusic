import { Fragment } from "react";
import { useNavigate } from "react-router-dom";
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
	className?: string;
}

/**
 * Clickable artist name that opens the artist page (closing the fullscreen
 * lyrics view). Renders as plain text when no channel id is known.
 * Anchor-based so it can live inside other buttons without invalid nesting
 * (navigation goes through the hash router).
 */
export function ArtistLink({ id, name, className }: ArtistLinkProps) {
	const navigate = useNavigate();
	const displayName = formatArtistName(name);

	if (!id) {
		return <span className={className}>{displayName}</span>;
	}

	return (
		<a
			className={cn(
				"cursor-pointer underline-offset-2 transition-colors hover:text-foreground hover:underline",
				className,
			)}
			href={`#/artist/${id}`}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				closeNowPlaying();
				navigate(`/artist/${id}`);
			}}
		>
			{displayName}
		</a>
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
export function ArtistLinks({
	song,
	className,
}: {
	song: Song;
	className?: string;
}) {
	const formatTitle = useFormatTitle();
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

	return (
		<>
			{artists.map((a, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: artists may repeat names
					key={`${a.id ?? "na"}-${a.name}-${i}`}
				>
					<ArtistLink className={className} id={a.id} name={a.name} />
					{i < artists.length - 1 ? ", " : ""}
				</span>
			))}
			{extras.length > 0 && (
				<span className="text-muted-foreground/70">
					{artists.length > 0 ? " " : ""}
					feat.{" "}
					{extras.map((feat, index) => (
						<Fragment
							// biome-ignore lint/suspicious/noArrayIndexKey: featured names may repeat
							key={`${feat}-${index}`}
						>
							{index === 0 ? "" : index === extras.length - 1 ? " & " : ", "}
							<ArtistLink id={creditId(feat)} name={feat} />
						</Fragment>
					))}
				</span>
			)}
		</>
	);
}
