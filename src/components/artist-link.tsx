import { useNavigate } from "react-router-dom";
import type { Song } from "@/contexts/player-context";
import { useArtistName } from "@/lib/artist-names";
import { closeNowPlaying } from "@/lib/player-ui";
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

/** Artist name that upgrades to the original-language form in that mode. */
function ResolvedArtistLink({
	id,
	name,
	className,
}: {
	id?: string;
	name: string;
	className?: string;
}) {
	const displayName = useArtistName(name, id);
	return <ArtistLink className={className} id={id} name={displayName} />;
}

/** Renders every artist of a song as its own clickable link. */
export function ArtistLinks({
	song,
	className,
}: {
	song: Song;
	className?: string;
}) {
	const list = (song.artists ?? []).filter((a) => a.name);

	if (list.length === 0) {
		return (
			<ResolvedArtistLink
				className={className}
				id={song.artistId}
				name={song.artist}
			/>
		);
	}

	return (
		<>
			{list.map((a, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: artists may repeat names
					key={`${a.id ?? "na"}-${a.name}-${i}`}
				>
					<ResolvedArtistLink className={className} id={a.id} name={a.name} />
					{i < list.length - 1 ? ", " : ""}
				</span>
			))}
		</>
	);
}
