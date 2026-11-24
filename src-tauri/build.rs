fn main() {
	let bridge = "src/po_token_bgutils.js";
	println!("cargo:rerun-if-changed={bridge}");
	println!("cargo:rerun-if-changed=../bun.lock");
	let output =
		std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"))
			.join("po_token_bgutils.js");
	let status = std::process::Command::new("bun")
		.args([
			"build",
			bridge,
			"--target",
			"browser",
			"--format",
			"iife",
			"--minify",
			"--outfile",
		])
		.arg(output)
		.status()
		.expect("Bun is required to bundle the PO token minter");
	assert!(status.success(), "Failed to bundle the PO token minter");
	tauri_build::build()
}
