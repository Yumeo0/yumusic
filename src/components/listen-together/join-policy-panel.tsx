import { ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import type { JoinPolicy } from "@/lib/listen-together/join-settings";
import { listenRoom, useListenRoom } from "@/lib/listen-together/room";

export function JoinPolicyPanel() {
	const room = useListenRoom();
	const [error, setError] = useState("");
	const guest = room.role === "guest";
	return (
		<section className="mb-5 rounded-2xl border border-foreground/10 p-5">
			{guest ? (
				<div>
					<h2 className="flex items-center gap-2 text-sm font-medium">
						<ShieldCheck className="size-4 text-primary" />
						People you trust
					</h2>
				</div>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="flex items-center gap-2 text-sm font-medium">
						<ShieldCheck className="size-4 text-primary" />
						Joining
					</h2>
					<select
						aria-label="Room join approval"
						className="max-w-full rounded-lg border border-foreground/12 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
						onChange={(event) => {
							setError("");
							try {
								listenRoom.setJoinPolicy(event.target.value as JoinPolicy);
							} catch (e) {
								setError(
									e instanceof Error
										? e.message
										: "Could not save join policy.",
								);
							}
						}}
						value={room.joinPolicy}
					>
						<option value="manual">Manual approval</option>
						<option value="trusted">Auto-approve trusted people</option>
						<option value="everyone">Auto-approve everyone</option>
						<option value="trusted-only">Trusted people only</option>
					</select>
				</div>
			)}

			{room.trustedPeople.length > 0 && (
				<details className="mt-4 border-t border-foreground/8 pt-3">
					<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
						Trusted devices · {room.trustedPeople.length}
					</summary>
					<div className="mt-2 max-h-56 overflow-y-auto">
						{room.trustedPeople.map((person) => (
							<div
								className="flex items-center gap-3 py-2"
								key={person.fingerprint}
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">{person.username}</p>
									<p
										className="truncate font-mono text-[10px] text-muted-foreground"
										title={person.fingerprint}
									>
										{person.fingerprint.match(/.{1,8}/g)?.join(" ")}
									</p>
								</div>
								<button
									aria-label={`Forget ${person.username}'s device`}
									className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-destructive"
									onClick={() => {
										setError("");
										try {
											listenRoom.forgetPerson(person.fingerprint);
										} catch (e) {
											setError(
												e instanceof Error
													? e.message
													: "Could not forget this device.",
											);
										}
									}}
									type="button"
								>
									<Trash2 className="size-4" />
								</button>
							</div>
						))}
					</div>
				</details>
			)}
			{error && (
				<p className="mt-3 text-sm text-destructive" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
