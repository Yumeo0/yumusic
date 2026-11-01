import { expect, test } from "bun:test";
import { YTNodes } from "youtubei.js/web";
import {
	channelCardShelves,
	channelProfileThumbnail,
	channelSearchEntries,
	channelVideos,
} from "./channel-data";

const id = "UCy0tKL1T7wFoYcxCe0xjN6Q";

test("profile avatars use the foreground thumbnail rather than the wide banner", () => {
	const header = new YTNodes.MusicVisualHeader({
		title: { simpleText: "Listener" },
		thumbnail: {
			musicThumbnailRenderer: {
				thumbnail: {
					thumbnails: [
						{
							url: "https://yt3.googleusercontent.com/banner",
							width: 2560,
							height: 1066,
						},
					],
				},
			},
		},
		foregroundThumbnail: {
			musicThumbnailRenderer: {
				thumbnail: {
					thumbnails: [
						{
							url: "https://yt3.googleusercontent.com/avatar",
							width: 544,
							height: 544,
						},
					],
				},
			},
		},
	});
	expect(channelProfileThumbnail(header)).toContain("/avatar");
	header.foreground_thumbnail = [];
	expect(channelProfileThumbnail(header)).toBeNull();
});

test("public Personal mix cards remain browsable even though artist.sections omits them", () => {
	const playlist = "VLRDATjuUCexample";
	const card = new YTNodes.MusicCardShelf({
		header: {
			musicCardShelfHeaderBasicRenderer: {
				title: { simpleText: "Personal mix" },
			},
		},
		title: { simpleText: "Listener's Mix" },
		subtitle: { simpleText: "Made for sharing" },
		onTap: { browseEndpoint: { browseId: playlist } },
		thumbnail: {
			musicThumbnailRenderer: {
				thumbnail: {
					thumbnails: [
						{
							url: "https://music.youtube.com/image/radioart?r=example",
							width: 1000,
							height: 1000,
						},
					],
				},
			},
		},
	});
	expect(channelCardShelves([card])).toEqual([
		{
			title: "Personal mix",
			items: [
				{
					title: "Listener's Mix",
					subtitle: "Made for sharing",
					thumbnail: "https://music.youtube.com/image/radioart?r=example",
					link: `/playlists/${playlist}`,
				},
			],
		},
	]);
	card.on_tap.payload.browseId = id;
	expect(channelCardShelves([card])).toEqual([]);
});
test("normal channels remain browsable without any YouTube Music artist page", () => {
	const channel = new YTNodes.Channel({
		channelId: id,
		title: { simpleText: "Technology Connections" },
		navigationEndpoint: { browseEndpoint: { browseId: id } },
		thumbnail: {
			thumbnails: [
				{
					url: "https://yt3.googleusercontent.com/example",
					width: 88,
					height: 88,
				},
			],
		},
	});
	const rows = channelSearchEntries([channel, channel]);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		id,
		name: "Technology Connections",
		kind: "artist",
	});
	expect(rows[0].subtitle).toContain("Channel");
});

test("current YouTube channel video lockups become playable songs with channel links", () => {
	const video = new YTNodes.LockupView({
		contentId: "abcdefghijk",
		contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
		metadata: {
			lockupMetadataViewModel: {
				title: { content: "Ordinary YouTube upload" },
			},
		},
		contentImage: {
			thumbnailViewModel: {
				image: {
					sources: [
						{
							url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
							width: 480,
							height: 360,
						},
					],
				},
			},
		},
	});
	const playlist = new YTNodes.LockupView({
		contentId: "PLexample",
		contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
	});
	const songs = channelVideos(
		[video, playlist, video],
		"Technology Connections",
		id,
	);
	expect(songs).toHaveLength(1);
	expect(songs[0]).toMatchObject({
		id: "abcdefghijk",
		title: "Ordinary YouTube upload",
		artistId: id,
		upload: true,
	});
});
