import SwiftUI
import UniformTypeIdentifiers
import SuperAgentCore

private enum MemoryStatusFilter: String, CaseIterable, Identifiable {
    case all = "全部", verified = "已验证", candidate = "待审核", attention = "需关注"
    var id: String { rawValue }
}

private enum MemoryDetailTab: String, CaseIterable, Identifiable {
    case content = "内容", source = "来源与范围"
    var id: String { rawValue }
}

private enum MemoryPalette {
    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        })
    }

    static let list = adaptive(
        light: NSColor(calibratedRed: 0.973, green: 0.969, blue: 0.980, alpha: 1),
        dark: NSColor(calibratedRed: 0.125, green: 0.121, blue: 0.137, alpha: 1)
    )
    static let connection = adaptive(
        light: NSColor(calibratedRed: 0.957, green: 0.949, blue: 0.969, alpha: 1),
        dark: NSColor(calibratedRed: 0.105, green: 0.102, blue: 0.118, alpha: 1)
    )
    static let selection = adaptive(
        light: NSColor(calibratedRed: 0.902, green: 0.882, blue: 0.933, alpha: 1),
        dark: NSColor(calibratedRed: 0.275, green: 0.255, blue: 0.325, alpha: 1)
    )
    static let search = adaptive(
        light: NSColor(calibratedRed: 0.937, green: 0.929, blue: 0.949, alpha: 1),
        dark: NSColor(calibratedRed: 0.175, green: 0.169, blue: 0.190, alpha: 1)
    )
    static let detail = Color(nsColor: .textBackgroundColor)
    static let line = Color(nsColor: .separatorColor).opacity(0.55)
}

private let orderedMemoryTypes = ["preference", "procedure", "project", "website", "experience", "fact", "pattern", "architecture", "bug", "workflow", "lesson"]

