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
    @Published var lastSync: Date?
    @Published var selectedEngine: Engine = .codex
    @Published var selectedDevice = ""
    @Published var selectedModelId = ""
    @Published var notificationStatus: String?
    weak var notifications: NativeNotifications?
    private var cursor = "0"
    private var pollTask: Task<Void, Never>?
    let api: APIClient
    private let oidc = OIDCLogin()
    init() { api = APIClient(baseURL: URL(string: UserDefaults.standard.string(forKey: "server") ?? "https://super-agent.aimo.plus") ?? URL(string: "https://super-agent.aimo.plus")!) }
    func bootstrap() async {
        guard !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        session = await api.currentSession()
        if session != nil { await refresh(); startPolling() }
        else { await loadAuthConfig() }
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
    func signIn(email: String, name: String) async {
        await operation {
            try await self.configure()
            guard let config = self.authConfig else { throw APIError(status: 0, code: "auth_config", message: "无法取得服务器登录方式") }
            if config.mode == "development" { self.session = try await self.api.loginDevelopment(email: email, name: name) }
            else {
                let token = try await self.oidc.authenticate(config: config)
                let result: Session = try await self.api.request("/auth/exchange", method: "POST", body: ["access_token": .string(token)], authenticated: false)
                try await self.api.setSession(result); self.session = result
            }
            await self.refresh(); self.startPolling()
        }
    }
    func signOut() async {
        pollTask?.cancel(); await api.logout(); session = nil; tasks = []; devices = []; messages = []; questions = []; memories = []; costs = nil; series = []; breakdown = []; budget = nil; memorySettings = nil; settings = nil; selectedDevice = ""; selectedModelId = ""; selectedEngine = .codex; lastSync = nil; error = nil; cursor = "0"
    }
    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self, self.session != nil else { return }
                do {
                    let batch: EventBatch = try await self.api.request("/events?after=\(self.cursor)")
                    self.cursor = batch.cursor
                    if !batch.items.isEmpty { await self.refresh() }
                    else { self.lastSync = Date() }
                } catch let e as APIError where e.status == 410 { self.cursor = "0"; await self.refresh() }
                catch { self.error = error.localizedDescription; if await self.api.currentSession() == nil { self.session = nil; return } }
            }
        }
    }
    func refresh() async {
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
            if selectedDevice.isEmpty { selectedDevice = settings?.defaultDeviceId ?? devices.first?.id ?? ""; selectedEngine = settings?.defaultEngine ?? .codex }
            lastSync = Date(); error = nil
        } catch { self.error = error.localizedDescription }
    }
    func sendMessage(_ text: String, taskId: String? = nil) async {
        await operation {
            var body: [String: JSONValue] = ["client_message_id": .string(UUID().uuidString), "text": .string(text)]
            if let taskId { body["task_id"] = .string(taskId) }
            if !self.selectedDevice.isEmpty { body["execution_preference"] = .object(["engine": .string(self.selectedEngine.rawValue), "device_id": .string(self.selectedDevice), "selection_mode": .string("pinned")]) }
            let _: Message = try await self.api.request("/messages", method: "POST", body: body)
            await self.refresh()
        }
    }
    func createTask(_ goal: String) async {
        await operation {
            guard !self.selectedDevice.isEmpty else { throw APIError(status: 0, code: "device_required", message: "先选择执行电脑；可以在电脑页认领已安装的节点") }
            var body: [String: JSONValue] = ["goal": .string(goal), "engine": .string(self.selectedEngine.rawValue), "device_id": .string(self.selectedDevice)]
            if !self.selectedModelId.isEmpty { body["model_id"] = .string(self.selectedModelId) }
            let _: AgentTask = try await self.api.request("/tasks", method: "POST", body: body)
            await self.refresh()
        }
    }
    func action(_ action: String, task: AgentTask, targetEngine: Engine? = nil, targetDevice: String? = nil) async {
        await operation {
            var body: [String: JSONValue] = ["action": .string(action)]
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
    func saveSettings(engine: Engine, device: String, assistant: String) async {
        await operation {
            let body: [String: JSONValue] = ["default_engine": .string(engine.rawValue), "default_device_id": device.isEmpty ? .null : .string(device), "assistant_device_id": assistant.isEmpty ? .null : .string(assistant)]
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
    func connectMemory(url: String, token: String) async {
        await operation {
            guard let parsed = URL(string: url), parsed.scheme == "https", parsed.host != nil, parsed.user == nil, parsed.password == nil, parsed.query == nil, parsed.fragment == nil else { throw APIError(status: 0, code: "memory_url", message: "记忆服务需要有效的 HTTPS 地址") }
            guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(status: 0, code: "memory_token", message: "请填写你自己的记忆库访问令牌") }
            self.memorySettings = try await self.api.request("/settings/memory", method: "PUT", body: ["url": .string(url), "token": .string(token)], version: self.memorySettings?.version)
            await self.refresh()
        }
    }
    func deleteMemory(_ memory: Memory) async { await operation { let _: JSONValue = try await self.api.request("/memories/\(memory.id)", method: "DELETE", version: memory.version); await self.refresh() } }
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
            self.budget = try await self.api.request("/budgets", method: "PUT", body: ["monthly_limit_usd": monthly.isEmpty ? .null : .string(monthly), "task_limit_usd": task.isEmpty ? .null : .string(task)], version: self.budget?.version)
        }
    }
    func operation(_ action: () async throws -> Void) async {
        busy = true; defer { busy = false }
        do { try await action(); error = nil } catch { self.error = error.localizedDescription }
    }
    func enableNotifications() async { await notifications?.enable() }
}
