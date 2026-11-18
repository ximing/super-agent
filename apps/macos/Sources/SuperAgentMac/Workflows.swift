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
                HStack { VStack(alignment: .leading, spacing: 7) { Text("让助理持续关注").font(.title2.weight(.semibold)); Text("定时提醒并准备工作目标，你确认后再执行。").foregroundStyle(.secondary) }; Spacer(); Button("添加关注") { editing = true }.buttonStyle(.borderedProminent) }
                if rules.isEmpty { EmptyState(icon: "clock.arrow.circlepath", title: "还没有定时关注", detail: "例如每小时提醒检查指定系统，或每天准备工作的汇总计划。每次提醒后，由你确认目标再执行。") }
                ForEach(rules) { rule in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text(rule.title).font(.headline); Spacer(); Toggle("启用", isOn: Binding(get: { rule.enabled }, set: { enabled in Task { await change(rule, enabled: enabled) } })).toggleStyle(.switch) }
                        Text(rule.goal).textSelection(.enabled)
                        Text("每 \(rule.intervalMinutes) 分钟 · \(rule.engine.rawValue.capitalized) · \(model.devices.first(where: { $0.id == rule.deviceId })?.name ?? "指定电脑")").font(.caption).foregroundStyle(.secondary)
                        HStack { Text(rule.enabled ? "下次提醒：\(rule.nextDueAt.map(formatTime) ?? "等待计划")" : "已暂停关注").font(.caption).foregroundStyle(.secondary); Spacer(); Button("删除", role: .destructive) { Task { await remove(rule) } } }
                    }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 12))
                }
            }.padding(28)
        }.task(id: model.lastSync) { await load() }.sheet(isPresented: $editing) {
            VStack(alignment: .leading, spacing: 18) {
                Text("添加定时关注").font(.title2.weight(.semibold))
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
    private func load() async { do { let result: Items<Schedule> = try await model.api.request("/schedules"); rules = result.items } catch { model.error = error.localizedDescription } }
    private func create() async {
        await model.operation {
            guard let interval = Int(minutes), (5...525600).contains(interval) else { throw APIError(status: 0, code: "schedule_interval", message: "间隔应为 5–525600 的整数分钟") }
            let _: Schedule = try await model.api.request("/schedules", method: "POST", body: ["title": .string(title), "goal": .string(goal), "engine": .string(model.selectedEngine.rawValue), "device_id": .string(model.selectedDevice), "interval_minutes": .number(Double(interval))])
            editing = false; title = ""; goal = ""; await load()
        }
    }
    private func change(_ rule: Schedule, enabled: Bool) async { await model.operation { let _: JSONValue = try await model.api.request("/schedules/\(rule.id)", method: "PATCH", body: ["enabled": .bool(enabled)], version: rule.version); await load() } }
    private func remove(_ rule: Schedule) async { await model.operation { let _: JSONValue = try await model.api.request("/schedules/\(rule.id)", method: "DELETE", version: rule.version); await load() } }
}

struct TaskArtifactsView: View {
    @EnvironmentObject var model: WorkspaceModel
    let taskId: String
    @State private var files: [Artifact] = []
    @State private var transferring = false
    @State private var transferStatus: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Label("任务附件与交付物", systemImage: "paperclip").font(.headline); Spacer(); if transferring { ProgressView().controlSize(.small) }; Button("添加文件") { chooseFile() }.disabled(transferring) }
            if files.isEmpty { Text("可添加本次任务需要的资料，已上传的文件仅对本用户及获授权任务开放。").font(.caption).foregroundStyle(.secondary) }
            ForEach(files) { file in HStack { Image(systemName: "doc"); VStack(alignment: .leading, spacing: 4) { Text(file.name); Text(file.mime).font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("保存到本机") { save(file) }.disabled(transferring) } }
            if let transferStatus { Text(transferStatus).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 12)).task(id: model.lastSync) { await load() }
    }
    private func load() async { do { let result: Items<Artifact> = try await model.api.request("/artifacts?task_id=\(taskId)"); files = result.items } catch { transferStatus = error.localizedDescription } }
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
