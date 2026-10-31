import { useState } from "react";
import {
	defaultPermissions,
	type GuestPermissions,
	type PermissionCategory,
	type PermissionMode,
	permissionLabels,
} from "@/lib/listen-together/guest-permissions";
import { listenRoom, useListenRoom } from "@/lib/listen-together/room";

export function GuestPermissionsPanel() {
	const room = useListenRoom();
	const [error, setError] = useState("");
	const save = (permissions: GuestPermissions) => {
		setError("");
		try {
			listenRoom.setGuestPermissions(permissions);
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Could not save guest permissions.",
			);
		}
	};
	const preset = (mode: PermissionMode) =>
		save(
			Object.fromEntries(
				Object.keys(defaultPermissions).map((key) => [key, mode]),
			) as GuestPermissions,
		);
	return (
		<section className="mb-5 rounded-2xl border border-foreground/10 p-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-sm font-medium">Guest controls</h2>
				{room.role !== "guest" && (
					<div className="flex flex-wrap gap-2">
						{(
							[
								["deny", "Host only"],
								["suggest", "Ask first"],
								["allow", "Shared controls"],
							] as const
						).map(([mode, label]) => (
							<button
								className="rounded-md border border-foreground/10 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
								key={mode}
								onClick={() => preset(mode)}
								type="button"
							>
								{label}
							</button>
						))}
					</div>
				)}
			</div>
			<div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
				{(Object.keys(permissionLabels) as PermissionCategory[]).map((key) => (
					<label
						className="flex items-center justify-between gap-3 text-xs"
						key={key}
					>
						<span>{permissionLabels[key]}</span>
						<select
							aria-label={`Guest permission: ${permissionLabels[key]}`}
							className="rounded-md border border-foreground/10 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary disabled:opacity-70"
							disabled={room.role === "guest"}
							onChange={(e) =>
								save({
									...room.permissions,
									[key]: e.target.value as PermissionMode,
								})
							}
							value={room.permissions[key]}
						>
							<option value="allow">Allow</option>
							<option value="suggest">Request approval</option>
							<option value="deny">Deny</option>
						</select>
					</label>
				))}
			</div>
			{error && (
				<p className="mt-3 text-sm text-destructive" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
