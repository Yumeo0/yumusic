import { Cloud, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	cancelGoogleSignIn,
	signInWithGoogle,
	useGoogleAuthorization,
} from "@/lib/sync/oauth";
import { syncNow, useCloudSync } from "@/lib/sync/sync";

export function SyncSection() {
	const sync = useCloudSync();
	const [starting, setBusy] = useState(false);
	const busy = useGoogleAuthorization() || starting;
	const [error, setError] = useState<string | null>(null);
	const email = sync.email || sync.youtubeEmail;
	const [revealedEmail, setRevealedEmail] = useState<string | null>(null);
	const showEmail = !!email && revealedEmail === email;
	const displayedError = showEmail
		? error || sync.error
		: (error || sync.error)?.replace(
				/[^\s()<>]+@[^\s()<>]+\.[^\s()<>]+/g,
				"hidden email",
			);
	async function signIn() {
		setBusy(true);
		setError(null);
		try {
			await signInWithGoogle();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not sign in.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section aria-labelledby="sync-heading" className="mt-8">
			<h2
				className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground"
				id="sync-heading"
			>
				<Cloud aria-hidden className="size-4" />
				Sync across devices
			</h2>
			<div className="rounded-xl border border-foreground/8 bg-card p-4">
				<div className="flex items-center justify-between gap-6">
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<p className="text-xs leading-relaxed text-muted-foreground">
							Keep your preferences, pinned playlists, Listen together profile,
							permissions and trusted people in sync using your YouTube Google
							account.
						</p>
						{email && (
							<button
								aria-expanded={showEmail}
								aria-label={
									showEmail ? "Hide account email" : "Show account email"
								}
								className="w-fit max-w-full truncate rounded-sm text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
								onClick={() => setRevealedEmail(showEmail ? null : email)}
								type="button"
							>
								{showEmail ? email : "Show email"}
							</button>
						)}
						{sync.email ? (
							<p aria-live="polite" className="text-xs text-muted-foreground">
								{sync.status === "syncing"
									? "Syncing…"
									: sync.status === "error"
										? "Sync paused. Changes remain on this device."
										: sync.pending
											? `${sync.pending} changes waiting to sync`
											: sync.lastSynced
												? `Last synced ${new Date(sync.lastSynced).toLocaleTimeString()}`
												: "Waiting to sync…"}
							</p>
						) : (
							sync.youtubeStatus !== "ready" && (
								<p className="text-xs text-muted-foreground">
									{sync.youtubeStatus === "checking"
										? "Checking your YouTube account…"
										: sync.youtubeStatus === "signed-out"
											? "Sign in to YouTube above to enable sync."
											: "Sign in to YouTube again to enable sync."}
								</p>
							)
						)}
					</div>
					{(sync.email || sync.youtubeStatus === "ready") && (
						<div className="flex shrink-0 flex-col items-end gap-2">
							{sync.email ? (
								<Button
									disabled={sync.status === "syncing"}
									onClick={() => void syncNow()}
									size="sm"
									variant="secondary"
								>
									<RefreshCw data-icon="inline-start" />
									Sync now
								</Button>
							) : (
								<>
									<Button
										disabled={busy}
										onClick={() => void signIn()}
										size="sm"
									>
										{busy ? "Waiting for Google…" : "Enable sync"}
									</Button>
									{busy && (
										<Button
											onClick={cancelGoogleSignIn}
											size="sm"
											variant="ghost"
										>
											Cancel
										</Button>
									)}
								</>
							)}
						</div>
					)}
				</div>
				{displayedError && (
					<p className="mt-3 text-xs text-destructive" role="alert">
						{displayedError}
					</p>
				)}
			</div>
		</section>
	);
}