struct MemoriesView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var selectedID: String?
    @State private var statusFilter: MemoryStatusFilter = .all
    @State private var typeFilter = "all"
    @State private var search = ""
    @State private var deleting: Memory?
    @State private var showingConnection = false
    @State private var recallURL = ""
    @State private var recallToken = ""
    @State private var recallProject = ""
    @State private var importingConnection = false
    @State private var importMessage: String?
    @FocusState private var searchFocused: Bool

    private var connected: Bool { model.memorySettings?.configured == true }

    private var savedProjectNotice: String {
        let saved = model.memorySettings?.project?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = saved.isEmpty ? "未限定" : saved
        return "已保存的项目：\(name)。更改或清除项目会改变任务之后能看到哪些记忆，不会修改记忆正文。"
    }

    private var availableTypes: [String] {
        var values = orderedMemoryTypes
        for memory in model.memories {
            let type = memory.recallType ?? memory.type
            if !values.contains(type) { values.append(type) }
        }
        return values
    }

    private var filtered: [Memory] {
        model.memories.filter { memory in
            let state = effectiveMemoryState(memory)
            let matchesStatus: Bool
            switch statusFilter {
            case .all: matchesStatus = true
            case .verified: matchesStatus = state == "verified"
            case .candidate: matchesStatus = state == "candidate"
            case .attention: matchesStatus = ["conflict", "expired", "stale", "superseded"].contains(state)
            }
            let matchesType = typeFilter == "all" || (memory.recallType ?? memory.type) == typeFilter
            let matchesSearch = search.isEmpty
                || memory.title.localizedCaseInsensitiveContains(search)
                || memory.content.localizedCaseInsensitiveContains(search)
                || memory.type.localizedCaseInsensitiveContains(search)
                || (memory.recallProject?.localizedCaseInsensitiveContains(search) ?? false)
                || (memory.recallTags?.contains { $0.localizedCaseInsensitiveContains(search) } ?? false)
                || (memory.site?.localizedCaseInsensitiveContains(search) ?? false)
            return matchesStatus && matchesType && matchesSearch
        }
    }

    private var selectedMemory: Memory? {
        filtered.first { $0.id == selectedID }
    }

    var body: some View {
        Group {
            if connected { workspace } else { unconnected }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MemoryPalette.detail)
        .onAppear {
            recallURL = model.memorySettings?.url ?? ""
            recallProject = model.memorySettings?.project ?? ""
            reconcileSelection()
        }
        .onChange(of: filtered.map(\.id)) { _, _ in reconcileSelection() }
        .onChange(of: model.memorySettings?.url) { _, value in recallURL = value ?? "" }
        .onChange(of: model.memorySettings?.project) { _, value in recallProject = value ?? "" }
        .onReceive(NotificationCenter.default.publisher(for: .searchRequested)) { _ in
            searchFocused = true
        }
        .sheet(isPresented: $showingConnection) { connectionSheet }
        .fileImporter(isPresented: $importingConnection, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            importConnection(result)
        }
        .confirmationDialog(
            "删除这条记忆？新任务将不再检索它。",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("删除记忆", role: .destructive) {
                if let value = deleting { Task { await model.deleteMemory(value) } }
                deleting = nil
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
    }

    private var workspace: some View {
        HSplitView {
            memoryList
                .frame(minWidth: 250, idealWidth: 300, maxWidth: 380, maxHeight: .infinity)
            Group {
                if let memory = selectedMemory {
                    MemoryDetailView(memory: memory, remove: { deleting = memory })
                        .id(memory.id)
                } else {
                    MemoryEmptyView(
                        icon: "book.open",
                        title: "选择一条记忆",
                        detail: "查看完整内容、来源与适用范围。"
                    )
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            .background(MemoryPalette.detail)
        }
    }

    private var memoryList: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 13) {
                Picker("记忆状态筛选", selection: $statusFilter) {
                    ForEach(MemoryStatusFilter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)

                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    TextField("搜索已加载记忆", text: $search)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                        .focused($searchFocused)
                    if !search.isEmpty {
                        Button { search = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("清除搜索")
                        .accessibilityLabel("清除搜索")
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(MemoryPalette.search, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(MemoryPalette.line))

                HStack {
                    Text("\(filtered.count) 条已加载")
                    Spacer()
                    Menu {
                        Button("所有类型") { typeFilter = "all" }
                        ForEach(availableTypes, id: \.self) { type in
                            Button {
                                typeFilter = type
                            } label: {
                                if typeFilter == type { Label(memoryTypeTitle(type), systemImage: "checkmark") }
                                else { Text(memoryTypeTitle(type)) }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(typeFilter == "all" ? "所有类型" : memoryTypeTitle(typeFilter)).lineLimit(1)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.down").font(.system(size: 8))
                        }
                        .frame(width: 96)
                        .foregroundStyle(.primary)
                        .contentShape(Rectangle())
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .tint(.primary)
                    .frame(maxWidth: 112)
                }
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.top, 17)
            .padding(.bottom, 13)
            .background(MemoryPalette.list)
            .overlay(alignment: .bottom) { MemoryPalette.line.frame(height: 1) }

            ScrollView {
                LazyVStack(spacing: 2) {
                    if filtered.isEmpty {
                        MemoryEmptyView(
                            icon: statusFilter == .candidate && search.isEmpty && typeFilter == "all" ? "checkmark.circle" : "magnifyingglass",
                            title: statusFilter == .candidate && search.isEmpty && typeFilter == "all" ? "待审核的内容都处理好了" : "没有找到相关记忆",
                            detail: statusFilter == .candidate && search.isEmpty && typeFilter == "all" ? "助理整理出新的候选记忆时，会出现在这里。" : "换个关键词，或调整类型与状态筛选。",
                            actionTitle: "查看全部记忆",
                            action: resetFilters
                        )
                    }
                    ForEach(filtered) { memory in
                        MemoryRow(memory: memory, selected: selectedID == memory.id) {
                            selectedID = memory.id
                        }
                    }
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 5)
            }
            .background(MemoryPalette.list)

            Button { showingConnection = true } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Circle().fill(Color(red: 0.35, green: 0.59, blue: 0.50)).frame(width: 6, height: 6)
                        Text("记忆库已连接")
                        Spacer()
                        Image(systemName: "gearshape")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    Text("连接设置与配置导入")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 13)
                }
                .font(.system(size: 10))
                .foregroundStyle(.primary)
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .background(MemoryPalette.connection)
                .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("记忆库连接设置")
        }
        .background(MemoryPalette.list)
    }

    private var unconnected: some View {
        VStack(spacing: 13) {
            Image(systemName: "book.open")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary)
            Text("连接自己的记忆库")
                .font(.system(size: 20, weight: .semibold))
                .padding(.top, 5)
            Text("把工作习惯、项目约定与经验放在一起。连接后可以查看已加载的内容，并审核助理整理的新记忆。")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineSpacing(6)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            Button("连接记忆库…") { showingConnection = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .padding(.top, 5)
        }
        .padding(35)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var connectionSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: "books.vertical")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .frame(width: 38, height: 38)
                    .background(MemoryPalette.selection, in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 4) {
                    Text("记忆库连接").font(.headline)
                    Text("自己的记忆库 · 独立管理连接").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 25)
            .padding(.top, 22)
            .padding(.bottom, 18)

            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 6) {
                    Circle().fill(connected ? Color(red: 0.45, green: 0.65, blue: 0.55) : Color.secondary).frame(width: 6, height: 6)
                    Text(connected ? "记忆库已连接" : "尚未连接记忆库")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.bottom, 5)

                labeledField("记忆库地址") {
                    TextField("https://memory.example/recall", text: $recallURL)
                        .textFieldStyle(.roundedBorder)
                }
                labeledField("访问令牌") {
                    SecureField("输入访问令牌", text: $recallToken)
                        .textFieldStyle(.roundedBorder)
                }
                labeledField("Recall 项目") {
                    TextField("留空则清除项目", text: $recallProject)
                        .textFieldStyle(.roundedBorder)
                }
                Text(savedProjectNotice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("已保存的令牌不回显。使用你自己的 agent-recall 账号，其他用户无法访问这份记忆。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                Button {
                    importingConnection = true
                } label: {
                    Label("从配置文件导入…", systemImage: "square.and.arrow.down")
                }
                .disabled(model.busy)
                if let importMessage {
                    Text(importMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 25)
            .padding(.bottom, 22)

            Divider()
            HStack {
                Spacer()
                Button("取消") { showingConnection = false }
                Button(connected ? "保存连接" : "连接记忆库") { connectMemory() }
                    .buttonStyle(.borderedProminent)
                    .disabled(recallURL.isEmpty || recallToken.isEmpty || model.busy)
            }
            .padding(.horizontal, 25)
            .padding(.vertical, 16)
        }
        .frame(width: 520)
        .background(MemoryPalette.list)
    }

    @ViewBuilder
    private func labeledField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }

    private func resetFilters() {
        statusFilter = .all
        typeFilter = "all"
        search = ""
    }

    private func reconcileSelection() {
        if let selectedID, filtered.contains(where: { $0.id == selectedID }) { return }
        selectedID = filtered.first?.id
    }

    private func connectMemory() {
        Task {
            await model.connectMemory(url: recallURL, token: recallToken, project: recallProject)
            if model.error == nil {
                recallToken = ""
                importMessage = nil
                showingConnection = false
            }
        }
    }

    private func importConnection(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let files):
            guard let file = files.first else { return }
            let scoped = file.startAccessingSecurityScopedResource()
            defer { if scoped { file.stopAccessingSecurityScopedResource() } }
            do {
                let handle = try FileHandle(forReadingFrom: file)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: RecallConnectionImport.maximumBytes + 1) ?? Data()
                let value = try RecallConnectionImport.decode(data)
                recallURL = value.url
                recallToken = value.token
                importMessage = "已读取配置；请核对地址后手动点击连接按钮。"
            } catch {
                importMessage = "无法导入配置，请选择不超过 32 KiB 且包含有效 HTTPS 地址和令牌的 JSON 文件。"
            }
        case .failure(let failure):
            if (failure as NSError).code != NSUserCancelledError {
                importMessage = "无法读取所选配置文件，请重新选择。"
            }
        }
    }
}

