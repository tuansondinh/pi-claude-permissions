/// <reference lib="es2022" />

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type PermissionAction = "allow" | "ask" | "deny";

interface PermissionConfig {
  defaultAction?: PermissionAction;
  footerStatus?: boolean;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

interface SessionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

interface RuleTarget {
  primary: string;
  candidates: string[];
}

interface MatchResult {
  action: PermissionAction;
  source: "session" | "project" | "global" | "default";
  rule?: string;
}

const DEFAULT_GLOBAL_CONFIG: PermissionConfig = {
  defaultAction: "allow",
  allow: [],
  ask: [],
  deny: [],
};

const STARTER_PROJECT_CONFIG: PermissionConfig = {
  defaultAction: "allow",
  allow: ["read:*", "grep", "find"],
  ask: ["bash:*", "write:*", "edit:*", "mcp:*"],
  deny: ["bash:rm -rf*", "bash:sudo *", "write:.env*", "edit:.env*"],
};

const CHOICES = [
  "Allow once",
  "Allow for session",
  "Allow for project",
  "Allow globally",
  "Deny for session",
  "Deny for project",
  "Deny globally",
  "Cancel",
] as const;

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matches(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function normalizeRule(rule: string): string {
  return rule.trim();
}

function parseConfig(raw: string, label: string): PermissionConfig {
  try {
    const parsed = JSON.parse(raw);
    return sanitizeConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-claude-permissions] Failed parsing ${label}: ${message}`);
    return {};
  }
}

export function sanitizeConfig(value: unknown): PermissionConfig {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaultAction = obj.defaultAction;
  return {
    defaultAction:
      defaultAction === "allow" || defaultAction === "ask" || defaultAction === "deny"
        ? defaultAction
        : undefined,
    footerStatus: typeof obj.footerStatus === "boolean" ? obj.footerStatus : undefined,
    allow: Array.isArray(obj.allow) ? obj.allow.filter((v): v is string => typeof v === "string") : [],
    ask: Array.isArray(obj.ask) ? obj.ask.filter((v): v is string => typeof v === "string") : [],
    deny: Array.isArray(obj.deny) ? obj.deny.filter((v): v is string => typeof v === "string") : [],
  };
}

function readConfig(filePath: string, fallback?: PermissionConfig): PermissionConfig {
  if (!existsSync(filePath)) return fallback ? structuredClone(fallback) : {};
  return parseConfig(readFileSync(filePath, "utf-8"), filePath);
}

function writeConfig(filePath: string, config: PermissionConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function appendRule(filePath: string, action: PermissionAction, rule: string, fallback?: PermissionConfig): void {
  const config = readConfig(filePath, fallback);
  const list =
    action === "allow"
      ? (config.allow ??= [])
      : action === "ask"
        ? (config.ask ??= [])
        : (config.deny ??= []);
  if (!list.includes(rule)) list.push(rule);
  writeConfig(filePath, config);
}

function removeRule(filePath: string, action: PermissionAction, rule: string, fallback?: PermissionConfig): boolean {
  const config = readConfig(filePath, fallback);
  const list =
    action === "allow"
      ? (config.allow ??= [])
      : action === "ask"
        ? (config.ask ??= [])
        : (config.deny ??= []);
  const next = list.filter((entry) => entry !== rule);
  const changed = next.length !== list.length;
  if (!changed) return false;
  if (action === "allow") config.allow = next;
  else if (action === "ask") config.ask = next;
  else config.deny = next;
  writeConfig(filePath, config);
  return true;
}

export function buildPaths(cwd: string) {
  return {
    global: join(getAgentDir(), "tool-permissions.json"),
    project: join(cwd, ".pi", "tool-permissions.json"),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripLeadingEnvAssignments(command: string): string {
  let rest = command.trimStart();

  while (rest) {
    const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s*/);
    if (!match) break;
    rest = rest.slice(match[0].length).trimStart();
  }

  return rest;
}

function unwrapKnownBashWrappers(command: string): string[] {
  const trimmed = command.trim();
  const candidates = [trimmed];

  const rtkProxy = trimmed.match(/^rtk\s+proxy\s+(\S+)(?:\s+(.+))?$/i);
  if (rtkProxy?.[1]) candidates.push([rtkProxy[1], rtkProxy[2]].filter(Boolean).join(" "));

  const rtkGit = trimmed.match(/^rtk\s+git\s+(.+)$/i);
  if (rtkGit?.[1]) candidates.push(`git ${rtkGit[1]}`);

  const rtkGh = trimmed.match(/^rtk\s+gh\s+(.+)$/i);
  if (rtkGh?.[1]) candidates.push(`gh ${rtkGh[1]}`);

  return dedupe(candidates);
}

function bashTargetCandidates(command: string): string[] {
  const trimmed = command.trim();
  const withoutEnv = stripLeadingEnvAssignments(trimmed);
  return dedupe([
    trimmed,
    withoutEnv,
    ...unwrapKnownBashWrappers(trimmed),
    ...unwrapKnownBashWrappers(withoutEnv),
  ]);
}

export function toolTarget(event: { toolName: string; input: Record<string, any>; cwd: string }): RuleTarget {
  const { toolName, input, cwd } = event;

  if (toolName === "bash") {
    const command = String(input.command ?? "").trim();
    return { primary: command, candidates: bashTargetCandidates(command) };
  }

  if (["read", "write", "edit"].includes(toolName)) {
    const rawPath = String(input.path ?? "").trim();
    const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
    return { primary: rawPath, candidates: dedupe([rawPath, resolvedPath]) };
  }

  if (toolName === "mcp") {
    const target =
      typeof input.tool === "string"
        ? input.tool
        : typeof input.connect === "string"
          ? `connect:${input.connect}`
          : typeof input.describe === "string"
            ? `describe:${input.describe}`
            : typeof input.search === "string"
              ? `search:${input.search}`
              : typeof input.server === "string"
                ? `list:${input.server}`
                : typeof input.action === "string"
                  ? `action:${input.action}`
                  : "status";
    return { primary: target, candidates: dedupe([target]) };
  }

  try {
    const compact = JSON.stringify(input);
    const trimmed = compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
    return { primary: trimmed, candidates: dedupe([trimmed, compact]) };
  } catch {
    return { primary: "", candidates: [] };
  }
}

export function parseRule(rule: string): { toolPattern: string; targetPattern?: string } {
  const trimmed = normalizeRule(rule);
  const idx = trimmed.indexOf(":");
  if (idx === -1) return { toolPattern: trimmed };
  return {
    toolPattern: trimmed.slice(0, idx),
    targetPattern: trimmed.slice(idx + 1),
  };
}

export function ruleMatches(rule: string, toolName: string, target: RuleTarget): boolean {
  const { toolPattern, targetPattern } = parseRule(rule);
  if (!matches(toolName, toolPattern || "*")) return false;
  if (targetPattern === undefined) return true;
  return target.candidates.some((candidate) => matches(candidate, targetPattern));
}

export function findMatch(config: PermissionConfig, toolName: string, target: RuleTarget): MatchResult | undefined {
  for (const rule of config.deny ?? []) {
    if (ruleMatches(rule, toolName, target)) return { action: "deny", source: "default", rule };
  }
  for (const rule of config.ask ?? []) {
    if (ruleMatches(rule, toolName, target)) return { action: "ask", source: "default", rule };
  }
  for (const rule of config.allow ?? []) {
    if (ruleMatches(rule, toolName, target)) return { action: "allow", source: "default", rule };
  }
  return undefined;
}

export function evaluateRules(
  sessionRules: SessionRules,
  projectConfig: PermissionConfig,
  globalConfig: PermissionConfig,
  toolName: string,
  target: RuleTarget,
): MatchResult {
  const sessionMatch = findMatch(sessionRules, toolName, target);
  if (sessionMatch) return { ...sessionMatch, source: "session" };

  const projectMatch = findMatch(projectConfig, toolName, target);
  if (projectMatch) return { ...projectMatch, source: "project" };

  const globalMatch = findMatch(globalConfig, toolName, target);
  if (globalMatch) return { ...globalMatch, source: "global" };

  return {
    action: projectConfig.defaultAction ?? globalConfig.defaultAction ?? DEFAULT_GLOBAL_CONFIG.defaultAction ?? "allow",
    source: "default",
  };
}

export function ruleFromCall(event: { toolName: string; input: Record<string, any>; cwd: string }): string {
  const target = toolTarget(event).primary;
  if (!target) return event.toolName;
  return `${event.toolName}:${target}`;
}

function displayCall(event: { toolName: string; input: Record<string, any>; cwd: string }): string {
  const target = toolTarget(event).primary;
  if (!target) return event.toolName;
  return `${event.toolName} → ${target}`;
}

function updateStatus(ctx: any, enabled: boolean, showFooterStatus: boolean): void {
  if (!showFooterStatus) {
    ctx.ui.setStatus("claude-permissions", undefined);
    return;
  }

  const theme = ctx.ui.theme;
  if (!enabled) {
    ctx.ui.setStatus("claude-permissions", theme.fg("warning", "permissions:off"));
    return;
  }

  ctx.ui.setStatus("claude-permissions", theme.fg("success", "permissions:on"));
}

function showSummary(
  ctx: any,
  paths: { global: string; project: string },
  sessionRules: SessionRules,
  projectConfig: PermissionConfig,
  globalConfig: PermissionConfig,
  enabled: boolean,
  sessionDefaultAction?: PermissionAction,
  footerStatusEnabled = true,
): void {
  const lines = [
    `Permissions: ${enabled ? "enabled" : "disabled"}`,
    `Session default: ${sessionDefaultAction ?? "(none)"}`,
    `Footer status: ${footerStatusEnabled ? "enabled" : "disabled"}`,
    `Session allow/ask/deny: ${sessionRules.allow.length}/${sessionRules.ask.length}/${sessionRules.deny.length}`,
    `Project config: ${existsSync(paths.project) ? paths.project : "missing"}`,
    `Global config: ${existsSync(paths.global) ? paths.global : "missing"}`,
    `Project default: ${projectConfig.defaultAction ?? "(none)"}`,
    `Global default: ${globalConfig.defaultAction ?? "(none)"}`,
    `Project allow/ask/deny: ${(projectConfig.allow ?? []).length}/${(projectConfig.ask ?? []).length}/${(projectConfig.deny ?? []).length}`,
    `Global allow/ask/deny: ${(globalConfig.allow ?? []).length}/${(globalConfig.ask ?? []).length}/${(globalConfig.deny ?? []).length}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

function showHelp(ctx: any, paths: { global: string; project: string }): void {
  ctx.ui.notify(
    [
      "Commands:",
      "- /permissions",
      "- /permissions:on",
      "- /permissions:off",
      "- /permissions:ask",
      "- /permissions:allow",
      "- /permissions:deny",
      "- /permissions:init",
      "- /permissions:help",
      "Rule format:",
      "- tool_name",
      "- tool_name:target-pattern",
      "- *",
      "- *:target-pattern",
      "Examples:",
      "- tool_search",
      "- read:*",
      "- bash:git status*",
      "- bash:rm -rf*",
      "- mcp:github_*",
      "Config files:",
      `- Project: ${paths.project}`,
      `- Global: ${paths.global}`,
      "Starter project config:",
      JSON.stringify(STARTER_PROJECT_CONFIG, null, 2),
      "Notes:",
      "- Create starter config with /permissions:init",
      "- Agent bash tool calls use tool_call hook",
      "- User ! / !! bash commands are not affected by this extension",
    ].join("\n"),
    "info",
  );
}

async function promptForDecision(
  ctx: any,
  paths: { global: string; project: string },
  sessionRules: SessionRules,
  decision: MatchResult,
  callText: string,
  exactRule: string,
): Promise<{ allow: boolean; blockReason?: string }> {
  if (decision.action === "allow") return { allow: true };

  if (decision.action === "deny") {
    const reason = decision.rule
      ? `Blocked by ${decision.source} deny rule: ${decision.rule}`
      : `Blocked by ${decision.source} deny policy`;
    return { allow: false, blockReason: `${reason}\nCall: ${callText}` };
  }

  if (!ctx.hasUI) {
    return {
      allow: false,
      blockReason: [
        `Blocked in non-interactive mode.`,
        `Decision: ask`,
        `Call: ${callText}`,
        `Add allow rule: ${exactRule}`,
        `Project config: ${paths.project}`,
        `Global config: ${paths.global}`,
      ].join("\n"),
    };
  }

  const subtitle = decision.rule ? `Matched ${decision.source} ask rule: ${decision.rule}` : `Matched default action: ask`;
  const choice = await ctx.ui.select(`Permission required\n\n${callText}\n\n${subtitle}`, [...CHOICES]);

  if (choice === "Allow once") return { allow: true };

  if (choice === "Allow for session") {
    if (!sessionRules.allow.includes(exactRule)) sessionRules.allow.push(exactRule);
    ctx.ui.notify(`Allowed for session: ${exactRule}`, "info");
    return { allow: true };
  }

  if (choice === "Allow for project") {
    appendRule(paths.project, "allow", exactRule);
    ctx.ui.notify(`Allowed for project: ${exactRule}`, "info");
    return { allow: true };
  }

  if (choice === "Allow globally") {
    appendRule(paths.global, "allow", exactRule, DEFAULT_GLOBAL_CONFIG);
    ctx.ui.notify(`Allowed globally: ${exactRule}`, "info");
    return { allow: true };
  }

  if (choice === "Deny for session") {
    if (!sessionRules.deny.includes(exactRule)) sessionRules.deny.push(exactRule);
    return { allow: false, blockReason: `Blocked by session deny: ${exactRule}` };
  }

  if (choice === "Deny for project") {
    appendRule(paths.project, "deny", exactRule);
    return { allow: false, blockReason: `Blocked by project deny: ${exactRule}` };
  }

  if (choice === "Deny globally") {
    appendRule(paths.global, "deny", exactRule, DEFAULT_GLOBAL_CONFIG);
    return { allow: false, blockReason: `Blocked by global deny: ${exactRule}` };
  }

  return { allow: false, blockReason: "Cancelled by user" };
}


export function parseRuleMutationArgs(rawArgs: string): { action: PermissionAction; scope: "session" | "project" | "global"; rule: string } | null {
  const match = rawArgs.trim().match(/^(allow|ask|deny)\s+(session|project|global)\s+(.+)$/i);
  if (!match) return null;
  return {
    action: match[1].toLowerCase() as PermissionAction,
    scope: match[2].toLowerCase() as "session" | "project" | "global",
    rule: match[3].trim(),
  };
}

export function mutateSessionRule(sessionRules: SessionRules, action: PermissionAction, rule: string, add: boolean): boolean {
  const list = action === "allow" ? sessionRules.allow : action === "ask" ? sessionRules.ask : sessionRules.deny;
  if (add) {
    if (list.includes(rule)) return false;
    list.push(rule);
    return true;
  }
  const next = list.filter((entry) => entry !== rule);
  if (next.length === list.length) return false;
  list.length = 0;
  list.push(...next);
  return true;
}

export default function toolPermissionsExtension(pi: ExtensionAPI) {
  const sessionRules: SessionRules = { allow: [], ask: [], deny: [] };
  let enabled = true;
  let sessionDefaultAction: PermissionAction | undefined;

  function currentConfigs(ctx: any) {
    const paths = buildPaths(ctx.cwd);
    return {
      paths,
      globalConfig: readConfig(paths.global, DEFAULT_GLOBAL_CONFIG),
      projectConfig: readConfig(paths.project),
    };
  }

  function refreshStatus(ctx: any): void {
    const { globalConfig, projectConfig } = currentConfigs(ctx);
    updateStatus(ctx, enabled, projectConfig.footerStatus ?? globalConfig.footerStatus ?? true);
  }

  function setEnabled(ctx: any, next: boolean): void {
    enabled = next;
    refreshStatus(ctx);
    ctx.ui.notify(next ? "Permissions on" : "Permissions off for this session", next ? "info" : "warning");
  }

  function setMode(ctx: any, mode: PermissionAction): void {
    sessionDefaultAction = mode;
    refreshStatus(ctx);
    ctx.ui.notify(`Permission mode: ${mode} for this session`, "info");
  }

  function initProjectConfig(ctx: any, force = false): void {
    const paths = buildPaths(ctx.cwd);
    if (existsSync(paths.project) && !force) {
      ctx.ui.notify(`Project permission config already exists: ${paths.project}\nUse /permissions:init force to overwrite.`, "warning");
      return;
    }
    writeConfig(paths.project, STARTER_PROJECT_CONFIG);
    refreshStatus(ctx);
    ctx.ui.notify(`Created project permission config: ${paths.project}`, "info");
  }

  async function handlePermissionsCommand(args: string, ctx: any): Promise<void> {
    const { paths, globalConfig, projectConfig } = currentConfigs(ctx);
    const arg = args.trim().toLowerCase();

    if (arg === "on") return setEnabled(ctx, true);
    if (arg === "off") return setEnabled(ctx, false);
    if (arg === "init") return initProjectConfig(ctx);
    if (arg === "init force") return initProjectConfig(ctx, true);
    if (arg === "help") return showHelp(ctx, paths);

    if (arg.startsWith("mode ")) {
      const mode = arg.slice("mode ".length).trim();
      if (mode !== "allow" && mode !== "ask" && mode !== "deny") {
        ctx.ui.notify("Usage: /permissions mode <allow|ask|deny>", "warning");
        return;
      }
      return setMode(ctx, mode);
    }

    showSummary(ctx, paths, sessionRules, projectConfig, globalConfig, enabled, sessionDefaultAction, projectConfig.footerStatus ?? globalConfig.footerStatus ?? true);
  }

  const argumentCompletions = (prefix: string) => {
    const items = ["on", "off", "mode allow", "mode ask", "mode deny", "init", "init force", "help"].map((value) => ({
      value,
      label: value,
    }));
    return items.filter((item) => item.value.startsWith(prefix));
  };

  pi.registerCommand("permissions", {
    description: "Show tool permission config and session rules",
    getArgumentCompletions: argumentCompletions,
    handler: handlePermissionsCommand,
  });

  pi.registerCommand("permissions:help", {
    description: "Show permission help",
    handler: async (_args, ctx) => showHelp(ctx, buildPaths(ctx.cwd)),
  });

  pi.registerCommand("permissions:init", {
    description: "Create starter project permission config",
    handler: async (args, ctx) => initProjectConfig(ctx, args.trim().toLowerCase() === "force"),
  });

  pi.registerCommand("permissions:on", {
    description: "Enable permission checks for this session",
    handler: async (_args, ctx) => setEnabled(ctx, true),
  });

  pi.registerCommand("permissions:off", {
    description: "Disable permission checks for this session",
    handler: async (_args, ctx) => setEnabled(ctx, false),
  });

  pi.registerCommand("permissions:allow", {
    description: "Set permission fallback mode to allow for this session",
    handler: async (_args, ctx) => setMode(ctx, "allow"),
  });

  pi.registerCommand("permissions:ask", {
    description: "Set permission fallback mode to ask for this session",
    handler: async (_args, ctx) => setMode(ctx, "ask"),
  });

  pi.registerCommand("permissions:deny", {
    description: "Set permission fallback mode to deny for this session",
    handler: async (_args, ctx) => setMode(ctx, "deny"),
  });

  pi.on("session_start", (_event, ctx) => {
    sessionRules.allow.length = 0;
    sessionRules.ask.length = 0;
    sessionRules.deny.length = 0;

    const paths = buildPaths(ctx.cwd);
    const globalConfig = readConfig(paths.global, DEFAULT_GLOBAL_CONFIG);
    const projectConfig = readConfig(paths.project);
    const defaultAction = projectConfig.defaultAction ?? globalConfig.defaultAction ?? "allow";

    enabled = true;
    sessionDefaultAction = undefined;
    updateStatus(ctx, enabled, projectConfig.footerStatus ?? globalConfig.footerStatus ?? true);
    ctx.ui.notify(`claude-permissions: default=${defaultAction}, tool_search allowed`, "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = (event.input ?? {}) as Record<string, any>;
    if (!enabled) return undefined;

    const target = toolTarget({ toolName, input, cwd: ctx.cwd });
    const paths = buildPaths(ctx.cwd);
    const globalConfig = readConfig(paths.global, DEFAULT_GLOBAL_CONFIG);
    const projectConfig = readConfig(paths.project);
    const effectiveProjectConfig = sessionDefaultAction ? { ...projectConfig, defaultAction: sessionDefaultAction } : projectConfig;
    const decision = evaluateRules(sessionRules, effectiveProjectConfig, globalConfig, toolName, target);
    const callText = displayCall({ toolName, input, cwd: ctx.cwd });
    const exactRule = ruleFromCall({ toolName, input, cwd: ctx.cwd });
    const prompt = await promptForDecision(ctx, paths, sessionRules, decision, callText, exactRule);
    updateStatus(ctx, enabled, projectConfig.footerStatus ?? globalConfig.footerStatus ?? true);

    if (prompt.allow) return undefined;
    return { block: true, reason: prompt.blockReason ?? "Cancelled by user" };
  });

}
