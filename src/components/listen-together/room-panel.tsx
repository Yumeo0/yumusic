import {
	Check,
	ChevronDown,
	Copy,
	Loader2,
	LogOut,
	Music2,
	Plus,
	QrCode,
	Settings2,
	ShieldCheck,
	UserRoundPen,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GuestPermissionsPanel } from "@/components/listen-together/guest-permissions-panel";
import { JoinPolicyPanel } from "@/components/listen-together/join-policy-panel";
import {
	RoomAvatar,
	RoomProfileDialog,
} from "@/components/listen-together/room-profile-dialog";
import {
	RoomQrCode,
	RoomQrScanner,
} from "@/components/listen-together/room-qr";
import type { Song } from "@/contexts/player-context";
import { actionLabel } from "@/lib/listen-together/guest-permissions";
import {
	profileSource,
	type RoomProfile,
	readRoomProfile,
	saveRoomProfile,
} from "@/lib/listen-together/profile";
import { parseInvite } from "@/lib/listen-together/protocol";
import { listenRoom, useListenRoom } from "@/lib/listen-together/room";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { getUserProfile } from "@/lib/youtube/youtube-client";

const button =
	"inline-flex items-center justify-center gap-2 rounded-lg border border-foreground/10 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-foreground/5 disabled:opacity-40";
interface Setup {
	source: string;
	profile: RoomProfile;
	googlePhoto?: string;
	signedIn: boolean;
	action: "create" | "join" | "edit";
}

function SuggestedSongCover({ song }: { song: Song }) {
	const [failed, setFailed] = useState(false);
	return song.thumbnail && !failed ? (
		<img
			alt=""
			className="size-11 shrink-0 rounded-md border border-foreground/10 object-cover"
			loading="lazy"
			onError={() => setFailed(true)}
			src={proxiedImageUrl(song.thumbnail, 96)}
		/>
	) : (
		<span className="grid size-11 shrink-0 place-items-center rounded-md border border-foreground/10 bg-muted text-muted-foreground">
			<Music2 aria-hidden className="size-5" />
		</span>
	);
}

