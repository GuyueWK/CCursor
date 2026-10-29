/**
 * aiserver.v1.AiService — 核心 AI 服务
 *
 * Cursor 最大的服务 (183 方法)，承载几乎所有 AI 能力：
 *   - 模型管理: AvailableModels, GetDefaultModel, CheckQueuePosition
 *   - 对话: StreamChat, StreamChatTryReallyHard, StreamComposer, StreamEdit
 *   - 补全: StreamCpp, StreamNextCursorPrediction, CppConfig, CppAppend
 *   - Agent: InterfaceAgentInit, StreamInterfaceAgentStatus
 *   - 任务: TaskInit, TaskInfo, TaskStreamLog, TaskSendMessage
 *   - 知识库: KnowledgeBaseList, KnowledgeBaseAdd, AvailableDocs
 *   - 配置: ServerTime, HealthCheck, CppConfig, CppEditHistoryStatus
 *   - 遥测: ReportClientNumericMetrics, UpdateVscodeProfile, ReportFeedback
 *
 * Transport: backendUrl (api2.cursor.sh)
 *   部分方法有独立 transport 覆盖:
 *     - streamNextCursorPrediction, getCppEditClassification, streamCpp → geoCppTransport
 *     - cppConfig → cppConfigTransport
 *     - cppEditHistoryAppend, cppAppend → telemTransport
 *     - streamStt, streamBugBotAgentic, streamUiBestOfNJudge → agenticComposerTransport
 *
 * 拦截策略 (与 ~/.ccursor/routes.json redirect 白名单配合):
 *   - AvailableModels: 双源合并 (上游官方订阅 + 本地 BYOK providers.json)
 *   - StreamChat / StreamUiApply / 其他被白名单覆盖的方法: 由各 stream 实现处理
 *   - 未列入白名单的方法: 不会到我们这里, 直通官方
 */
import type { ConnectRouter } from '@connectrpc/connect'
import { create } from '@bufbuild/protobuf'
import {
  AiService,
  AvailableModelsResponse_FeatureModelConfigSchema,
  AvailableModelsResponse_ModelPickerDisplayConfigurationSchema,
  AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfigSchema,
  AvailableModelsResponseSchema,
} from '../../gen/aiserver_v1_pb'
import {
  addKnowledgeItem,
  listKnowledgeItems,
  removeKnowledgeItem,
  updateKnowledgeItem,
} from '../../config/knowledgeBaseStore'
import {
  buildByokAvailableModels,
  buildClassifierFallbackStubModels,
  isClassifierModelName,
  toHiddenClassifierStubModel,
} from '../../handlers/models/byokModelBuilder'
import { fetchUpstreamAvailableModels } from '../../handlers/models/upstream'
import { enabledModelEntries } from '../../handlers/models/requestedModelId'
import { logger } from '../../logger'

/**
 * BYOK ON 模式下,客户端能命中我们这里就说明白名单生效中。
 * 返回 providers.json 本地模型 (全部带 supportsSmartModeClassifier=true)
 * + 隐藏的 Auto-review classifier 桩。
 *
 * 为什么需要 classifier 桩:
 *   客户端的门禁是 modelConfigService.hasSmartModeClassifierModel():
 *   AvailableModels 里至少有一个 supportsSmartModeClassifier === true
 *   (proto field 45)。文档里写成“需要 Claude 4.5 Haiku / GPT-5.4 Mini
 *   其中之一”,但 wire 上只看这个布尔值。BYOK 之前一个都不带,客户端直接在
 *   Settings > Agents > Approvals & Execution 把 Auto-review 置灰,导致
 *   BYOK OFF 能选、BYOK ON 选不上的现象。CCursor 的本地 classifier
 *   (autoReview.ts) 并不需要托管模型跑分,只是 UI 门禁过不去。
 *   主修复在 byokModelBuilder: 每个 BYOK 模型都带上该 flag (本地 classifier
 *   就跑在用户的 providers.json 模型上,语义成立)。这里额外把上游同名模型
 *   转成隐藏桩 (supportsAgent=false, 不污染 Agent 选择器) 并入列表,双保险;
 *   Agent 实际跑分仍走本地 providers.json 模型。
 *
 * BYOK OFF 模式下,白名单不含 AvailableModels,这个 handler 根本不会被调用 ——
 * 客户端直接拿到官方真实订阅列表。
 */
