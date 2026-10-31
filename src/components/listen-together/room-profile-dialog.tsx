import { Dialog } from "@base-ui/react/dialog";
import { Camera, Loader2, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
	prepareAvatar,
	type RoomProfile,
	validProfile,
} from "@/lib/listen-together/profile";
import { proxiedImageUrl } from "@/lib/utils/tauri";

export function RoomAvatar({
	profile,
	size = "size-10",
}: {
	profile: RoomProfile;
	size?: string;
}) {
	const [failed, setFailed] = useState(false);
	return profile.avatar && !failed ? (
		<img
			alt=""
			className={`${size} shrink-0 rounded-full object-cover ring-1 ring-foreground/10`}
			onError={() => setFailed(true)}
			src={profile.avatar}
		/>
	) : (
		<span
			aria-hidden
			className={`${size} grid shrink-0 place-items-center rounded-full bg-primary/12 text-sm font-semibold text-primary ring-1 ring-primary/20`}
		>
			{profile.username.slice(0, 2).toUpperCase() || "?"}
		</span>
	);
}

export function RoomProfileDialog({
	initial,
	googlePhoto,
	signedIn,
	onSave,
	onClose,
}: {
	initial: RoomProfile;
	googlePhoto?: string;
	signedIn: boolean;
	onSave: (profile: RoomProfile) => void;
	onClose: () => void;
}) {
	const [username, setUsername] = useState(initial.username);
	const [avatar, setAvatar] = useState(initial.avatar);
	const [photo, setPhoto] = useState(googlePhoto);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const upload = useRef<HTMLInputElement>(null);
	const usernameId = useId();
	const save = async () => {
		setBusy(true);
		setError("");
		try {
			let image = avatar;
			if (photo) {
				const response = await fetch(proxiedImageUrl(photo, 192), {
					signal: AbortSignal.timeout(10000),
				});
				if (!response.ok)
					throw new Error(
						"Could not load your Google picture. Upload a picture or choose initials.",
					);
				image = await prepareAvatar(await response.blob());
			}
			const profile = { username: username.trim(), avatar: image };
			if (!validProfile(profile))
				throw new Error("Enter a username of 1–40 characters.");
			onSave(profile);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save your profile.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog.Root
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
			open
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/60 backdrop-blur-sm" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-6 shadow-2xl">
					<div className="flex items-start justify-between gap-4">
						<div>
							<Dialog.Title className="text-xl font-semibold tracking-tight">
								Your profile
							</Dialog.Title>
							<Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
								{signedIn
									? "Use your Google profile or edit it."
									: "Choose a name and picture."}
							</Dialog.Description>
						</div>
						<Dialog.Close
							aria-label="Close profile setup"
							className="rounded-full p-1.5 text-muted-foreground hover:bg-foreground/5"
							disabled={busy}
						>
							<X className="size-4" />
						</Dialog.Close>
					</div>
					<div className="my-6 flex items-center gap-4 rounded-xl border border-foreground/8 bg-foreground/3 p-4">
						{photo ? (
							<img
								alt="Your Google profile"
								className="size-16 rounded-full object-cover"
								src={proxiedImageUrl(photo, 192)}
							/>
						) : (
							<RoomAvatar
								key={avatar}
								profile={{ username, avatar }}
								size="size-16"
							/>
						)}
						<div className="space-y-2">
							<button
								className="flex items-center gap-2 text-sm font-medium hover:text-primary"
								disabled={busy}
								onClick={() => upload.current?.click()}
								type="button"
							>
								<Camera className="size-4" />
								Choose picture
							</button>
							<button
								className="block text-xs text-muted-foreground hover:text-foreground"
								disabled={busy}
								onClick={() => {
									setAvatar(null);
									setPhoto(undefined);
								}}
								type="button"
							>
								Use initials instead
							</button>
						</div>
						<input
							accept="image/png,image/jpeg,image/webp,image/gif"
							aria-label="Upload profile picture"
							className="hidden"
							onChange={async (e) => {
								const file = e.target.files?.[0];
								if (!file) return;
								e.target.value = "";
								setBusy(true);
								setError("");
								try {
									setAvatar(await prepareAvatar(file));
									setPhoto(undefined);
								} catch (e) {
									setError(
										e instanceof Error ? e.message : "Could not read picture.",
									);
								} finally {
									setBusy(false);
								}
							}}
							ref={upload}
							type="file"
						/>
					</div>
					<label
						className="text-xs font-medium text-muted-foreground"
						htmlFor={usernameId}
					>
						Username
					</label>
					<input
						autoComplete="nickname"
						className="mt-2 w-full rounded-lg border border-foreground/12 bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
						id={usernameId}
						maxLength={40}
						onChange={(e) => setUsername(e.target.value)}
						placeholder="Your name"
						value={username}
					/>
					<p className="mt-3 text-xs leading-relaxed text-muted-foreground">
						Only this name and picture are shared with the room. You can change
						them later.
					</p>
					{error && (
						<p className="mt-3 text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					<button
						className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
						disabled={busy || !username.trim()}
						onClick={() => void save()}
						type="button"
					>
						{busy && <Loader2 className="size-4 animate-spin" />}
						{signedIn &&
						username === initial.username &&
						(photo || avatar === initial.avatar)
							? "Use this profile"
							: "Save profile"}
					</button>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
