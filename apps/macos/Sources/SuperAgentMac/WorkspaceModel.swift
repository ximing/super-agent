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
    private var cursor = "0"
    private var seenSeqs: Set<String> = []
    private var pollTask: Task<Void, Never>?
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
            if saved != nil { await refresh(); startPolling() }
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
        await api.configure(url); session = await api.currentSession(); cursor = "0"
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
        pollTask?.cancel(); await api.logout(); session = nil; tasks = []; devices = []; messages = []; questions = []; memories = []; costs = nil; series = []; breakdown = []; budget = nil; memorySettings = nil; settings = nil; selectedDevice = ""; selectedModelId = ""; selectedEngine = .codex; assistantDraft = ""; taskDrafts = [:]; isDemo = false; demoRuns = []; demoTaskMessages = []; demoEvidence = [:]; demoArtifacts = []; demoSteps = []; lastSync = nil; error = nil; cursor = "0"; seenSeqs = []
    }
    func startPolling(restore: Bool = true) {
        pollTask?.cancel()
        if restore { restoreCursor() }
        pollTask = Task { [weak self] in
            await self?.runEventStream()
        }
    }
    func reconnectEventStream() {
        guard session != nil, !isDemo else { return }
        startPolling(restore: false)
    }
    private func restoreCursor() {
        seenSeqs = []
        guard let id = session?.user.id else { cursor = "0"; return }
        let saved = UserDefaults.standard.string(forKey: "event-cursor.\(id)") ?? "0"
        cursor = saved.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil ? saved : "0"
    }
    private func storeCursor() {
        guard let id = session?.user.id, cursor.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil else { return }
        UserDefaults.standard.set(cursor, forKey: "event-cursor.\(id)")
    }
    private func runEventStream() async {
        var failureDelay = 0.0
        var nextReconcile = Date().addingTimeInterval(45)
        while !Task.isCancelled {
            if session == nil || isDemo { return }
            if Date() >= nextReconcile {
                await refresh()
                nextReconcile = Date().addingTimeInterval(45)
                if Task.isCancelled || session == nil { return }
            }
            if failureDelay > 0 {
                do { try await Task.sleep(for: .seconds(failureDelay)) } catch { return }
            }
            if Task.isCancelled || session == nil || isDemo { return }
            do {
                let stream = try await api.events(after: cursor)
                var remainder = ""
                for try await line in stream {
                    if Task.isCancelled { return }
                    let consumed = EventStreamDecoder.consume(line + "\n", cursor: cursor, seen: seenSeqs, remainder: remainder)
                    remainder = consumed.remainder
                    let moved = consumed.cursor != cursor
                    cursor = consumed.cursor
                    seenSeqs = consumed.seen
                    if moved { storeCursor() }
                    if !consumed.applied.isEmpty { await applyStream(consumed.applied) }
                }
                if !remainder.isEmpty {
                    let consumed = EventStreamDecoder.consume("\n", cursor: cursor, seen: seenSeqs, remainder: remainder)
                    let moved = consumed.cursor != cursor
                    cursor = consumed.cursor
                    seenSeqs = consumed.seen
                    if moved { storeCursor() }
                    if !consumed.applied.isEmpty { await applyStream(consumed.applied) }
                }
                failureDelay = 0
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch let error as APIError where error.status == 401 {
                do {
                    let _: User = try await api.request("/me")
                    failureDelay = 0
                } catch {
                    if await api.currentSession() == nil { session = nil }
                    return
                }
            } catch let error as APIError where error.status == 422 || error.status == 410 || error.code == "invalid_cursor" {
                if cursor != "0" {
                    cursor = "0"; seenSeqs = []; storeCursor(); failureDelay = 0
                } else {
                    failureDelay = min(max(failureDelay, 1) * 2, 30)
                }
            } catch {
                if await api.currentSession() == nil { session = nil; return }
                failureDelay = failureDelay == 0 ? 1 : min(failureDelay * 2, 30)
            }
        }
    }
    private func applyStream(_ events: [AppliedStreamEvent]) async {
        var taskIds: [String] = []
        var reloadDevices = false
        var reloadQuestions = false
        var reloadMessages = false
        for event in events where event.type != "cursor" {
            if let taskId = event.taskId, !taskIds.contains(taskId) { taskIds.append(taskId) }
            if event.type == "device.changed" { reloadDevices = true }
            if event.type == "notification.created" || event.type == "question.created" || event.type == "question.resolved" { reloadQuestions = true }
            if event.type == "message.created" || event.type == "assistant.replied" || event.type.hasPrefix("plan.") { reloadMessages = true }
        }
        for id in taskIds {
            if let task: AgentTask = try? await api.request("/tasks/\(id)") {
                if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
                else { tasks.insert(task, at: 0) }
            }
        }
        if reloadMessages, let list: Items<Message> = try? await api.request("/messages") { messages = list.items }
        if reloadDevices, let list: Items<Device> = try? await api.request("/devices") { devices = list.items }
        if reloadQuestions, let list: Items<Question> = try? await api.request("/questions?status=open") {
            let previous = Set(questions.map(\.id))
            if lastSync != nil { NativeNotifications.announceNewQuestions(list.items.filter { !previous.contains($0.id) }) }
            questions = list.items
        }
        if events.contains(where: { $0.type != "cursor" }) { lastSync = Date() }
    }
    func refresh() async {
        guard !isDemo else { lastSync = Date(); return }
        do {
            let taskList: Items<AgentTask> = try await api.request("/tasks"); tasks = taskList.items
            let deviceList: Items<Device> = try await api.request("/devices"); devices = deviceList.items
            let messageList: Items<Message> = try await api.request("/messages"); messages = messageList.items
            let questionList: Items<Question> = try await api.request("/questions?status=open")
            let previous = Set(questions.map(\.id))
            if lastSync != nil { NativeNotifications.announceNewQuestions(questionList.items.filter { !previous.contains($0.id) }) }
            questions = questionList.items
            memorySettings = try await api.request("/settings/memory")
            if memorySettings?.configured == true { let memoryList: Items<Memory> = try await api.request("/memories"); memories = memoryList.items }
            else { memories = [] }
            settings = try await api.request("/settings/execution")
            if selectedDevice.isEmpty { selectedDevice = settings?.defaultDeviceId ?? devices.first(where: { $0.revoked != true })?.id ?? ""; selectedEngine = settings?.defaultEngine ?? .codex }
            lastSync = Date(); error = nil
        } catch { self.error = error.localizedDescription }
    }
    func sendMessage(_ text: String, taskId: String? = nil, scope: MemoryScopeDraft = MemoryScopeDraft()) async {
        await operation {
            var body: [String: JSONValue] = ["client_message_id": .string(UUID().uuidString), "text": .string(text), "memory_scope": try RequestBodies.memoryScope(scope)]
            if let taskId { body["task_id"] = .string(taskId) }
            if !self.selectedDevice.isEmpty { body["execution_preference"] = .object(["engine": .string(self.selectedEngine.rawValue), "device_id": .string(self.selectedDevice), "selection_mode": .string("pinned")]) }
            let _: Message = try await self.api.request("/messages", method: "POST", body: body)
            await self.refresh()
        }
    }
    func createTask(_ goal: String, scope: MemoryScopeDraft = MemoryScopeDraft()) async {
        await operation {
            guard !self.selectedDevice.isEmpty else { throw APIError(status: 0, code: "device_required", message: "先选择执行电脑；可以在电脑页认领已安装的节点") }
            guard self.devices.first(where: { $0.id == self.selectedDevice })?.revoked != true else { throw APIError(status: 0, code: "device_revoked", message: "此电脑已撤销，请手动选择其他电脑") }
            var body: [String: JSONValue] = ["goal": .string(goal), "engine": .string(self.selectedEngine.rawValue), "device_id": .string(self.selectedDevice), "memory_scope": try RequestBodies.memoryScope(scope)]
            if !self.selectedModelId.isEmpty { body["model_id"] = .string(self.selectedModelId) }
            let _: AgentTask = try await self.api.request("/tasks", method: "POST", body: body)
            await self.refresh()
        }
    }
    func raiseLimitAndRetry(task: AgentTask, reason: String, raw: String) async {
        await operation {
            guard let value = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw APIError(status: 0, code: "invalid_budget", message: "请输入整数上限") }
            let updated: AgentTask = try await self.api.request("/tasks/\(task.id)/budget", method: "PUT", body: try RequestBodies.taskBudgetMerge(reason: reason, value: value), version: task.version)
            let _: JSONValue = try await self.api.request("/tasks/\(updated.id)/actions", method: "POST", body: ["action": .string("retry")], version: updated.version)
            await self.refresh()
        }
    }
    func action(_ action: String, task: AgentTask, targetEngine: Engine? = nil, targetDevice: String? = nil) async {
        await operation {
            var body: [String: JSONValue] = ["action": .string(action)]
            if action == "switch", let device = targetDevice, self.devices.first(where: { $0.id == device })?.revoked == true { throw APIError(status: 0, code: "device_revoked", message: "此电脑已撤销，请手动选择其他电脑") }
            if action == "switch", let engine = targetEngine, let device = targetDevice { body["target"] = .object(["engine": .string(engine.rawValue), "device_id": .string(device)]) }
            let _: JSONValue = try await self.api.request("/tasks/\(task.id)/actions", method: "POST", body: body, version: task.version)
            await self.refresh()
        }
    }
    func answer(_ question: Question, text: String) async {
        await operation { let _: JSONValue = try await self.api.request("/questions/\(question.id)/answers", method: "POST", body: ["answer": .string(text), "version": .number(Double(question.version))], version: question.version); await self.refresh() }
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
