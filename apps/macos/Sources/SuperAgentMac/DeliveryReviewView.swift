import SwiftUI
import AppKit
import SuperAgentCore

struct DeliveryReviewView: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    let taskId: String
    @State private var evidence: TaskEvidence?
    @State private var passed: Set<Int> = []
    @State private var selected: [Int: String] = [:]
    @State private var summary = ""
    @State private var loading = false
    @State private var submitting = false
    @State private var error: String?
    @State private var preview: EvidencePreview?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Label("核对交付", systemImage: "checkmark.seal")
                        .font(.headline)
                    if let evidence {
                        Text(evidence.task.title)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .help(evidence.task.title)
                    }
                }
                Spacer()
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("刷新证据")
                    .accessibilityLabel("刷新证据")
                    .disabled(loading || submitting)
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .help("关闭验收")
                    .accessibilityLabel("关闭验收")
                    .disabled(submitting)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("执行结束后还需要核对目标与交付标准。打开材料并逐条确认，验收通过后才标记目标完成。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if loading && evidence == nil {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("读取交付证据").font(.callout)
                        }
                    }
                    if let evidence {
                        if let delivery = evidence.delivery {
                            Label(deliveryTitle(delivery.status), systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !evidence.canReview {
                            Label("交付状态已变化或证据尚未准备好，请刷新任务与证据。", systemImage: "exclamationmark.triangle")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        }
                        materials(evidence)
                        Divider()
                        Text("逐条核对交付标准")
                            .font(.headline)
                        ForEach(Array(evidence.deliverables.enumerated()), id: \.offset) { index, criterion in
                            VStack(alignment: .leading, spacing: 9) {
                                Toggle(isOn: Binding(
                                    get: { passed.contains(index) },
                                    set: { if $0 { passed.insert(index) } else { passed.remove(index) } }
                                )) {
                                    Text(criterion)
                                        .font(.callout)
                                        .textSelection(.enabled)
                                }
                                .disabled(submitting || !evidence.canReview)
                                Picker("第 \(index + 1) 项核对证据", selection: Binding(
                                    get: { selected[index] ?? "" },
                                    set: { selected[index] = $0 }
                                )) {
                                    Text("选择实际核对的证据").tag("")
                                    ForEach(evidence.options) { option in
                                        Text(option.title).tag(option.id)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityLabel("第 \(index + 1) 项核对证据")
                                .disabled(submitting || !evidence.canReview)
                            }
                            .padding(.vertical, 5)
                            if index < evidence.deliverables.count - 1 { Divider() }
                        }
                        if evidence.deliverables.isEmpty {
                            Text("本次交付未提供可逐项核对的标准，暂不能验收通过。")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        }
                        if evidence.options.isEmpty {
                            Text("当前没有可引用的交付证据。可记录缺失内容并要求补充。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else if !loading, let error {
                        ContentUnavailableView("无法读取交付证据", systemImage: "exclamationmark.triangle", description: Text(error))
                    }
                }
                .padding(24)
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                TextField("验收说明：记录核对依据或需要补充的内容", text: $summary, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
                    .disabled(submitting)
                    .accessibilityLabel("验收说明")
                if let error, evidence != nil {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                HStack(spacing: 10) {
                    Button("取消", role: .cancel) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .disabled(submitting)
                    Spacer()
                    Button("需要补充说明") { Task { await submit("needs_input") } }
                        .disabled(submitting || evidence?.canReview != true || summaryIsEmpty)
                    Button("退回") { Task { await submit("reject") } }
                        .disabled(submitting || evidence?.canReview != true || summaryIsEmpty)
                    Button("验收通过") { Task { await submit("accept") } }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(submitting || summaryIsEmpty || !canAccept)
                    if submitting { ProgressView().controlSize(.small) }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
        }
        .frame(width: 660, height: 600)
        .background(.background)
        .task(id: taskId) { await load() }
        .sheet(item: $preview) { item in
            EvidencePreviewView(preview: item)
        }
    }

    private var summaryIsEmpty: Bool {
        summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canAccept: Bool {
        guard let evidence else { return false }
        return (try? evidence.reviewBody(verdict: "accept", summary: summary, passed: passed, selected: selected)) != nil
    }

    @ViewBuilder
    private func materials(_ evidence: TaskEvidence) -> some View {
        let steps = evidence.steps.filter { $0.runId == evidence.run?.id }
        if evidence.run != nil || !steps.isEmpty || !evidence.artifacts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("交付材料")
                    .font(.headline)
                if let run = evidence.run {
                    materialButton(
                        title: "执行结果",
                        subtitle: run.summary.isEmpty ? "查看 resultText 与运行摘要" : run.summary,
                        systemImage: "text.alignleft"
                    ) {
                        let result = run.resultText?.isEmpty == false ? run.resultText! : run.summary
                        preview = EvidencePreview(
                            id: "run:\(run.id)",
                            title: "执行结果",
                            detail: result.isEmpty ? "本次运行没有文本结果。" : result,
                            artifact: nil
                        )
                    }
                }
                ForEach(steps) { step in
                    materialButton(title: step.displayTitle, subtitle: "工具步骤 · \(step.statusTitle)", systemImage: "checklist") {
                        var lines = ["状态：\(step.statusTitle)"]
                        if let date = step.startDate { lines.append("开始：\(date.formatted(date: .abbreviated, time: .standard))") }
                        if let date = step.completionDate { lines.append("结束：\(date.formatted(date: .abbreviated, time: .standard))") }
                        if let message = step.errorMessage { lines.append("错误：\(message)") }
                        preview = EvidencePreview(id: "step:\(step.id)", title: step.displayTitle, detail: lines.joined(separator: "\n\n"), artifact: nil)
                    }
                }
                ForEach(evidence.artifacts) { artifact in
                    materialButton(title: artifact.name, subtitle: artifact.mime, systemImage: "doc") {
                        preview = EvidencePreview(id: "artifact:\(artifact.id)", title: artifact.name, detail: "", artifact: artifact)
                    }
                }
            }
        }
    }

    private func materialButton(title: String, subtitle: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(.primary).lineLimit(2)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("预览 \(title)")
    }

    private func deliveryTitle(_ status: String) -> String {
        ["pending": "当前交付待核对", "rejected": "已退回，等待后续处理", "needs_input": "已请求补充说明", "accepted": "交付已通过验收"][status] ?? "交付状态待确认"
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        if model.isDemo {
            guard let latest = model.demoEvidence[taskId] else {
                error = "演示证据尚未准备好"
                return
            }
            evidence = latest
            error = nil
            return
        }
        do {
            let latest: TaskEvidence = try await model.api.request("/tasks/\(taskId)/evidence")
            guard latest.task.id == taskId, !Task.isCancelled else { return }
            if evidence?.delivery?.id != latest.delivery?.id || evidence?.delivery?.version != latest.delivery?.version || evidence?.run?.id != latest.run?.id {
                passed = []
                selected = [:]
            }
            evidence = latest
            error = nil
        } catch {
            if !Task.isCancelled { self.error = "无法读取交付证据，请刷新后重试" }
        }
    }

    private func submit(_ verdict: String) async {
        guard let evidence, !submitting else { return }
        submitting = true
        defer { submitting = false }
        if model.isDemo {
            dismiss()
            return
        }
        do {
            let body = try evidence.reviewBody(verdict: verdict, summary: summary, passed: passed, selected: selected)
            let accepted = await model.runReview(taskId) {
                let _: JSONValue = try await model.api.request("/tasks/\(taskId)/reviews", method: "POST", body: body, version: evidence.task.version)
            }
            if accepted {
                Task { await model.refresh() }
                dismiss()
            }
        } catch let failure as APIError {
            error = failure.status == 409 || failure.status == 412 ? "交付已被更新，请刷新证据后重新核对" : failure.localizedDescription
        } catch {
            self.error = "验收提交未完成，请稍后重试"
        }
    }
}

private struct EvidencePreview: Identifiable {
    let id: String
    let title: String
    let detail: String
    let artifact: Artifact?
}

private struct EvidencePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let preview: EvidencePreview

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(preview.title, systemImage: preview.artifact == nil ? "text.alignleft" : "doc")
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .help("返回验收")
                    .accessibilityLabel("返回验收")
            }
            .padding(18)
            Divider()
            Group {
                if let artifact = preview.artifact {
                    ArtifactEvidencePreview(artifact: artifact)
                } else {
                    ScrollView {
                        Text(preview.detail)
                            .font(.body)
                            .lineSpacing(5)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(24)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack {
                Text("关闭预览会返回验收，已勾选内容和验收说明会保留。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("返回验收") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 680, height: 590)
        .background(.background)
    }
}

private struct ArtifactEvidencePreview: View {
    @EnvironmentObject var model: WorkspaceModel
    let artifact: Artifact
    @State private var localURL: URL?
    @State private var text: String?
    @State private var image: NSImage?
    @State private var loading = false
    @State private var status: String?

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if loading {
                    ProgressView("读取交付材料")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let image {
                    ScrollView {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFit()
                            .padding(20)
                    }
                } else if let text {
                    ScrollView {
                        Text(text)
                            .font(.body)
                            .lineSpacing(4)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(24)
                    }
                } else {
                    ContentUnavailableView("请下载原件核对", systemImage: "doc", description: Text("此格式不提供内联预览。文件名、格式和下载内容均来自本次任务附件。"))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(artifact.name).font(.caption)
                    Text(artifact.mime).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let status {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
                Button("保存到本机") { save() }
                    .disabled(localURL == nil || loading)
            }
            .padding(16)
        }
        .task(id: artifact.id) { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if model.isDemo {
            status = "演示附件仅用于展示，不连接云端"
            return
        }
        do {
            let descriptor: DownloadDescriptor = try await model.api.request("/artifacts/\(artifact.id)/download")
            guard let source = URL(string: descriptor.url), source.scheme == "https" else {
                throw APIError(status: 0, code: "download_target", message: "下载地址无效")
            }
            let (downloaded, response) = try await URLSession.shared.download(from: source)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                throw APIError(status: 0, code: "download_failed", message: "文件下载失败")
            }
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent("super-agent-evidence-\(UUID().uuidString)-\(artifact.name)")
            try FileManager.default.moveItem(at: downloaded, to: destination)
            localURL = destination
            let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            if artifact.mime.hasPrefix("image/") {
                image = NSImage(contentsOf: destination)
            } else if isTextual(artifact.mime), size <= 2_000_000 {
                text = try? String(contentsOf: destination, encoding: .utf8)
            }
            status = nil
        } catch {
            status = error.localizedDescription
        }
    }

    private func isTextual(_ mime: String) -> Bool {
        mime.hasPrefix("text/") || ["json", "xml", "csv", "markdown", "yaml"].contains { mime.contains($0) }
    }

    private func save() {
        guard let localURL else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: artifact.name).lastPathComponent
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.copyItem(at: localURL, to: copy)
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: copy)
            } else {
                try FileManager.default.copyItem(at: localURL, to: destination)
            }
            status = "已保存"
        } catch {
            status = error.localizedDescription
        }
    }
}
