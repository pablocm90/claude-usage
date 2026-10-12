import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TranscriptRecord,
  TranscriptRecordSchema,
  type TranscriptSession,
} from "../../src/transcripts.ts";

const WORKSPACE = "/home/me/Code/acme";

type SessionFixture = {
  readonly project: string;
  readonly sessionId: string;
  readonly records: ReadonlyArray<TranscriptRecord | string>;
  readonly subagents?: ReadonlyArray<ReadonlyArray<TranscriptRecord>>;
  readonly agents?: ReadonlyArray<{
    readonly agentType: string;
    readonly records: ReadonlyArray<TranscriptRecord>;
  }>;
};

const toJsonl = (records: ReadonlyArray<TranscriptRecord | string>): string =>
  records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");

export const writeProjectsDir = (sessions: ReadonlyArray<SessionFixture>): string => {
  const root = mkdtempSync(join(tmpdir(), "claude-usage-"));
  for (const { project, sessionId, records, subagents = [], agents = [] } of sessions) {
    mkdirSync(join(root, project), { recursive: true });
    writeFileSync(join(root, project, `${sessionId}.jsonl`), toJsonl(records));
    subagents.forEach((sub, i) => {
      mkdirSync(join(root, project, sessionId, "subagents"), { recursive: true });
      writeFileSync(join(root, project, sessionId, "subagents", `agent-${i}.jsonl`), toJsonl(sub));
    });
    agents.forEach(({ agentType, records: agentRecords }, i) => {
      const dir = join(root, project, sessionId, "subagents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-typed${i}.jsonl`), toJsonl(agentRecords));
      writeFileSync(join(dir, `agent-typed${i}.meta.json`), JSON.stringify({ agentType }));
    });
  }
  return root;
};

export const worktree = (repo: string, slug: string): string =>
  `${WORKSPACE}/${repo}/.claude/worktrees/${slug}`;

type PromptOptions = { readonly text?: string; readonly at: string; readonly cwd?: string };

export const prompt = ({ text = "go", at, cwd = WORKSPACE }: PromptOptions): TranscriptRecord =>
  TranscriptRecordSchema.parse({
    type: "user",
    timestamp: at,
    cwd,
    origin: { kind: "human" },
    message: { role: "user", content: text },
  });

export const cyclePrompt = ({ slug, at }: { readonly slug: string; readonly at: string }) =>
  prompt({
    at,
    text: `Fresh session for task '${slug}'. Read ${WORKSPACE}/.claude/handoffs/${slug}.md and the plan it references.`,
  });

export const notification = ({ at }: { readonly at: string }): TranscriptRecord =>
  TranscriptRecordSchema.parse({
    type: "user",
    timestamp: at,
    cwd: WORKSPACE,
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>done</task-notification>" },
  });

type ToolResultOptions = { readonly at: string; readonly cwd?: string; readonly isError?: boolean };

export const toolResult = ({ at, cwd = WORKSPACE, isError = false }: ToolResultOptions) =>
  TranscriptRecordSchema.parse({
    type: "user",
    timestamp: at,
    cwd,
    message: {
      role: "user",
      content: [
        { type: "tool_result", content: isError ? "Exit code 1" : "ok", is_error: isError },
      ],
    },
  });

export const interruption = ({ at }: { readonly at: string }): TranscriptRecord =>
  TranscriptRecordSchema.parse({
    type: "user",
    timestamp: at,
    cwd: WORKSPACE,
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });

type Tokens = {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly thinking?: number;
};

type AssistantOptions = {
  readonly at: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly tokens?: Tokens;
  readonly toolInputs?: ReadonlyArray<Record<string, unknown>>;
  readonly id?: string;
};

export const assistant = ({
  at,
  cwd = WORKSPACE,
  model = "claude-opus-5-5",
  tokens = {},
  toolInputs = [],
  id = randomUUID(),
}: AssistantOptions): TranscriptRecord =>
  TranscriptRecordSchema.parse({
    type: "assistant",
    timestamp: at,
    cwd,
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      model,
      content: [
        { type: "text", text: "working" },
        ...toolInputs.map((input) => ({ type: "tool_use", name: "Bash", input })),
      ],
      usage: {
        input_tokens: tokens.input ?? 0,
        output_tokens: tokens.output ?? 0,
        cache_read_input_tokens: tokens.cacheRead ?? 0,
        cache_creation_input_tokens: (tokens.cacheWrite5m ?? 0) + (tokens.cacheWrite1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: tokens.cacheWrite5m ?? 0,
          ephemeral_1h_input_tokens: tokens.cacheWrite1h ?? 0,
        },
        output_tokens_details: { thinking_tokens: tokens.thinking ?? 0 },
      },
    },
  });

type SessionOptions = {
  readonly records: ReadonlyArray<TranscriptRecord>;
  readonly subagents?: ReadonlyArray<ReadonlyArray<TranscriptRecord>>;
  readonly agents?: TranscriptSession["subagents"];
};

export const session = ({
  records,
  subagents = [],
  agents = [],
}: SessionOptions): TranscriptSession => ({
  project: "-home-me-Code-acme",
  sessionId: randomUUID(),
  records,
  subagents: [
    ...subagents.map((agentRecords) => ({ agentType: "general-purpose", records: agentRecords })),
    ...agents,
  ],
});

export const bookkeeping = (): TranscriptRecord =>
  TranscriptRecordSchema.parse({ type: "file-history-snapshot" });

export const systemNotice = ({ at }: { readonly at: string }): TranscriptRecord =>
  TranscriptRecordSchema.parse({ type: "system", timestamp: at, cwd: WORKSPACE });

export const queueOperation = ({ at }: { readonly at: string }): TranscriptRecord =>
  TranscriptRecordSchema.parse({ type: "queue-operation", timestamp: at });

type ToolCallOptions = {
  readonly at: string;
  readonly tool?: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
};

export const failedToolCall = ({
  at,
  tool = "Bash",
  input,
  result,
}: ToolCallOptions): ReadonlyArray<TranscriptRecord> => {
  const id = `toolu_${randomUUID()}`;
  return [
    TranscriptRecordSchema.parse({
      type: "assistant",
      timestamp: at,
      cwd: WORKSPACE,
      message: { content: [{ type: "tool_use", id, name: tool, input }] },
    }),
    TranscriptRecordSchema.parse({
      type: "user",
      timestamp: at,
      cwd: WORKSPACE,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: true }],
      },
    }),
  ];
};

export const skillLoad = ({
  at,
  skill,
  body,
}: {
  readonly at: string;
  readonly skill: string;
  readonly body: string;
}): ReadonlyArray<TranscriptRecord> => [
  TranscriptRecordSchema.parse({
    type: "assistant",
    timestamp: at,
    cwd: WORKSPACE,
    message: {
      content: [{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "Skill", input: { skill } }],
    },
  }),
  TranscriptRecordSchema.parse({
    type: "user",
    timestamp: at,
    cwd: WORKSPACE,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `Base directory for this skill: /home/me/.claude/skills/${skill}\n\n${body}`,
        },
      ],
    },
  }),
];
