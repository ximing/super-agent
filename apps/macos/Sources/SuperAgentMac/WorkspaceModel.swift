import Foundation
import SwiftUI
import SuperAgentCore

@MainActor final class WorkspaceModel: ObservableObject {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? "https://super-agent.aimo.plus"
    @Published var session: Session?
    @Published var authConfig: AuthConfig?
    @Published var devices: [Device] = []
    @Published var tasks: [AgentTask] = []
    @Published var messages: [Message] = []
    @Published var questions: [Question] = []
    @Published var memories: [Memory] = []
    @Published var memorySettings: MemorySettings?
    @Published var costs: CostSummary?
    @Published var series: [CostPoint] = []
    @Published var breakdown: [CostBreakdown] = []
    @Published var budget: Budget?
    @Published var settings: ExecutionSettings?
    @Published var error: String?
    @Published var busy = false
    @Published var loginPhase: LoginPhase?
    @Published var loginInProgress = false
    @Published var sessionRestoring = false
    @Published var sessionRestoreMessage: String?
    private var bootstrapStarted = false
    private var restoreAttempt: UUID?
    private var loginTask: Task<Void, Never>?
    @Published var lastSync: Date?
    @Published var selectedEngine: Engine = .codex
    @Published var selectedDevice = ""
    @Published var selectedModelId = ""
    @Published var assistantDraft = ""
    @Published var taskDrafts: [String: String] = [:]
    @Published var notificationStatus: String?
    private(set) var isDemo = false
    var demoRuns: [Run] = []
    var demoTaskMessages: [Message] = []
    var demoEvidence: [String: TaskEvidence] = [:]
    var demoArtifacts: [Artifact] = []
    var demoSteps: [ToolStep] = []
    weak var notifications: NativeNotifications?
    var cursor = "0"
    var seenSeqs: Set<String> = []
    private var pollTask: Task<Void, Never>?
    @Published var outbound: [OutboundMessage] = []
    @Published var processingRecords: [String: MessageProcessing] = [:]
    @Published var controlNotices: [String: String] = [:]
    @Published var stageRecords: [String: TaskStageRecord] = [:]
    @Published var capabilities = InteractionCapabilities.legacy
    @Published var syncing = false
    @Published var syncNote: String?
    @Published var connectionBanner: String?
    @Published var serverConnected = false
    @Published var authRequired = false
    @Published var fastChoice: FastChoice?
    @Published private(set) var busyKeys: Set<String> = []
    func markBusy(_ key: String, _ active: Bool) {
        if active { busyKeys.insert(key) } else { busyKeys.remove(key) }
    }
    func clearBusyKeys() { busyKeys = [] }
    var laneTail: [String: Task<Void, Never>] = [:]
    var laneAction: [String: String] = [:]
    var projection = ProjectionJournal()
    var loadedScope: InteractionScope?
    var scopeGeneration = 0
    var disconnectStarted: Date?
    var receiptById: [String: ActionReceipt] = [:]
    let interactionStore = InteractionFileStore.applicationSupport()
    let api: APIClient
    private let oidc = OIDCLogin()
    init() { api = APIClient(baseURL: URL(string: UserDefaults.standard.string(forKey: "server") ?? "https://super-agent.aimo.plus") ?? URL(string: "https://super-agent.aimo.plus")!) }
    func bootstrap() async {
        guard !bootstrapStarted, !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        bootstrapStarted = true
        await Task.yield()
        await restoreSavedSession()
    }
    func restoreSavedSession(allowInteraction: Bool = false) async {
        guard !sessionRestoring, !loginInProgress, session == nil else { return }
        let attempt = UUID(); restoreAttempt = attempt; sessionRestoring = true
        sessionRestoreMessage = allowInteraction ? "正在恢复已保存登录，请留意系统的钥匙串授权提示。" : "正在检查已保存登录…"
        // An OS Keychain call may ignore noninteractive hints and never return.
        // This independent deadline ends only the UX/generation, not the read's
        // worker thread, and never waits for an uncancellable task-group child.
        let deadline: Task<Void, Never>? = allowInteraction ? nil : Task { [weak self] in
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            guard let self, self.restoreAttempt == attempt, self.session == nil, !self.loginInProgress else { return }
            self.restoreAttempt = nil; self.sessionRestoring = false
            self.sessionRestoreMessage = "安全存储响应较慢，已停止自动等待。可以重新登录；旧凭据会保留，系统请求未结束前不会重复读取。"
            await self.api.cancelSessionRestoration()
            if self.authConfig == nil { Task { await self.loadAuthConfig() } }
        }
        defer { deadline?.cancel(); if restoreAttempt == attempt { sessionRestoring = false; restoreAttempt = nil } }
        do {
            if allowInteraction { try await configure() }
            let saved = try await api.restoreSession(allowInteraction: allowInteraction)
            guard restoreAttempt == attempt, !loginInProgress else { return }
            session = saved
            sessionRestoreMessage = saved == nil ? "没有可自动恢复的登录，可以直接登录。" : nil
            if saved != nil { authRequired = false; await refresh(); startPolling() }
        } catch {
            guard restoreAttempt == attempt, !loginInProgress else { return }
            sessionRestoreMessage = (error as? APIError)?.message ?? "暂时无法恢复已保存登录，可以直接重新登录；旧凭据会保留。"
        }
        if session == nil, restoreAttempt == attempt { await loadAuthConfig() }
    }
    func skipSessionRestoration() async {
        restoreAttempt = nil; sessionRestoring = false
        sessionRestoreMessage = "已跳过恢复，可以重新登录；旧凭据会保留。"
        await api.cancelSessionRestoration()
        if authConfig == nil { await loadAuthConfig() }
    }
    func configure() async throws {
        let url = try APIClient.validatedURL(server)
        UserDefaults.standard.set(url.absoluteString, forKey: "server")
        await api.configure(url); session = await api.currentSession(); resetInteractionMemory()
        await loadAuthConfig()
    }
    func loadAuthConfig() async {
        do { authConfig = try await api.request("/auth/config", authenticated: false) }
        catch { self.error = error.localizedDescription }
    }
    func signIn(email: String, name: String, mode: LoginBrowserMode = .system) async {
        guard loginTask == nil else { return }
        restoreAttempt = nil; sessionRestoring = false; sessionRestoreMessage = nil
        loginInProgress = true; busy = true; error = nil; loginPhase = .configure
        loginTask = Task {
            defer { loginTask = nil; loginInProgress = false; busy = false }
            do {
                await api.cancelSessionRestoration()
                try await configure()
                try Task.checkCancellation()
                guard let config = authConfig else { throw APIError(status: 0, code: "auth_config", message: "无法取得服务器登录方式") }
                if config.mode == "development" { session = try await api.loginDevelopment(email: email, name: name) }
                else {
                    let token = try await oidc.authenticate(config: config, mode: mode) { [weak self] phase in self?.loginPhase = phase }
                    loginPhase = .productSession
                    let result: Session = try await api.request("/auth/exchange", method: "POST", body: ["access_token": .string(token)], authenticated: false)
                    try Task.checkCancellation()
                    try await api.setSession(result); session = result
                }
                loginPhase = .loadingWorkspace
                authRequired = false
                await refresh(); startPolling(); loginPhase = nil
            } catch is CancellationError { error = "已取消登录"; loginPhase = nil }
            catch let failure as URLError where failure.code == .cancelled { error = "已取消登录"; loginPhase = nil }
            catch let failure as URLError where failure.code == .timedOut { error = "登录连接超时，请检查网络后重试"; loginPhase = nil }
            catch { self.error = error.localizedDescription; loginPhase = nil }
        }
        await loginTask?.value
    }
    func cancelSignIn() { loginTask?.cancel(); oidc.cancel() }
    func handleLoginCallback(_ url: URL) { oidc.handleCallback(url) }
    func signOut() async {
        pollTask?.cancel(); resetInteractionMemory(); await api.logout(); session = nil; tasks = []; devices = []; messages = []; questions = []; memories = []; costs = nil; series = []; breakdown = []; budget = nil; memorySettings = nil; settings = nil; selectedDevice = ""; selectedModelId = ""; selectedEngine = .codex; assistantDraft = ""; taskDrafts = [:]; isDemo = false; demoRuns = []; demoTaskMessages = []; demoEvidence = [:]; demoArtifacts = []; demoSteps = []; lastSync = nil; error = nil; syncNote = nil
    }
    func startPolling(restore: Bool = true) {
        pollTask?.cancel()
        let generation = scopeGeneration
        pollTask = Task { [weak self] in
            guard let self else { return }
            if restore {
                await self.restoreCursor()
                await self.recoverOutbound(generation: generation)
            }
            await self.runEventStream()
        }
    }
    func reconnectEventStream() {
        guard session != nil, !isDemo else { return }
        startPolling(restore: false)
    }

