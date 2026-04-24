import assert from "node:assert/strict";
import {
  evaluateRules,
  mutateSessionRule,
  parseRule,
  parseRuleMutationArgs,
  ruleFromCall,
  ruleMatches,
  sanitizeConfig,
  toolTarget,
} from "../extensions/index.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

test("sanitizeConfig keeps only valid permission values", () => {
  const config = sanitizeConfig({
    defaultAction: "ask",
    allow: ["read:*", 123, null],
    ask: ["bash:npm install*"],
    deny: ["write:.env*", {}],
  });

  assert.equal(config.defaultAction, "ask");
  assert.deepEqual(config.allow, ["read:*"]);
  assert.deepEqual(config.ask, ["bash:npm install*"]);
  assert.deepEqual(config.deny, ["write:.env*"]);
});

test("parseRule splits tool and target pattern", () => {
  assert.deepEqual(parseRule("bash:git status*"), {
    toolPattern: "bash",
    targetPattern: "git status*",
  });
  assert.deepEqual(parseRule("tool_search"), { toolPattern: "tool_search" });
});

test("ruleMatches supports file path raw and absolute matching", () => {
  const target = toolTarget({
    toolName: "write",
    input: { path: ".env" },
    cwd: "/tmp/project",
  });

  assert.equal(ruleMatches("write:.env", "write", target), true);
  assert.equal(ruleMatches("write:/tmp/project/.env", "write", target), true);
  assert.equal(ruleMatches("write:*.env", "write", target), true);
  assert.equal(ruleMatches("write:/etc/*", "write", target), false);
});

test("bash target unwraps RTK git wrapper for matching", () => {
  const target = toolTarget({
    toolName: "bash",
    input: { command: 'RTK_DB_PATH="/tmp/history.db" rtk git push' },
    cwd: "/tmp/project",
  });

  assert.equal(target.candidates.includes('RTK_DB_PATH="/tmp/history.db" rtk git push'), true);
  assert.equal(target.candidates.includes("rtk git push"), true);
  assert.equal(target.candidates.includes("git push"), true);
  assert.equal(ruleMatches("bash:git push", "bash", target), true);
});

test("bash target unwraps RTK proxy wrapper for matching", () => {
  const target = toolTarget({
    toolName: "bash",
    input: { command: 'RTK_DB_PATH="/tmp/history.db" rtk proxy npm publish --access public' },
    cwd: "/tmp/project",
  });

  assert.equal(target.candidates.includes("rtk proxy npm publish --access public"), true);
  assert.equal(target.candidates.includes("npm publish --access public"), true);
  assert.equal(ruleMatches("bash:npm publish*", "bash", target), true);
});

test("evaluateRules uses deny before ask before allow within same source", () => {
  const target = toolTarget({
    toolName: "bash",
    input: { command: "git status" },
    cwd: "/tmp/project",
  });

  const result = evaluateRules(
    { allow: [], ask: [], deny: [] },
    {
      allow: ["bash:git *"],
      ask: ["bash:git status"],
      deny: ["bash:git status"],
    },
    { defaultAction: "allow", allow: ["tool_search"], ask: [], deny: [] },
    "bash",
    target,
  );

  assert.equal(result.action, "deny");
  assert.equal(result.source, "project");
});

test("evaluateRules prefers session over project over global", () => {
  const target = toolTarget({
    toolName: "bash",
    input: { command: "npm install" },
    cwd: "/tmp/project",
  });

  const result = evaluateRules(
    { allow: [], ask: ["bash:npm install*"], deny: [] },
    { allow: ["bash:npm install*"], ask: [], deny: [] },
    { defaultAction: "deny", allow: ["tool_search"], ask: [], deny: [] },
    "bash",
    target,
  );

  assert.equal(result.action, "ask");
  assert.equal(result.source, "session");
});

test("mutateSessionRule adds and removes ask rules", () => {
  const sessionRules = { allow: [], ask: [], deny: [] };
  assert.equal(mutateSessionRule(sessionRules, "ask", "bash:*", true), true);
  assert.deepEqual(sessionRules.ask, ["bash:*"]);
  assert.equal(mutateSessionRule(sessionRules, "ask", "bash:*", true), false);
  assert.equal(mutateSessionRule(sessionRules, "ask", "bash:*", false), true);
  assert.deepEqual(sessionRules.ask, []);
});

test("parseRuleMutationArgs parses command syntax", () => {
  assert.deepEqual(parseRuleMutationArgs("allow project bash:git status*"), {
    action: "allow",
    scope: "project",
    rule: "bash:git status*",
  });
  assert.equal(parseRuleMutationArgs("bogus"), null);
});

test("ruleFromCall keeps exact primary subject", () => {
  assert.equal(
    ruleFromCall({
      toolName: "mcp",
      input: { connect: "github" },
      cwd: "/tmp/project",
    }),
    "mcp:connect:github",
  );
});

console.log("All pi-claude-permissions tests passed.");
