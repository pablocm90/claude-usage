import { basename } from "node:path";
import { z } from "zod";
import { costUsd, usedTokens } from "./pricing.ts";
import type { TokenUsage, TranscriptRecord, TranscriptSession } from "./transcripts.ts";

export type RepoUsage = {
  readonly repo: string;
  readonly activeSeconds: number;
  readonly waitingSeconds: number;
  readonly costUsd: number;
  readonly largeContextCostUsd: number;
  readonly cyclingSavingsUsd: number;
  readonly thinkingCostUsd: number;
  readonly standingCostPer10kUsd: number;
  readonly cacheReadCostUsd: number;
  readonly cacheWriteCostUsd: number;
  readonly inputCostUsd: number;
  readonly answerCostUsd: number;
};

export type FeatureUsage = Omit<RepoUsage, "repo"> & {
  readonly feature: string;
  readonly sessions: number;
  readonly prompts: number;
  readonly endContextTokens: number | undefined;
  readonly friction: Friction;
  readonly firstActive: string;
  readonly lastActive: string;
  readonly repos: ReadonlyArray<RepoUsage>;
};

export type Friction = {
  readonly denied: number;
  readonly staleEdits: number;
  readonly editMismatches: number;
  readonly guardrailBlocks: number;
  readonly autoModeBlocks: number;
  readonly safetyCheckUnavailable: number;
  readonly zshTraps: number;
  readonly missingToolVersions: number;
  readonly browserErrors: number;
  readonly missingFiles: number;
  readonly serviceErrors: number;
  readonly failedCommands: number;
  readonly interruptions: number;
};

type FrictionKind = keyof Friction;

export const FRICTION_KINDS: ReadonlyArray<FrictionKind> = [
  "failedCommands",
  "zshTraps",
  "browserErrors",
  "missingToolVersions",
  "autoModeBlocks",
  "safetyCheckUnavailable",
  "guardrailBlocks",
  "missingFiles",
  "serviceErrors",
  "denied",
  "staleEdits",
  "editMismatches",
  "interruptions",
];

export type SkillUsage = {
  readonly skill: string;
  readonly loads: number;
  readonly tokens: number;
  readonly rereadCostUsd: number;
};

export type AgentUsage = {
  readonly agentType: string;
  readonly runs: number;
  readonly costUsd: number;
};

export type UsageSummary = {
  readonly features: ReadonlyArray<FeatureUsage>;
  readonly unpricedModels: ReadonlyArray<string>;
  readonly sessionStartTokens: number | undefined;
  readonly skills: ReadonlyArray<SkillUsage>;
  readonly agents: ReadonlyArray<AgentUsage>;
  readonly weekdays: ReadonlyArray<WeekdayUsage>;
};

export type DayUsage = {
  readonly date: string;
  readonly repos: ReadonlyArray<RepoUsage>;
};

export type WeekdayUsage = {
  readonly days: ReadonlyArray<DayUsage>;
};

export type WeekUsage = {
  readonly weekStart: string;
  readonly repos: ReadonlyArray<RepoUsage>;
};

type WorktreeHit = { readonly repo: string; readonly slug: string };

type Moment = {
  readonly at: number;
  readonly repo: string;
  readonly costUsd: number;
  readonly contextTokens: number | undefined;
  readonly inMainTranscript: boolean;
  readonly isPrompt: boolean;
  readonly friction: ReadonlyArray<FrictionKind>;
  readonly excessReadUsd: number;
  readonly cycleWriteUsd: number;
  readonly thinkingCostUsd: number;
  readonly standingCostPer10kUsd: number;
  readonly costByKind: CostByKind;
  readonly agentRun: { readonly id: string; readonly agentType: string } | undefined;
  readonly skillLoad: SkillLoad | undefined;
  readonly skillRereads: ReadonlyArray<SkillReread>;
};

type CostByKind = {
  readonly cacheReadCostUsd: number;
  readonly cacheWriteCostUsd: number;
  readonly inputCostUsd: number;
  readonly answerCostUsd: number;
};

