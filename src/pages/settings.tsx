import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { validateListenbrainzToken } from "@/lib/listenbrainz";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
	const [settings, update] = useSettings();
	const [cleared, setCleared] = useState(false);
	const [tokenState, setTokenState] = useState<{
		valid: boolean;
		user?: string;
	} | null>(null);

	// Verify the ListenBrainz token whenever it changes (debounced).
	useEffect(() => {
		const token = settings.listenbrainzToken.trim();
		if (!settings.listenbrainz || token.length < 8) {
			setTokenState(null);
			return;
		}
		const timer = window.setTimeout(() => {
			validateListenbrainzToken(token)
				.then(setTokenState)
				.catch(() => setTokenState({ valid: false }));
		}, 600);
		return () => window.clearTimeout(timer);
	}, [settings.listenbrainzToken, settings.listenbrainz]);

	const clearCaches = () => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith("yumusic:") && !key.startsWith("yumusic:settings")) {
				localStorage.removeItem(key);
			}
		}
		setCleared(true);
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-6 pt-12 sm:px-10">
			<p className="mb-2 font-mono text-[11px] font-medium tracking-[0.24em] text-primary">
				APP
			</p>
			<h1 className="text-3xl font-bold tracking-tight">Settings</h1>

			{/* Lyrics */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Lyrics</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Romanize lyrics</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Show a latin reading under each line for Japanese, Chinese and
								Korean lyrics, with extra spacing for readability.
							</p>
						</div>
						<button
							aria-label="Toggle romanized lyrics"
							aria-pressed={settings.romanizeLyrics}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.romanizeLyrics ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() =>
								update({ romanizeLyrics: !settings.romanizeLyrics })
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.romanizeLyrics && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* Song titles */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					Song titles
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Dual-language titles</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Some tracks pair an original and a translated title or artist
								name, e.g. "本能スピード - Instinctive Speed". Choose which part
								to show.
							</p>
						</div>
						<div className="flex shrink-0 overflow-hidden rounded-full border border-foreground/12">
							{(
								[
									["both", "Both"],
									["original", "Original"],
									["translation", "Translation"],
								] as const
							).map(([mode, label]) => (
								<button
									className={cn(
										"h-8 px-3 text-xs font-medium transition-colors duration-200",
										settings.titleMode === mode
											? "bg-primary text-primary-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
									key={mode}
									onClick={() => update({ titleMode: mode })}
									type="button"
								>
									{label}
								</button>
							))}
						</div>
					</div>
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Original artist names</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Show artists under their original-language name, e.g.
								"猫又おかゆ" instead of "Nekomata Okayu". Each artist
								name is looked up once and cached.
							</p>
						</div>
						<button
							aria-label="Toggle original artist names"
							aria-pressed={settings.originalArtists}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.originalArtists ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() =>
								update({ originalArtists: !settings.originalArtists })
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.originalArtists && "translate-x-5",
								)}
							/>
						</button>
					</div>
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Clean up titles</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Strip noise from the end of titles, e.g. "美人局 covered by
								藍月なくる" → "美人局".
							</p>
						</div>
						<button
							aria-label="Toggle title cleanup"
							aria-pressed={settings.cleanTitles}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.cleanTitles ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ cleanTitles: !settings.cleanTitles })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.cleanTitles && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* ListenBrainz */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					ListenBrainz
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Scrobbling</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Send your plays to ListenBrainz. Tracks are matched on
								MusicBrainz and submitted with their recording ID so they land
								in your history correctly.
							</p>
						</div>
						<button
							aria-label="Toggle ListenBrainz scrobbling"
							aria-pressed={settings.listenbrainz}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.listenbrainz ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ listenbrainz: !settings.listenbrainz })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.listenbrainz && "translate-x-5",
								)}
							/>
						</button>
					</div>
					{settings.listenbrainz && (
						<div className="p-4">
							<label className="text-sm font-medium" htmlFor="lb-token">
								User token
							</label>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Find your token under your avatar at listenbrainz.org → Settings
								→ User identity.
							</p>
							<Input
								autoComplete="off"
								className="mt-2 max-w-sm font-mono"
								id="lb-token"
								onChange={(event) => {
									setTokenState(null);
									update({ listenbrainzToken: event.target.value.trim() });
								}}
								placeholder="Paste your ListenBrainz token"
								value={settings.listenbrainzToken}
							/>
							<p
								className={cn(
									"mt-1.5 text-xs",
									tokenState?.valid
										? "text-primary"
										: tokenState
											? "text-destructive"
											: "text-muted-foreground/70",
								)}
							>
								{tokenState === null
									? "Token not verified yet."
									: tokenState.valid
										? `Connected as ${tokenState.user ?? "unknown user"}.`
										: "Token invalid — check that you copied it correctly."}
							</p>
						</div>
					)}
				</div>
			</section>

			{/* Discord */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Discord</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Rich presence</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Show the song you're listening to on your Discord profile, with
								cover art and links to the song, album and artist. Discord must
								be running for the presence to appear.
							</p>
						</div>
						<button
							aria-label="Toggle Discord rich presence"
							aria-pressed={settings.discordRpc}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.discordRpc ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ discordRpc: !settings.discordRpc })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.discordRpc && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* Storage */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Storage</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Synced caches</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Clear the locally stored playlists and artist data. They will be
								fetched again on next visit.
							</p>
						</div>
						<button
							className={cn(
								"flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-200",
								cleared
									? "border-primary/40 text-primary"
									: "border-foreground/12 text-muted-foreground hover:border-destructive/40 hover:text-destructive",
							)}
							onClick={() => {
								clearCaches();
							}}
							type="button"
						>
							<Trash2 className="size-4" />
							{cleared ? "Cleared" : "Clear"}
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}
