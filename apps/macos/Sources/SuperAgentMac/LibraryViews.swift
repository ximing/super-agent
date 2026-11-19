import SwiftUI
import Charts
import UniformTypeIdentifiers
import SuperAgentCore

struct DevicesView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var code = ""
    @State private var defaultDevice = ""
    @State private var assistant = ""
    @State private var engine: Engine = .codex
    @State private var revoking: Device?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(alignment: .top, spacing: 16) { Image(systemName: "desktopcomputer").font(.system(size: 32, weight: .light)).foregroundStyle(Palette.blue); VStack(alignment: .leading, spacing: 7) { Text("你的执行电脑").font(.title3.weight(.semibold)); Text("每台电脑保留自己的模型账号和网站登录态，记忆由你的助理统一检索。").font(.callout).foregroundStyle(.secondary) } }
                HStack { TextField("输入节点显示的配对码", text: $code).textFieldStyle(.roundedBorder).frame(maxWidth: 300); Button("认领电脑") { let value = code; code = ""; Task { await model.claim(value) } }.buttonStyle(.borderedProminent).disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy) }
                if model.devices.isEmpty { EmptyState(icon: "desktopcomputer.badge.plus", title: "还没有连接执行电脑", detail: "在 Mac 安装并运行节点，用上面的配对码把它加入你的助理。") }
                ForEach(model.devices) { device in
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Label(device.name, systemImage: "desktopcomputer").font(.headline); Spacer()
                            if device.revoked == true { Label("已撤销", systemImage: "xmark.shield").font(.caption).foregroundStyle(.secondary) }
                            else { StatusLabel(value: device.status); Button("撤销电脑", role: .destructive) { revoking = device }.disabled(model.busy) }
                        }
                        HStack(alignment: .top, spacing: 30) { ForEach(device.capabilities.engines, id: \.engine) { capability in VStack(alignment: .leading, spacing: 5) { Label(capability.engine.rawValue.capitalized, systemImage: capability.ready ? "checkmark.circle.fill" : "exclamationmark.circle").foregroundStyle(capability.ready ? Color.green : Color.secondary); Text(capability.ready ? capability.models.joined(separator: "、") : capability.reason ?? "尚未配置").font(.caption).foregroundStyle(.secondary) } } }
                        Text(device.revoked == true ? "云端执行权限已撤销；重新连接需要重新配对。" : "工具：\(device.capabilities.tools.joined(separator: "、"))").font(.caption).foregroundStyle(.secondary)
                    }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
                }
                Divider()
                Text("默认执行方式").font(.headline)
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 16) {
                    GridRow { Text("默认引擎"); Picker("默认引擎", selection: $engine) { ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }.labelsHidden() }
                    GridRow { Text("默认执行电脑"); devicePicker($defaultDevice) }
                    GridRow { Text("主助理电脑"); devicePicker($assistant) }
                }.frame(maxWidth: 560)
                Text("主助理负责理解、拆解和汇报；执行任务可以使用你的其他电脑。主助理离线时，新消息会等待它上线。").font(.callout).foregroundStyle(.secondary).frame(maxWidth: 600)
                Button("保存默认设置") { Task { await model.saveSettings(engine: engine, device: defaultDevice, assistant: assistant) } }.disabled(model.busy)
            }.padding(28)
        }.onAppear { loadSettings() }.onChange(of: model.settings?.version) { _, _ in loadSettings() }
        .confirmationDialog("撤销这台执行电脑？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("撤销“\(revoking?.name ?? "此电脑")”", role: .destructive) {
                guard let device = revoking, !model.busy else { return }
                revoking = nil
                Task { await model.revokeDevice(device.id) }
            }.disabled(model.busy)
            Button("取消", role: .cancel) { revoking = nil }
        } message: {
            Text("将撤销这台电脑的云端执行权限。正在运行的任务可能需要核对结果，重新连接需要重新配对。")
        }
    }
    private func loadSettings() { engine = model.settings?.defaultEngine ?? .codex; defaultDevice = model.settings?.defaultDeviceId ?? ""; assistant = model.settings?.assistantDeviceId ?? "" }
    private func devicePicker(_ selection: Binding<String>) -> some View { Picker("电脑", selection: selection) { Text("未设置").tag(""); ForEach(model.devices.filter { $0.revoked != true }) { Text($0.name).tag($0.id) } }.labelsHidden() }
}
struct MemoriesView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var editing: Memory?
    @State private var adding = false
    @State private var search = ""
    @State private var deleting: Memory?
    @State private var recallURL = ""
    @State private var recallToken = ""
    @State private var importingConnection = false
    @State private var importMessage: String?
    var filtered: [Memory] { model.memories.filter { search.isEmpty || ($0.title + $0.content).localizedCaseInsensitiveContains(search) } }
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("自己的记忆库").font(.headline); Spacer(); Label(model.memorySettings?.configured == true ? "已连接" : "尚未连接", systemImage: model.memorySettings?.configured == true ? "checkmark.circle" : "link").font(.caption).foregroundStyle(.secondary) }
                HStack { TextField("agent-recall 服务 HTTPS 地址", text: $recallURL).textFieldStyle(.roundedBorder); SecureField("你的访问令牌", text: $recallToken).textFieldStyle(.roundedBorder); Button(model.memorySettings?.configured == true ? "更新连接" : "连接记忆库") { Task { await model.connectMemory(url: recallURL, token: recallToken); if model.error == nil { recallToken = "" } } }.disabled(recallURL.isEmpty || recallToken.isEmpty || model.busy) }
                HStack { Button("从配置文件导入", systemImage: "square.and.arrow.down") { importingConnection = true }.disabled(model.busy); if let importMessage { Text(importMessage).font(.caption).foregroundStyle(.secondary) } }
                Text("使用你自己的 agent-recall 账号。访问令牌不会回显，其他用户无法访问这份记忆。").font(.caption).foregroundStyle(.secondary)
            }.padding(24).background(.background)
            Divider()
            HStack { TextField("搜索网站、流程或经验", text: $search).textFieldStyle(.roundedBorder).frame(maxWidth: 330); Spacer(); Button("教助理一件事", systemImage: "plus") { adding = true }.buttonStyle(.borderedProminent).disabled(model.memorySettings?.configured != true) }.padding(24)
            ScrollView { VStack(alignment: .leading, spacing: 14) {
                if filtered.isEmpty { EmptyState(icon: "books.vertical", title: model.memorySettings?.configured != true ? "先连接自己的记忆库" : search.isEmpty ? "把经验交给助理" : "没有找到相关记忆", detail: "添加网站用途、工作流程和你的偏好。探索形成的知识会注明验证状态。") }
                ForEach(filtered) { memory in VStack(alignment: .leading, spacing: 10) { HStack { Text(memory.title).font(.headline); StatusLabel(value: memory.status); Spacer(); Text("v\(memory.version)").font(.caption).foregroundStyle(.secondary); Button(memory.status == "candidate" ? "审核发布" : "编辑") { editing = memory }; Button { deleting = memory } label: { Image(systemName: "trash") }.buttonStyle(.plain).foregroundStyle(.secondary) }; Text(memory.content).font(.body).lineSpacing(4).textSelection(.enabled); HStack { Text(memoryTypeTitle(memory.type)); if let site = memory.site { Text(site) }; Spacer(); Text(formatTime(memory.updatedAt)) }.font(.caption).foregroundStyle(.secondary) }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary)) }
            }.padding(.horizontal, 24).padding(.bottom, 24) }
        }.onAppear { recallURL = model.memorySettings?.url ?? "" }.onChange(of: model.memorySettings?.url) { _, value in recallURL = value ?? "" }.sheet(isPresented: $adding) { MemoryEditor(memory: nil) }.sheet(item: $editing) { MemoryEditor(memory: $0) }
        .fileImporter(isPresented: $importingConnection, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let files):
                guard let file = files.first else { return }
                let scoped = file.startAccessingSecurityScopedResource(); defer { if scoped { file.stopAccessingSecurityScopedResource() } }
                do {
                    let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
                    let data = try handle.read(upToCount: RecallConnectionImport.maximumBytes + 1) ?? Data()
                    let value = try RecallConnectionImport.decode(data)
                    recallURL = value.url; recallToken = value.token
                    importMessage = "已读取配置；请核对地址后手动点击连接按钮。"
                } catch { importMessage = "无法导入配置，请选择不超过 32 KiB 且包含有效 HTTPS 地址和令牌的 JSON 文件。" }
            case .failure(let failure):
                if (failure as NSError).code != NSUserCancelledError { importMessage = "无法读取所选配置文件，请重新选择。" }
            }
        }
        .confirmationDialog("删除这条记忆？新任务将不再检索它。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) { Button("删除记忆", role: .destructive) { if let value = deleting { Task { await model.deleteMemory(value) } }; deleting = nil } }
    }
}
struct MemoryEditor: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    let memory: Memory?
    @State private var title = ""
    @State private var content = ""
    @State private var type = "website"
    @State private var site = ""
    private var invalid: Bool { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy }
    private func save(publish: Bool = false) {
        Task {
            let saved = await model.saveMemory(id: memory?.id, title: title, content: content, type: type, site: site, version: memory?.version, publish: publish)
            if saved { dismiss() }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(memory?.status == "candidate" ? "审核候选记忆" : memory == nil ? "教助理一件事" : "修正记忆").font(.title2.weight(.semibold))
            if memory?.status == "candidate" { Text("请核对助理整理的内容，修正后发布。发布后，后续任务可以检索并使用这条经验。").font(.callout).foregroundStyle(.secondary) }
            TextField("标题", text: $title).textFieldStyle(.roundedBorder)
            HStack {
                Picker("类型", selection: $type) { ForEach(["website", "procedure", "preference", "project", "experience"], id: \.self) { Text(memoryTypeTitle($0)).tag($0) } }
                TextField("网站地址（可选）", text: $site).textFieldStyle(.roundedBorder)
            }
            TextEditor(text: $content).font(.body).frame(height: 240).border(.quaternary)
            Text("请勿把密码、Cookie 或 API Key 写进记忆。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("取消") { dismiss() }; Spacer()
                Button(memory?.status == "candidate" ? "保存待审核" : "保存记忆") { save() }.disabled(invalid)
                if memory?.status == "candidate" { Button("审核并发布") { save(publish: true) }.buttonStyle(.borderedProminent).disabled(invalid) }
            }
            if let error = model.error { Text(error).foregroundStyle(.orange).font(.callout) }
        }.padding(28).frame(width: 650).onAppear { title = memory?.title ?? ""; content = memory?.content ?? ""; type = memory?.type ?? "website"; site = memory?.site ?? "" }
    }
}
func memoryTypeTitle(_ type: String) -> String { ["website":"网站档案", "procedure":"操作流程", "preference":"个人偏好", "project":"项目状态", "experience":"工作经验"][type] ?? type }
struct CostsView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var group = "device"
    @State private var monthly = ""
    @State private var taskLimit = ""
    @State private var period = "month"
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 26) {
            HStack(alignment: .firstTextBaseline) { VStack(alignment: .leading, spacing: 8) { Text("每一项工作的成本").font(.title2.weight(.semibold)); Text("统计本产品观测到的用量，金额保留来源；未知费用不视为零。").font(.callout).foregroundStyle(.secondary) }; Spacer(); Button("刷新费用") { Task { await reload() } } }
            Picker("时间", selection: $period) { Text("今日").tag("today"); Text("近 7 天").tag("week"); Text("本月").tag("month"); Text("近一年").tag("year") }.pickerStyle(.segmented).frame(maxWidth: 440)
            if let summary = model.costs {
                HStack(alignment: .top, spacing: 40) { VStack(alignment: .leading, spacing: 8) { Text("已取得金额").font(.callout).foregroundStyle(.secondary); if summary.totals.isEmpty { Text("暂无可核算金额").font(.title2.weight(.semibold)) }; ForEach(Array(summary.totals.enumerated()), id: \.offset) { _, total in HStack(alignment: .firstTextBaseline, spacing: 8) { Text("\(total.currency) \(total.amount)").font(.system(size: 28, weight: .semibold)); Text(sourceTitle(total.source)).font(.caption).foregroundStyle(.secondary) } } }; Spacer(); metric("请求", "\(summary.requestCount)"); metric("输入 Token", "\(summary.inputTokens)"); metric("输出 Token", "\(summary.outputTokens)") }
                if summary.unknownCount > 0 { Label("\(summary.unknownCount) 次请求未取得金额（包括不可逐次核算的订阅用量）", systemImage: "info.circle").font(.callout).foregroundStyle(.secondary) }
                Text("费用覆盖率 \(Int(summary.coverage * 100))%  ·  更新于 \(formatTime(summary.asOf))").font(.caption).foregroundStyle(.secondary)
            } else { Text("正在读取费用；没有记录时不会生成演示数据。").foregroundStyle(.secondary) }
            if !model.series.isEmpty { VStack(alignment: .leading, spacing: 12) { Text("费用趋势").font(.headline); Chart(Array(model.series.enumerated()), id: \.offset) { _, point in BarMark(x: .value("日期", String(point.date.prefix(10))), y: .value("金额", Double(point.amount) ?? 0)).foregroundStyle(by: .value("币种与来源", "\(point.currency) \(sourceTitle(point.source))")) }.frame(height: 210).chartLegend(position: .bottom) } }
            Divider()
            HStack { Text("费用分布").font(.headline); Spacer(); Picker("分组", selection: $group) { Text("按电脑").tag("device"); Text("按引擎").tag("engine"); Text("按任务").tag("task") }.pickerStyle(.segmented).frame(width: 290) }
            if model.breakdown.isEmpty { Text("暂无费用明细。任务开始产生用量后，会显示在这里。").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(model.breakdown.enumerated()), id: \.offset) { _, item in HStack { Text(item.label); Spacer(); Text("\(item.requestCount) 次请求").foregroundStyle(.secondary); Text("\(item.currency) \(item.amount)").fontWeight(.medium); if item.unknownCount > 0 { Text("另有 \(item.unknownCount) 次未知").foregroundStyle(.secondary) } }.padding(.vertical, 6) }
            Divider()
            Text("预算提醒").font(.headline)
            HStack { TextField("月预算 USD（留空不限制）", text: $monthly).textFieldStyle(.roundedBorder); TextField("单任务 USD（留空不限制）", text: $taskLimit).textFieldStyle(.roundedBorder); Button("保存预算") { Task { await model.saveBudget(monthly: monthly, task: taskLimit) } }.disabled(model.busy) }
            Text("预算约束新的执行额度。在途模型请求可能继续产生费用；订阅型账号的金额可能无法逐任务核算。").font(.caption).foregroundStyle(.secondary)
        }.padding(28) }.task { await reload(); monthly = model.budget?.monthlyLimitUsd ?? ""; taskLimit = model.budget?.taskLimitUsd ?? "" }.onChange(of: group) { _, _ in Task { await reload() } }.onChange(of: period) { _, _ in Task { await reload() } }
    }
    private func metric(_ title: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 9) { Text(title).font(.callout).foregroundStyle(.secondary); Text(value).font(.title2.weight(.semibold)) } }
    private func sourceTitle(_ source: String) -> String { ["supplier_reported":"供应商返回", "estimated":"估算", "unavailable":"不可核算"][source] ?? source }
    private func reload() async {
        let now = Date(); let calendar = Calendar.current
        let start: Date
        switch period {
        case "today": start = calendar.startOfDay(for: now)
        case "week": start = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        case "year": start = calendar.date(byAdding: .day, value: -365, to: now) ?? now
        default: start = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) ?? now
        }
        let formatter = ISO8601DateFormatter()
        await model.loadCosts(group: group, from: formatter.string(from: start), to: formatter.string(from: now))
    }
}