async function handleAvailableModels(request: Record<string, unknown>, context: { requestHeader?: Headers } | undefined) {
  const byok = buildByokAvailableModels()
  const byokNameSet = new Set(byok.map((model) => model.name))
  let classifierStubs: ReturnType<typeof buildByokAvailableModels> = []
  try {
    const clientHeaders = context?.requestHeader ?? new Headers()
    const upstream = await fetchUpstreamAvailableModels(
      clientHeaders,
      (request ?? {}) as Parameters<typeof fetchUpstreamAvailableModels>[1],
    )
    const upstreamModels = upstream?.models ?? []
    const seenUpstreamNames = new Set<string>()
    for (const upstreamModel of upstreamModels) {
      const modelName = typeof upstreamModel?.name === 'string' ? upstreamModel.name : ''
      if (!modelName || byokNameSet.has(modelName) || seenUpstreamNames.has(modelName))
        continue
      if (!isClassifierModelName(modelName))
        continue
      seenUpstreamNames.add(modelName)
      classifierStubs.push(toHiddenClassifierStubModel(upstreamModel))
    }
    logger.info(
      {
        byokCount: byok.length,
        byokClassifierCount: byok.filter(model => model.supportsSmartModeClassifier === true).length,
        upstreamCount: upstreamModels.length,
        classifierCount: classifierStubs.length,
      },
      '[MODEL] availableModels (BYOK + classifier stubs from upstream)',
    )
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[MODEL] upstream classifier lookup failed, using fallbacks')
  }
  if (classifierStubs.length === 0) {
    classifierStubs = buildClassifierFallbackStubModels().filter((stub) => !byokNameSet.has(stub.name))
    logger.info(
      {
        byokCount: byok.length,
        byokClassifierCount: byok.filter(model => model.supportsSmartModeClassifier === true).length,
        classifierCount: classifierStubs.length,
      },
      '[MODEL] availableModels (BYOK + classifier fallback stubs)',
    )
  }
  const merged = [...byok, ...classifierStubs]
  return create(AvailableModelsResponseSchema, {
    models: merged,
    modelNames: merged.map(m => m.name),
    // feature config 给空 stub,Cursor 客户端遇到空 config 会用内置默认行为
    composerModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    cmdKModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    backgroundComposerModelConfig: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    // subagentModelConfigs: map<string, FeatureModelConfig>
    // 提供 explore 条目让 Settings > Subagents 显示 "Explore subagent model" 选择器
    subagentModelConfigs: {
      explore: create(AvailableModelsResponse_FeatureModelConfigSchema, {}),
    },
    // displayConfiguration — 覆盖客户端 localStorage 缓存的官方配置:
    //   routedModelViewConfig.hideRoutedModelView = true
    //     → Auto toggle 不显示 (routedModelViewToNamedViewToggle 不存在)
    //     → 即使 modelName="default" (Auto), picker 也回退到 named-model 列表
    //   BYOK OFF 时此 handler 不被调用, 官方 server 返回含 Auto 的配置, 自动恢复。
    displayConfiguration: create(AvailableModelsResponse_ModelPickerDisplayConfigurationSchema, {
      routedModelViewConfig: create(AvailableModelsResponse_ModelPickerDisplayConfiguration_RoutedModelViewConfigSchema, {
        hideRoutedModelView: true,
      }),
    }),
    useModelParameters: true,
  })
}