export function RoomPanel({ embedded = false }: { embedded?: boolean }) {
	const room = useListenRoom();
	const [code, setCode] = useState("");
	const [setup, setSetup] = useState<Setup | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [copied, setCopied] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [showQr, setShowQr] = useState(false);
	const [profile, setProfile] = useState<RoomProfile | null>(
		() =>
			room.members.find((member) => member.id === room.selfId)?.profile ?? null,
	);
	const [source, setSource] = useState("");
	const request = useRef(0);
	useEffect(
		() => () => {
			request.current++;
		},
		[],
	);
	const enter = async (action: Setup["action"], invitation = code) => {
		const revision = ++request.current;
		if (action === "join" && !parseInvite(invitation)) {
			setError("Paste a valid YuMusic room code.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const cookie = await window.electron.getCookie();
			const account = cookie ? await getUserProfile() : null;
			const key = await profileSource(account);
			if (request.current !== revision) return;
			const saved = readRoomProfile(key);
			setSource(key);
			if (saved && action !== "edit") {
				setProfile(saved);
				await listenRoom.connect(
					saved,
					action === "join" ? invitation.trim() : undefined,
				);
			} else
				setSetup({
					source: key,
					profile:
						action === "edit" && profile
							? profile
							: (saved ?? { username: account?.name ?? "", avatar: null }),
					googlePhoto:
						saved || (action === "edit" && profile)
							? undefined
							: account?.photo,
					signedIn: !!account,
					action,
				});
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Could not prepare your room profile.",
			);
		} finally {
			setBusy(false);
		}
	};
	const save = (next: RoomProfile) => {
		if (!setup) return;
		saveRoomProfile(setup.source, next);
		setProfile(next);
		setSource(setup.source);
		const action = setup.action;
		setSetup(null);
		if (action === "edit") listenRoom.setProfile(next);
		else
			void listenRoom
				.connect(next, action === "join" ? code.trim() : undefined)
				.catch((e) => setError(String(e)));
	};
	const active = room.role !== null;
	const waiting = ["connecting", "reconnecting"].includes(room.status);
	return (
		<div
			className={
				embedded
					? "p-4 sm:p-6"
					: "mx-auto max-w-3xl px-6 pt-8 pb-10 sm:px-8 sm:pt-12"
			}
		>
			{!embedded && (
				<div className="mb-10 flex items-center gap-3">
					<h1 className="text-2xl font-semibold tracking-tight">
						Listen together
					</h1>
				</div>
			)}

			{!active ? (
				<div className="space-y-3">
					<button
						className={`${button} w-full border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
						disabled={busy}
						onClick={() => void enter("create")}
						type="button"
					>
						{busy ? (
							<Loader2 aria-hidden className="size-4 animate-spin" />
						) : (
							<Plus aria-hidden className="size-4" />
						)}{" "}
						Create room
					</button>
					<div className="flex gap-2">
						<input
							aria-label="Room code"
							autoComplete="off"
							className="min-w-0 flex-1 rounded-lg border border-foreground/10 bg-background px-3 py-2.5 text-sm outline-none focus:border-primary"
							onChange={(event) => setCode(event.target.value)}
							placeholder="Room code"
							spellCheck={false}
							value={code}
						/>
						<button
							className={button}
							disabled={busy || !code.trim()}
							onClick={() => void enter("join")}
							type="button"
						>
							Join
						</button>
						<button
							aria-label="Scan QR code"
							className={button}
							disabled={busy}
							onClick={() => setScanning(true)}
							title="Scan QR code"
							type="button"
						>
							<QrCode aria-hidden className="size-4" />
						</button>
					</div>
				</div>
			) : (
				<div className="space-y-5">
					<section className="rounded-2xl border border-primary/20 bg-primary/4 p-5">
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2 text-sm font-medium">
								{waiting ? (
									<Loader2 className="size-4 animate-spin text-primary" />
								) : (
									<span className="size-2 rounded-full bg-primary" />
								)}
								{room.status === "hosting"
									? "Room"
									: room.status === "connecting"
										? "Connecting…"
										: room.status === "reconnecting"
											? "Reconnecting…"
											: "Listening together"}
							</div>
							<button
								className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
								onClick={() => listenRoom.leave()}
								type="button"
							>
								<LogOut className="size-3.5" />
								{room.role === "host" ? "End room" : "Leave"}
							</button>
						</div>
						{room.invite && (
							<div>
								<div className="mt-4 flex items-center gap-2">
									<input
										aria-label="Room invitation code"
										className="min-w-0 flex-1 rounded-lg border border-foreground/10 bg-background px-3 py-2.5 font-mono text-xs"
										onFocus={(e) => e.target.select()}
										readOnly
										value={room.invite}
									/>
									<button
										className={button}
										onClick={() => {
											void navigator.clipboard
												.writeText(room.invite)
												.then(() => setCopied(true))
												.catch(() =>
													setError("Select and copy the room code manually."),
												);
										}}
										type="button"
									>
										{copied ? (
											<Check className="size-4" />
										) : (
											<Copy className="size-4" />
										)}
										<span className="sr-only">Copy room code</span>
									</button>
								</div>
								<button
									aria-expanded={showQr}
									className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
									onClick={() => setShowQr((value) => !value)}
									type="button"
								>
									<QrCode aria-hidden className="size-4" />
									{showQr ? "Hide QR code" : "Show QR code"}
								</button>
								{showQr && (
									<RoomQrCode invite={room.invite} key={room.invite} />
								)}
							</div>
						)}
					</section>
					{room.pending.length > 0 && (
						<section className="rounded-2xl border border-foreground/10 p-5">
							<h2 className="mb-4 text-sm font-medium">Wants to join</h2>
							{room.pending.map((member) => {
								const trusted =
									!!member.fingerprint &&
									room.trustedPeople.some(
										(person) => person.fingerprint === member.fingerprint,
									);
								return (
									<div className="flex items-center gap-3 py-2" key={member.id}>
										<RoomAvatar profile={member.profile} />
										<div className="min-w-0 flex-1">
											<p
												className="truncate text-sm"
												title={member.profile.username}
											>
												{member.profile.username}
											</p>
											{trusted && (
												<p
													className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
													title={member.fingerprint}
												>
													<ShieldCheck className="size-3.5 text-primary" />
													Already trusted
												</p>
											)}
										</div>
										<button
											aria-label={`Accept ${member.profile.username}`}
											className="rounded-full bg-primary/10 p-2 text-primary"
											onClick={() => listenRoom.approve(member.id, true)}
											type="button"
										>
											<Check className="size-4" />
										</button>
										{!trusted && (
											<button
												aria-label={`Approve and trust ${member.profile.username}'s device`}
												className="rounded-full bg-primary/10 p-2 text-primary"
												onClick={() => {
													try {
														listenRoom.approve(member.id, true, true);
													} catch (e) {
														setError(
															e instanceof Error
																? e.message
																: "Could not trust this device.",
														);
													}
												}}
												title="Approve and trust this device"
												type="button"
											>
												<ShieldCheck className="size-4" />
											</button>
										)}
										<button
											aria-label={`Decline ${member.profile.username}`}
											className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5"
											onClick={() => listenRoom.approve(member.id, false)}
											type="button"
										>
											<X className="size-4" />
										</button>
									</div>
								);
							})}
						</section>
					)}
					{room.role === "host" && room.requests.length > 0 && (
						<section className="rounded-2xl border border-foreground/10 p-5">
							<h2 className="mb-4 text-sm font-medium">Guest requests</h2>
							{room.requests.map((request) => {
								const song = request.song;
								return (
									<div
										className="flex flex-wrap items-center gap-3 py-2"
										key={request.id}
									>
										{song ? (
											<SuggestedSongCover key={song.thumbnail} song={song} />
										) : (
											<RoomAvatar profile={request.profile} />
										)}
										<div className="min-w-0 flex-1">
											<p
												className="truncate text-sm font-medium"
												title={actionLabel(request.action, request.song)}
											>
												{actionLabel(request.action, request.song)}
											</p>
											<p className="truncate text-xs text-muted-foreground">
												{song ? song.artist : request.profile.username}
											</p>
										</div>
										{song && (
											<div className="order-last flex w-full min-w-0 items-center justify-end gap-2 text-xs text-muted-foreground sm:order-none sm:w-auto sm:max-w-[40%]">
												<span
													className="truncate"
													title={`Requested by ${request.profile.username}`}
												>
													Requested by {request.profile.username}
												</span>
												<RoomAvatar
													key={request.profile.avatar}
													profile={request.profile}
													size="size-7"
												/>
											</div>
										)}
										<button
											aria-label={`Approve: ${actionLabel(request.action, request.song)}`}
											className="rounded-full bg-primary/10 p-2 text-primary"
											onClick={() =>
												listenRoom.resolveRequest(request.id, true)
											}
											type="button"
										>
											<Check className="size-4" />
										</button>
										<button
											aria-label={`Decline: ${actionLabel(request.action, request.song)}`}
											className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5"
											onClick={() =>
												listenRoom.resolveRequest(request.id, false)
											}
											type="button"
										>
											<X className="size-4" />
										</button>
									</div>
								);
							})}
						</section>
					)}

					<section className="rounded-2xl border border-foreground/10 p-5">
						<div className="mb-4 flex items-center justify-between">
							<h2 className="text-sm font-medium">
								In the room{" "}
								<span className="ml-1 text-muted-foreground">
									{room.members.length}/8
								</span>
							</h2>
							<button
								className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
								disabled={busy}
								onClick={() => void enter("edit")}
								type="button"
							>
								<UserRoundPen className="size-3.5" />
								Edit your profile
							</button>
						</div>
						{room.members.map((member, i) => (
							<div className="flex items-center gap-3 py-2.5" key={member.id}>
								<RoomAvatar
									key={member.profile.avatar}
									profile={member.profile}
								/>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2">
										<p
											className="min-w-0 truncate text-sm font-medium"
											title={member.profile.username}
										>
											{member.profile.username}
										</p>
										{i === 0 && (
											<span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
												Host
											</span>
										)}
										<span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
											{member.status === "buffering"
												? "Catching up…"
												: member.status === "paused"
													? "Paused"
													: member.status === "unavailable"
														? "Track unavailable"
														: "Listening"}
										</span>
									</div>
									{member.fingerprint && member.id !== room.selfId && (
										<div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
											{member.id !== room.selfId && member.fingerprint && (
												<button
													className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
													disabled={room.verifyingTrust.includes(member.id)}
													onClick={() => {
														try {
															if (
																room.trustedPeople.some(
																	(p) => p.fingerprint === member.fingerprint,
																)
															)
																listenRoom.forgetPerson(
																	member.fingerprint as string,
																);
															else listenRoom.trustPerson(member.id);
														} catch (e) {
															setError(
																e instanceof Error
																	? e.message
																	: "Could not update device trust.",
															);
														}
													}}
													title={member.fingerprint}
													type="button"
												>
													<ShieldCheck className="size-3.5" />
													{room.verifyingTrust.includes(member.id)
														? "Verifying…"
														: room.trustedPeople.some(
																	(p) => p.fingerprint === member.fingerprint,
																)
															? "Trusted · Forget"
															: "Trust device"}
												</button>
											)}
										</div>
									)}
								</div>
							</div>
						))}
						{room.members.length === 0 && profile && (
							<div className="flex items-center gap-3 py-2">
								<RoomAvatar profile={profile} />
								<p className="text-sm">
									{profile.username}
									<span className="ml-2 text-muted-foreground">
										Connecting…
									</span>
								</p>
							</div>
						)}
					</section>
				</div>
			)}
			<div className="mt-5">
				<details className="group mb-5 rounded-2xl border border-foreground/10">
					<summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
						<Settings2
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground"
						/>
						<div className="min-w-0 flex-1">
							<span className="block text-sm font-medium">Settings</span>
						</div>
						<ChevronDown
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
						/>
					</summary>
					<div className="border-t border-foreground/10 p-4 pb-0">
						<JoinPolicyPanel />
						<GuestPermissionsPanel />
					</div>
				</details>
			</div>
			{(error || room.error) && (
				<p
					className="mt-5 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					{error || room.error}
				</p>
			)}
			{scanning && (
				<RoomQrScanner
					onClose={() => setScanning(false)}
					onScan={(invitation) => {
						setScanning(false);
						setCode(invitation);
						void enter("join", invitation);
					}}
				/>
			)}
			{setup && (
				<RoomProfileDialog
					googlePhoto={setup.googlePhoto}
					initial={setup.profile}
					key={`${source}:${setup.action}`}
					onClose={() => setSetup(null)}
					onSave={save}
					signedIn={setup.signedIn}
				/>
			)}
		</div>
	);
}