private struct MemoryRow: View {
    let memory: Memory
    let selected: Bool
    let select: () -> Void

    private var preview: String {
        memory.content
            .replacingOccurrences(of: "## ", with: "")
            .replacingOccurrences(of: "\n", with: " ")
    }

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: memoryTypeIcon(memory.recallType ?? memory.type))
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 15)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 0) {
                    Text(memory.title)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(preview)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineSpacing(3)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 5)
                        .padding(.bottom, 7)
                    HStack(spacing: 8) {
                        MemoryStatusLabel(memory: memory, size: 9)
                        Spacer(minLength: 4)
                        Text(compactMemoryTime(memory.updatedAt))
                            .lineLimit(1)
                    }
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? MemoryPalette.selection : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(memory.title)，\(memoryDisplayState(memory))，\(memoryTypeTitle(memory.recallType ?? memory.type))")
        .accessibilityHint("查看记忆详情")
    }
}

private struct MemoryDetailView: View {
    @EnvironmentObject var model: WorkspaceModel
    let memory: Memory
    let remove: () -> Void
    @State private var tab: MemoryDetailTab = .content
    @State private var editing = false
    @State private var reviewChecked = false
    @State private var title: String
    @State private var content: String
    @State private var type: String
    @State private var site: String
    @State private var otherID = ""
    @State private var validUntil = ""
    @State private var relationMessage: String?

