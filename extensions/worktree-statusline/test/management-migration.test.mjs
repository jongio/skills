import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleUrl = (id) => JSON.stringify(pathToFileURL(join(root, "extensions", id, "tracker.mjs")).href);

for (const [component, standalone] of [["issues", "issue-statusline"], ["subagents", "subagent-statusline"]]) {
	for (const extension of ["pr-statusline", standalone]) {
		for (const adapter of ["command", "tool"]) {
			for (const action of ["list", "clear"]) {
				test(`${extension} ${component} ${adapter} ${action} migrates before saving management state`, () => {
					const home = realpathSync.native(mkdtempSync(join(tmpdir(), "management-migration-")));
					try {
						configureStatuslines({ home, repoRoot: root, enabled: [extension] });
						const entry = pathToFileURL(join(home, "extensions", extension, "extension.mjs")).href;
						const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
							import assert from "node:assert/strict";
							import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
							import { join } from "node:path";
							import { registerHooks } from "node:module";
							import { IssueTracker, readState as readIssues, writeState as writeIssues, syncSession as syncIssues } from ${moduleUrl("issue-statusline")};
							import { SubagentTracker, readState as readAgents, writeState as writeAgents, syncSession as syncAgents } from ${moduleUrl("subagent-statusline")};
							const component = ${JSON.stringify(component)}, action = ${JSON.stringify(action)}, adapter = ${JSON.stringify(adapter)};
							const id = "management-first";
							const home = process.env.COPILOT_HOME;
							const issue = "https://github.com/acme/app/issues/7", pr = "https://github.com/acme/app/pull/42";
							const event = (type, data, agentId) => ({ type, data, agentId, timestamp: new Date(1000).toISOString() });
							const history = [
								event("session.start", { repository: "acme/app" }),
								event("tool.execution_start", { toolCallId: "issue-work", toolName: "powershell", arguments: { command: "gh issue develop 7" } }),
								event("subagent.started", { agentId: "worker", agentType: "general-purpose" }),
								event("tool.execution_start", { toolCallId: "agent-work", toolName: "powershell", arguments: { command: "gh pr checkout 42" } }, "worker"),
							].map(JSON.stringify).join("\\n") + "\\n";
							const directory = join(home, "session-state", id);
							mkdirSync(directory, { recursive: true });
							const transcript = join(directory, "events.jsonl");
							writeFileSync(transcript, history);
							const issues = new IssueTracker(id);
							issues.add(issue);
							issues.add("https://github.com/acme/app/issues/99");
							const oldIssues = issues.snapshot();
							delete oldIssues.activeTrackingVersion;
							for (const item of oldIssues.issues) delete item.active;
							oldIssues.transcriptOffset = Buffer.byteLength(history);
							writeIssues(oldIssues);
							const agents = new SubagentTracker(id);
							agents.ensureAgent("worker", { agentType: "general-purpose" });
							agents.linkPr("worker", pr);
							agents.linkPr("worker", "https://github.com/acme/app/pull/99");
							const oldAgents = agents.snapshot();
							delete oldAgents.activeTrackingVersion;
							oldAgents.transcriptOffset = Buffer.byteLength(history);
							writeAgents(oldAgents);
							const other = new IssueTracker("other-session");
							other.add("acme/app#55");
							writeIssues(other.snapshot());
							const otherBefore = readFileSync(join(home, "issue-statusline", "other-session.json"), "utf8");
							const config = ["settings.json", "statusline-config.json"].map(path => readFileSync(join(home, path), "utf8"));
							let configuration;
							const logs = [];
							const session = {
								sessionId: id, capabilities: {}, log: async value => logs.push(value),
								on: () => () => {}, getEvents: async () => [],
								rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
							};
							globalThis.joinTestSession = async value => { configuration = value; return session; };
							const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinTestSession;");
							registerHooks({ resolve(specifier, context, next) {
								return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
							} });
							await import(${JSON.stringify(entry)});
							if (adapter === "command") {
								await configuration.commands.find(item => item.name === "session-" + component).handler({ args: action });
								assert.doesNotMatch(logs.at(-1), /Usage:/);
							} else {
								JSON.parse(await configuration.tools.find(item => item.name === "session_" + component).handler({ action }));
							}
							const read = component === "issues" ? readIssues : readAgents;
							const write = component === "issues" ? writeIssues : writeAgents;
							const saved = read(id);
							assert.equal(saved.activeTrackingVersion, 1);
							if (action === "list") {
								if (component === "issues") assert.deepEqual(saved.issues.map(item => item.url), [issue]);
								else assert.deepEqual(saved.agents.worker.prs, [pr]);
							} else {
								assert.deepEqual(saved.issues ?? saved.agents, component === "issues" ? [] : {});
								assert.ok(saved.ignored.includes(component === "issues" ? issue : "worker"));
								write({ ...saved, transcriptOffset: Number.MAX_SAFE_INTEGER });
							}
							if (component === "issues") {
								const current = syncIssues({ session_id: id }, { fetchIssueStatus: false }).state;
								assert.deepEqual(current.issues.map(item => item.url), action === "clear" ? [] : [issue]);
							} else {
								const current = syncAgents({ session_id: id }).tracker;
								assert.deepEqual([...current.agents.keys()], action === "clear" ? [] : ["worker"]);
								if (action === "list") assert.deepEqual(current.agents.get("worker").prs, [pr]);
							}
							assert.equal(readFileSync(transcript, "utf8"), history);
							assert.equal(readFileSync(join(home, "issue-statusline", "other-session.json"), "utf8"), otherBefore);
							assert.deepEqual(["settings.json", "statusline-config.json"].map(path => readFileSync(join(home, path), "utf8")), config);
						`], {
							encoding: "utf8", timeout: 60000, windowsHide: true,
							env: { ...process.env, COPILOT_HOME: home, NO_COLOR: "1" },
						});
						assert.ifError(result.error);
						assert.equal(result.status, 0, result.stderr || result.stdout);
					} finally { rmSync(home, { recursive: true, force: true }); }
				});
			}
		}
	}
}