/**
 * 只在客户端还没有默认模型时种一次。
 *
 * 客户端: lastDefaultModelSetDate === 0,或 nextDefaultSetDate 比它新,才 setDefaultModel。
 * 日期必须稳定。每次返回 Date.now() 都会让刷新 (新会话挂载 / 登录 / BYOK refresh)
 * 重新 setDefaultModel,把 Composer 默认模型盖成 providers.json 里第一个启用模型,
 * 并清掉参数 (Extra High / Max)。种过一次之后,选择器的最近选择由客户端自己记住。
 *
 * 返回空 {} = 不推送。没有启用模型时必须走这条,避免把未启用模型推上去。
 *
 * 候选集必须与 AvailableModels 下发的启用集一致 —— 都走 isModelDefaultOn,
 * 否则会把选择器里根本没启用的模型推成默认模型。
 */
export const DEFAULT_MODEL_SEED_DATE = '1'

export async function handleGetDefaultModel() {
  // 与 "default" 占位名映射共用同一选择函数 (requestedModelId.ts), 两处永远指向同一个模型
  const all = enabledModelEntries()
  const first = all[0]
  if (!first)
    return {}
  const thinkingModel = all.find(x => x.model.thinking)
  return {
    model: first.model.id,
    thinkingModel: thinkingModel?.model.id ?? '',
    maxMode: false,
    nextDefaultSetDate: DEFAULT_MODEL_SEED_DATE,
  }
}

/**
 * 新会话不要切回 default。
 *
 * modelDefaultSwitchOnNewChat 为 true 时,createComposer 会把模型改成 "default"。
 * BYOK 隐藏了 Auto,选择器就落到第一个具名模型。显式关掉,并把已配置模型放进豁免列表,
 * 这样即使客户端还留着旧的 true,下次拉到这份数据后也不会清掉最近使用的模型。
 * nudgeDate 保持 "0": 非 0 会再触发一次 "Model nudged to default"。
 */
export async function handleGetDefaultModelNudgeData() {
  return {
    nudgeDate: '0',
    shouldDefaultSwitchOnNewChat: false,
    modelsWithNoDefaultSwitch: flattenModels().map(entry => entry.model.id),
  }
}

export default (router: ConnectRouter) => {
  router.service(AiService, {
    serverTime: async () => ({
      receiveTimestamp: Date.now(),
      transmitTimestamp: Date.now(),
    }),

    availableModels: async (request, context) =>
      handleAvailableModels(
        (request ?? {}) as Record<string, unknown>,
        context as { requestHeader?: Headers } | undefined,
      ),

    getDefaultModel: handleGetDefaultModel,
    getDefaultModelNudgeData: handleGetDefaultModelNudgeData,
    cppConfig: async () => ({
      isOn: true,
      isGhostText: true,
      shouldLetUserEnableCppEvenIfNotPro: true,
    }),
    cppEditHistoryStatus: async () => ({ on: true, onlyIfExplicit: true }),
    availableDocs: async () => ({ docs: [] }),

    // ── KnowledgeBase (设置页 "User Rules") ──
    // 官方服务端把 items 存在用户账户云端,BYOK 用本地 knowledge-base.json 替代。
    // parseRunRequest 侧会在每次 Agent 请求时把这些 items 合入 userRules,
    // 让客户端设置页填的规则真正作用到 Agent。
    knowledgeBaseList: async () => {
      const items = listKnowledgeItems()
      return {
        success: true,
        allResults: items.map(it => ({
          id: it.id,
          knowledge: it.knowledge,
          title: it.title,
          createdAt: it.createdAt,
          isGenerated: it.isGenerated,
        })),
      }
    },
    knowledgeBaseAdd: async (req) => {
      const item = await addKnowledgeItem({
        knowledge: req.knowledge ?? '',
        title: req.title ?? '',
      })
      return { success: true, id: item.id }
    },
    knowledgeBaseUpdate: async (req) => {
      const ok = await updateKnowledgeItem(req.id ?? '', {
        knowledge: req.knowledge ?? undefined,
        title: req.title ?? undefined,
      })
      return { success: ok }
    },
    knowledgeBaseRemove: async (req) => {
      const ok = await removeKnowledgeItem(req.id ?? '')
      return { success: ok }
    },

    reportClientNumericMetrics: async () => ({}),
    updateVscodeProfile: async () => ({}),
  })
}
