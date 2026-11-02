import { useNavigate } from "react-router-dom";
import { closeNowPlaying } from "@/lib/player/player-ui";

/** YouTube Music uses the same release metadata for albums and singles. */
export function AlbumLink({
	album,
	interactive = true,
}: {
	album: { name: string; id?: string };
	interactive?: boolean;
}) {
	const navigate = useNavigate();
	if (!album.id || !interactive)
		return <span title={album.name}>{album.name}</span>;
	return (
		<a
			className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
			href={`#/playlists/${album.id}`}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				closeNowPlaying();
				navigate(`/playlists/${album.id}`);
			}}
			title={album.name}
		>
			{album.name}
		</a>
	);
}
