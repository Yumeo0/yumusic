import { ContextMenu } from "@base-ui/react/context-menu";
import { ArrowUpRight, AudioLines, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayer } from "@/contexts/player-context";
import { preventSwipeContextMenu } from "@/lib/motion/swipe-context-menu";
import { shareLink } from "@/lib/services/share";
import { showToast } from "@/lib/stores/toast";
import { getArtistMixSongs } from "@/lib/youtube/youtube-client";

export function ArtistContextMenu({
	artist,
	children,
}: {
	artist: { id: string; name: string };
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const { playQueue } = usePlayer();
	const item =
		"flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none data-highlighted:bg-foreground/8";
	const mix = async () => {
		try {
			const songs = await getArtistMixSongs(artist.id);
			if (songs.length) playQueue(songs, 0);
			else showToast("No mix is available for this channel.");
		} catch {
			showToast("Could not start this channel's mix.");
		}
	};
	return (
		<ContextMenu.Root onOpenChange={preventSwipeContextMenu}>
			<ContextMenu.Trigger className="context-menu-highlight contents">
				{children}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-100" sideOffset={4}>
					<ContextMenu.Popup className="min-w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none">
						<ContextMenu.Group>
							<ContextMenu.Item
								className={item}
								onClick={() => navigate(`/artist/${artist.id}`)}
							>
								<ArrowUpRight className="size-4 text-muted-foreground" />
								Open channel
							</ContextMenu.Item>
							<ContextMenu.Item className={item} onClick={() => void mix()}>
								<AudioLines className="size-4 text-muted-foreground" />
								Start mix
							</ContextMenu.Item>
							<ContextMenu.Item
								className={item}
								onClick={() =>
									void shareLink({
										title: artist.name,
										url: `https://www.youtube.com/channel/${artist.id}`,
									})
								}
							>
								<Share2 className="size-4 text-muted-foreground" />
								Share channel
							</ContextMenu.Item>
						</ContextMenu.Group>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
