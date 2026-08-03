export {
  clearLoadedJsonConfig,
  getLoadedJsonConfig,
  loadJsonConfigFile,
} from './config/loadJsonConfigFile.js';
export {
  resolveHadamardSettingsStore,
  persistHadamardSettingsStore,
  getDefaultHadamardSettingsPath,
} from './config/hadamardSettingsStore.js';
export { mapHadamardEnvToAnthropicEnv } from './config/anthropicEnvMapping.js';
export {
  defaultHadamardHome,
  defaultLegacyActoviqHome,
  getHadamardHomePointerPath,
  listHadamardHomeTopLevelEntries,
  migrateHadamardHomeData,
  migrateLegacyActoviqHomeIfNeeded,
  migrateLegacyProjectActoviqDirIfNeeded,
  resolveHadamardHome,
  summarizeHadamardHome,
  writeHadamardHomePointer,
} from './config/hadamardHome.js';
export {
  deleteAgentProfile,
  findAgentProfile,
  findSelectableAgent,
  getAgentProfilesPath,
  listAgentProfileBridgeModels,
  listAgentProfiles,
  listSelectableAgents,
  matchSelectableAgent,
  readAgentProfiles,
  resolveAgentProfileRun,
  resolveSelectableAgentRun,
  agentProfileRunOverrides,
  upsertAgentProfile,
  validateAgentProfile,
  writeAgentProfiles,
} from './config/agentProfiles.js';
export type {
  AgentProfile,
  AgentProfileValidationResult,
  PersistedAgentProfiles,
  ResolvedAgentProfileRun,
  SelectableAgent,
} from './config/agentProfiles.js';
export * from './issues/issueStore.js';
export * from './issues/issueExecution.js';
export {
  HadamardBuddyApi,
  createHadamardBuddyApi,
  getHadamardBuddyIntroText,
  rollHadamardBuddy,
  rollHadamardBuddyWithSeed,
} from './buddy/hadamardBuddy.js';
export {
  HadamardMemoryApi,
  createHadamardMemoryApi,
  getHadamardCompactBoundarySummary,
  getHadamardDefaultSessionMemoryCompactConfig,
  getHadamardDefaultSessionMemoryConfig,
  getHadamardDefaultSessionMemoryTemplate,
  getHadamardDefaultSettingsPath,
  formatHadamardMemoryManifest,
  getHadamardMemoryAge,
  getHadamardMemoryAgeDays,
  getHadamardMemoryFreshnessNote,
  getHadamardMemoryFreshnessText,
  getHadamardMemoryHeader,
  readHadamardMemoriesForSurfacing,
  scanHadamardMemoryFiles,
  selectHadamardRelevantMemories,
} from './memory/hadamardMemory.js';
export {
  HadamardDreamApi,
  buildHadamardDreamPrompt,
  createHadamardDreamApi,
  ensureHadamardDreamLayout,
  isHadamardDreamEligibleSession,
  listHadamardSessionsTouchedSince,
  readHadamardLastConsolidatedAt,
  recordHadamardConsolidation,
  rollbackHadamardConsolidationLock,
  tryAcquireHadamardConsolidationLock,
} from './memory/hadamardDream.js';
export {
  HADAMARD_SESSION_MEMORY_STATE_KEY,
  createDefaultHadamardSessionMemoryRuntimeState,
  estimateHadamardConversationTokens,
  evaluateHadamardSessionMemoryProgress,
  filterHadamardMessagesForSessionMemory,
  hasHadamardToolCallsInLastAssistantTurn,
  parseHadamardSessionMemoryExtractionOutput,
  parseHadamardSessionMemoryRuntimeState,
  redactMemorySecrets,
  sanitizeHadamardSessionMemoryOutput,
  serializeHadamardSessionMemoryRuntimeState,
} from './memory/hadamardSessionMemoryState.js';
export { buildSystemPrompt } from './prompts/systemPrompt.js';
export { loadDefaultHadamardSettings } from './config/loadDefaultHadamardSettings.js';
export { loadHadamardSettings } from './config/loadHadamardSettings.js';
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
  RuntimeLocalConfigPaths,
  RuntimeLocalConfigUpdate,
  RuntimeLocalConfigUpdateResult,
} from './runtime/agentRuntimeDiscovery.js';
export {
  encodeHadamardProjectPath,
  getHadamardProjectSessionDirectory,
  migrateLegacyHadamardProjectSessions,
} from './config/projectSessionDirectory.js';
export {
  HADAMARD_COMPUTER_USE_WORKFLOW_ACTIONS,
  createHadamardComputerUseMcpServer,
  createHadamardComputerUseToolkit,
  createHadamardComputerUseTools,
  createDefaultHadamardComputerUseExecutor,
} from './computer/hadamardComputerUse.js';
export {
  createE2bComputerUseToolkit,
} from './computer/e2bComputerUse.js';
export type {
  CreateE2bComputerUseOptions,
  E2bComputerUseToolkit,
  E2bDesktopCreateOptions,
  E2bDesktopSandboxLike,
} from './computer/e2bComputerUse.js';
export {
  HadamardBrowserSession,
} from './browser/hadamardBrowserSession.js';
export type {
  HadamardBrowserElementRef,
  HadamardBrowserSnapshot,
  HadamardBrowserSessionOptions,
  HadamardBrowserTabInfo,
} from './browser/hadamardBrowserSession.js';
export {
  createHadamardBrowserTools,
  createHadamardBrowserUseMcpServer,
  createHadamardBrowserUseToolkit,
  sessionOptionsFromBrowserUse,
} from './browser/hadamardBrowserTools.js';
export type {
  HadamardBrowserSessionLike,
  HadamardBrowserUseToolkit,
} from './browser/hadamardBrowserTools.js';
export {
  readHadamardBrowserSettings,
  writeHadamardBrowserSettings,
} from './browser/browserSettings.js';
export type { HadamardBrowserSettings } from './browser/browserSettings.js';
export {
  MANAGED_PLUGIN_DEFINITIONS,
  MANAGED_PLUGIN_IDS,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  readStoredManagedPluginConfig,
} from './plugins/managedPluginCatalog.js';
export type {
  ManagedPluginCatalog,
  ManagedPluginCatalogEntry,
  ManagedPluginHealth,
  ManagedPluginId,
  ManagedPluginState,
} from './plugins/managedPluginCatalog.js';
export {
  createManagedPluginRuntime,
} from './plugins/managedPluginRuntime.js';
export type {
  ManagedPluginRuntime,
  ManagedPluginRuntimeOptions,
} from './plugins/managedPluginRuntime.js';
export { probeManagedPlugin } from './plugins/managedPluginHealth.js';
export {
  createManagedOcrTool,
  runManagedOcr,
} from './plugins/ocrPlugin.js';
export type {
  ManagedOcrConfig,
  ManagedOcrInput,
  ManagedOcrResult,
} from './plugins/ocrPlugin.js';
export { createImageGenTool } from './plugins/imageGenPlugin.js';
export { createVideoGenTool } from './plugins/videoGenPlugin.js';
export { createMeshGenTool } from './plugins/meshGenPlugin.js';
export {
  MEDIA_GEN_PROVIDER_LINKS,
  MEDIA_GEN_PLUGIN_IDS,
} from './plugins/mediaGenProfiles.js';
export {
  IMAGE_GEN_PROMPT_GUIDANCE,
  VIDEO_GEN_PROMPT_GUIDANCE,
  MESH_GEN_PROMPT_GUIDANCE,
} from './plugins/mediaGenPromptGuidance.js';
export { createGitHubPlugin } from './plugins/githubPlugin.js';
export { createKimiWebBridgePlugin } from './plugins/kimiWebBridgePlugin.js';
export * from './plugins/packageManifest.js';
export * from './plugins/pluginPackageStore.js';
export * from './plugins/pluginResolver.js';
export * from './plugins/pluginLoader.js';
export * from './plugins/pluginRegistryClient.js';
export * from './plugins/pluginTrustStore.js';
export * from './plugins/pluginManager.js';
export {
  HadamardSdkError,
  HadamardProviderApiError,
  HadamardBridgeProcessError,
  ConfigurationError,
  DeadlineExceededError,
  RunAbortedError,
  SessionConflictError,
  SessionDataError,
  SessionNotFoundError,
  ToolExecutionError,
} from './errors.js';
export { McpConnectionManager } from './mcp/connectionManager.js';
export {
  mergeHadamardHooks,
  normalizeHadamardHookMessages,
  resolveHadamardPostSamplingHooks,
  resolveHadamardPostRunHooks,
  resolveHadamardSessionStartHooks,
  resolveHadamardStopHooks,
} from './hooks/hadamardHooks.js';
export { createHadamardFileTools } from './tools/hadamardFileTools.js';
export type { HadamardFileToolsOptions } from './tools/hadamardFileTools.js';
export { createHadamardWebTools } from './tools/hadamardWebTools.js';
export { createHadamardCoreTools } from './tools/hadamardCoreTools.js';
export type { HadamardCoreToolsOptions } from './tools/hadamardCoreTools.js';
export * from './goal/index.js';
export * from './checkpoint/index.js';
export * from './sandbox/index.js';
export * from './remote/index.js';
export * from './context/ruleTypes.js';
export * from './context/ruleStore.js';
export * from './context/ruleResolver.js';
export * from './context/ruleCommandService.js';
export * from './memory/memoryProposalService.js';
export * from './memory/memoryProposalTools.js';
export * from './memory/memoryProposalCommandService.js';
export * from './memory/memoryCommandService.js';
export * from './memory/durableMemoryPipeline.js';
export * from './memory/durableMemoryStore.js';
export * from './config/projectSettings.js';
export * from './policy/index.js';
export * from './app-server/index.js';
export * from './codeIntel/index.js';
export * from './worktree/taskWorktreeCoordinator.js';
export * from './review/index.js';
export * from './hooks/hookTypes.js';
export * from './hooks/hookRunner.js';
export * from './hooks/hookConfig.js';
export * from './hooks/handlers/commandHook.js';
export * from './hooks/handlers/promptHook.js';
export * from './hooks/handlers/httpHook.js';
export { createBashTool, BASH_TOOL_NAME } from './tools/bash/BashTool.js';
export { createTavilySearchTool, TAVILY_SEARCH_TOOL_NAME, resolveTavilyApiKey, runTavilySearch } from './tools/tavilySearch.js';
export { createExaSearchTool, EXA_SEARCH_TOOL_NAME, resolveExaApiKey, runExaSearch } from './tools/exaSearch.js';
export type { BashInput } from './tools/bash/BashTool.js';
export { createTodoWriteTool, TODO_WRITE_TOOL_NAME } from './tools/todo/TodoWriteTool.js';
export { createAskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME } from './tools/askUserQuestion/AskUserQuestionTool.js';
export { createHadamardTaskTools } from './tools/hadamardTaskTools.js';
export { createTaskCreateTool, TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME } from './tools/hadamardTaskTools.js';
export { createNotebookEditTool, NOTEBOOK_EDIT_TOOL_NAME } from './tools/hadamardNotebookEdit.js';
export { createPowerShellTool, POWERSHELL_TOOL_NAME } from './tools/hadamardShellTools.js';
export { createHadamardMiscTools, createConfigTool, createToolSearchTool, createSkillTool, CONFIG_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from './tools/hadamardMiscTools.js';
export {
  HADAMARD_RECENT_FILES_KEY,
  HADAMARD_RECENT_SKILLS_KEY,
  trackRecentFile,
  trackRecentSkill,
} from './runtime/hadamardCompact.js';
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
export { createAgentSdk, HadamardAgentClient, AgentSessionsApi } from './runtime/agentClient.js';
export * from './runtime/agentExecution.js';
export * from './runtime/hadamardAgentExecutions.js';
export {
  HadamardAgentHandle,
  HadamardAgentsApi,
  createHadamardTaskTool,
  summarizeHadamardAgentDefinition,
} from './runtime/hadamardAgents.js';
export { loadHadamardAgentDefinitions } from './runtime/hadamardAgentDefinitions.js';
export { getDefaultHadamardAgents } from './runtime/defaultHadamardAgents.js';
export {
  HadamardContextApi,
  HadamardSlashCommandHandle,
  HadamardSlashCommandsApi,
  formatHadamardAgents,
  formatHadamardCompactResult,
  formatHadamardContextOverview,
  formatHadamardDreamResult,
  formatHadamardMemoryState,
  formatHadamardSkills,
  formatHadamardTools,
} from './runtime/hadamardSlashCommands.js';
export {
  HadamardSkillHandle,
  HadamardSkillsApi,
  getDefaultHadamardBundledSkills,
  loadHadamardSkillDefinitionFile,
  loadHadamardSkillDefinitions,
  resolveHadamardSkillPrompt,
  skill,
  summarizeHadamardSkillDefinition,
} from './runtime/hadamardSkills.js';
export { discoverHadamardSkillCatalog } from './runtime/externalSkillCatalog.js';
export type {
  HadamardSkillCatalog,
  HadamardSkillCatalogCapability,
  HadamardSkillCatalogConflict,
  HadamardSkillCatalogDiagnostic,
  HadamardSkillCatalogEntry,
  HadamardSkillCatalogEntryStatus,
  HadamardSkillCatalogOrigin,
  HadamardSkillCatalogProvider,
  HadamardSkillCatalogScope,
  HadamardSkillCatalogSource,
  HadamardSkillCatalogSourceStatus,
  DiscoverHadamardSkillCatalogOptions,
} from './runtime/externalSkillCatalog.js';
export { loadHadamardExternalSkillDefinitions } from './runtime/externalSkillRuntime.js';
export type {
  HadamardExternalSkillConflictSkip,
  HadamardExternalSkillLoadError,
  HadamardExternalSkillRuntimeResult,
} from './runtime/externalSkillRuntime.js';
export {
  hadamardExternalSkillPreferencesPath,
  clearHadamardPreferredExternalSkill,
  externalSkillPreferencesToRuntimeOptions,
  readHadamardExternalSkillPreferences,
  setHadamardExternalSkillDisabled,
  setHadamardPreferredExternalSkill,
  writeHadamardExternalSkillPreferences,
} from './runtime/externalSkillPreferences.js';
export type {
  HadamardExternalSkillPreferenceLocation,
  HadamardExternalSkillPreferences,
} from './runtime/externalSkillPreferences.js';
export {
  decideHadamardToolPermission,
} from './runtime/hadamardPermissions.js';
export {
  HADAMARD_SESSION_PERMISSION_STATE_KEY,
  getPersistedHadamardSessionPermissionState,
  serializeHadamardSessionPermissionState,
} from './runtime/hadamardSessionPermissions.js';
export {
  HadamardToolsApi,
  buildHadamardCleanToolCatalog,
  resolveHadamardCleanToolMetadata,
  summarizeHadamardResolvedTool,
} from './runtime/hadamardToolCatalog.js';
export { getHadamardApiContextManagement } from './runtime/hadamardApiMicrocompact.js';
export {
  HadamardBackgroundTaskHandle,
  HadamardBackgroundTaskManager,
  HadamardBackgroundTasksApi,
} from './runtime/hadamardBackgroundTasks.js';
export {
  deleteScheduledAutomationTask,
  getScheduledAutomationTask,
  InMemoryTaskStore,
  listScheduledAutomationTasks,
  msUntilNextCron,
  nextCronTime,
  parseCron,
  recordScheduledAutomationRun,
  resolveScheduledAutomationWorkflow,
  scheduledAutomationFilePath,
  setScheduledAutomationEnabled,
  TaskScheduler,
  upsertScheduledAutomationTask,
} from './scheduling/index.js';
export { AgentSession } from './runtime/agentSession.js';
export {
  AgentRunStream,
  AsyncQueueOverflowError,
  DEFAULT_AGENT_RUN_STREAM_BUFFER_CAPACITY,
} from './runtime/asyncQueue.js';
export type {
  AgentRunStreamController,
  AgentRunStreamOptions,
  AsyncQueueOverflowStrategy,
} from './runtime/asyncQueue.js';
export { HadamardModelApi, createHadamardModelApi } from './runtime/hadamardModelApi.js';
export { OpenaiModelApi, createOpenaiModelApi } from './provider/openai-model-api.js';
export {
  HADAMARD_MODEL_TIERS,
  isHadamardModelTier,
  resolveHadamardModelReference,
  selectDefaultHadamardModel,
} from './config/modelTiers.js';
export {
  HadamardSwarmApi,
  HadamardSwarmTeam,
  HadamardSwarmTeammateHandle,
} from './swarm/hadamardSwarm.js';
export { tool } from './runtime/tools.js';
export { MailboxStore } from './storage/mailboxStore.js';
export { AgentExecutionStore } from './storage/agentExecutionStore.js';
export { SessionStore } from './storage/sessionStore.js';
export * from './storage/sessionGraph.js';
export * from './storage/sessionForkService.js';
export * from './storage/sessionBranchSummary.js';
export { TeammateStore } from './storage/teammateStore.js';
export {
  HadamardWorkspace,
  createGitWorktreeWorkspace,
  createTempWorkspace,
  createWorkspace,
} from './workspace/hadamardWorkspace.js';

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
  clearEdgeBezierUiForNodeRef,
  defaultEdgeTension,
  sanitizeEdgeBezierUi,
  getTeamGraphBezierClientScript,
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
export {
  TeamProposalConflictError,
  TeamProposalStore,
  diffTeamDefinitions,
  mergeTeamProposalLayout,
  teamDefinitionFingerprint,
} from './team/teamProposalService.js';
export type {
  ApplyTeamProposalResult,
  StageTeamProposalInput,
  TeamGraphProposal,
  TeamProposalDiff,
  TeamProposalStatus,
} from './team/teamProposalService.js';
export {
  buildAssistantTeamSystemPrompt,
  createAssistantTeamTools,
} from './team/assistantTeamTools.js';
export type {
  AssistantTeamToolHost,
  AssistantTeamToolScope,
} from './team/assistantTeamTools.js';
export {
  SessionCatalog,
  sessionCatalogLocatorKey,
} from './storage/sessionCatalog.js';
export type {
  SessionCatalogAction,
  SessionCatalogActionInput,
  SessionCatalogActivity,
  SessionCatalogItem,
  SessionCatalogLocator,
  SessionCatalogOptions,
  SessionCatalogPage,
  SessionCatalogQuery,
  SessionCatalogRuntimeStatus,
  SessionCatalogType,
} from './storage/sessionCatalog.js';

// ── Project Manager (per-project governance agent) ───────────────────
export {
  createManagerTools,
  buildDecomposeIssuePrompt,
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
  isManagerReadScope,
  MANAGER_READ_SCOPES,
  DEFAULT_MANAGER_CONFIG,
  EMPTY_PROJECT_PLAN,
} from './manager/projectManager.js';
export type {
  ManagerConfig,
  IssueDecomposeContext,
  ManagerReadScope,
  ManagerUpdateContext,
  ProjectPlan,
  ProjectPlanMilestone,
  CreateManagerToolsOptions,
} from './manager/projectManager.js';
export {
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  readAssistantConfig,
  writeAssistantConfig,
  assistantConfigPath,
  listAssistantProjectBriefs,
  isAssistantScope,
  DEFAULT_ASSISTANT_CONFIG,
} from './manager/assistantGlobalTools.js';
export type {
  AssistantScope,
  AssistantGlobalConfig,
  AssistantGlobalHost,
  AssistantProjectBrief,
} from './manager/assistantGlobalTools.js';

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
  HadamardBridgeAgentHandle,
  HadamardBridgeAgentsApi,
  HadamardBridgeContextApi,
  HadamardBridgeRunStream,
  HadamardBridgeSession,
  HadamardBridgeSessionsApi,
  HadamardBridgeSlashCommandsApi,
  HadamardBridgeSkillHandle,
  HadamardBridgeSkillsApi,
  HadamardBridgeSdkClient,
  HadamardBridgeToolsApi,
  createHadamardBridgeSdk,
} from './parity/hadamardBridgeSdk.js';
export {
  HadamardCleanBridgeAgentHandle,
  HadamardCleanBridgeAgentsApi,
  HadamardCleanBridgeContextApi,
  HadamardCleanBridgeRunStream,
  HadamardCleanBridgeSession,
  HadamardCleanBridgeSessionsApi,
  HadamardCleanBridgeSlashCommandsApi,
  HadamardCleanBridgeSkillHandle,
  HadamardCleanBridgeSkillsApi,
  HadamardCleanBridgeSdkClient,
  HadamardCleanBridgeToolsApi,
  bridgePromptFromMessageContent,
  createHadamardCleanBridgeSdk,
  getHadamardCleanBridgeParityMatrix,
  normalizeCleanBridgeError,
} from './parity/hadamardCleanBridgeCompatSdk.js';
export {
  analyzeHadamardBridgeEvents,
  extractHadamardBridgeTaskInvocations,
  extractHadamardBridgeToolRequests,
  extractHadamardBridgeToolResults,
  getHadamardBridgeTextDelta,
} from './parity/hadamardBridgeEvents.js';
export {
  getHadamardBridgeCompactBoundaries,
  getHadamardBridgeLatestCompactBoundary,
  getHadamardBridgeSessionInfo,
  getHadamardBridgeSessionMessages,
  listHadamardBridgeSessions,
} from './parity/hadamardTranscripts.js';
export {
  detectBridgeProviders,
} from './parity/bridgeProviders.js';
export {
  ExternalCliRuntimeManager,
  createExternalCliRuntimeManager,
} from './parity/externalCliRuntimeManager.js';
export type {
  ExternalCliClientFactory,
  ExternalCliClientLike,
  ExternalCliRunEvent,
  ExternalCliRunLog,
  ExternalCliRunReplay,
  ExternalCliRunSnapshot,
  ExternalCliRunStartOptions,
  ExternalCliRunStatus,
  ExternalCliRunUpdate,
  ExternalCliRuntimeManagerOptions,
  ExternalCliSessionLike,
} from './parity/externalCliRuntimeManager.js';
export {
  listExternalCliSessions,
  readExternalCliSession,
} from './parity/externalCliSessions.js';
export type {
  ExternalCliRuntime,
  ExternalCliSession,
  ExternalCliSessionMessage,
  ExternalCliSessionOptions,
  ExternalCliSessionSummary,
  ExternalCliSessionRole,
  ExternalCliToolMetadata,
} from './parity/externalCliSessions.js';
export { probeExternalCliAuth } from './parity/externalCliAuth.js';
export type {
  ExternalCliAuthProbeOptions,
  ExternalCliAuthProbeResult,
  ExternalCliAuthRuntime,
  ExternalCliAuthState,
  ExternalCliAuthStatus,
} from './parity/externalCliAuth.js';

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

