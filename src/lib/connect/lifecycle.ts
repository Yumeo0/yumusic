import type { Session } from "@supabase/supabase-js";

export function deviceId(
	owner: string,
	storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) {
	const key = `yumusic:connect:device-id:${owner}`;
	const saved = storage.getItem(key);
	if (saved && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(saved))
		return saved;
	const id = crypto.randomUUID();
	storage.setItem(key, id);
	return id;
}

interface DiscoveryHub {
	start(): Promise<void>;
	stop(): void;
}

/** One background discovery session per account, independent of any device UI. */
export class AccountDeviceDiscovery<T extends DiscoveryHub> {
	private session: Session | null = null;
	private owner: string | null = null;
	private hub: T | null = null;
	private stopped = false;
	constructor(
		private options: {
			eligible(session: Session): boolean;
			create(session: Session): T;
			attach(hub: T | null): void;
		},
	) {}
	setSession(session: Session | null) {
		this.session = session;
		this.reconcile();
	}
	reconcile = () => {
		if (this.stopped) return;
		const session = this.session;
		const owner =
			session && this.options.eligible(session) ? session.user.id : null;
		if (owner === this.owner) return;
		this.hub?.stop();
		this.hub = null;
		this.owner = owner;
		this.options.attach(null);
		if (!owner || !session) return;
		try {
			this.hub = this.options.create(session);
			this.options.attach(this.hub);
			void this.hub.start();
		} catch {
			this.owner = null;
		}
	};
	stop() {
		this.stopped = true;
		this.hub?.stop();
		this.hub = null;
		this.options.attach(null);
	}
}