    func claim(_ code: String) async {
        await operation { let _: JSONValue = try await self.api.request("/device-pairings/claim", method: "POST", body: ["code": .string(code.trimmingCharacters(in: .whitespacesAndNewlines))]); await self.refresh() }
    }
    func revokeDevice(_ id: String) async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do { try await api.revokeDevice(id: id); await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func saveSettings(engine: Engine, device: String, assistant: String, memoryGlobalRead: Bool) async {
        await operation {
            let body = RequestBodies.executionSettings(engine: engine.rawValue, device: device, assistant: assistant, memoryGlobalRead: memoryGlobalRead)
            let result: ExecutionSettings = try await self.api.request("/settings/execution", method: "PUT", body: body, version: self.settings?.version)
            self.settings = result; self.selectedEngine = engine; self.selectedDevice = device
        }
    }
    func saveMemory(id: String? = nil, title: String, content: String, type: String, site: String, version: Int? = nil, publish: Bool = false) async -> Bool {
        busy = true; error = nil; defer { busy = false }
        do {
            var body: [String: JSONValue] = ["title": .string(title), "content": .string(content), "type": .string(type), "site": site.isEmpty ? .null : .string(site)]
            if publish { body["status"] = .string("verified") }
            let saved: Memory = try await api.request(id.map { "/memories/\($0)" } ?? "/memories", method: id == nil ? "POST" : "PATCH", body: body, version: version)
            memories.removeAll { $0.id == id || $0.id == saved.id }
            memories.insert(saved, at: 0)
            await refresh()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func connectMemory(url: String, token: String, project: String) async {
        await operation {
            guard let parsed = URL(string: url), parsed.scheme == "https", parsed.host != nil, parsed.user == nil, parsed.password == nil, parsed.query == nil, parsed.fragment == nil else { throw APIError(status: 0, code: "memory_url", message: "记忆服务需要有效的 HTTPS 地址") }
            guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(status: 0, code: "memory_token", message: "请填写你自己的记忆库访问令牌") }
            do {
                self.memorySettings = try await self.api.request("/settings/memory", method: "PUT", body: RequestBodies.memoryBinding(url: url, token: token, project: project), version: self.memorySettings?.version)
            } catch let failure as APIError where RequestBodies.memorySettingsConflictMessage(status: failure.status, code: failure.code) != nil {
                await self.refresh()
                throw APIError(status: failure.status, code: failure.code, message: RequestBodies.memorySettingsConflictMessage(status: failure.status, code: failure.code) ?? failure.message)
            }
            await self.refresh()
        }
    }
    func deleteMemory(_ memory: Memory) async { await operation { let _: JSONValue = try await self.api.request("/memories/\(memory.id)", method: "DELETE", version: memory.version); await self.refresh() } }
    func relateMemory(_ memory: Memory, relation: String, otherId: String, validUntil: String) async -> String? {
        guard !busy else { return "上一项操作还在进行" }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let body = try RequestBodies.memoryRelation(relation: relation, otherId: otherId, validUntil: validUntil, governanceVersion: memory.governance?.version ?? 0, operationKey: "relation:\(relation):\(UUID().uuidString)")
            let _: Memory = try await api.request("/memories/\(memory.id)/relations", method: "POST", body: body, version: memory.version)
            await refresh()
            return nil
        } catch let failure as APIError where RequestBodies.relationConflictMessage(status: failure.status, code: failure.code) != nil {
            await refresh()
            let message = RequestBodies.relationConflictMessage(status: failure.status, code: failure.code) ?? failure.message
            self.error = message
            return message
        } catch {
            let message = error.localizedDescription
            self.error = message
            return message
        }
    }
    func loadCosts(group: String = "device", from: String? = nil, to: String? = nil) async {
        await operation {
            var query = URLComponents(); query.queryItems = [URLQueryItem(name: "group_by", value: group)]
            if let from { query.queryItems?.append(URLQueryItem(name: "from", value: from)) }
            if let to { query.queryItems?.append(URLQueryItem(name: "to", value: to)) }
            let suffix = "?" + (query.percentEncodedQuery ?? "")
            self.costs = try await self.api.request("/costs/summary" + suffix)
            let points: Items<CostPoint> = try await self.api.request("/costs/series" + suffix); self.series = points.items
            let groups: Items<CostBreakdown> = try await self.api.request("/costs/breakdown" + suffix); self.breakdown = groups.items
            self.budget = try await self.api.request("/budgets")
        }
    }
    func saveBudget(monthly: String, task: String) async {
        await operation {
            self.budget = try await self.api.request("/budgets", method: "PUT", body: RequestBodies.moneyBudgetMerge(monthly: monthly, task: task), version: self.budget?.version)
        }
    }
    func saveCategoryLimits(_ draft: [String: [String: String]]) async {
        await operation {
            self.budget = try await self.api.request("/budgets", method: "PUT", body: try RequestBodies.categoryLimits(fromDraft: draft), version: self.budget?.version)
        }
    }
    func operation(_ action: () async throws -> Void) async {
        busy = true; defer { busy = false }
        do { try await action(); error = nil } catch { self.error = error.localizedDescription }
    }
    func enableNotifications() async { await notifications?.enable() }
    func taskDraftBinding(for id: String) -> Binding<String> {
        Binding(get: { self.taskDrafts[id] ?? "" }, set: { self.taskDrafts[id] = $0 })
    }
    func markAsDemo() { isDemo = true }
}
