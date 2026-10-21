import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OCTICONS, summarizePrStatus } from "../github.mjs";
import { render } from "../render.mjs";
import { SessionTracker, readState, writeState } from "../tracker.mjs";

const open = (checks, extra = {}) => ({ state: "OPEN", statusCheckRollup: checks, ...extra });
const success = { status: "COMPLETED", conclusion: "SUCCESS" };
const failure = { status: "COMPLETED", conclusion: "FAILURE" };
const suffix = ` ${OCTICONS.approved} 0/0 ${OCTICONS.comment} 0/0`;
const amber = "\x1b[1;38;2;255;238;196;48;2;118;68;16m";
const red = "\x1b[1;38;2;255;224;222;48;2;122;32;40m";
const green = "\x1b[1;38;2;216;250;228;48;2;22;92;50m";

test("active check status supersedes a previous attempt's conclusion", () => {
	for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]) {
		for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "SUCCESS", null]) {
			assert.equal(
				summarizePrStatus(open([success, { status, conclusion }])),
				`${OCTICONS.running} 1/2${suffix}`,
				`${status} with ${conclusion}`,
			);
		}
	}
});

test("mixed active and failed checks show progress without hiding completed failures", () => {
	for (const active of [{ status: "QUEUED" }, { status: "IN_PROGRESS" }, { state: "PENDING" }]) {
		assert.equal(
			summarizePrStatus(open([success, failure, { state: "ERROR" }, active])),
			`${OCTICONS.running} 1/4 (2 failed)${suffix}`,
		);
	}
});

test("settled checks retain failure and success semantics", () => {
	for (const conclusion of ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
		assert.equal(summarizePrStatus(open([success, { status: "COMPLETED", conclusion }])),
			`${OCTICONS.fail} 1/2${suffix}`);
	}
	assert.equal(summarizePrStatus(open([{ state: "FAILURE" }])), `${OCTICONS.fail} 0/1${suffix}`);
	assert.equal(summarizePrStatus(open([success, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }, { state: "SUCCESS" }])),
		`${OCTICONS.pass} 4/4${suffix}`);
	assert.equal(summarizePrStatus(open([])), `${OCTICONS.pass} 0/0${suffix}`);
	assert.equal(summarizePrStatus({ state: "MERGED" }), `${OCTICONS.merged} Merged`);
	assert.equal(summarizePrStatus({ state: "CLOSED" }), "CLOSED");
});

test("persisted PR transitions red -> amber -> green/red and polls active failures at the running cadence", (t) => {
	const home = mkdtempSync(join(tmpdir(), "pr-ci-restart-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const tracker = new SessionTracker("restart");
	tracker.manage("add", "acme/app#42");
	writeState(tracker.snapshot(), home);
	let info = open([success, failure]);
	let calls = 0;
	const fetchPrStatus = () => { calls++; return info; };
	const draw = (now, nerdFont = true) => render({ session_id: "restart" }, {
		home, now, fetchPrStatus, color: true, links: false, nerdFont,
	});

	assert.ok(draw(1000).startsWith(red));
	info = open([success, failure, { status: "QUEUED" }]);
	assert.ok(draw(46000).startsWith(amber));
	assert.equal(readState("restart", home).prs[0].status, `${OCTICONS.running} 1/3 (1 failed)${suffix}`);
	assert.match(draw(46001, false), /1\/3 \(1 failed\)/);
	assert.doesNotMatch(draw(46001, false), /[\uE700-\uF8FF]/);
	assert.equal(calls, 2, "cached rerender does not query GitHub");
	draw(65999);
	assert.equal(calls, 2, "running cache remains valid before 20 seconds");

	info = open([success, { status: "IN_PROGRESS", conclusion: "FAILURE" }]);
	assert.ok(draw(66000).startsWith(amber));
	assert.equal(calls, 3, "mixed failures refresh at 20 seconds, not the settled 45 seconds");
	assert.equal(readState("restart", home).prs[0].status, `${OCTICONS.running} 1/2${suffix}`);
	info = open([success, success]);
	assert.ok(draw(86000).startsWith(green));
	info = open([success, { status: "IN_PROGRESS" }]);
	assert.ok(draw(131000).startsWith(amber));
	info = open([success, failure]);
	assert.ok(draw(151000).startsWith(red));
	assert.equal(readState("restart", home).prs[0].status, `${OCTICONS.fail} 1/2${suffix}`);
});

test("conflicts and requested changes remain red during CI reruns in either icon mode", (t) => {
	const home = mkdtempSync(join(tmpdir(), "pr-ci-blockers-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const tracker = new SessionTracker("blockers");
	tracker.manage("add", "acme/app#42");
	writeState(tracker.snapshot(), home);
	for (const extra of [{ mergeStateStatus: "DIRTY" }, { reviewDecision: "CHANGES_REQUESTED" }]) {
		for (const nerdFont of [true, false]) {
			const output = render({ session_id: "blockers" }, {
				home, now: 1000, prCacheTtlMs: 0, color: true, links: false, nerdFont,
				fetchPrStatus: () => open([failure, { status: "IN_PROGRESS" }], extra),
			});
			assert.ok(output.startsWith(red));
			assert.ok(output.includes(nerdFont ? OCTICONS.running : "\u25f7"));
			assert.match(output, /0\/2 \(1 failed\)/);
		}
	}
});
