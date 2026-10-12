import { describe, expect, test } from "vitest";
import type { TranscriptSession } from "../src/transcripts.ts";
import { prepareUsage } from "../src/usage.ts";
import {
  assistant,
  bookkeeping,
  cyclePrompt,
  failedToolCall,
  interruption,
  notification,
  prompt,
  queueOperation,
  session,
  skillLoad,
  systemNotice,
  toolResult,
  worktree,
} from "./support/transcripts.ts";

const summariseUsage = (
  sessions: ReadonlyArray<TranscriptSession>,
  options: { readonly since?: Date } = {},
) => prepareUsage(sessions).summary(options);

const weeklyUsage = (sessions: ReadonlyArray<TranscriptSession>) => prepareUsage(sessions).weeks();

const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 9, 1, 9, 0) + minutes * 60_000).toISOString();

const featureNames = (sessions: Parameters<typeof summariseUsage>[0]) =>
  summariseUsage(sessions).features.map((f) => f.feature);

describe("summariseUsage: which feature a session belongs to", () => {
  test("a cycled session belongs to the task its cycle prompt names, wherever it then worked", () => {
    const cycled = session({
      records: [
        bookkeeping(),
        cyclePrompt({ slug: "new-templates", at: at(0) }),
        assistant({ at: at(1), cwd: worktree("acme-backend", "other-task") }),
      ],
    });

    expect(featureNames([cycled])).toEqual(["new-templates"]);
  });

  test("an uncycled session belongs to the worktree it worked in most", () => {
    const uncycled = session({
      records: [
        prompt({ at: at(0) }),
        assistant({ at: at(1), cwd: worktree("acme-frontend", "cohort-graph") }),
        assistant({ at: at(2), cwd: worktree("acme-frontend", "cohort-graph") }),
        assistant({ at: at(3), cwd: worktree("acme-backend", "excel-export") }),
      ],
    });

    expect(featureNames([uncycled])).toEqual(["cohort-graph"]);
  });

  test("worktree paths in tool calls count as working there", () => {
    const viaAbsolutePaths = session({
      records: [
        prompt({ at: at(0) }),
        assistant({
          at: at(1),
          toolInputs: [{ command: `git -C ${worktree("acme-backend", "excel-export")} status` }],
        }),
      ],
    });

    expect(featureNames([viaAbsolutePaths])).toEqual(["excel-export"]);
  });

  test("a session that never touched a worktree is grouped under the folder it ran in", () => {
    const hub = session({ records: [prompt({ at: at(0), cwd: "/home/me/Code/acme" })] });

    expect(featureNames([hub])).toEqual(["(acme)"]);
  });

  test("backend and frontend sessions of one task are one feature", () => {
    const {
      features: [feature, ...others],
    } = summariseUsage([
      session({ records: [assistant({ at: at(0), cwd: worktree("acme-backend", "auth") })] }),
      session({ records: [assistant({ at: at(0), cwd: worktree("acme-frontend", "auth") })] }),
    ]);

    expect(others).toEqual([]);
    expect(feature).toMatchObject({ feature: "auth", sessions: 2 });
  });
});

describe("summariseUsage: prompts", () => {
  test("counts only what the human typed, not tool results or notifications", () => {
    const {
      features: [feature],
    } = summariseUsage([
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1) }),
          toolResult({ at: at(2) }),
          notification({ at: at(3) }),
          prompt({ at: at(4), text: "continue" }),
        ],
      }),
    ]);

    expect(feature?.prompts).toBe(2);
  });
});

const onlyFeature = (...sessions: Parameters<typeof summariseUsage>[0]) => {
  const { features } = summariseUsage(sessions);
  expect(features).toHaveLength(1);
  return features[0];
};

const OPUS_OUTPUT_PER_DOLLAR = 50_000;
const costing = (dollars: number) => ({ output: dollars * OPUS_OUTPUT_PER_DOLLAR });

