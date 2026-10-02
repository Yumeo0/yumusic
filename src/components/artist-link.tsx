import { useNavigate } from "react-router-dom";
import type { Song } from "@/contexts/player-context";
import { closeNowPlaying } from "@/lib/player-ui";
import { joinArtists, useFormatTitle } from "@/lib/title";
import { cn } from "@/lib/utils";

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

	if (!id) {
		return <span className={className}>{name}</span>;
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
			{name}
		</a>
	);
}

/** Folds a name for duplicate comparison: lowercase, trimmed. */
function foldName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Renders every artist of a song as its own clickable link, followed by the
 * "feat. …" credit parsed from the title. Featured names already present in
 * the artist list are skipped so the row never repeats a name.
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
	const { feats } = formatTitle(song.title, song.artist);
	const known = new Set<string>();
	for (const name of list.length > 0
		? list.map((a) => a.name)
		: [song.artist]) {
		known.add(foldName(name));
		for (const part of name.split(/[,，&]/)) known.add(foldName(part));
	}
	const extras = feats.filter((feat) => !known.has(foldName(feat)));

	return (
		<>
			{list.length === 0 ? (
				<ArtistLink
					className={className}
					id={song.artistId}
					name={song.artist}
				/>
			) : (
				list.map((a, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: artists may repeat names
						key={`${a.id ?? "na"}-${a.name}-${i}`}
					>
						<ArtistLink className={className} id={a.id} name={a.name} />
						{i < list.length - 1 ? ", " : ""}
					</span>
				))
			)}
			{extras.length > 0 && (
				<span className="text-muted-foreground/70">
					{list.length > 0 ? " " : ""}
					feat. {joinArtists(extras)}
				</span>
			)}
		</>
	);
}
