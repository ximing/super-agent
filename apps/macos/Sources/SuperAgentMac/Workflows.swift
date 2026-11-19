import SwiftUI
import AppKit
import UniformTypeIdentifiers
import SuperAgentCore

struct SchedulesView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var rules: [Schedule] = []
    @State private var editing = false
    @State private var title = ""
    @State private var goal = ""
    @State private var minutes = "60"
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ObservationRulesSection()
                HStack { VStack(alignment: .leading, spacing: 7) { Text("关注规则").font(.headline); Text("定时提醒并准备工作目标，你确认后再执行。").font(.callout).foregroundStyle(.secondary) }; Spacer(); Button("添加关注") { editing = true }.controlSize(.small) }
                if rules.isEmpty { EmptyState(icon: "clock.arrow.circlepath", title: "还没有定时关注", detail: "例如每小时提醒检查指定系统，或每天准备工作的汇总计划。每次提醒后，由你确认目标再执行。") }
                ForEach(rules) { rule in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text(rule.title).font(.callout.weight(.medium)); Spacer(); Toggle("启用", isOn: Binding(get: { rule.enabled }, set: { enabled in Task { await change(rule, enabled: enabled) } })).toggleStyle(.switch).controlSize(.small) }
                        Text(rule.goal).font(.callout).textSelection(.enabled)
                        Text("每 \(rule.intervalMinutes) 分钟 · \(rule.engine.rawValue.capitalized) · \(model.devices.first(where: { $0.id == rule.deviceId })?.name ?? "指定电脑")").font(.caption).foregroundStyle(.secondary)
                        HStack { Text(rule.enabled ? "下次提醒：\(rule.nextDueAt.map(formatTime) ?? "等待计划")" : "已暂停关注").font(.caption).foregroundStyle(.secondary); Spacer(); Button("删除", role: .destructive) { Task { await remove(rule) } } }
                    }.padding(.vertical, 14)
                    Divider()
                }
            }.padding(28).frame(maxWidth: 840, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }.task(id: model.lastSync) { await load() }.sheet(isPresented: $editing) {
            VStack(alignment: .leading, spacing: 18) {
                Text("添加定时关注").font(.title3.weight(.semibold))
                TextField("关注事项名称", text: $title).textFieldStyle(.roundedBorder)
                ExecutionPicker()
                TextEditor(text: $goal).frame(height: 150).border(.quaternary)
                HStack { Text("间隔（分钟）"); TextField("5–525600", text: $minutes).textFieldStyle(.roundedBorder).frame(width: 150) }
                Text("保存后定时提醒并准备目标，不会自动执行业务操作。你在聊天中确认后开始，可随时停用。").font(.callout).foregroundStyle(.secondary)
                if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange) }
                HStack { Button("取消") { editing = false }; Spacer(); Button("保存提醒") { Task { await create() } }.buttonStyle(.borderedProminent).disabled(title.isEmpty || goal.isEmpty || model.selectedDevice.isEmpty || model.busy) }
            }.padding(28).frame(width: 650)
        }
    }
    private func load() async { guard !model.isDemo else { return }; do { let result: Items<Schedule> = try await model.api.request("/schedules"); rules = result.items } catch { model.error = error.localizedDescription } }
    private func create() async {
        await model.operation {
            guard model.devices.first(where: { $0.id == model.selectedDevice })?.revoked != true else { throw APIError(status: 0, code: "device_revoked", message: "此电脑已撤销，请手动选择其他电脑") }
            guard let interval = Int(minutes), (5...525600).contains(interval) else { throw APIError(status: 0, code: "schedule_interval", message: "间隔应为 5–525600 的整数分钟") }
            let _: Schedule = try await model.api.request("/schedules", method: "POST", body: ["title": .string(title), "goal": .string(goal), "engine": .string(model.selectedEngine.rawValue), "device_id": .string(model.selectedDevice), "interval_minutes": .number(Double(interval))])
            editing = false; title = ""; goal = ""; await load()
        }
    }
    private func change(_ rule: Schedule, enabled: Bool) async { await model.operation { let _: JSONValue = try await model.api.request("/schedules/\(rule.id)", method: "PATCH", body: ["enabled": .bool(enabled)], version: rule.version); await load() } }
    private func remove(_ rule: Schedule) async { await model.operation { let _: JSONValue = try await model.api.request("/schedules/\(rule.id)", method: "DELETE", version: rule.version); await load() } }
}

