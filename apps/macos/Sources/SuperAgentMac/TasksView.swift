import SwiftUI
import SuperAgentCore

struct TasksView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var selected: String?
    @State private var newTask = false
    @State private var goal = ""
    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                HStack { Text("\(model.tasks.count) 项工作").font(.caption).foregroundStyle(.secondary); Spacer(); Button { newTask = true } label: { Image(systemName: "plus") }.help("派新任务") }.padding(16)
                List(selection: $selected) {
                    ForEach(model.tasks) { task in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(task.title).font(.body.weight(.medium)).lineLimit(2)
                            StatusLabel(value: task.status)
                            Text(task.deviceName ?? task.engine.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 9).tag(task.id)
                    }
                }.listStyle(.inset)
            }.frame(minWidth: 240, idealWidth: 290, maxWidth: 350)
            if let task = model.tasks.first(where: { $0.id == selected }) { TaskDetailView(task: task).id(task.id).frame(maxWidth: .infinity) }
            else { EmptyState(icon: "checklist", title: "选择一项任务", detail: "查看它的目标、执行电脑、运行记录和需要你处理的事项。") }
        }.sheet(isPresented: $newTask) {
            VStack(alignment: .leading, spacing: 18) { Text("交办一项工作").font(.title2.weight(.semibold)); ExecutionPicker(); TextEditor(text: $goal).frame(height: 160).border(.quaternary); Text("描述目标与交付物。明确交办的范围内，助理会自主执行。").font(.callout).foregroundStyle(.secondary); HStack { Button("取消") { newTask = false }; Spacer(); Button("创建任务") { let value = goal; goal = ""; newTask = false; Task { await model.createTask(value) } }.buttonStyle(.borderedProminent).disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.selectedDevice.isEmpty) } }.padding(28).frame(width: 600)
        }
    }
}
struct TaskDetailView: View {
    @EnvironmentObject var model: WorkspaceModel
    let task: AgentTask
    @State private var runs: [Run] = []
    @State private var messages: [Message] = []
    @State private var input = ""
    @State private var switching = false
    @State private var targetEngine: Engine = .codex
    @State private var targetDevice = ""
    @State private var reconciling = false
    @State private var outcome = "unknown"
    @State private var reconciliationNote = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) { VStack(alignment: .leading, spacing: 9) { Text(task.title).font(.title.weight(.semibold)); StatusLabel(value: task.status) }; Spacer(); Menu { Button("暂停") { act("pause") }; Button("继续") { act("resume") }; Button("切换引擎或电脑") { targetEngine = task.engine; targetDevice = task.deviceId ?? ""; switching = true }; Button("重试") { act("retry") }; Button("核对业务结果") { reconciling = true }; Divider(); Button("取消任务", role: .destructive) { act("cancel") } } label: { Label("任务操作", systemImage: "ellipsis.circle") } }
                Text(task.goal).font(.body).lineSpacing(5).textSelection(.enabled)
                HStack(spacing: 25) { Label(task.engine.rawValue.capitalized, systemImage: "sparkle"); Label(task.deviceName ?? model.devices.first(where: { $0.id == task.deviceId })?.name ?? "等待设备", systemImage: "desktopcomputer"); if let modelId = task.modelId { Text(modelId) } }.font(.callout).foregroundStyle(.secondary)
                if let reason = task.reasonCode { Label(reason, systemImage: "info.circle").font(.callout).foregroundStyle(.orange) }
                ForEach(model.questions.filter { $0.taskId == task.id }) { QuestionRow(question: $0) }
                Divider()
                Text("运行记录").font(.headline)
                if runs.isEmpty { Text("任务尚未开始执行。").foregroundStyle(.secondary) }
                ForEach(runs) { run in HStack(alignment: .top, spacing: 12) { Image(systemName: "circle.dotted").foregroundStyle(Palette.blue); VStack(alignment: .leading, spacing: 6) { HStack { Text(run.engine.rawValue.capitalized).fontWeight(.medium); StatusLabel(value: run.state); Spacer(); Text(formatTime(run.createdAt)).font(.caption).foregroundStyle(.secondary) }; Text(run.resultText.flatMap { $0.isEmpty ? nil : $0 } ?? (run.summary.isEmpty ? run.modelId : run.summary)).font(.callout).textSelection(.enabled) } }.padding(.vertical, 5) }
                if let runId = task.currentRunId { BrowserFrameView(runId: runId) }
                TaskArtifactsView(taskId: task.id)
                Divider()
                Text("补充要求").font(.headline)
                ForEach(messages) { message in VStack(alignment: .leading, spacing: 5) { Text(message.role == "user" ? "你" : "助理").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Text(message.content).textSelection(.enabled) } }
                HStack { TextField("补充目标、说明或约束", text: $input).textFieldStyle(.roundedBorder); Button("发送") { let value = input; input = ""; Task { await model.operation { let _: JSONValue = try await model.api.request("/tasks/\(task.id)/inputs", method: "POST", body: ["text": .string(value)]); await load() } } }.disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(28)
        }.task(id: model.lastSync) { await load() }
        .sheet(isPresented: $switching) {
            VStack(alignment: .leading, spacing: 20) { Text("切换执行方式").font(.title2.weight(.semibold)); Picker("引擎", selection: $targetEngine) { ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }; Picker("电脑", selection: $targetDevice) { Text("选择电脑").tag(""); ForEach(model.devices) { Text("\($0.name)（\(AgentStatus.title($0.status))）").tag($0.id) } }; Text("先停止当前执行并保存检查点，再由新的 Worker 接续。尚未确认结果的提交会先核对。").foregroundStyle(.secondary); HStack { Button("取消") { switching = false }; Spacer(); Button("切换并继续") { switching = false; Task { await model.action("switch", task: task, targetEngine: targetEngine, targetDevice: targetDevice) } }.buttonStyle(.borderedProminent).disabled(targetDevice.isEmpty) } }.padding(28).frame(width: 480)
        }
        .sheet(isPresented: $reconciling) {
            VStack(alignment: .leading, spacing: 18) {
                Text("核对业务结果").font(.title2.weight(.semibold))
                Text("先在目标系统核对实际回执。只有明确未生效的操作才适合重试，避免重复提交。").foregroundStyle(.secondary)
                Picker("核对结论", selection: $outcome) { Text("仍不确定").tag("unknown"); Text("确认已生效").tag("applied"); Text("确认未生效").tag("not_applied") }
                TextEditor(text: $reconciliationNote).frame(height: 130).border(.quaternary)
                Text("记录核对对象、回执或判断依据。").font(.caption).foregroundStyle(.secondary)
                if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange) }
                HStack { Button("返回") { reconciling = false }; Spacer(); Button("提交核对") { Task { await model.operation { let _: JSONValue = try await model.api.request("/tasks/\(task.id)/reconciliation", method: "POST", body: ["outcome": .string(outcome), "note": .string(reconciliationNote)], version: task.version); reconciling = false; await model.refresh() } } }.buttonStyle(.borderedProminent).disabled(reconciliationNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy) }
            }.padding(28).frame(width: 520)
        }
    }
    private func act(_ value: String) { Task { await model.action(value, task: task) } }
    private func load() async { do { let result: Items<Run> = try await model.api.request("/tasks/\(task.id)/runs"); runs = result.items; let list: Items<Message> = try await model.api.request("/messages?task_id=\(task.id)"); messages = list.items } catch { model.error = error.localizedDescription } }
}
struct QuestionsView: View {
    @EnvironmentObject var model: WorkspaceModel
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 22) { if model.questions.isEmpty { EmptyState(icon: "checkmark.circle", title: "暂时没有需要你处理的事", detail: "助理遇到需要业务判断的问题时，会在这里给出背景和选项。") }; ForEach(model.questions) { QuestionRow(question: $0) } }.padding(28) } }
}
struct QuestionRow: View {
    @EnvironmentObject var model: WorkspaceModel
    let question: Question
    @State private var answer = ""
    var body: some View { VStack(alignment: .leading, spacing: 14) { Label("需要你的判断", systemImage: "hand.raised").font(.caption.weight(.semibold)).foregroundStyle(Palette.blue); Text(question.text).font(.body).textSelection(.enabled); if !question.options.isEmpty { HStack { ForEach(question.options, id: \.self) { option in Button(option) { Task { await model.answer(question, text: option) } } } } }; HStack { TextField("补充回答", text: $answer).textFieldStyle(.roundedBorder); Button("回答") { let value = answer; answer = ""; Task { await model.answer(question, text: value) } }.disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy) } }.padding(20).background(Palette.blue.opacity(0.05), in: RoundedRectangle(cornerRadius: 12)) }
}
