import SwiftUI
import Charts
import SuperAgentCore

struct DevicesView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var code = ""
    @State private var pairing = false
    @State private var revoking: Device?
    @State private var engine: Engine = .codex
    @State private var defaultDevice = ""
    @State private var assistant = ""
    @State private var memoryGlobalRead = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("已连接的电脑")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("连接电脑…") { pairing = true }.controlSize(.small)
                }
                .padding(.bottom, 20)

                VStack(spacing: 0) {
                    if model.devices.isEmpty {
                        EmptyState(
                            icon: "desktopcomputer.badge.plus",
                            title: "还没有连接执行电脑",
                            detail: "在执行 Mac 上打开 Super Agent，生成配对码后在这里完成配对。"
                        )
                    }
                    ForEach(model.devices) { device in
                        HStack(spacing: 13) {
                            Image(systemName: "desktopcomputer")
                                .font(.system(size: 24, weight: .light))
                                .foregroundStyle(.secondary)
                                .frame(width: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(device.name).font(.system(size: 12, weight: .medium))
                                Text(deviceRole(device)).font(.system(size: 10)).foregroundStyle(.secondary)
                                Text(engineSummary(device)).font(.system(size: 10)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 12)
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(device.revoked == true || device.status == "offline" ? Color.secondary : Color(red: 0.35, green: 0.59, blue: 0.50))
                                    .frame(width: 6, height: 6)
                                Text(device.revoked == true ? "已撤销" : AgentStatus.title(device.status))
                            }
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 17)
                        .padding(.vertical, 15)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .contextMenu {
                            if device.revoked != true {
                                Button("撤销电脑", role: .destructive) { revoking = device }.disabled(model.busy)
                            }
                        }
                        .overlay(alignment: .bottom) {
                            if device.id != model.devices.last?.id {
                                Color(nsColor: .separatorColor).opacity(0.35).frame(height: 1)
                            }
                        }
                    }
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color(nsColor: .separatorColor).opacity(0.45)))

                Text("模型凭据和浏览器留在执行设备上。指定电脑离线时，任务会排队等待。")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineSpacing(5)
                    .padding(.top, 20)

                executionSettings
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            .frame(maxWidth: 950, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear(perform: syncSettings)
        .onChange(of: model.settings?.version) { _, _ in syncSettings() }
        .sheet(isPresented: $pairing) { pairingSheet }
        .confirmationDialog("撤销这台执行电脑？", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("撤销“\(revoking?.name ?? "此电脑")”", role: .destructive) {
                guard let device = revoking, !model.busy else { return }
                revoking = nil
                Task { await model.revokeDevice(device.id) }
            }
            .disabled(model.busy)
            Button("取消", role: .cancel) { revoking = nil }
        } message: {
            Text("将撤销这台电脑的云端执行权限。正在运行的任务可能需要核对结果，重新连接需要重新配对。")
        }
    }

    private var pairingSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 13) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 21))
                    .foregroundStyle(.secondary)
                    .frame(width: 38, height: 38)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 4) {
                    Text("连接电脑").font(.headline)
                    Text("在自己的 Mac 上保留模型与浏览器").font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("在执行 Mac 上打开 Super Agent，生成配对码后在原生客户端完成配对。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineSpacing(4)
            VStack(alignment: .leading, spacing: 7) {
                Text("配对码").font(.caption).foregroundStyle(.secondary)
                TextField("输入节点显示的配对码", text: $code).textFieldStyle(.roundedBorder)
            }
            Text("配对只授权这台电脑加入你的工作空间，不会上传模型凭据或网站登录态。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
            Divider()
            HStack {
                Spacer()
                Button("取消") { pairing = false }
                Button("认领电脑") { claimDevice() }
                    .buttonStyle(.borderedProminent)
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
            }
        }
        .padding(25)
        .frame(width: 500)
    }

    private var executionSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("默认执行")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Picker("默认引擎", selection: $engine) {
                ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            .font(.system(size: 12))
            Picker("默认执行电脑", selection: $defaultDevice) {
                Text("未设置").tag("")
                ForEach(model.devices.filter { $0.revoked != true }) { Text($0.name).tag($0.id) }
            }
            .font(.system(size: 12))
            Picker("主助理电脑", selection: $assistant) {
                Text("未设置").tag("")
                ForEach(model.devices.filter { $0.revoked != true }) { Text($0.name).tag($0.id) }
            }
            .font(.system(size: 12))
            Toggle("允许助理读取全局偏好", isOn: $memoryGlobalRead)
                .font(.system(size: 12))
            Text("当前\(model.settings?.memoryGlobalRead == true ? "开启" : "关闭")。关闭会明确保存为 false。这是账号设置，不代替单个任务的记忆范围。")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("保存执行设置") {
                Task { await model.saveSettings(engine: engine, device: defaultDevice, assistant: assistant, memoryGlobalRead: memoryGlobalRead) }
            }
            .controlSize(.small)
            .disabled(model.busy)
        }
        .padding(.top, 22)
    }

    private func syncSettings() {
        engine = model.settings?.defaultEngine ?? .codex
        defaultDevice = model.settings?.defaultDeviceId ?? ""
        assistant = model.settings?.assistantDeviceId ?? ""
        memoryGlobalRead = model.settings?.memoryGlobalRead == true
    }

    private func deviceRole(_ device: Device) -> String {
        let assistant = model.settings?.assistantDeviceId == device.id
        let executor = model.settings?.defaultDeviceId == device.id
        if assistant && executor { return "主助理与执行电脑" }
        if assistant { return "主助理电脑" }
        if executor { return "默认执行电脑" }
        return "执行电脑"
    }

    private func engineSummary(_ device: Device) -> String {
        let ready = device.capabilities.engines.filter(\.ready).map { $0.engine.rawValue.capitalized }
        if device.revoked == true { return "云端执行权限已撤销；重新连接需要重新配对" }
        return ready.isEmpty ? "尚未配置模型引擎" : "已配置 \(ready.joined(separator: "、"))"
    }

    private func claimDevice() {
        let value = code
        Task {
            await model.claim(value)
            if model.error == nil {
                code = ""
                pairing = false
            }
        }
    }
}
struct CostsView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var group = "device"
    @State private var monthly = ""
    @State private var taskLimit = ""
    @State private var period = "month"
    @State private var categoryDraft: [String: [String: String]] = [:]
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .firstTextBaseline) { VStack(alignment: .leading, spacing: 8) { Text("用量与预算").font(.headline); Text("统计本产品观测到的用量，金额保留来源；未知费用不视为零。").font(.callout).foregroundStyle(.secondary) }; Spacer(); Button("刷新费用") { Task { await reload() } }.controlSize(.small) }
            Picker("时间", selection: $period) { Text("今日").tag("today"); Text("近 7 天").tag("week"); Text("本月").tag("month"); Text("近一年").tag("year") }.pickerStyle(.segmented).frame(maxWidth: 440)
            if let summary = model.costs {
                HStack(alignment: .top, spacing: 40) { VStack(alignment: .leading, spacing: 8) { Text("已取得金额").font(.callout).foregroundStyle(.secondary); if summary.totals.isEmpty { Text("暂无可核算金额").font(.title2.weight(.semibold)) }; ForEach(Array(summary.totals.enumerated()), id: \.offset) { _, total in HStack(alignment: .firstTextBaseline, spacing: 8) { Text("\(total.currency) \(total.amount)").font(.system(size: 24, weight: .semibold)); Text(sourceTitle(total.source)).font(.caption).foregroundStyle(.secondary) } } }; Spacer(); metric("请求", "\(summary.requestCount)"); metric("输入 Token", "\(summary.inputTokens)"); metric("输出 Token", "\(summary.outputTokens)") }
                if summary.unknownCount > 0 { Label("\(summary.unknownCount) 次请求未取得金额（包括不可逐次核算的订阅用量）。未知金额不会当成没有费用。", systemImage: "info.circle").font(.callout).foregroundStyle(.secondary) }
                VStack(alignment: .leading, spacing: 6) {
                    Text(summary.reservedHoldUsd.map { "预留 \($0) USD" } ?? "预留金额尚未确定，不能当作没有费用")
                    Text(summary.reservedUnknownCount.map { "\($0) 笔预留金额尚未确定" } ?? "预留未知笔数尚未取得，不会按 0 计算")
                    Text("预留不是已经发生的费用，也不会计入上方已取得金额。")
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                Text("费用覆盖率 \(Int(summary.coverage * 100))%  ·  更新于 \(formatTime(summary.asOf))").font(.caption).foregroundStyle(.secondary)
            } else { Text(model.isDemo ? "演示模式未加载费用记录。" : "正在读取费用；没有记录时不会生成演示数据。").font(.callout).foregroundStyle(.secondary) }
            if !model.series.isEmpty { VStack(alignment: .leading, spacing: 12) { Text("费用趋势").font(.headline); Chart(Array(model.series.enumerated()), id: \.offset) { _, point in BarMark(x: .value("日期", String(point.date.prefix(10))), y: .value("金额", Double(point.amount) ?? 0)).foregroundStyle(by: .value("币种与来源", "\(point.currency) \(sourceTitle(point.source))")) }.frame(height: 210).chartLegend(position: .bottom) } }
            Divider()
            HStack { Text("费用分布").font(.headline); Spacer(); Picker("分组", selection: $group) { Text("按电脑").tag("device"); Text("按引擎").tag("engine"); Text("按任务").tag("task"); Text("按活动").tag("category") }.pickerStyle(.segmented).frame(maxWidth: 520) }
            if model.breakdown.isEmpty { Text("暂无费用明细。任务开始产生用量后，会显示在这里。").font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(model.breakdown.enumerated()), id: \.offset) { _, item in HStack { Text(item.label); Spacer(); Text("\(item.requestCount) 次请求").foregroundStyle(.secondary); Text("\(item.currency) \(item.amount)").fontWeight(.medium); if item.unknownCount > 0 { Text("另有 \(item.unknownCount) 次未知").foregroundStyle(.secondary) } }.padding(.vertical, 6) }
            Divider()
            Text("预算提醒").font(.headline)
            HStack(alignment: .bottom, spacing: 14) {
                VStack(alignment: .leading, spacing: 7) { Text("月预算 USD").font(.caption).foregroundStyle(.secondary); TextField("留空不限制", text: $monthly).textFieldStyle(.roundedBorder) }
                VStack(alignment: .leading, spacing: 7) { Text("单任务预算 USD").font(.caption).foregroundStyle(.secondary); TextField("留空不限制", text: $taskLimit).textFieldStyle(.roundedBorder) }
                Button("保存预算") { Task { await model.saveBudget(monthly: monthly, task: taskLimit) } }.controlSize(.small).disabled(model.busy)
            }.frame(maxWidth: 640, alignment: .leading)
            Text("预算约束新的执行额度。在途模型请求可能继续产生费用；订阅型账号的金额可能无法逐任务核算。").font(.caption).foregroundStyle(.secondary)
            categoryLimits
            if let unknown = model.budget?.unknownCount, unknown > 0 {
                Text("账号有 \(unknown) 次金额未知的请求，不会按 0 计算。").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(28).frame(maxWidth: 840, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading) }.task { await reload(); applyBudgetFields() }.onChange(of: group) { _, _ in Task { await reload(); applyBudgetFields() } }.onChange(of: period) { _, _ in Task { await reload(); applyBudgetFields() } }
    }
    private var categoryLimits: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("活动用量上限").font(.headline)
            Text("这是账号默认。每个任务的预算是该任务自己的覆盖。留空保持已保存的值。保存活动上限不会提交月预算和单任务金额。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(BudgetCatalog.categories, id: \.id) { category in
                VStack(alignment: .leading, spacing: 8) {
                    Text(category.label).font(.callout.weight(.medium))
                    ForEach(BudgetCatalog.limits, id: \.key) { limit in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(limit.label) · 已保存 \(storedLimit(category.id, limit.key)) · 产品上限 \(limit.ceiling)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextField("留空保持当前值", text: limitBinding(category.id, limit.key))
                                .textFieldStyle(.roundedBorder)
                        }
                    }
                }
            }
            Button("保存活动上限") { Task { await model.saveCategoryLimits(categoryDraft) } }
                .controlSize(.small)
                .disabled(model.busy)
        }
    }

    private func storedLimit(_ category: String, _ key: String) -> String {
        model.budget?.categoryLimits?[category]?.stored(key).map(String.init) ?? "未设置"
    }

    private func limitBinding(_ category: String, _ key: String) -> Binding<String> {
        Binding(
            get: { categoryDraft[category]?[key] ?? "" },
            set: { value in
                var next = categoryDraft
                var row = next[category] ?? [:]
                row[key] = value
                next[category] = row
                categoryDraft = next
            }
        )
    }

    private func applyBudgetFields() {
        monthly = model.budget?.monthlyLimitUsd ?? ""
        taskLimit = model.budget?.taskLimitUsd ?? ""
        var draft: [String: [String: String]] = [:]
        for category in BudgetCatalog.categories {
            var row: [String: String] = [:]
            for limit in BudgetCatalog.limits {
                row[limit.key] = model.budget?.categoryLimits?[category.id]?.stored(limit.key).map(String.init) ?? ""
            }
            draft[category.id] = row
        }
        categoryDraft = draft
    }

    private func metric(_ title: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 9) { Text(title).font(.callout).foregroundStyle(.secondary); Text(value).font(.title3.weight(.semibold)) } }
    private func sourceTitle(_ source: String) -> String { ["supplier_reported":"供应商返回", "estimated":"估算", "unavailable":"不可核算"][source] ?? source }
    private func reload() async {
        guard !model.isDemo else { return }
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
