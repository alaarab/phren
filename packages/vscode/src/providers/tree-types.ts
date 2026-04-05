export type TaskSection = "Active" | "Queue" | "Done";
export type PhrenCategory = "findings" | "truths" | "sessions" | "task" | "queue" | "reference" | "hooks";
export type SessionBucket = "findings" | "tasks";
export type QueueSection = "Review" | "Stale" | "Conflicts";

export interface RootSectionNode {
  kind: "rootSection";
  section: "projects" | "tasks" | "machines" | "review" | "skills" | "hooks" | "graph" | "manage";
  description?: string;
}

export interface ProjectGroupNode {
  kind: "projectGroup";
  group: "device" | "other";
  count: number;
}

export interface StoreGroupNode {
  kind: "storeGroup";
  storeName: string;
  role: string;
  count: number;
  syncMode?: string;
  lastSync?: string;
  reviewCount?: number;
  conflictCount?: number;
}

export interface ManageItemNode {
  kind: "manageItem";
  item: "health" | "profile" | "machine" | "lastSync" | "storeSync";
  label: string;
  value: string;
  storeName?: string;
  syncMode?: string;
}

export interface ProjectNode {
  kind: "project";
  projectName: string;
  brief?: string;
  active?: boolean;
  reviewCount?: number;
  conflictCount?: number;
}

export interface CategoryNode {
  kind: "category";
  projectName: string;
  category: PhrenCategory;
}

export interface FindingDateGroupNode {
  kind: "findingDateGroup";
  projectName: string;
  date: string;
  count: number;
}

export interface FindingNode {
  kind: "finding";
  projectName: string;
  id: string;
  date: string;
  text: string;
  type?: string;
  confidence?: number;
  supersededBy?: string;
  supersedes?: string;
  contradicts?: string[];
  potentialDuplicates?: string[];
}

export interface TaskSectionGroupNode {
  kind: "taskSectionGroup";
  projectName: string;
  section: TaskSection;
  count: number;
}

export interface GlobalTaskSectionGroupNode {
  kind: "globalTaskSectionGroup";
  section: "Pinned" | TaskSection;
  count: number;
}

export interface TaskNode {
  kind: "task";
  projectName: string;
  id: string;
  line: string;
  section: TaskSection;
  checked: boolean;
  priority?: string;
  pinned?: boolean;
  issueUrl?: string;
  issueNumber?: number;
}

export interface SkillGroupNode {
  kind: "skillGroup";
  source: string;
}

export interface SkillNode {
  kind: "skill";
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
}

export interface HookNode {
  kind: "hook";
  tool: string;
  enabled: boolean;
}

export interface CustomHookNode {
  kind: "customHook";
  event: string;
  target: string;
  isWebhook: boolean;
  timeout?: number;
}

export interface HookErrorNode {
  kind: "hookError";
  timestamp: string;
  event: string;
  message: string;
}

export interface ProjectHookEventNode {
  kind: "projectHookEvent";
  projectName: string;
  event: string;
  enabled: boolean;
  configured: boolean | null;
}

export interface QueueSectionGroupNode {
  kind: "queueSectionGroup";
  projectName: string;
  section: QueueSection;
  count: number;
}

export interface AggregateQueueSectionGroupNode {
  kind: "aggregateQueueSectionGroup";
  section: QueueSection;
  count: number;
}

export interface ReviewProjectGroupNode {
  kind: "reviewProjectGroup";
  projectName: string;
  reviewCount: number;
  conflictCount: number;
}

export interface QueueItemNode {
  kind: "queueItem";
  projectName: string;
  id: string;
  section: string;
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
  showProjectName?: boolean;
}

export interface TruthNode {
  kind: "truth";
  projectName: string;
  text: string;
}

export interface ReferenceFileNode {
  kind: "referenceFile";
  projectName: string;
  fileName: string;
}

export interface SessionDateGroupNode {
  kind: "sessionDateGroup";
  projectName: string;
  date: string;
  count: number;
}

export interface SessionNode {
  kind: "session";
  projectName: string;
  date: string;
  sessionId: string;
  startedAt: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

export interface SessionBucketNode {
  kind: "sessionBucket";
  projectName: string;
  sessionId: string;
  bucket: SessionBucket;
  count: number;
}

export interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  iconId?: string;
}

export type PhrenNode =
  | RootSectionNode
  | ProjectGroupNode
  | StoreGroupNode
  | ManageItemNode
  | ProjectNode
  | CategoryNode
  | FindingDateGroupNode
  | FindingNode
  | TaskSectionGroupNode
  | GlobalTaskSectionGroupNode
  | TaskNode
  | QueueSectionGroupNode
  | AggregateQueueSectionGroupNode
  | ReviewProjectGroupNode
  | QueueItemNode
  | SkillGroupNode
  | SkillNode
  | HookNode
  | CustomHookNode
  | HookErrorNode
  | ProjectHookEventNode
  | ReferenceFileNode
  | SessionDateGroupNode
  | SessionNode
  | SessionBucketNode
  | TruthNode
  | MessageNode;

export interface ProjectSummary {
  name: string;
  brief?: string;
  store?: string;
  source?: string;
}

export interface FindingSummary {
  id: string;
  date: string;
  text: string;
  type?: string;
  confidence?: number;
  supersededBy?: string;
  supersedes?: string;
  contradicts?: string[];
  potentialDuplicates?: string[];
}

export interface TaskSummary {
  id: string;
  line: string;
  section: TaskSection;
  checked: boolean;
  priority?: string;
  pinned?: boolean;
  issueUrl?: string;
  issueNumber?: number;
}

export interface QueueItemSummary {
  projectName: string;
  id: string;
  section: QueueSection;
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
}

export interface SkillSummary {
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
}

export interface SessionSummary {
  projectName: string;
  date: string;
  sessionId: string;
  startedAt: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

export interface SessionArtifactSummary {
  findings: FindingSummary[];
  tasks: TaskSummary[];
}

export interface DateFilter {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  label: string;
}