describe("summariseUsage: active time", () => {
  test("adds up the time between records, counting at most five minutes of any idle gap", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1) }),
          bookkeeping(),
          prompt({ at: at(21) }),
          systemNotice({ at: at(21) }),
        ],
      }),
    );

    expect(feature?.activeSeconds).toBe(60 + 300);
  });

  test("a subagent working through the parent's silence keeps the session active", () => {
    const feature = onlyFeature(
      session({
        records: [cyclePrompt({ slug: "auth", at: at(0) }), assistant({ at: at(20) })],
        subagents: [[4, 8, 12, 16].map((m) => assistant({ at: at(m) }))],
      }),
    );

    expect(feature?.activeSeconds).toBe(20 * 60);
  });
});

describe("summariseUsage: cost", () => {
  test("prices every kind of token at the model's API rate", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({
            at: at(1),
            model: "claude-opus-5-5",
            tokens: {
              input: 1_000_000,
              output: 100_000,
              cacheRead: 2_000_000,
              cacheWrite5m: 400_000,
              cacheWrite1h: 250_000,
            },
          }),
        ],
      }),
    );

    expect(feature?.costUsd).toBeCloseTo(4 + 2 + 0.4 + 2 + 2);
  });

  test("a response recorded once per content block is paid for once", () => {
    const repeated = assistant({ at: at(1), id: "same", tokens: costing(1) });
    const feature = onlyFeature(
      session({ records: [cyclePrompt({ slug: "auth", at: at(0) }), repeated, repeated] }),
    );

    expect(feature?.costUsd).toBeCloseTo(1);
  });

  test("a dated model id is priced like its model", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({
            at: at(1),
            model: "claude-haiku-4-5-20251001",
            tokens: { output: 1_000_000 },
          }),
        ],
      }),
    );

    expect(feature?.costUsd).toBeCloseTo(5);
  });

  test("includes what the session's subagents spent", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), tokens: costing(1) }),
        ],
        subagents: [[assistant({ at: at(2), tokens: costing(2) })]],
      }),
    );

    expect(feature?.costUsd).toBeCloseTo(3);
  });

  test.for([
    { model: "claude-zeta-9", tokens: { output: 10 }, unpriced: ["claude-zeta-9"] },
    { model: "<synthetic>", tokens: {}, unpriced: [] },
    { model: "claude-opus-5-5", tokens: { output: 10 }, unpriced: [] },
  ])("lists $model as unpriced only when it used tokens", ({ model, tokens, unpriced }) => {
    const { unpricedModels } = summariseUsage([
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), model, tokens }),
        ],
      }),
    ]);

    expect(unpricedModels).toEqual(unpriced);
  });
});

describe("summariseUsage: split by repo", () => {
  test("time and cost go to the repo last worked in for this task, else the folder the session ran in", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), tokens: costing(1) }),
          assistant({ at: at(2), cwd: worktree("acme-backend", "auth"), tokens: costing(2) }),
          assistant({ at: at(3), cwd: worktree("acme-mobile", "other-task"), tokens: costing(1) }),
          assistant({
            at: at(4),
            toolInputs: [{ file_path: `${worktree("acme-frontend", "auth")}/src/App.tsx` }],
            tokens: costing(4),
          }),
          assistant({ at: at(5), tokens: costing(0.5) }),
        ],
      }),
    );

    expect(feature?.repos).toMatchObject([
      { repo: "acme", activeSeconds: 60, costUsd: expect.closeTo(1) },
      { repo: "acme-backend", activeSeconds: 120, costUsd: expect.closeTo(3) },
      { repo: "acme-frontend", activeSeconds: 120, costUsd: expect.closeTo(4.5) },
    ]);
  });

  test("a session launched inside a worktree starts in that worktree's repo, not in a repo named after the task", () => {
    const feature = onlyFeature(
      session({
        records: [
          queueOperation({ at: at(0) }),
          queueOperation({ at: at(1) }),
          assistant({ at: at(2), cwd: worktree("acme-backend", "auth"), tokens: costing(1) }),
        ],
      }),
    );

    expect(feature?.repos.map((r) => r.repo)).toEqual(["acme-backend"]);
  });

  test("a repo whose folder name has spaces still has its worktrees recognised", () => {
    const feature = onlyFeature(
      session({
        records: [
          queueOperation({ at: at(0) }),
          queueOperation({ at: at(1) }),
          assistant({ at: at(2), cwd: worktree("Ping Pong", "me-card"), tokens: costing(1) }),
        ],
      }),
    );

    expect(feature).toMatchObject({ feature: "me-card", repos: [{ repo: "Ping Pong" }] });
  });

  test("a space in a tool call separates arguments, it does not join them into one repo name", () => {
    const feature = onlyFeature(
      session({
        records: [
          assistant({
            at: at(0),
            cwd: worktree("acme-backend", "auth"),
            toolInputs: [
              {
                command:
                  "cat /home/me/Code/acme/.claude/handoffs/auth.md acme-frontend/.claude/worktrees/auth/plan.md",
              },
            ],
            tokens: costing(1),
          }),
        ],
      }),
    );

    expect(feature?.repos.map((r) => r.repo)).toEqual(["acme-backend"]);
  });
});

