import { extractVideoId } from "./youtube.utils";

export type YouTubeLink = {
	kind: "video" | "channel" | "collection" | "route";
	url: string;
	id?: string;
	route?: string;
};
const entityId = (id: string | null | undefined) =>
	!!id && /^[A-Za-z0-9_-]{1,200}$/.test(id);

function parseLink(text: string): YouTubeLink | null {
	if (/\s|[<>"']/.test(text)) return null;
	try {
		const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return null;
		const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
		if (!["youtube.com", "music.youtube.com", "youtu.be"].includes(host))
			return null;
		const video = extractVideoId(url.href);
		if (video) return { kind: "video", id: video, url: url.href };
		if (host === "youtu.be") return null;
		const [path, id] = url.pathname.split("/").filter(Boolean);
		if (host === "music.youtube.com") {
			if (!path || ["home", "explore"].includes(path))
				return { kind: "route", url: url.href, route: "/" };
			if (path === "library")
				return { kind: "route", url: url.href, route: "/playlists" };
			if (path === "search") {
				const query =
					url.searchParams.get("q") ?? url.searchParams.get("search_query");
				return {
					kind: "route",
					url: url.href,
					route: query ? `/?q=${encodeURIComponent(query)}` : "/",
				};
			}
		}
		if (path === "podcast" && entityId(id))
			return { kind: "collection", id, url: url.href };
		if (
			["playlist", "watch"].includes(path) &&
			entityId(url.searchParams.get("list"))
		)
			return {
				kind: "collection",
				id: url.searchParams.get("list") as string,
				url: url.href,
			};
		if (path === "browse" && entityId(id)) {
			if (id === "FEmusic_home" || id === "FEmusic_explore")
				return { kind: "route", url: url.href, route: "/" };
			if (id === "FEmusic_library_landing")
				return { kind: "route", url: url.href, route: "/playlists" };
			if (id.startsWith("UC")) return { kind: "channel", id, url: url.href };
			if (/^(?:MPR|VL|FEmusic_library_privately_owned_release)/.test(id))
				return { kind: "collection", id, url: url.href };
		}
		if (path === "channel" && id?.startsWith("UC") && entityId(id))
			return { kind: "channel", id, url: url.href };
		if (
			(path?.startsWith("@") && path.length > 1) ||
			(["c", "user"].includes(path) && id)
		)
			return { kind: "channel", url: url.href };
	} catch {
		/* Not a supported share URL. */
	}
	return null;
}

export function findYouTubeLink(text: string): YouTubeLink | null {
	const direct = parseLink(text.trim());
	if (direct) return direct;
	for (const url of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
		const link = parseLink(url.replace(/[),.;!?]+$/, ""));
		if (link) return link;
	}
	return null;
}

export async function youTubeLinkRoute(
	link: YouTubeLink,
	resolve: (url: string) => Promise<{ payload?: { browseId?: string } }>,
): Promise<string> {
	if (link.kind === "video")
		throw new Error("Video links use the song preview.");
	if (link.kind === "route" && link.route) return link.route;
	const id = link.id ?? (await resolve(link.url)).payload?.browseId;
	if (!entityId(id)) throw new Error("Could not resolve this YouTube link.");
	if (link.kind === "channel" && id?.startsWith("UC"))
		return `/artist/${encodeURIComponent(id)}`;
	if (link.kind === "collection")
		return `/playlists/${encodeURIComponent(id as string)}`;
	throw new Error("This link does not refer to a supported YouTube channel.");
}
