export {
  clearLoadedJsonConfig,
  getLoadedJsonConfig,
  loadJsonConfigFile,
} from './config/loadJsonConfigFile.js';
export {
  resolveActoviqSettingsStore,
  persistActoviqSettingsStore,
  getDefaultActoviqSettingsPath,
} from './config/actoviqSettingsStore.js';
export { mapActoviqEnvToAnthropicEnv } from './config/anthropicEnvMapping.js';
export {
  ActoviqBuddyApi,
  createActoviqBuddyApi,
  getActoviqBuddyIntroText,
  rollActoviqBuddy,
  rollActoviqBuddyWithSeed,
} from './buddy/actoviqBuddy.js';
export {
  ActoviqMemoryApi,
  createActoviqMemoryApi,
  getActoviqCompactBoundarySummary,
  getActoviqDefaultSessionMemoryCompactConfig,
  getActoviqDefaultSessionMemoryConfig,
  getActoviqDefaultSessionMemoryTemplate,
  getActoviqDefaultSettingsPath,
  formatActoviqMemoryManifest,
  getActoviqMemoryAge,
  getActoviqMemoryAgeDays,
  getActoviqMemoryFreshnessNote,
  getActoviqMemoryFreshnessText,
  getActoviqMemoryHeader,
  readActoviqMemoriesForSurfacing,
  scanActoviqMemoryFiles,
  selectActoviqRelevantMemories,
} from './memory/actoviqMemory.js';
export {
  ActoviqDreamApi,
  buildActoviqDreamPrompt,
  createActoviqDreamApi,
  ensureActoviqDreamLayout,
  isActoviqDreamEligibleSession,
  listActoviqSessionsTouchedSince,
  readActoviqLastConsolidatedAt,
  recordActoviqConsolidation,
  rollbackActoviqConsolidationLock,
  tryAcquireActoviqConsolidationLock,
} from './memory/actoviqDream.js';
export {
  ACTOVIQ_SESSION_MEMORY_STATE_KEY,
  createDefaultActoviqSessionMemoryRuntimeState,
  estimateActoviqConversationTokens,
  evaluateActoviqSessionMemoryProgress,
  filterActoviqMessagesForSessionMemory,
  hasActoviqToolCallsInLastAssistantTurn,
  parseActoviqSessionMemoryRuntimeState,
  sanitizeActoviqSessionMemoryOutput,
  serializeActoviqSessionMemoryRuntimeState,
} from './memory/actoviqSessionMemoryState.js';
export { buildSystemPrompt } from './prompts/systemPrompt.js';
export { loadDefaultActoviqSettings } from './config/loadDefaultActoviqSettings.js';
export { loadActoviqSettings } from './config/loadActoviqSettings.js';
export { resolveRuntimeConfig } from './config/resolveRuntimeConfig.js';
export {
  DEFAULT_AGENT_RUNTIME_CANDIDATES,
  discoverAgentRuntimes,
  detectRuntimeLocalConfig,
  updateRuntimeLocalConfig,
} from './runtime/agentRuntimeDiscovery.js';
export type {
  AgentRuntimeCandidate,
  AgentRuntimeStatus,
  DiscoverAgentRuntimesOptions,
  DiscoveredAgentRuntime,
  RuntimeLocalConfig,
  RuntimeLocalConfigUpdate,
  RuntimeLocalConfigUpdateResult,
} from './runtime/agentRuntimeDiscovery.js';
export {
  encodeActoviqProjectPath,
  getActoviqProjectSessionDirectory,
  migrateLegacyActoviqProjectSessions,
} from './config/projectSessionDirectory.js';
export {
  ACTOVIQ_COMPUTER_USE_WORKFLOW_ACTIONS,
  createActoviqComputerUseMcpServer,
  createActoviqComputerUseToolkit,
  createActoviqComputerUseTools,
  createDefaultActoviqComputerUseExecutor,
} from './computer/actoviqComputerUse.js';
export {
  ActoviqSdkError,
  ActoviqProviderApiError,
  ActoviqBridgeProcessError,
  ConfigurationError,
  RunAbortedError,
  SessionNotFoundError,
  ToolExecutionError,
} from './errors.js';
export { McpConnectionManager } from './mcp/connectionManager.js';
export {
  mergeActoviqHooks,
  normalizeActoviqHookMessages,
  resolveActoviqPostSamplingHooks,
  resolveActoviqPostRunHooks,
  resolveActoviqSessionStartHooks,
  resolveActoviqStopHooks,
} from './hooks/actoviqHooks.js';
export { createActoviqFileTools } from './tools/actoviqFileTools.js';
export type { ActoviqFileToolsOptions } from './tools/actoviqFileTools.js';
export { createActoviqWebTools } from './tools/actoviqWebTools.js';
export { createActoviqCoreTools } from './tools/actoviqCoreTools.js';
export type { ActoviqCoreToolsOptions } from './tools/actoviqCoreTools.js';
export { createBashTool, BASH_TOOL_NAME } from './tools/bash/BashTool.js';
export { createTavilySearchTool, TAVILY_SEARCH_TOOL_NAME } from './tools/tavilySearch.js';
export type { BashInput } from './tools/bash/BashTool.js';
export { createTodoWriteTool, TODO_WRITE_TOOL_NAME } from './tools/todo/TodoWriteTool.js';
export { createAskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME } from './tools/askUserQuestion/AskUserQuestionTool.js';
export { createActoviqTaskTools } from './tools/actoviqTaskTools.js';
export { createTaskCreateTool, TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME } from './tools/actoviqTaskTools.js';
export { createNotebookEditTool, NOTEBOOK_EDIT_TOOL_NAME } from './tools/actoviqNotebookEdit.js';
export { createPowerShellTool, POWERSHELL_TOOL_NAME } from './tools/actoviqShellTools.js';
export { createActoviqMiscTools, createConfigTool, createToolSearchTool, createSkillTool, CONFIG_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from './tools/actoviqMiscTools.js';
export {
  ACTOVIQ_RECENT_FILES_KEY,
  ACTOVIQ_RECENT_SKILLS_KEY,
  trackRecentFile,
  trackRecentSkill,
} from './runtime/actoviqCompact.js';
export { SessionManager } from './runtime/sessionManager.js';
export { parallel, race } from './runtime/parallel.js';
export { WorkflowApi, WorkflowBuilder } from './workflow/workflowBuilder.js';
export { WorkflowEngine } from './workflow/workflowEngine.js';
export type {
  WorkflowDefinition,
  WorkflowStepDefinition,
  WorkflowParameter,
  WorkflowStepResult,
  WorkflowRunResult,
  WorkflowRunOptions,
} from './workflow/types.js';
export { createAgentSdk, ActoviqAgentClient, AgentSessionsApi } from './runtime/agentClient.js';
export {
  ActoviqAgentHandle,
  ActoviqAgentsApi,
  createActoviqTaskTool,
  summarizeActoviqAgentDefinition,
} from './runtime/actoviqAgents.js';
export { loadActoviqAgentDefinitions } from './runtime/actoviqAgentDefinitions.js';
export { getDefaultActoviqAgents } from './runtime/defaultActoviqAgents.js';
export {
  ActoviqContextApi,
  ActoviqSlashCommandHandle,
  ActoviqSlashCommandsApi,
  formatActoviqAgents,
  formatActoviqCompactResult,
  formatActoviqContextOverview,
  formatActoviqDreamResult,
  formatActoviqMemoryState,
  formatActoviqSkills,
  formatActoviqTools,
} from './runtime/actoviqSlashCommands.js';
export {
  ActoviqSkillHandle,
  ActoviqSkillsApi,
  getDefaultActoviqBundledSkills,
  loadActoviqSkillDefinitions,
  resolveActoviqSkillPrompt,
  skill,
  summarizeActoviqSkillDefinition,
} from './runtime/actoviqSkills.js';
export {
  decideActoviqToolPermission,
} from './runtime/actoviqPermissions.js';
export {
  ACTOVIQ_SESSION_PERMISSION_STATE_KEY,
  getPersistedActoviqSessionPermissionState,
  serializeActoviqSessionPermissionState,
} from './runtime/actoviqSessionPermissions.js';
export {
  ActoviqToolsApi,
  buildActoviqCleanToolCatalog,
  resolveActoviqCleanToolMetadata,
  summarizeActoviqResolvedTool,
} from './runtime/actoviqToolCatalog.js';
export { getActoviqApiContextManagement } from './runtime/actoviqApiMicrocompact.js';
export {
  ActoviqBackgroundTaskHandle,
  ActoviqBackgroundTaskManager,
  ActoviqBackgroundTasksApi,
} from './runtime/actoviqBackgroundTasks.js';
export {
  deleteScheduledAutomationTask,
  getScheduledAutomationTask,
  InMemoryTaskStore,
  listScheduledAutomationTasks,
  msUntilNextCron,
  nextCronTime,
  parseCron,
  recordScheduledAutomationRun,
  scheduledAutomationFilePath,
  setScheduledAutomationEnabled,
  TaskScheduler,
  upsertScheduledAutomationTask,
} from './scheduling/index.js';
export { AgentSession } from './runtime/agentSession.js';
export { AgentRunStream } from './runtime/asyncQueue.js';
export { ActoviqModelApi, createActoviqModelApi } from './runtime/actoviqModelApi.js';
export { OpenaiModelApi, createOpenaiModelApi } from './provider/openai-model-api.js';
export {
  ACTOVIQ_MODEL_TIERS,
  isActoviqModelTier,
  resolveActoviqModelReference,
  selectDefaultActoviqModel,
} from './config/modelTiers.js';
export {
  ActoviqSwarmApi,
  ActoviqSwarmTeam,
  ActoviqSwarmTeammateHandle,
} from './swarm/actoviqSwarm.js';
export { tool } from './runtime/tools.js';
export { MailboxStore } from './storage/mailboxStore.js';
export { SessionStore } from './storage/sessionStore.js';
export { TeammateStore } from './storage/teammateStore.js';
export {
  ActoviqWorkspace,
  createGitWorktreeWorkspace,
  createTempWorkspace,
  createWorkspace,
} from './workspace/actoviqWorkspace.js';

// ── v0.5.0: Dynamic Workflows ─────────────────────────────────────────
export {
  WorkflowScriptRuntime,
} from './workflow/workflowScriptRuntime.js';
export {
  loadWorkflow,
  saveWorkflow,
  listWorkflows,
  deleteWorkflow,
  isWorkflowsDisabled,
} from './workflow/workflowPersistence.js';
export type { SavedWorkflow } from './workflow/workflowPersistence.js';

// ── v0.5.0: Worktrees ─────────────────────────────────────────────────
export {
  WorktreeService,
  generateWorktreeName,
} from './worktree/worktreeService.js';
export {
  parseWorktreeInclude,
  matchesPattern as matchesWorktreeIncludePattern,
} from './worktree/worktreeInclude.js';
export {
  ENTER_WORKTREE_TOOL_NAME,
  createEnterWorktreeTool,
} from './tools/enterWorktree.js';
export {
  EXIT_WORKTREE_TOOL_NAME,
  createExitWorktreeTool,
} from './tools/exitWorktree.js';
export {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  resolveWorktreeHooks,
  hasWorktreeHooks,
} from './worktree/worktreeHooks.js';
export type {
  WorktreeCreateHookInput,
  WorktreeRemoveHookInput,
  WorktreeHookResult,
} from './worktree/worktreeHooks.js';

// ── v0.5.0: Model Team ────────────────────────────────────────────────
export {
  ModelTeam,
  createModelTeam,
  createTeamTool,
  orchestratePanel,
  formatExpertPanelReports,
  resolveGraphDisplayAnswer,
} from './team/modelTeam.js';
export {
  AgentPool,
  getGlobalAgentPool,
  resetGlobalAgentPool,
} from './team/agentPool.js';
export {
  getModelPricing,
  estimateCost,
  clearPricingCache,
} from './team/pricing.js';
export {
  loadTeamDefinition,
  saveTeamDefinition,
  listTeamDefinitions,
  deleteTeamDefinition,
  cloneTeamDefinition,
  instantiateTeamDefinition,
  BUILT_IN_TEAM_DEFINITIONS,
  getBuiltInTeamDefinition,
  listTeamAgentLabels,
  countTeamAgents,
} from './team/teamDefinitions.js';
export type { LoadedTeamDefinition } from './team/teamDefinitions.js';
export {
  validateTeamGraph,
  assertValidTeamGraph,
  migrateTeamDefinitionToV2,
  migrateTeamDefinitionToGraph,
  migrateTeamDefinitionToV3,
  isTeamGraphV3,
  validateTeamGraphV2,
  validateTeamGraphV3,
  canonicalizeTeamDefinition,
  toPersistedTeamDefinition,
  graphNodeKind,
  isPortNode,
  orchestrateGraph,
  graphNodeRef,
  edgeConditionPasses,
  createNotifyTeammateTool,
  ensureConfiguredTeamGraph,
  resolveGraphNodeAllowedTools,
  TEAM_READ_ONLY_EXPERT_TOOL_NAMES,
  MAX_GRAPH_NODES,
  isUndirectedTeamGraphEdge,
  formatTeamGraphEdgeLabel,
  expandTeamGraphEdges,
} from './team/teamGraph.js';
export {
  defaultEdgeBezierOffsets,
  resolveEdgeBezierPoints,
  writeEdgeBezierUi,
  clearEdgeBezierUi,
  computeTeamGraphAutoLayoutLanes,
} from './team/teamGraphLayout.js';
export { orchestrateGraphV3 } from './team/teamGraphV3.js';
export {
  TEAM_GRAPH_MEMBER_FRAMING,
  buildMemberAssignmentPrompt,
  buildMemberSystemPrompt,
  resolveGraphNodeSystemPrompt,
} from './team/teamPrompts.js';
export type {
  OrchestrateGraphOptions,
  OrchestrateGraphResult,
  GraphNodeRunResult,
  GraphNodeRunContext,
  GraphNotifyResult,
} from './team/teamGraph.js';
export {
  applyTeamRunEvent,
  createTeamRunViewState,
  formatTeamRunTreeLines,
  teamRunViewFromSnapshot,
} from './team/teamRunView.js';
export type {
  TeamRunViewState,
  TeamRunMemberView,
  TeamRunEdgeView,
  TeamRunMemberStatus,
  FormatTeamRunTreeOptions,
} from './team/teamRunView.js';
export {
  readTeamPreferences,
  writeTeamPreferences,
  DEFAULT_TEAM_PREFERENCES,
} from './team/teamPreferences.js';
export type { TeamPreferences } from './team/teamPreferences.js';

// ── Project Manager (per-project governance agent) ───────────────────
export {
  createManagerTools,
  buildManagerSystemPrompt,
  buildUpdateProgressPrompt,
  formatManagerUpdatePreview,
  shouldIncludeGitHubDigest,
  parseGitHubRepoFromRemote,
  fetchGitHubPrDigest,
  resolveGitHubDigestForUpdate,
  readManagerConfig,
  writeManagerConfig,
  managerConfigPath,
  managerPlanPath,
  managerProgressPath,
  readProjectPlanFile,
  writeProjectPlanFile,
  readProgressFile,
  writeProgressFile,
  resolveManagerReadRoots,
  DEFAULT_MANAGER_CONFIG,
  EMPTY_PROJECT_PLAN,
} from './manager/projectManager.js';
export type {
  ManagerConfig,
  ManagerReadScope,
  ManagerUpdateContext,
  ProjectPlan,
  ProjectPlanMilestone,
  CreateManagerToolsOptions,
} from './manager/projectManager.js';

// ── Model Router (a /model routing layer) ─────────────────────────────
export {
  classifyRoute,
  resolveRoutedRun,
  buildRouteModelApi,
  parseRouteSelection,
  loadRouterProfile,
  saveRouterProfile,
  listRouterProfiles,
  deleteRouterProfile,
} from './router/modelRouter.js';
export type { LoadedRouterProfile, RoutedModel } from './router/modelRouter.js';

// ── Bridge SDK ────────────────────────────────────────────────────────
export {
  ActoviqBridgeAgentHandle,
  ActoviqBridgeAgentsApi,
  ActoviqBridgeContextApi,
  ActoviqBridgeRunStream,
  ActoviqBridgeSession,
  ActoviqBridgeSessionsApi,
  ActoviqBridgeSlashCommandsApi,
  ActoviqBridgeSkillHandle,
  ActoviqBridgeSkillsApi,
  ActoviqBridgeSdkClient,
  ActoviqBridgeToolsApi,
  createActoviqBridgeSdk,
} from './parity/actoviqBridgeSdk.js';
export {
  ActoviqCleanBridgeAgentHandle,
  ActoviqCleanBridgeAgentsApi,
  ActoviqCleanBridgeContextApi,
  ActoviqCleanBridgeRunStream,
  ActoviqCleanBridgeSession,
  ActoviqCleanBridgeSessionsApi,
  ActoviqCleanBridgeSlashCommandsApi,
  ActoviqCleanBridgeSkillHandle,
  ActoviqCleanBridgeSkillsApi,
  ActoviqCleanBridgeSdkClient,
  ActoviqCleanBridgeToolsApi,
  bridgePromptFromMessageContent,
  createActoviqCleanBridgeSdk,
  getActoviqCleanBridgeParityMatrix,
  normalizeCleanBridgeError,
} from './parity/actoviqCleanBridgeCompatSdk.js';
export {
  analyzeActoviqBridgeEvents,
  extractActoviqBridgeTaskInvocations,
  extractActoviqBridgeToolRequests,
  extractActoviqBridgeToolResults,
  getActoviqBridgeTextDelta,
} from './parity/actoviqBridgeEvents.js';
export {
  getActoviqBridgeCompactBoundaries,
  getActoviqBridgeLatestCompactBoundary,
  getActoviqBridgeSessionInfo,
  getActoviqBridgeSessionMessages,
  listActoviqBridgeSessions,
} from './parity/actoviqTranscripts.js';
export {
  detectBridgeProviders,
} from './parity/bridgeProviders.js';

export type * from './types.js';

export function localMcpServer(
  options: import('./types.js').LocalMcpServerDefinition,
): import('./types.js').LocalMcpServerDefinition {
  return options;
}

export function stdioMcpServer(
  options: import('./types.js').StdioMcpServerDefinition,
): import('./types.js').StdioMcpServerDefinition {
  return options;
}

export function streamableHttpMcpServer(
  options: import('./types.js').StreamableHttpMcpServerDefinition,
): import('./types.js').StreamableHttpMcpServerDefinition {
  return options;
}

