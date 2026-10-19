import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

let attempts = 0;
for (const name of ["spawnSync", "spawn", "execFileSync", "execFile", "execSync", "exec"]) {
	const original = childProcess[name];
	childProcess[name] = function (command, ...args) {
		const text = String(command);
		const shell = /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|(?:ba)?sh)$/i.test(basename(text));
		const githubCommand = /(?:^|[\s"';&|])(?:[^\r\n"';&|]*[/\\])?gh(?:\.exe)?(?=[\s"';&|]|$)/i;
		const github = /^gh(?:\.exe)?$/i.test(basename(text)) ||
			(name.startsWith("exec") && githubCommand.test(text)) ||
			(shell && Array.isArray(args[0]) && githubCommand.test(args[0].join(" ")));
		if (github) {
			attempts++;
			process.exitCode = 1;
			throw new Error("Statusline benchmark forbids live GitHub commands.");
		}
		return original.call(this, command, ...args);
	};
}
syncBuiltinESMExports();

export function assertOffline() {
	if (attempts) throw new Error(`Statusline benchmark blocked ${attempts} live GitHub command(s).`);
}