private struct ObservationSuggestionItem: Decodable, Identifiable {
    let id: String
    let status: String
    let reason: String
}

private struct ObservationRuleItem: Decodable, Identifiable {
    let id: String
    let title: String
    let enabled: Bool
    let version: Int
    let lastStatus: String
    let suggestions: [ObservationSuggestionItem]
    enum CodingKeys: String, CodingKey { case id, title, enabled, version, suggestions; case lastStatus = "last_status" }
}

struct ObservationRulesSection: View {
    @EnvironmentObject private var model: WorkspaceModel
    @State private var rules: [ObservationRuleItem] = []
    @State private var title = ""
    @State private var goal = ""
    @State private var sites = ""
    @State private var project = ""
    @State private var source = "task_result"
    @State private var taskId = ""
    @State private var match = "status"
    @State private var value = "awaiting_review"
    @State private var pageURL = ""
    @State private var condition = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("按变化提出建议").font(.headline)
            Text("任务状态或授权网页上的条件成立时，先给你一条建议。确认后才创建任务。项目和网站是这条任务的记忆上限，不会改写已有记忆。").font(.callout).foregroundStyle(.secondary)
            TextField("规则名称", text: $title).textFieldStyle(.roundedBorder)
            TextField("确认后要做的事", text: $goal).textFieldStyle(.roundedBorder)
            TextField("网站，逗号分隔", text: $sites).textFieldStyle(.roundedBorder)
            TextField("项目，可空", text: $project).textFieldStyle(.roundedBorder)
            Picker("来源", selection: $source) { Text("任务结果").tag("task_result"); Text("网页").tag("page") }.pickerStyle(.segmented)
            if source == "page" {
                TextField("https 地址", text: $pageURL).textFieldStyle(.roundedBorder)
                TextField("业务条件", text: $condition).textFieldStyle(.roundedBorder)
            } else {
                TextField("任务标识", text: $taskId).textFieldStyle(.roundedBorder)
                TextField("status、delivery 或 reason", text: $match).textFieldStyle(.roundedBorder)
                TextField("期望值", text: $value).textFieldStyle(.roundedBorder)
            }
            Button("保存观察规则") { Task { await create() } }
                .disabled(title.isEmpty || goal.isEmpty || model.selectedDevice.isEmpty || model.busy)
            ForEach(rules) { rule in
                VStack(alignment: .leading, spacing: 8) {
                    Text(rule.title).font(.callout.weight(.medium))
                    Text(rule.lastStatus).font(.caption).foregroundStyle(.secondary)
                    ForEach(rule.suggestions.filter { $0.status == "pending" }) { suggestion in
                        Text(suggestion.reason).font(.caption).textSelection(.enabled)
                        HStack {
                            Button("确认并创建任务") { Task { await decide(rule, suggestion, action: "confirm") } }
                            Button("忽略") { Task { await decide(rule, suggestion, action: "dismiss") } }
                        }
                    }
                }
                Divider()
            }
        }
        .task(id: model.lastSync) { await load() }
    }
    private func load() async {
        guard !model.isDemo else { return }
        do { let result: Items<ObservationRuleItem> = try await model.api.request("/observation-rules"); rules = result.items } catch { model.error = error.localizedDescription }
    }
    private func create() async {
        await model.operation {
            let body = try RequestBodies.observationRule(title: title, goal: goal, deviceId: model.selectedDevice, engine: model.selectedEngine.rawValue, sites: sites, project: project, cooldownMinutes: 30, source: source, taskId: taskId, match: match, value: value, url: pageURL, condition: condition)
            let _: JSONValue = try await model.api.request("/observation-rules", method: "POST", body: body)
            title = ""; goal = ""; await load()
        }
    }
    private func decide(_ rule: ObservationRuleItem, _ suggestion: ObservationSuggestionItem, action: String) async {
        await model.operation {
            let _: JSONValue = try await model.api.request("/observation-rules/\(rule.id)/suggestions/\(suggestion.id)", method: "POST", body: ["action": .string(action)], version: rule.version)
            await load()
        }
    }
}