describe("summariseUsage: split by repo, passing through", () => {
  test.for([
    { reason: "neither time nor cost", firstCost: 0, listed: ["acme-frontend"] },
    { reason: "cost but no time", firstCost: 1, listed: ["acme-backend", "acme-frontend"] },
  ])("a repo it touched with $reason is listed only if it cost something", ({
    firstCost,
    listed,
  }) => {
    const feature = onlyFeature(
      session({
        records: [
          assistant({
            at: at(0),
            cwd: worktree("acme-backend", "auth"),
            tokens: costing(firstCost),
          }),
          assistant({ at: at(1), cwd: worktree("acme-frontend", "auth"), tokens: costing(1) }),
        ],
      }),
    );

    expect(feature?.repos.map((r) => r.repo)).toEqual(listed);
  });
});

describe("summariseUsage: across sessions", () => {
  test("a session with no recorded activity is not counted", () => {
    const stub = session({ records: [bookkeeping()] });
    const real = session({ records: [prompt({ at: at(0) }), assistant({ at: at(1) })] });

    expect(summariseUsage([stub, real]).features).toMatchObject([
      { feature: "(acme)", sessions: 1 },
    ]);
  });

  test("a feature spans from its first to its last activity", () => {
    const feature = onlyFeature(
      session({ records: [cyclePrompt({ slug: "auth", at: at(60) }), assistant({ at: at(61) })] }),
      session({ records: [cyclePrompt({ slug: "auth", at: at(0) }), assistant({ at: at(1) })] }),
    );

    expect(feature).toMatchObject({ firstActive: at(0), lastActive: at(61) });
  });

  test("lists the most expensive feature first", () => {
    const { features } = summariseUsage([
      session({
        records: [
          cyclePrompt({ slug: "cheap", at: at(0) }),
          assistant({ at: at(1), tokens: costing(1) }),
        ],
      }),
      session({
        records: [
          cyclePrompt({ slug: "dear", at: at(0) }),
          assistant({ at: at(1), tokens: costing(3) }),
        ],
      }),
    ]);

    expect(features.map((f) => f.feature)).toEqual(["dear", "cheap"]);
  });
});