const NO_COST: CostByKind = {
  cacheReadCostUsd: 0,
  cacheWriteCostUsd: 0,
  inputCostUsd: 0,
  answerCostUsd: 0,
};

type SkillLoad = { readonly skill: string; readonly tokens: number };

type SkillReread = { readonly skill: string; readonly costUsd: number };

type ToolCall = { readonly name: string; readonly command: string };

type Contribution = RepoUsage & { readonly at: number };

type Timeline = { readonly feature: string; readonly moments: ReadonlyArray<Moment> };

const CYCLE_PROMPT = /^Fresh session for task '([^']+)'/;
const WORKTREE_PATH = /\/([\w.-]+)\/\.claude\/worktrees\/([\w.-]+)/g;
const WORKTREE_FOLDER = /\/([\w .-]+)\/\.claude\/worktrees\/([\w.-]+)/g;
const IDLE_CAP_MS = 5 * 60 * 1000;
const LARGE_CONTEXT_TOKENS = 200_000;
const FRESH_SESSION_TOKENS = 60_000;
const CYCLED_AVERAGE_TOKENS = 130_000;
const INTERRUPTION = "[Request interrupted by user";
const SKILL_HEADER = "Base directory for this skill: ";
const CHARS_PER_TOKEN = 4;
const STANDING_CONTEXT_STEP = 10_000;
const ToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown(),
});
const ToolErrorSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  is_error: z.literal(true),
  content: z.unknown(),
});
const CommandSchema = z.object({ command: z.string() });
const DENIED = /doesn't want to proceed|tool use was rejected/i;
const STALE_EDIT = /modified since read|has not been read yet/i;
const EDIT_MISMATCH = /String to replace not found|Found \d+ matches of the string/i;
const GUARDRAIL = /hook error|Blocked:/;
const AUTO_MODE_BLOCK = /denied by the Claude Code auto mode classifier/i;
const SAFETY_CHECK_UNAVAILABLE = /classifier gave no verdict/i;
const ZSH_TRAP =
  /\(eval\):\d+: (no matches found|.+ not found|unmatched|parse error|bad substitution|read-only variable)/;
const MISSING_TOOL_VERSION = /No version is set for command/i;
const MISSING_FILE = /File does not exist|No such file or directory/i;
const BROWSER_TOOL = /playwright|chrome|browser/i;
const CONNECTOR_TOOL = /^mcp__/;
const EXPECTED_FAILURE = [
  /(^|[|&;]\s*)(grep|rg|find|ls|diff|cmp|test)\b/,
  /claude-dev cycle/,
  /rails test|rspec|vitest|yarn (-s )?(test|verify)|bin\/check|stryker|mutate/,
];
const TextSchema = z.object({ type: z.literal("text"), text: z.string() });

const isHumanPrompt = (record: TranscriptRecord): boolean => record.origin?.kind === "human";

const promptText = (record: TranscriptRecord): string | undefined =>
  typeof record.message?.content === "string" ? record.message.content : undefined;

const contentBlocks = (record: TranscriptRecord): ReadonlyArray<unknown> => {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
};

const toolInputs = (record: TranscriptRecord): ReadonlyArray<string> =>
  contentBlocks(record).flatMap((block) => {
    const toolUse = ToolUseSchema.safeParse(block);
    return toolUse.success ? [JSON.stringify(toolUse.data.input)] : [];
  });

const toolCalls = (records: ReadonlyArray<TranscriptRecord>): ReadonlyMap<string, ToolCall> =>
  new Map(
    records.flatMap(contentBlocks).flatMap((block) => {
      const call = ToolUseSchema.safeParse(block);
      if (!call.success || !call.data.id) return [];
      const command = CommandSchema.safeParse(call.data.input);
      return [
        [
          call.data.id,
          { name: call.data.name ?? "", command: command.success ? command.data.command : "" },
        ],
      ] as const;
    }),
  );

