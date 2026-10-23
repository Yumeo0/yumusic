import { spawnSync } from "bun";

/** Run Git without a shell, preserving failure handling for release scripts. */
export function runGit(
	args: string[],
	options: { cwd?: string; inherit?: boolean } = {},
): string {
	const output = options.inherit ? "inherit" : "pipe";
	const result = spawnSync(["git", ...args], {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: output,
		stderr: output,
	});
	if (!result.success) {
		throw new Error(
			result.stderr?.toString().trim() ||
				`git ${args[0]} failed (exit ${result.exitCode})`,
		);
	}
	return result.stdout?.toString().trim() ?? "";
}