describe("summariseUsage: context size", () => {
  test("cost spent with more than 200k tokens of context is counted as large-context", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), tokens: { cacheRead: 200_000, ...costing(1) } }),
          assistant({ at: at(2), tokens: { cacheRead: 200_001, ...costing(2) } }),
        ],
      }),
    );

    expect(feature?.largeContextCostUsd).toBeCloseTo(2.04);
    expect(feature?.repos[0]?.largeContextCostUsd).toBeCloseTo(2.04);
  });

  test("context at session end averages each session's last call, subagents aside", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), tokens: { cacheRead: 500_000 } }),
          assistant({
            at: at(2),
            tokens: { input: 1_000, cacheRead: 90_000, cacheWrite5m: 9_000 },
          }),
          prompt({ at: at(3) }),
        ],
        subagents: [[assistant({ at: at(4), tokens: { cacheRead: 900_000 } })]],
      }),
      session({ records: [cyclePrompt({ slug: "auth", at: at(5) })] }),
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(10) }),
          assistant({ at: at(11), tokens: { cacheRead: 280_000, cacheWrite1h: 20_000 } }),
        ],
      }),
    );

    expect(feature?.endContextTokens).toBe(200_000);
  });

  test("a feature whose sessions made no calls has no end context", () => {
    const feature = onlyFeature(session({ records: [cyclePrompt({ slug: "auth", at: at(0) })] }));

    expect(feature?.endContextTokens).toBeUndefined();
  });
});

describe("summariseUsage: what cycling at 200k would have saved", () => {
  const callsAt = (contextTokens: number, count: number, startMinute = 1) =>
    Array.from({ length: count }, (_, i) =>
      assistant({ at: at(startMinute + i / 10), tokens: { cacheRead: contextTokens } }),
    );

  test.for([
    {
      reason: "a session that barely passes 200k, where the cycle would cost more",
      calls: [...callsAt(100_000, 1), ...callsAt(210_000, 1, 2)],
      savings: 0,
    },
    {
      reason:
        "a long session: re-reading above 130k, less one cache write per 140k grown past 200k",
      calls: [...callsAt(100_000, 10), ...callsAt(200_000, 1, 3), ...callsAt(400_000, 30, 4)],
      savings: 30 * 0.054 - 2 * 0.48,
    },
  ])("$reason", ({ calls, savings }) => {
    const feature = onlyFeature(
      session({
        records: [cyclePrompt({ slug: "auth", at: at(0) }), ...calls],
        subagents: [callsAt(900_000, 5)],
      }),
    );

    expect(feature?.cyclingSavingsUsd).toBeCloseTo(savings);
    expect(feature?.repos[0]?.cyclingSavingsUsd ?? 0).toBeCloseTo(savings);
  });
});

describe("summariseUsage: thinking", () => {
  test("prices thinking tokens as the output they are billed as", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), tokens: { output: 100_000, thinking: 40_000 } }),
        ],
      }),
    );

    expect(feature?.thinkingCostUsd).toBeCloseTo(0.8);
    expect(feature?.repos[0]?.thinkingCostUsd).toBeCloseTo(0.8);
  });
});

describe("summariseUsage: where the cost goes", () => {
  test("splits each call's cost into re-reading, storing, uncached input, answers and thinking", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({
            at: at(1),
            tokens: {
              input: 1_000_000,
              cacheRead: 2_000_000,
              cacheWrite5m: 400_000,
              cacheWrite1h: 250_000,
              output: 100_000,
              thinking: 40_000,
            },
          }),
        ],
      }),
    );

    expect(feature?.repos[0]).toMatchObject({
      cacheReadCostUsd: expect.closeTo(0.4),
      cacheWriteCostUsd: expect.closeTo(2 + 2),
      inputCostUsd: expect.closeTo(4),
      answerCostUsd: expect.closeTo(1.2),
      thinkingCostUsd: expect.closeTo(0.8),
      costUsd: expect.closeTo(0.4 + 4 + 4 + 1.2 + 0.8),
    });
  });
});