const frictionKind = (result: string, call: ToolCall | undefined): FrictionKind | undefined => {
  if (DENIED.test(result)) return "denied";
  if (STALE_EDIT.test(result)) return "staleEdits";
  if (EDIT_MISMATCH.test(result)) return "editMismatches";
  if (GUARDRAIL.test(result)) return "guardrailBlocks";
  if (AUTO_MODE_BLOCK.test(result)) return "autoModeBlocks";
  if (SAFETY_CHECK_UNAVAILABLE.test(result)) return "safetyCheckUnavailable";
  if (ZSH_TRAP.test(result)) return "zshTraps";
  if (MISSING_TOOL_VERSION.test(result)) return "missingToolVersions";
  const tool = call?.name ?? "";
  if (BROWSER_TOOL.test(tool)) return "browserErrors";
  const command = call?.command ?? "";
  if (EXPECTED_FAILURE.some((pattern) => pattern.test(command))) return undefined;
  if (MISSING_FILE.test(result)) return "missingFiles";
  if (CONNECTOR_TOOL.test(tool)) return "serviceErrors";
  return "failedCommands";
};

const frictionOf = (
  record: TranscriptRecord,
  calls: ReadonlyMap<string, ToolCall>,
): ReadonlyArray<FrictionKind> => [
  ...contentBlocks(record).flatMap((block) => {
    const error = ToolErrorSchema.safeParse(block);
    if (!error.success) return [];
    const result = JSON.stringify(error.data.content);
    const kind = frictionKind(result, calls.get(error.data.tool_use_id ?? ""));
    return kind ? [kind] : [];
  }),
  ...(isInterruption(record) ? (["interruptions"] as const) : []),
];

const isInterruption = (record: TranscriptRecord): boolean =>
  contentBlocks(record).some((block) => {
    const text = TextSchema.safeParse(block);
    return text.success && text.data.text.startsWith(INTERRUPTION);
  });

const contextTokens = (record: TranscriptRecord): number | undefined => {
  const usage = record.message?.usage;
  if (!usage) return undefined;
  const writes = usage.cache_creation;
  return (
    usage.input_tokens +
    usage.cache_read_input_tokens +
    writes.ephemeral_5m_input_tokens +
    writes.ephemeral_1h_input_tokens
  );
};

const matchWorktrees = (text: string, pattern: RegExp): ReadonlyArray<WorktreeHit> =>
  [...text.matchAll(pattern)].map(([, repo = "", slug = ""]) => ({ repo, slug }));

const worktreeHits = (record: TranscriptRecord): ReadonlyArray<WorktreeHit> => [
  ...matchWorktrees(record.cwd ?? "", WORKTREE_FOLDER),
  ...toolInputs(record).flatMap((text) => matchWorktrees(text, WORKTREE_PATH)),
];

const transcripts = (
  session: TranscriptSession,
): ReadonlyArray<ReadonlyArray<TranscriptRecord>> => [
  session.records,
  ...session.subagents.map((s) => s.records),
];

const cycledTask = (session: TranscriptSession): string | undefined =>
  session.records
    .map((r) => promptText(r)?.match(CYCLE_PROMPT)?.[1])
    .find((slug) => slug !== undefined);

const mostWorkedWorktree = (session: TranscriptSession): string | undefined => {
  const hits = transcripts(session).flat().flatMap(worktreeHits);
  const counts = Map.groupBy(hits, (hit) => hit.slug);
  return [...counts].reduce<[string, number] | undefined>(
    (best, [slug, slugHits]) =>
      slugHits.length > (best?.[1] ?? 0) ? [slug, slugHits.length] : best,
    undefined,
  )?.[0];
};

const launchFolder = (session: TranscriptSession): string => {
  const folder = session.records.find((r) => r.cwd)?.cwd ?? session.project;
  return matchWorktrees(folder, WORKTREE_FOLDER)[0]?.repo ?? basename(folder);
};

const featureOf = (session: TranscriptSession): string =>
  cycledTask(session) ?? mostWorkedWorktree(session) ?? `(${launchFolder(session)})`;

const responseKey = (record: TranscriptRecord): string | undefined =>
  record.message?.usage ? `${record.message.id}:${record.requestId}` : undefined;