struct TaskArtifactsView: View {
    @EnvironmentObject var model: WorkspaceModel
    let taskId: String
    @State private var files: [Artifact] = []
    @State private var transferring = false
    @State private var transferStatus: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("任务附件与交付物", systemImage: "paperclip").font(.headline)
                Spacer()
                if transferring { ProgressView().controlSize(.small) }
                Button("添加文件") { chooseFile() }
                    .disabled(transferring)
                    .accessibilityLabel("添加任务附件")
            }
            if files.isEmpty {
                Text("可添加本次任务需要的资料，已上传的文件仅对本用户及获授权任务开放。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                HStack(spacing: 10) {
                    Image(systemName: "doc").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(file.name).font(.callout).textSelection(.enabled)
                        Text(file.mime).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("保存到本机") { save(file) }
                        .disabled(transferring)
                        .accessibilityLabel("保存 \(file.name) 到本机")
                }
                .padding(.vertical, 5)
                if index < files.count - 1 { Divider() }
            }
            if let transferStatus {
                Text(transferStatus).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: model.lastSync) { await load() }
    }
    private func load() async {
        if model.isDemo {
            files = model.demoArtifacts.filter { $0.taskId == taskId }
            transferStatus = nil
            return
        }
        do {
            let result: Items<Artifact> = try await model.api.request("/artifacts?task_id=\(taskId)")
            files = result.items
        } catch {
            transferStatus = error.localizedDescription
        }
    }
    private func chooseFile() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await upload(url) }
    }
    private func upload(_ file: URL) async {
        transferring = true; defer { transferring = false }
        let scoped = file.startAccessingSecurityScopedResource(); defer { if scoped { file.stopAccessingSecurityScopedResource() } }
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let descriptor: UploadDescriptor = try await model.api.request("/artifacts/uploads", method: "POST", body: ["name": .string(file.lastPathComponent), "mime": .string(mime), "size": .number(Double(size)), "task_id": .string(taskId)])
            guard size <= descriptor.maxSize, let target = URL(string: descriptor.uploadUrl), target.scheme == "https" else { throw APIError(status: 0, code: "upload_target", message: "文件超过限制或上传地址无效") }
            var request = URLRequest(url: target); request.httpMethod = "PUT"; request.timeoutInterval = 180
            for (name, value) in descriptor.uploadHeaders { request.setValue(value, forHTTPHeaderField: name) }
            let (_, response) = try await URLSession.shared.upload(for: request, fromFile: file)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw APIError(status: 0, code: "upload_failed", message: "对象存储未接受上传，请重试") }
            let _: JSONValue = try await model.api.request("/artifacts/\(descriptor.artifactId)/finalize", method: "POST", body: [:])
            transferStatus = "文件已上传并加入本次任务"; await load()
        } catch { transferStatus = error.localizedDescription }
    }
    private func save(_ artifact: Artifact) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: artifact.name).lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        Task {
            transferring = true; defer { transferring = false }
            do {
                let descriptor: DownloadDescriptor = try await model.api.request("/artifacts/\(artifact.id)/download")
                guard let source = URL(string: descriptor.url), source.scheme == "https" else { throw APIError(status: 0, code: "download_target", message: "下载地址无效") }
                let (temporary, response) = try await URLSession.shared.download(from: source)
                guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw APIError(status: 0, code: "download_failed", message: "文件下载失败") }
                if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary) }
                else { try FileManager.default.moveItem(at: temporary, to: destination) }
                transferStatus = "文件已保存到所选位置"
            } catch { transferStatus = error.localizedDescription }
        }
    }
}