describe("summariseUsage: standing context", () => {
  test("what 10k more tokens re-read on every call would have cost, per model", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1), model: "claude-opus-5-5" }),
          assistant({ at: at(2), model: "claude-opus-5" }),
        ],
      }),
    );

    expect(feature?.standingCostPer10kUsd).toBeCloseTo(0.002 + 0.005, 5);
  });

  test("sessions start at the median context of their first call, subagents aside", () => {
    const startingAt = (contextTokens: number, minute: number) =>
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(minute) }),
          assistant({ at: at(minute + 1), tokens: { cacheRead: contextTokens } }),
          assistant({ at: at(minute + 2), tokens: { cacheRead: 900_000 } }),
        ],
        subagents: [[assistant({ at: at(minute), tokens: { cacheRead: 1_000 } })]],
      });

    const { sessionStartTokens } = summariseUsage([
      startingAt(50_000, 0),
      startingAt(70_000, 10),
      startingAt(54_000, 20),
    ]);

    expect(sessionStartTokens).toBe(54_000);
  });
});

describe("summariseUsage: skills", () => {
  test("counts each skill's loads and what re-reading its text cost in the calls after", () => {
    const header = "Base directory for this skill: /home/me/.claude/skills/";
    const body = (skill: string, tokens: number) =>
      "x".repeat(tokens * 4 - header.length - skill.length - 2);

    const { skills } = summariseUsage([
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1) }),
          ...skillLoad({ at: at(2), skill: "tdd", body: body("tdd", 10_000) }),
          assistant({ at: at(3) }),
          assistant({ at: at(4), id: "repeated" }),
          assistant({ at: at(4), id: "repeated" }),
          ...skillLoad({ at: at(5), skill: "testing", body: body("testing", 5_000) }),
          assistant({ at: at(6) }),
        ],
      }),
    ]);

    expect(skills).toEqual([
      { skill: "tdd", loads: 1, tokens: 10_000, rereadCostUsd: expect.closeTo(0.006, 5) },
      { skill: "testing", loads: 1, tokens: 5_000, rereadCostUsd: expect.closeTo(0.001, 5) },
    ]);
  });
});

describe("summariseUsage: agents", () => {
  test("counts each agent type's runs and what they cost, costliest first", () => {
    const run = (agentType: string, dollars: number) => ({
      agentType,
      records: [
        assistant({ at: at(2), tokens: costing(dollars / 2) }),
        assistant({ at: at(3), tokens: costing(dollars / 2) }),
      ],
    });

    const { agents } = summariseUsage([
      session({
        records: [cyclePrompt({ slug: "auth", at: at(0) }), assistant({ at: at(1) })],
        agents: [run("Explore", 0.5), run("plan-conformance", 2), run("plan-conformance", 1)],
      }),
    ]);

    expect(agents).toEqual([
      { agentType: "plan-conformance", runs: 2, costUsd: expect.closeTo(3) },
      { agentType: "Explore", runs: 1, costUsd: expect.closeTo(0.5) },
    ]);
  });
});

describe("summariseUsage: whose turn", () => {
  test("the time before each prompt you type is your turn, idle cap included", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1) }),
          prompt({ at: at(4) }),
          assistant({ at: at(5) }),
          prompt({ at: at(25) }),
        ],
      }),
    );

    expect(feature).toMatchObject({ activeSeconds: 600, waitingSeconds: 180 + 300 });
    expect(feature?.repos[0]?.waitingSeconds).toBe(480);
  });
});

const NO_FRICTION = {
  denied: 0,
  staleEdits: 0,
  editMismatches: 0,
  guardrailBlocks: 0,
  autoModeBlocks: 0,
  safetyCheckUnavailable: 0,
  zshTraps: 0,
  missingToolVersions: 0,
  browserErrors: 0,
  missingFiles: 0,
  serviceErrors: 0,
  failedCommands: 0,
  interruptions: 0,
};