    init(memory: Memory, remove: @escaping () -> Void) {
        self.memory = memory
        self.remove = remove
        _title = State(initialValue: memory.title)
        _content = State(initialValue: memory.content)
        _type = State(initialValue: memory.recallType ?? memory.type)
        _site = State(initialValue: memory.site ?? "")
    }

    private var invalid: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.busy
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Picker("记忆详情内容", selection: $tab) {
                    ForEach(MemoryDetailTab.allCases) { item in Text(item.rawValue).tag(item) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .frame(width: 181)
                Spacer()
                if editing {
                    Circle().fill(Color(red: 0.71, green: 0.57, blue: 0.32)).frame(width: 5, height: 5)
                    Text("未保存").font(.system(size: 10)).foregroundStyle(.secondary)
                } else {
                    Button("编辑") { editing = true }.controlSize(.small)
                }
                Menu {
                    if !editing { Button("编辑记忆") { editing = true } }
                    Button("删除记忆", role: .destructive, action: remove)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 26, height: 25)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .accessibilityLabel("更多记忆操作")
            }
            .padding(.horizontal, 26)
            .padding(.top, 16)
            .padding(.bottom, 12)
            .frame(minHeight: 53)
            .overlay(alignment: .bottom) { MemoryPalette.line.frame(height: 1) }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 7) {
                        Image(systemName: memoryTypeIcon(memory.recallType ?? memory.type))
                        Text(memoryTypeTitle(memory.recallType ?? memory.type))
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 14)