const isRepeatedResponse = (records: ReadonlyArray<TranscriptRecord>) => {
  const lastIndex = new Map(records.map((r, i) => [responseKey(r), i] as const));
  return (record: TranscriptRecord, index: number): boolean =>
    lastIndex.get(responseKey(record)) !== index;
};

const recordCost = (record: TranscriptRecord): number => {
  const usage = record.message?.usage;
  return usage ? (costUsd(record.message?.model ?? "", usage) ?? 0) : 0;
};

type MomentOptions = {
  readonly feature: string;
  readonly startRepo: string;
  readonly agentRun: Moment["agentRun"];
};

type HypotheticalTokens = {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly output?: number;
};

const hypotheticalCost = (
  model: string,
  { input = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, output = 0 }: HypotheticalTokens,
): number =>
  costUsd(model, {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation: {
      ephemeral_5m_input_tokens: cacheWrite5m,
      ephemeral_1h_input_tokens: cacheWrite1h,
    },
  }) ?? 0;

const excessReadUsd = (record: TranscriptRecord, context: number | undefined): number =>
  context !== undefined && context > LARGE_CONTEXT_TOKENS
    ? hypotheticalCost(record.message?.model ?? "", { cacheRead: context - CYCLED_AVERAGE_TOKENS })
    : 0;

const recordTexts = (record: TranscriptRecord): ReadonlyArray<string> => {
  const content = record.message?.content;
  if (typeof content === "string") return [content];
  return contentBlocks(record).flatMap((block) => {
    const text = TextSchema.safeParse(block);
    return text.success ? [text.data.text] : [];
  });
};

const skillLoadOf = (record: TranscriptRecord): SkillLoad | undefined => {
  const text = recordTexts(record).find((t) => t.startsWith(SKILL_HEADER));
  if (text === undefined) return undefined;
  const directory = text.slice(SKILL_HEADER.length).split("\n")[0] ?? "";
  return { skill: basename(directory.trim()), tokens: Math.round(text.length / CHARS_PER_TOKEN) };
};

const costByKind = (model: string, usage: TokenUsage): CostByKind => {
  const thinking = usage.output_tokens_details?.thinking_tokens ?? 0;
  return {
    cacheReadCostUsd: hypotheticalCost(model, { cacheRead: usage.cache_read_input_tokens }),
    cacheWriteCostUsd: hypotheticalCost(model, {
      cacheWrite5m: usage.cache_creation.ephemeral_5m_input_tokens,
      cacheWrite1h: usage.cache_creation.ephemeral_1h_input_tokens,
    }),
    inputCostUsd: hypotheticalCost(model, { input: usage.input_tokens }),
    answerCostUsd: hypotheticalCost(model, { output: usage.output_tokens - thinking }),
  };
};

const moments = (
  records: ReadonlyArray<TranscriptRecord>,
  { feature, startRepo, agentRun }: MomentOptions,
): Moment[] => {
  const inMainTranscript = agentRun === undefined;
  const repeated = isRepeatedResponse(records);
  const calls = toolCalls(records);
  const result: Moment[] = [];
  const loadedSkills: SkillLoad[] = [];
  let repo = startRepo;
  records.forEach((record, index) => {
    repo =
      worktreeHits(record)
        .filter((hit) => hit.slug === feature)
        .at(-1)?.repo ?? repo;
    if (!record.timestamp) return;
    const isRepeat = repeated(record, index);
    const cost = isRepeat ? 0 : recordCost(record);
    const context = contextTokens(record);
    const model = record.message?.model ?? "";
    const usage = record.message?.usage;
    const isCall = usage !== undefined && !isRepeat;
    const skillLoad = skillLoadOf(record);
    const skillRereads = isCall
      ? loadedSkills.map((s) => ({
          skill: s.skill,
          costUsd: hypotheticalCost(model, { cacheRead: s.tokens }),
        }))
      : [];
    if (skillLoad) loadedSkills.push(skillLoad);
    result.push({
      at: Date.parse(record.timestamp),
      repo,
      costUsd: cost,
      contextTokens: context,
      inMainTranscript,
      isPrompt: isHumanPrompt(record),
      friction: frictionOf(record, calls),
      excessReadUsd: inMainTranscript && !isRepeat ? excessReadUsd(record, context) : 0,
      cycleWriteUsd: hypotheticalCost(model, { cacheWrite1h: FRESH_SESSION_TOKENS }),
      thinkingCostUsd: isCall
        ? hypotheticalCost(model, { output: usage.output_tokens_details?.thinking_tokens ?? 0 })
        : 0,
      standingCostPer10kUsd: isCall
        ? hypotheticalCost(model, { cacheRead: STANDING_CONTEXT_STEP })
        : 0,
      costByKind: isCall ? costByKind(model, usage) : NO_COST,
      agentRun,
      skillLoad,
      skillRereads,
    });
  });
  return result;
};