describe("summariseUsage: friction", () => {
  test.for([
    {
      kind: "a call you denied",
      tool: "Bash",
      input: { command: "rm -rf tmp" },
      result: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      friction: { denied: 1 },
    },
    {
      kind: "an edit refused because the file changed",
      tool: "Edit",
      input: { file_path: "/x.ts" },
      result:
        "<tool_use_error>File has been modified since read, either by the user or by a linter.",
      friction: { staleEdits: 1 },
    },
    {
      kind: "an edit whose text did not match",
      tool: "Edit",
      input: { file_path: "/x.ts" },
      result: "<tool_use_error>String to replace not found in file.",
      friction: { editMismatches: 1 },
    },
    {
      kind: "a call a hook blocked",
      tool: "Bash",
      input: { command: "git worktree add ../x" },
      result: "PreToolUse:Bash hook error: [worktree-guard.sh]: Blocked: git worktree add",
      friction: { guardrailBlocks: 1 },
    },
    {
      kind: "a call blocked because the safety check had no verdict",
      tool: "Agent",
      input: {},
      result:
        "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Agent",
      friction: { safetyCheckUnavailable: 1 },
    },
    {
      kind: "a call auto mode refused",
      tool: "Bash",
      input: { command: "git merge origin/master" },
      result:
        "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [External System Writes]",
      friction: { autoModeBlocks: 1 },
    },
    {
      kind: "a zsh-only trap",
      tool: "Bash",
      input: { command: "cat notes.md; echo =====; grep -n plan notes.md" },
      result: "Exit code 1\n# Notes\n(eval):1: ===== not found",
      friction: { zshTraps: 1 },
    },
    {
      kind: "a command with no tool version set",
      tool: "Bash",
      input: { command: "python3 - <<'EOF'" },
      result: "Exit code 126\nNo version is set for command python3",
      friction: { missingToolVersions: 1 },
    },
    {
      kind: "a browser automation error",
      tool: "mcp__plugin_playwright_playwright__browser_navigate",
      input: { url: "http://localhost:3003" },
      result: "### Error Error: net::ERR_CONNECTION_REFUSED at http://localhost:3003",
      friction: { browserErrors: 1 },
    },
    {
      kind: "a file that did not exist",
      tool: "Read",
      input: { file_path: "/nope.ts" },
      result: "File does not exist.",
      friction: { missingFiles: 1 },
    },
    {
      kind: "a connector that refused",
      tool: "mcp__Todoist__delete-object",
      input: {},
      result: "Todoist API request failed (HTTP 403).",
      friction: { serviceErrors: 1 },
    },
    {
      kind: "a failed command",
      tool: "Bash",
      input: { command: "git push" },
      result: "Exit code 1\nerror: failed to push some refs",
      friction: { failedCommands: 1 },
    },
    {
      kind: "a search that found nothing",
      tool: "Bash",
      input: { command: "cd /repo && grep -rn missing src" },
      result: "Exit code 1",
      friction: {},
    },
    {
      kind: "claude-dev cycle ending its own session",
      tool: "Bash",
      input: { command: "claude-dev cycle" },
      result: "Exit code 137",
      friction: {},
    },
    {
      kind: "a failing test run",
      tool: "Bash",
      input: { command: "bin/rails test test/models/invoice_test.rb" },
      result: "Exit code 1\n1 runs, 1 failures",
      friction: {},
    },
  ])("counts $kind", ({ tool, input, result, friction }) => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          ...failedToolCall({ at: at(1), tool, input, result }),
        ],
      }),
    );

    expect(feature?.friction).toEqual({ ...NO_FRICTION, ...friction });
  });

  test("counts interruptions, and subagents' failures with the session's", () => {
    const feature = onlyFeature(
      session({
        records: [
          cyclePrompt({ slug: "auth", at: at(0) }),
          assistant({ at: at(1) }),
          interruption({ at: at(2) }),
        ],
        subagents: [
          failedToolCall({ at: at(3), input: { command: "make" }, result: "Exit code 2" }),
        ],
      }),
    );

    expect(feature?.friction).toEqual({ ...NO_FRICTION, failedCommands: 1, interruptions: 1 });
  });
});