                    Text(editing ? title : memory.title)
                        .font(.system(size: 23, weight: .semibold))
                        .tracking(-0.4)
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 10) {
                        MemoryStatusLabel(memory: memory, size: 10)
                        Text("v\(memory.version)")
                            .padding(.leading, 10)
                            .overlay(alignment: .leading) { MemoryPalette.line.frame(width: 1).padding(.leading, 0) }
                        if memory.governance?.claim == "inference" {
                            Text("模型推断").foregroundStyle(Color(red: 0.63, green: 0.48, blue: 0.21))
                        }
                        Spacer(minLength: 8)
                        Text(memory.recallProject?.isEmpty == false ? memory.recallProject! : "未指定项目")
                            .lineLimit(1)
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
                    .padding(.bottom, 27)

                    if tab == .source {
                        MemorySourceView(memory: memory)
                    } else if editing {
                        editorFields
                    } else {
                        MemoryAttentionView(memory: memory)
                        MemoryContentView(content: memory.content)
                        originStrip
                    }
                    if !editing { relationControls }
                }
                .padding(.horizontal, 35)
                .padding(.top, 30)
                .padding(.bottom, 32)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity)
            }

            if editing {
                HStack {
                    Spacer()
                    Button("取消", action: resetDraft)
                    Button(effectiveMemoryState(memory) == "candidate" ? "保存待审核" : "保存修改") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(invalid)
                }
                .padding(.horizontal, 26)
                .padding(.top, 13)
                .padding(.bottom, 17)
                .background(MemoryPalette.list)
                .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
            } else if effectiveMemoryState(memory) == "candidate" {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("我已核对内容与适用范围", isOn: $reviewChecked)
                        .toggleStyle(.checkbox)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 9) {
                        Text("发布后，可在任务授权范围内检索使用。")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Spacer()
                        Button("先修正内容") { editing = true }
                        Button("审核并发布") { save(publish: true) }
                            .buttonStyle(.borderedProminent)
                            .disabled(!reviewChecked || model.busy)
                    }
                }
                .padding(.horizontal, 26)
                .padding(.top, 15)
                .padding(.bottom, 17)
                .background(MemoryPalette.list)
                .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
            }

            HStack(spacing: 8) {
                Text("\(formatTime(memory.updatedAt)) 更新")
                Text("/")
                Text("已使用 \(memory.accessCount ?? 0) 次")
                Spacer()
            }
            .font(.system(size: 9))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 25)
            .padding(.vertical, 11)
            .frame(minHeight: 39)
            .background(MemoryPalette.list.opacity(0.65))
            .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
        }
        .background(MemoryPalette.detail)
    }

    private var editorFields: some View {
        VStack(alignment: .leading, spacing: 18) {
            labeledEditorField("标题") {
                TextField("标题", text: $title).textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 15) {
                labeledEditorField("类型") {
                    Picker("类型", selection: $type) {
                        ForEach(orderedMemoryTypes, id: \.self) { value in
                            Text(memoryTypeTitle(value)).tag(value)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                labeledEditorField("站点（可选）") {
                    TextField("例如：product.example", text: $site).textFieldStyle(.roundedBorder)
                }
            }
            labeledEditorField("记忆内容") {
                TextEditor(text: $content)
                    .font(.system(size: 12))
                    .lineSpacing(5)
                    .scrollContentBackground(.hidden)
                    .padding(5)
                    .frame(minHeight: 245)
                    .background(MemoryPalette.detail)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(MemoryPalette.line))
            }
            Text("只修改内容与分类，来源记录和治理状态继续保留。")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private func labeledEditorField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var relationControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("记忆关系")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Text("关系只记录冲突、替代或有效期，不会修改正文，也不会把候选记忆标成已验证。")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            labeledEditorField("另一条记忆") {
                TextField("冲突或替代的记忆标识", text: $otherID).textFieldStyle(.roundedBorder)
            }
            labeledEditorField("有效期") {
                TextField("例如 2026-12-31T23:59:00+08:00", text: $validUntil).textFieldStyle(.roundedBorder)
            }
            Text("治理版本 \(memory.governance?.version ?? 0) · 记忆版本 \(memory.version)")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("标记冲突") { relate("conflicts") }.disabled(model.busy)
                Button("标记替代") { relate("supersedes") }.disabled(model.busy)
                Button("设置过期") { relate("expires") }.disabled(model.busy)
            }
            .controlSize(.small)
            if let relationMessage {
                Text(relationMessage)
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 22)
    }

    private func relate(_ relation: String) {
        let memory = memory
        let other = otherID
        let until = validUntil
        Task {
            relationMessage = await model.relateMemory(memory, relation: relation, otherId: other, validUntil: until)
        }
    }

    private var originStrip: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "questionmark.circle")
                .font(.system(size: 14))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                Text(memory.source?.isEmpty == false ? "记录来源 \(memory.source!)" : memoryOriginDescription(memory))
                    .font(.system(size: 10, weight: .medium))
                Text(governanceSummary(memory))
                    .font(.system(size: 10))
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                Text(memoryScope(memory) + "。")
                    .font(.system(size: 10))
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    tab = .source
                } label: {
                    HStack(spacing: 3) {
                        Text("查看来源与适用范围")
                        Image(systemName: "chevron.right").font(.system(size: 8))
                    }
                }
                .buttonStyle(.link)
                .font(.system(size: 10))
                .padding(.top, 1)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 17)
        .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
        .padding(.top, 28)
    }

    private func resetDraft() {
        title = memory.title
        content = memory.content
        type = memory.recallType ?? memory.type
        site = memory.site ?? ""
        editing = false
    }

    private func save(publish: Bool = false) {
        Task {
            let saved = await model.saveMemory(
                id: memory.id,
                title: title,
                content: content,
                type: type,
                site: site,
                version: memory.version,
                publish: publish
            )
            if saved {
                editing = false
                reviewChecked = false
            }
        }
    }
}

private enum MemoryContentBlock {
    case paragraph(String)
    case heading(String)
    case list([String])
}

private struct MemoryContentView: View {
    let content: String

    private var blocks: [MemoryContentBlock] {
        var result: [MemoryContentBlock] = []
        var items: [String] = []
        func flushList() {
            if !items.isEmpty {
                result.append(.list(items))
                items = []
            }
        }
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let value = String(line)
            if value.hasPrefix("- ") {
                items.append(String(value.dropFirst(2)))
                continue
            }
            flushList()
            if value.hasPrefix("## ") {
                result.append(.heading(String(value.dropFirst(3))))
            } else if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(.paragraph(value))
            }
        }
        flushList()
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(text)
                        .font(.system(size: 13))
                        .lineSpacing(7)
                        .padding(.bottom, 15)
                        .fixedSize(horizontal: false, vertical: true)
                case .heading(let text):
                    Text(text)
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.top, 9)
                        .padding(.bottom, 11)
                case .list(let items):
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .top, spacing: 7) {
                                Text("•").foregroundStyle(.secondary)
                                Text(item).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .font(.system(size: 13))
                    .padding(.leading, 3)
                    .padding(.bottom, 17)
                }
            }
        }
        .frame(maxWidth: 650, alignment: .leading)
        .textSelection(.enabled)
    }
}

