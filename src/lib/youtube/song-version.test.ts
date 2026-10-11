import { describe, expect, test } from "bun:test";
import { applySongVersion, songVersionEntryFromQueue } from "./song-version";

const OMV = "MUSIC_VIDEO_TYPE_OMV";
const ATV = "MUSIC_VIDEO_TYPE_ATV";

/** A queue entry with its music video type, as the Up Next queue reports it. */
function entry(videoId: string, type?: string) {
	return {
		video_id: videoId,
		endpoint: {
			payload: {
				watchEndpointMusicSupportedConfigs: {
					watchEndpointMusicConfig: type ? { musicVideoType: type } : {},
				},
			},
		},
	};
}

describe("songVersionEntryFromQueue", () => {
	test("a music video switches to its album-track counterpart", () => {
		expect(
			songVersionEntryFromQueue(
				[{ primary: entry("MV", OMV), counterpart: [entry("ATV", ATV)] }],
				"MV",
			)?.video_id,
		).toBe("ATV");
	});

	test("an album track never switches to its video counterpart", () => {
		expect(
			songVersionEntryFromQueue(
				[{ primary: entry("ATV", ATV), counterpart: [entry("MV", OMV)] }],
				"ATV",
			),
		).toBeNull();
	});

	test("the album track is found among several counterparts", () => {
		expect(
			songVersionEntryFromQueue(
				[
					{
						primary: entry("MV", OMV),
						counterpart: [
							entry("Live", "MUSIC_VIDEO_TYPE_UGC"),
							entry("ATV", ATV),
						],
					},
				],
				"MV",
			)?.video_id,
		).toBe("ATV");
	});

	test("wrappers of other queue entries are ignored", () => {
		expect(
			songVersionEntryFromQueue(
				[
					{
						primary: entry("Other", OMV),
						counterpart: [entry("OtherSong", ATV)],
					},
				],
				"MV",
			),
		).toBeNull();
	});

	test("unknown or missing music video types keep the original", () => {
		expect(
			songVersionEntryFromQueue(
				[{ primary: entry("MV"), counterpart: [entry("Other")] }],
				"MV",
			),
		).toBeNull();
		expect(
			songVersionEntryFromQueue(
				[
					{
						primary: entry("MV", OMV),
						counterpart: [entry("Lyric", "MUSIC_VIDEO_TYPE_UGC")],
					},
				],
				"MV",
			),
		).toBeNull();
	});
});

describe("applySongVersion", () => {
	test("the track adopts the album track's listing", () => {
		const song = {
			id: "MV",
			title: "MV title",
			artist: "MV artist",
			artistId: "uc-mv",
			artists: [{ name: "MV artist", id: "uc-mv" }],
			thumbnail: "mv.jpg",
			duration: "3:20",
			description: "uploader credits",
			upload: true,
		};
		expect(
			applySongVersion(song, {
				id: "ATV",
				title: "Song title",
				artists: [{ name: "Song artist", id: "uc-atv" }],
				duration: "3:15",
				thumbnail: "atv.jpg",
			}),
		).toEqual({
			id: "ATV",
			title: "Song title",
			artist: "Song artist",
			artistId: "uc-atv",
			artists: [{ name: "Song artist", id: "uc-atv" }],
			thumbnail: "atv.jpg",
			duration: "3:15",
			description: undefined,
			upload: undefined,
		});
	});

	test("fields the album track listing omits keep the video's", () => {
		const song = {
			id: "MV",
			title: "Title",
			artist: "Artist",
			thumbnail: "mv.jpg",
		};
		expect(applySongVersion(song, { id: "ATV" })).toEqual({
			id: "ATV",
			title: "Title",
			artist: "Artist",
			thumbnail: "mv.jpg",
		});
	});
});