describe("summariseUsage: from a start date", () => {
  test("only activity from the start date on counts", () => {
    const { features } = summariseUsage(
      [
        session({
          records: [
            cyclePrompt({ slug: "auth", at: at(0) }),
            assistant({ at: at(1), tokens: costing(1) }),
            toolResult({ at: at(2), isError: true }),
            prompt({ at: at(60) }),
            assistant({ at: at(61), tokens: costing(2) }),
          ],
        }),
      ],
      { since: new Date(at(60)) },
    );

    expect(features).toMatchObject([
      {
        feature: "auth",
        costUsd: expect.closeTo(2),
        prompts: 1,
        friction: NO_FRICTION,
        activeSeconds: 60,
        firstActive: at(60),
      },
    ]);
  });

  test("a session with nothing since the start date is left out", () => {
    const old = session({
      records: [cyclePrompt({ slug: "auth", at: at(0) }), assistant({ at: at(1) })],
    });

    expect(summariseUsage([old], { since: new Date(at(60)) }).features).toEqual([]);
  });
});

describe("weeklyUsage", () => {
  test("no activity means no weeks", () => {
    expect(weeklyUsage([session({ records: [bookkeeping()] })])).toEqual([]);
  });

  test("adds up each Monday-to-Sunday week's cost per repo, empty weeks included", () => {
    const weeks = weeklyUsage([
      session({
        records: [
          bookkeeping(),
          cyclePrompt({ slug: "auth", at: "2026-09-30T12:00:00Z" }),
          assistant({
            at: "2026-09-30T12:01:00Z",
            cwd: worktree("acme-backend", "auth"),
            tokens: costing(1),
          }),
          assistant({
            at: "2026-10-04T12:00:00Z",
            cwd: worktree("acme-backend", "auth"),
            tokens: costing(2),
          }),
        ],
      }),
      session({
        records: [
          cyclePrompt({ slug: "auth", at: "2026-10-13T12:00:00Z" }),
          assistant({
            at: "2026-10-13T12:01:00Z",
            cwd: worktree("acme-frontend", "auth"),
            tokens: costing(3),
          }),
        ],
      }),
    ]);

    expect(weeks).toMatchObject([
      { weekStart: "2026-09-28", repos: [{ repo: "acme-backend", costUsd: expect.closeTo(3) }] },
      { weekStart: "2026-10-05", repos: [] },
      { weekStart: "2026-10-12", repos: [{ repo: "acme-frontend", costUsd: expect.closeTo(3) }] },
    ]);
  });
});

describe("summariseUsage: by day of the week", () => {
  const dayOfWork = ({ repo, day, dollars }: { repo: string; day: string; dollars: number }) =>
    session({
      records: [
        cyclePrompt({ slug: "auth", at: `${day}T12:00:00Z` }),
        assistant({
          at: `${day}T12:02:00Z`,
          cwd: worktree(repo, "auth"),
          tokens: costing(dollars),
        }),
      ],
    });

  test("splits each weekday into the dates worked within the range, per repo, Monday first", () => {
    const { weekdays } = summariseUsage(
      [
        dayOfWork({ repo: "acme-backend", day: "2026-09-28", dollars: 8 }),
        dayOfWork({ repo: "acme-backend", day: "2026-09-30", dollars: 1 }),
        dayOfWork({ repo: "acme-frontend", day: "2026-10-04", dollars: 4 }),
        dayOfWork({ repo: "acme-backend", day: "2026-10-07", dollars: 2 }),
      ],
      { since: new Date("2026-09-29T00:00:00Z") },
    );

    expect(weekdays).toMatchObject([
      { days: [] },
      { days: [] },
      {
        days: [
          {
            date: "2026-09-30",
            repos: [{ repo: "acme-backend", costUsd: expect.closeTo(1), activeSeconds: 120 }],
          },
          {
            date: "2026-10-07",
            repos: [{ repo: "acme-backend", costUsd: expect.closeTo(2), activeSeconds: 120 }],
          },
        ],
      },
      { days: [] },
      { days: [] },
      { days: [] },
      {
        days: [
          {
            date: "2026-10-04",
            repos: [{ repo: "acme-frontend", costUsd: expect.closeTo(4), activeSeconds: 120 }],
          },
        ],
      },
    ]);
  });
});
