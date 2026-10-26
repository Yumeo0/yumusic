import { $, fileURLToPath } from "bun";

const root = fileURLToPath(new URL("../", import.meta.url));
const appId = "dev.yumeo.yumusic";
const command = process.argv[2];
const targetDir = process.env.CARGO_TARGET_DIR ?? "src-tauri/target";
const cargo = process.env.CARGO ?? "cargo";
const shell = $.cwd(root);

switch (command) {
	case "build": {
		// Dependencies and Bun's patchedDependencies must already be installed.
		await shell`${process.execPath} run build`;
		await shell`${cargo} build --manifest-path src-tauri/Cargo.toml --target-dir ${targetDir} --release --frozen --features custom-protocol`;
		break;
	}
	case "install": {
		const prefix = process.env.PREFIX ?? "/usr/local";
		const destdir = process.env.DESTDIR ?? "";
		const destination = `${destdir}${prefix}`;
		const binary = process.env.BINARY ?? `${targetDir}/release/app`;
		await shell`install -Dm755 ${binary} ${`${destination}/bin/yumusic`}`;
		await shell`install -Dm644 ${`src-tauri/linux/${appId}.flatpak.desktop`} ${`${destination}/share/applications/${appId}.desktop`}`;
		await shell`install -Dm644 ${`src-tauri/linux/${appId}.metainfo.xml`} ${`${destination}/share/metainfo/${appId}.metainfo.xml`}`;
		await shell`install -Dm644 public/app-icon.svg ${`${destination}/share/icons/hicolor/scalable/apps/${appId}.svg`}`;
		await shell`install -Dm644 LICENSE ${`${destination}/share/licenses/${appId}/LICENSE`}`;
		break;
	}
	case "validate": {
		await shell`desktop-file-validate ${`src-tauri/linux/${appId}.flatpak.desktop`}`;
		await shell`appstreamcli validate --pedantic --no-net ${`src-tauri/linux/${appId}.metainfo.xml`}`;
		break;
	}
	default:
		console.error("Usage: bun scripts/flatpak.ts <build|install|validate>");
		process.exit(1);
}