private struct MemoryAttentionView: View {
    let memory: Memory

    var body: some View {
        let state = effectiveMemoryState(memory)
        if state == "conflict" {
            let ids = memory.governance?.conflictsWith?.joined(separator: "、") ?? ""
            notice(
                icon: "exclamationmark.triangle",
                title: "这条内容存在冲突",
                detail: "不同记录对同一偏好的表述不一致，当前不应作为已核实事实使用。可先修正内容；冲突标记不会因普通编辑自动解除。\(ids.isEmpty ? "" : " 冲突对象：\(ids)。")",
                attention: true
            )
        } else if state == "expired" {
            let until = memory.governance?.validUntil ?? memory.expiresAt ?? "已记录的日期"
            notice(icon: "clock", title: "这条资料已过期", detail: "有效期截至 \(until)。再次使用前需要重新核对当前资料。")
        } else if memory.governance?.claim == "inference" {
            notice(
                icon: "sparkles",
                title: "这是助理归纳的推断",
                detail: state == "candidate" ? "请核对内容是否准确，再决定是否审核发布。" : "内容已经过审核，但仍保留推断来源，不代表已核实事实。"
            )
        }
    }

    @ViewBuilder
    private func notice(icon: String, title: String, detail: String, attention: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.system(size: 14)).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 11, weight: .medium))
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineSpacing(4)
            }
        }
        .foregroundStyle(.primary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(attention ? Color(red: 0.98, green: 0.95, blue: 0.93) : Color(red: 0.98, green: 0.96, blue: 0.92), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(attention ? Color(red: 0.93, green: 0.87, blue: 0.82) : Color(red: 0.93, green: 0.88, blue: 0.78)))
        .padding(.bottom, 25)
    }
}

private struct MemoryProperty: Identifiable {
    let label: String
    let value: String
    var id: String { label }
}

private struct MemorySourceView: View {
    let memory: Memory

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            section("来源记录", [
                MemoryProperty(label: "来源类别", value: memoryOriginTitle(memory.origin)),
                MemoryProperty(label: "来源标识", value: memory.source?.isEmpty == false ? memory.source! : "未单列"),
                MemoryProperty(label: "整理说明", value: memoryOriginDescription(memory)),
                MemoryProperty(label: "证据或主张", value: memoryEvidenceLine(memory)),
                MemoryProperty(label: "内容性质", value: memory.governance?.claim == "inference" ? "模型推断" : memory.governance?.claim == "observed" ? "观察到的记录" : "资料或人工记录"),
                MemoryProperty(label: "创建时间", value: memory.createdAt.map(formatTime) ?? "未记录"),
                MemoryProperty(label: "最近更新", value: formatTime(memory.updatedAt))
            ])
            section("适用范围", [
                MemoryProperty(label: "项目", value: memory.recallProject?.isEmpty == false ? memory.recallProject! : "未指定项目"),
                MemoryProperty(label: "站点", value: memory.site?.isEmpty == false ? memory.site! : "未限定站点；按任务授权判断"),
                MemoryProperty(label: "使用范围", value: memoryScope(memory)),
                MemoryProperty(label: "有效期", value: memory.governance?.validUntil ?? memory.expiresAt ?? "未设置；仍需核对资料时效")
            ])
            let tags = (memory.recallTags ?? []).filter { !$0.hasPrefix("sa-type:") && !$0.hasPrefix("sa-op:") }
            section("分类与状态", [
                MemoryProperty(label: "记忆类型", value: memoryTypeTitle(memory.recallType ?? memory.type)),
                MemoryProperty(label: "核验", value: memory.governance?.verification ?? memory.status),
                MemoryProperty(label: "当前状态", value: memoryDisplayState(memory)),
                MemoryProperty(label: "治理版本", value: memory.governance?.version.map { "\($0)" } ?? "尚未记录"),
                MemoryProperty(label: "版本", value: "v\(memory.version)"),
                MemoryProperty(label: "冲突", value: memory.governance?.conflictsWith?.isEmpty == false ? memory.governance!.conflictsWith!.joined(separator: "、") : "无"),
                MemoryProperty(label: "替代", value: memory.governance?.supersedes ?? "无"),
                MemoryProperty(label: "被替代", value: memory.governance?.supersededBy ?? "无"),
                MemoryProperty(label: "使用次数", value: "\(memory.accessCount ?? 0) 次"),
                MemoryProperty(label: "标签", value: tags.isEmpty ? "未设置" : tags.map { "#\($0)" }.joined(separator: "  "))
            ])
            Text("这里只展示本条记忆的来源与范围。\(effectiveMemoryState(memory) == "conflict" ? "冲突状态保留，修正内容不会自动将其标记为已验证。" : "记忆能否用于某项任务，由任务的记忆授权决定。")")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineSpacing(5)
                .padding(.top, 17)
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ properties: [MemoryProperty]) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.top, 25)
            .padding(.bottom, 10)
        VStack(spacing: 0) {
            ForEach(properties) { property in
                HStack(alignment: .top, spacing: 18) {
                    Text(property.label)
                        .frame(width: 81, alignment: .leading)
                    Text(property.value)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineSpacing(4)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) { MemoryPalette.line.frame(height: 1) }
            }
        }
        .overlay(alignment: .top) { MemoryPalette.line.frame(height: 1) }
    }
}

