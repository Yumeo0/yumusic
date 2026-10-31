import { Dialog } from "@base-ui/react/dialog";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import type QrScanner from "qr-scanner";
import { useEffect, useRef, useState } from "react";
import {
	acquireCamera,
	waitForCameraForeground,
} from "@/lib/listen-together/camera";
import { parseInvite } from "@/lib/listen-together/protocol";
import { createRoomQr } from "@/lib/listen-together/qr";

export function RoomQrCode({ invite }: { invite: string }) {
	const [image, setImage] = useState("");
	const [error, setError] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void createRoomQr(invite)
			.then((url) => {
				if (!cancelled) setImage(url);
			})
			.catch(() => {
				if (!cancelled) setError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [invite]);
	return (
		<div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-foreground/10 bg-background/50 p-4">
			{image ? (
				<img
					alt="Scan this QR code in YuMusic to join the room"
					className="h-auto w-60 max-w-full rounded-lg"
					height={320}
					src={image}
					width={320}
				/>
			) : error ? (
				<p className="text-sm text-destructive" role="alert">
					Could not create a QR code. Share the room code instead.
				</p>
			) : (
				<div
					className="grid size-60 max-w-full place-items-center"
					role="status"
				>
					<Loader2
						aria-hidden
						className="size-6 animate-spin text-muted-foreground"
					/>
					<span className="sr-only">Creating QR code</span>
				</div>
			)}
			<p className="text-center text-xs text-muted-foreground">
				Open Listen together → Scan QR code on the other device.
			</p>
		</div>
	);
}

export function RoomQrScanner({
	onClose,
	onScan,
}: {
	onClose: () => void;
	onScan: (invite: string) => void;
}) {
	const video = useRef<HTMLVideoElement>(null);
	const upload = useRef<HTMLInputElement>(null);
	const scanner = useRef<QrScanner | null>(null);
	const acceptRef = useRef(onScan);
	acceptRef.current = onScan;
	const alive = useRef(false);
	const completed = useRef(false);
	const [error, setError] = useState("");
	const [cameraError, setCameraError] = useState("");
	const [starting, setStarting] = useState(true);
	const [reading, setReading] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const accept = (text: string) => {
		if (!alive.current || completed.current) return;
		if (!parseInvite(text)) {
			setError("This is not a YuMusic room QR code. Try another code.");
			return;
		}
		completed.current = true;
		scanner.current?.destroy();
		scanner.current = null;
		acceptRef.current(text.trim());
	};
	const acceptCode = useRef(accept);
	acceptCode.current = accept;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally restarts the camera after permissions change.
	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		let instance: QrScanner | null = null;
		alive.current = true;
		setStarting(true);
		setCameraError("");
		void (async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia)
					throw new Error("unavailable");
				const { default: Scanner } = await import("qr-scanner");
				if (cancelled || !video.current) return;
				const stream = await acquireCamera(
					() =>
						navigator.mediaDevices.getUserMedia({
							video: { facingMode: { ideal: "environment" } },
							audio: false,
						}),
					waitForCameraForeground,
					controller.signal,
				);
				if (cancelled || !video.current) return;
				video.current.srcObject = stream;
				instance = new Scanner(
					video.current,
					(result) => acceptCode.current(result.data),
					{
						preferredCamera: "environment",
						maxScansPerSecond: 5,
						returnDetailedScanResult: true,
					},
				);
				scanner.current = instance;
				await instance.start();
				if (cancelled) instance.destroy();
			} catch {
				if (!cancelled)
					setCameraError(
						"Camera unavailable or permission denied. Allow camera access and retry, or choose a QR image.",
					);
			} finally {
				if (!cancelled) setStarting(false);
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
			alive.current = false;
			instance?.destroy();
			if (scanner.current === instance) scanner.current = null;
		};
	}, [attempt]);
	const scanImage = async (file: File) => {
		setError("");
		setReading(true);
		try {
			if (file.size > 20 * 1024 * 1024) throw new Error("too large");
			const { default: Scanner } = await import("qr-scanner");
			if (!alive.current || completed.current) return;
			const result = await Scanner.scanImage(file, {
				returnDetailedScanResult: true,
			});
			acceptCode.current(result.data);
		} catch {
			if (alive.current && !completed.current)
				setError("Could not read a QR code. Choose a clear image under 20 MB.");
		} finally {
			if (alive.current) setReading(false);
		}
	};
	return (
		<Dialog.Root
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			open
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/60 backdrop-blur-sm" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-foreground/10 bg-popover p-5 shadow-2xl">
					<div className="flex items-center justify-between gap-3">
						<Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
							<Camera aria-hidden className="size-5 text-primary" />
							Scan QR code
						</Dialog.Title>
						<Dialog.Close
							aria-label="Close scanner"
							className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5"
						>
							<X aria-hidden className="size-4" />
						</Dialog.Close>
					</div>
					<Dialog.Description className="mt-2 text-sm text-muted-foreground">
						Point at a room QR code.
					</Dialog.Description>
					<div className="relative mt-4 aspect-square overflow-hidden rounded-xl bg-black">
						<video
							aria-label="QR scanner camera preview"
							autoPlay
							className="size-full object-cover"
							muted
							playsInline
							ref={video}
						/>
						{starting && (
							<div
								className="absolute inset-0 grid place-items-center bg-black/60"
								role="status"
							>
								<Loader2
									aria-hidden
									className="size-6 animate-spin text-white"
								/>
								<span className="sr-only">Starting camera</span>
							</div>
						)}
					</div>
					{cameraError && (
						<p className="mt-3 text-sm text-muted-foreground" role="status">
							{cameraError}
						</p>
					)}
					{error && (
						<p className="mt-3 text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					<div className="mt-4 flex flex-wrap gap-2">
						{cameraError && (
							<button
								className="rounded-lg border border-foreground/10 px-3 py-2 text-sm hover:bg-foreground/5"
								onClick={() => setAttempt((value) => value + 1)}
								type="button"
							>
								Retry camera
							</button>
						)}
						<button
							className="inline-flex items-center gap-2 rounded-lg border border-foreground/10 px-3 py-2 text-sm hover:bg-foreground/5 disabled:opacity-40"
							disabled={reading}
							onClick={() => upload.current?.click()}
							type="button"
						>
							{reading ? (
								<Loader2 aria-hidden className="size-4 animate-spin" />
							) : (
								<ImagePlus aria-hidden className="size-4" />
							)}
							Choose QR image
						</button>
						<input
							accept="image/*"
							aria-label="Choose a room QR image"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) void scanImage(file);
							}}
							ref={upload}
							type="file"
						/>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