const sessionMoments = (session: TranscriptSession, feature: string): ReadonlyArray<Moment> =>
  [
    moments(session.records, { feature, startRepo: launchFolder(session), agentRun: undefined }),
    ...session.subagents.map((subagent, i) =>
      moments(subagent.records, {
        feature,
        startRepo: launchFolder(session),
        agentRun: { id: `${session.sessionId}/${i}`, agentType: subagent.agentType },
      }),
    ),
  ]
    .flat()
    .sort((a, b) => a.at - b.at);

const timeline = (session: TranscriptSession): Timeline => {
  const feature = featureOf(session);
  return { feature, moments: sessionMoments(session, feature) };
};

const cyclingSavings = (timeline: ReadonlyArray<Moment>): ReadonlyArray<number> => {
  const none = timeline.map(() => 0);
  const isLarge = (m: Moment) =>
    m.inMainTranscript && (m.contextTokens ?? 0) > LARGE_CONTEXT_TOKENS;
  const crossing = timeline.findIndex(isLarge);
  const crossingMoment = timeline[crossing];
  if (!crossingMoment) return none;
  const peak = timeline
    .filter((m) => m.inMainTranscript)
    .reduce((max, m) => Math.max(max, m.contextTokens ?? 0), 0);
  const cycles = Math.ceil(
    (peak - LARGE_CONTEXT_TOKENS) / (LARGE_CONTEXT_TOKENS - FRESH_SESSION_TOKENS),
  );
  const writes = cycles * crossingMoment.cycleWriteUsd;
  const reads = sum(timeline.map((m) => m.excessReadUsd));
  if (reads <= writes) return none;
  return timeline.map((m, i) => m.excessReadUsd - (i === crossing ? writes : 0));
};

const contributions = (timeline: ReadonlyArray<Moment>): ReadonlyArray<Contribution> => {
  const savings = cyclingSavings(timeline);
  return timeline.map((moment, i) => {
    const gapSeconds = Math.min(moment.at - (timeline[i - 1]?.at ?? moment.at), IDLE_CAP_MS) / 1000;
    const isLarge = (moment.contextTokens ?? 0) > LARGE_CONTEXT_TOKENS;
    return {
      at: moment.at,
      repo: moment.repo,
      activeSeconds: gapSeconds,
      waitingSeconds: moment.isPrompt ? gapSeconds : 0,
      costUsd: moment.costUsd,
      largeContextCostUsd: isLarge ? moment.costUsd : 0,
      cyclingSavingsUsd: savings[i] ?? 0,
      thinkingCostUsd: moment.thinkingCostUsd,
      standingCostPer10kUsd: moment.standingCostPer10kUsd,
      ...moment.costByKind,
    };
  });
};

const sum = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0);

const totals = (parts: ReadonlyArray<Omit<RepoUsage, "repo">>): Omit<RepoUsage, "repo"> => ({
  activeSeconds: sum(parts.map((p) => p.activeSeconds)),
  waitingSeconds: sum(parts.map((p) => p.waitingSeconds)),
  costUsd: sum(parts.map((p) => p.costUsd)),
  largeContextCostUsd: sum(parts.map((p) => p.largeContextCostUsd)),
  cyclingSavingsUsd: sum(parts.map((p) => p.cyclingSavingsUsd)),
  thinkingCostUsd: sum(parts.map((p) => p.thinkingCostUsd)),
  standingCostPer10kUsd: sum(parts.map((p) => p.standingCostPer10kUsd)),
  cacheReadCostUsd: sum(parts.map((p) => p.cacheReadCostUsd)),
  cacheWriteCostUsd: sum(parts.map((p) => p.cacheWriteCostUsd)),
  inputCostUsd: sum(parts.map((p) => p.inputCostUsd)),
  answerCostUsd: sum(parts.map((p) => p.answerCostUsd)),
});