private struct MemoryStatusLabel: View {
    let memory: Memory
    let size: CGFloat

    private var color: Color {
        switch effectiveMemoryState(memory) {
        case "verified": memory.governance?.claim == "inference" ? Color(red: 0.63, green: 0.48, blue: 0.21) : Color(red: 0.34, green: 0.51, blue: 0.43)
        case "candidate": Color(red: 0.63, green: 0.48, blue: 0.21)
        case "conflict": Color(red: 0.67, green: 0.42, blue: 0.32)
        default: .secondary
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: size == 9 ? 4 : 5, height: size == 9 ? 4 : 5)
            Text(memoryDisplayState(memory)).foregroundStyle(color)
        }
        .font(.system(size: size))
        .lineLimit(1)
    }
}

private struct MemoryEmptyView: View {
    let icon: String
    let title: String
    let detail: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 30, weight: .light))
            Text(title).font(.system(size: 14, weight: .semibold)).padding(.top, 5)
            Text(detail)
                .font(.system(size: 11))
                .lineSpacing(5)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 310)
            if let actionTitle, let action {
                Button(actionTitle, action: action).controlSize(.small).padding(.top, 7)
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 25)
        .padding(.vertical, 55)
        .frame(maxWidth: .infinity)
    }
}

struct MemoryEditor: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    let memory: Memory?
    @State private var title = ""
    @State private var content = ""
    @State private var type = "preference"
    @State private var site = ""

    private var invalid: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.busy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(memory?.status == "candidate" ? "审核候选记忆" : memory == nil ? "教助理一件事" : "修正记忆")
                .font(.title3.weight(.semibold))
            if memory == nil {
                Text("记录一项工作偏好、项目约定，或值得复用的经验。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if memory?.status == "candidate" {
                Text("请核对助理整理的内容，修正后发布。发布后，后续任务可以检索并使用这条经验。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            TextField("例如：调研结论附上原始来源", text: $title).textFieldStyle(.roundedBorder)
            HStack {
                Picker("类型", selection: $type) {
                    ForEach(orderedMemoryTypes, id: \.self) { Text(memoryTypeTitle($0)).tag($0) }
                }
                TextField("站点（可选）", text: $site).textFieldStyle(.roundedBorder)
            }
            TextEditor(text: $content)
                .font(.body)
                .frame(height: 240)
                .scrollContentBackground(.hidden)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(MemoryPalette.line))
            Text("请勿把密码、Cookie 或 API Key 写进记忆。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button(memory?.status == "candidate" ? "保存待审核" : "保存记忆") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(invalid)
                if memory?.status == "candidate" {
                    Button("审核并发布") { save(publish: true) }.disabled(invalid)
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.orange).font(.callout) }
        }
        .padding(28)
        .frame(width: 650)
        .onAppear {
            title = memory?.title ?? ""
            content = memory?.content ?? ""
            type = memory?.recallType ?? memory?.type ?? "preference"
            site = memory?.site ?? ""
        }
    }

    private func save(publish: Bool = false) {
        Task {
            let saved = await model.saveMemory(id: memory?.id, title: title, content: content, type: type, site: site, version: memory?.version, publish: publish)
            if saved { dismiss() }
        }
    }
}

func memoryTypeTitle(_ type: String) -> String {
    [
        "website": "网站档案", "procedure": "操作流程", "preference": "个人偏好",
        "project": "项目约定", "experience": "工作经验", "fact": "事实",
        "pattern": "模式", "architecture": "架构", "bug": "问题",
        "workflow": "流程", "lesson": "经验"
    ][type] ?? type
}

private func memoryTypeIcon(_ type: String) -> String {
    switch type {
    case "preference": "slider.horizontal.3"
    case "procedure", "workflow": "list.bullet"
    case "project", "architecture": "folder"
    case "website": "globe"
    case "experience", "lesson": "book.open"
    default: "doc.text"
    }
}

private func effectiveMemoryState(_ memory: Memory) -> String {
    if let verification = memory.governance?.verification,
       ["conflict", "expired", "stale", "superseded"].contains(verification) {
        return verification
    }
    if ["expired", "stale", "superseded"].contains(memory.status) { return memory.status }
    return memory.governance?.verification ?? memory.status
}

private func memoryDisplayState(_ memory: Memory) -> String {
    let state = effectiveMemoryState(memory)
    if state == "verified", memory.governance?.claim == "inference" { return "已审核（推断）" }
    return [
        "verified": "已验证", "candidate": "待审核", "conflict": "有冲突",
        "expired": "已过期", "stale": "待更新", "superseded": "已被替代"
    ][state] ?? "待确认"
}

private func memoryOriginTitle(_ origin: String?) -> String {
    [
        "user": "手动整理", "agent": "助理整理", "import": "配置或文档导入",
        "web": "网页资料", "hook": "自动记录", "summary": "摘要整理"
    ][origin ?? ""] ?? origin ?? "未记录"
}

private func memoryEvidenceLine(_ memory: Memory) -> String {
    let rendered = (memory.governance?.evidenceRefs ?? []).compactMap { ref -> String? in
        let parts = [ref.kind, ref.id].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ":")
    }
    if !rendered.isEmpty { return rendered.joined(separator: "、") }
    if let claim = memory.governance?.claim, !claim.isEmpty {
        return claim == "inference" ? "主张：推断" : claim == "observed" ? "主张：观察到的记录" : "主张：\(claim)"
    }
    return "未记录证据或主张"
}

private func governanceSummary(_ memory: Memory) -> String {
    let verification = memory.governance?.verification ?? memory.status
    let version = memory.governance?.version.map { "治理版本 \($0)" } ?? "治理版本尚未记录"
    let expiry = memory.governance?.validUntil ?? memory.expiresAt ?? "未设置有效期"
    return "核验 \(verification) · \(version) · \(expiry) · \(memoryEvidenceLine(memory))"
}

private func memoryOriginDescription(_ memory: Memory) -> String {
    switch memory.origin {
    case "user": "你手动整理的记忆"
    case "agent": effectiveMemoryState(memory) == "candidate" ? "助理整理的记忆，尚待审核" : "由助理整理，已人工审核"
    case "import": "导入的配置或文档记录"
    case "web": "网页资料记录"
    case "hook": "由本机自动化流程记录"
    case "summary": "由会话摘要整理"
    default: effectiveMemoryState(memory) == "candidate" ? "助理整理的候选记忆" : "已加载的记忆记录"
    }
}

private func memoryScope(_ memory: Memory) -> String {
    if let project = memory.recallProject, !project.isEmpty {
        return "项目：\(project)；按任务授权使用"
    }
    if let site = memory.site, !site.isEmpty {
        return "站点：\(site)；按任务授权使用"
    }
    return "使用范围由任务授权决定"
}

private func compactMemoryTime(_ value: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: value) else { return String(value.prefix(16)) }
    if Calendar.current.isDateInToday(date) {
        return date.formatted(date: .omitted, time: .shortened)
    }
    if Calendar.current.isDateInYesterday(date) {
        return "昨天 " + date.formatted(date: .omitted, time: .shortened)
    }
    return date.formatted(date: .abbreviated, time: .omitted)
}