const byRepo = (parts: ReadonlyArray<Contribution>): ReadonlyArray<RepoUsage> =>
  [...Map.groupBy(parts, (p) => p.repo)]
    .map(([repo, group]) => ({ repo, ...totals(group) }))
    .filter((r) => r.activeSeconds > 0 || r.costUsd > 0);

const mean = (values: ReadonlyArray<number>): number | undefined =>
  values.length > 0 ? sum(values) / values.length : undefined;

const endContext = (moments: ReadonlyArray<Moment>): ReadonlyArray<number> => {
  const last = moments.findLast((m) => m.inMainTranscript && m.contextTokens !== undefined);
  return last?.contextTokens === undefined ? [] : [last.contextTokens];
};

const frictionTotals = (kinds: ReadonlyArray<FrictionKind>): Friction => {
  const count = (kind: FrictionKind) => kinds.filter((k) => k === kind).length;
  return {
    denied: count("denied"),
    staleEdits: count("staleEdits"),
    editMismatches: count("editMismatches"),
    guardrailBlocks: count("guardrailBlocks"),
    autoModeBlocks: count("autoModeBlocks"),
    zshTraps: count("zshTraps"),
    safetyCheckUnavailable: count("safetyCheckUnavailable"),
    missingToolVersions: count("missingToolVersions"),
    browserErrors: count("browserErrors"),
    missingFiles: count("missingFiles"),
    serviceErrors: count("serviceErrors"),
    failedCommands: count("failedCommands"),
    interruptions: count("interruptions"),
  };
};

const summariseFeature = (feature: string, timelines: ReadonlyArray<Timeline>): FeatureUsage => {
  const repos = byRepo(timelines.flatMap((t) => contributions(t.moments)));
  const all = timelines.flatMap((t) => t.moments);
  const times = all.map((m) => m.at);
  return {
    feature,
    sessions: timelines.length,
    prompts: all.filter((m) => m.inMainTranscript && m.isPrompt).length,
    ...totals(repos),
    endContextTokens: mean(timelines.flatMap((t) => endContext(t.moments))),
    friction: frictionTotals(all.flatMap((m) => m.friction)),
    firstActive: new Date(times.reduce((a, b) => Math.min(a, b))).toISOString(),
    lastActive: new Date(times.reduce((a, b) => Math.max(a, b))).toISOString(),
    repos,
  };
};

const unpricedModels = (sessions: ReadonlyArray<TranscriptSession>): ReadonlyArray<string> => {
  const models = sessions
    .flatMap((s) => transcripts(s).flat())
    .flatMap((r) => {
      const usage = r.message?.usage;
      const model = r.message?.model ?? "";
      return usage && usedTokens(usage) && costUsd(model, usage) === undefined ? [model] : [];
    });
  return [...new Set(models)];
};

const localDay = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((n) => String(n).padStart(2, "0"))
    .join("-");

const DAYS_IN_WEEK = 7;

const weekdayOf = (at: number): number => (new Date(at).getDay() + 6) % DAYS_IN_WEEK;

const mondayOf = (at: number): Date => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - weekdayOf(at));
};

const weekStarts = (first: Date, last: Date): ReadonlyArray<string> => {
  const starts: string[] = [];
  for (let week = first; week <= last; ) {
    starts.push(localDay(week));
    week = new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7);
  }
  return starts;
};

const weeksOf = (timelines: ReadonlyArray<Timeline>): ReadonlyArray<WeekUsage> => {
  const parts = timelines.flatMap((t) => contributions(t.moments));
  if (parts.length === 0) return [];
  const byWeek = Map.groupBy(parts, (p) => localDay(mondayOf(p.at)));
  const times = parts.map((p) => p.at);
  const first = mondayOf(times.reduce((a, b) => Math.min(a, b)));
  const last = mondayOf(times.reduce((a, b) => Math.max(a, b)));
  return weekStarts(first, last).map((weekStart) => ({
    weekStart,
    repos: byRepo(byWeek.get(weekStart) ?? []),
  }));
};

const weekdaysOf = (timelines: ReadonlyArray<Timeline>): ReadonlyArray<WeekdayUsage> => {
  const parts = timelines.flatMap((t) => contributions(t.moments));
  return Array.from({ length: DAYS_IN_WEEK }, (_, weekday) => {
    const byDate = Map.groupBy(
      parts.filter((p) => weekdayOf(p.at) === weekday),
      (p) => localDay(new Date(p.at)),
    );
    return { days: [...byDate].map(([date, dayParts]) => ({ date, repos: byRepo(dayParts) })) };
  });
};

export const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const sessionStart = (moments: ReadonlyArray<Moment>): ReadonlyArray<number> => {
  const first = moments.find((m) => m.inMainTranscript && m.contextTokens !== undefined);
  return first?.contextTokens === undefined ? [] : [first.contextTokens];
};

const skillsOf = (moments: ReadonlyArray<Moment>): ReadonlyArray<SkillUsage> => {
  const loads = Map.groupBy(
    moments.flatMap((m) => (m.skillLoad ? [m.skillLoad] : [])),
    (l) => l.skill,
  );
  const rereads = Map.groupBy(
    moments.flatMap((m) => m.skillRereads),
    (r) => r.skill,
  );
  return [...new Set([...loads.keys(), ...rereads.keys()])]
    .map((skill) => {
      const skillLoads = loads.get(skill) ?? [];
      return {
        skill,
        loads: skillLoads.length,
        tokens: Math.round(mean(skillLoads.map((l) => l.tokens)) ?? 0),
        rereadCostUsd: sum((rereads.get(skill) ?? []).map((r) => r.costUsd)),
      };
    })
    .sort((a, b) => b.rereadCostUsd - a.rereadCostUsd);
};

const agentsOf = (moments: ReadonlyArray<Moment>): ReadonlyArray<AgentUsage> => {
  const byType = Map.groupBy(
    moments.flatMap((m) => (m.agentRun ? [{ run: m.agentRun, costUsd: m.costUsd }] : [])),
    (m) => m.run.agentType,
  );
  return [...byType]
    .map(([agentType, group]) => ({
      agentType,
      runs: new Set(group.map((g) => g.run.id)).size,
      costUsd: sum(group.map((g) => g.costUsd)),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
};

const summaryOf = (
  timelines: ReadonlyArray<Timeline>,
  {
    since,
    unpricedModels,
  }: { readonly since: Date | undefined; readonly unpricedModels: ReadonlyArray<string> },
): UsageSummary => {
  const sinceMs = since?.getTime() ?? Number.NEGATIVE_INFINITY;
  const inRange = timelines
    .map((t) => ({ ...t, moments: t.moments.filter((m) => m.at >= sinceMs) }))
    .filter((t) => t.moments.length > 0);
  const all = inRange.flatMap((t) => t.moments);
  return {
    features: [...Map.groupBy(inRange, (t) => t.feature)]
      .map(([feature, group]) => summariseFeature(feature, group))
      .sort((a, b) => b.costUsd - a.costUsd),
    unpricedModels,
    sessionStartTokens: median(inRange.flatMap((t) => sessionStart(t.moments))),
    skills: skillsOf(all),
    agents: agentsOf(all),
    weekdays: weekdaysOf(inRange),
  };
};

export const prepareUsage = (sessions: ReadonlyArray<TranscriptSession>) => {
  const timelines = sessions.map(timeline);
  const unpriced = unpricedModels(sessions);
  return {
    summary: ({ since }: { readonly since?: Date } = {}): UsageSummary =>
      summaryOf(timelines, { since, unpricedModels: unpriced }),
    weeks: (): ReadonlyArray<WeekUsage> => weeksOf(timelines),
  };
};
