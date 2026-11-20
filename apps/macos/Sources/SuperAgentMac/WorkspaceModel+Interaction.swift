import Foundation
import SuperAgentCore

extension WorkspaceModel {
    func isBusy(_ key: String) -> Bool { busyKeys.contains(key) }

    var transcript: [TranscriptItem] {
        TranscriptMerge.merge(messages: messages, outbound: outbound, processing: Array(processingRecords.values), processingEnabled: capabilities.messageProcessing)
    }

    func assistantLinkFacts() -> (server: String, computer: String) {
        let serverText = serverConnected ? "与服务端连接" : "与服务端未连接"
        let deviceId = settings?.assistantDeviceId ?? (selectedDevice.isEmpty ? nil : selectedDevice)
        let computer: String
        if let deviceId, let device = devices.first(where: { $0.id == deviceId }) {
            computer = device.revoked != true && device.status != "offline" ? "执行电脑在线" : "执行电脑离线"
        } else {
            computer = "执行电脑状态未知"
        }
        return (serverText, computer)
    }

    func stagePresentation(for task: AgentTask, now: Date = Date()) -> StageView {
        let record = stageRecords[task.id] ?? TaskStageRecord()
        let device = devices.first { $0.id == task.deviceId }
        let online: Bool? = device.map { $0.revoked != true && $0.status != "offline" }
        return StageProjection.present(StageFacts(
            runState: record.runState,
            progressPhase: record.phase,
            progressSummary: record.summary,
            completedCount: record.completedCount,
            totalCount: record.totalCount,
            waitingReason: record.waitingReason,
            taskStatus: task.status,
            hasOpenQuestion: questions.contains { $0.taskId == task.id },
            deliveryStatus: task.deliveryStatus,
            lastProgressAt: record.lastProgressAt,
            serverConnected: serverConnected,
            deviceOnline: online,
            now: now,
            taskProgressEnabled: capabilities.taskProgress
        ))
    }

    func enterForeground() {
        guard session != nil, !isDemo else { return }
        if authRequired {
            connectionBanner = "登录已失效，请重新登录"
            return
        }
        syncing = true
        syncNote = "正在同步"
        let generation = scopeGeneration
        Task { [weak self] in
            guard let self else { return }
            await self.recoverOutbound(generation: generation)
            await self.refresh()
            guard self.session != nil, !self.authRequired, generation == self.scopeGeneration else { return }
            self.reconnectEventStream()
        }
    }

    func resetInteractionMemory() {
        scopeGeneration += 1
        loadedScope = nil
        outbound = []
        projection = ProjectionJournal()
        cursor = "0"
        seenSeqs = []
        controlNotices = [:]
        receiptById = [:]
        stageRecords = [:]
        processingRecords = [:]
        fastChoice = nil
        disconnectStarted = nil
        connectionBanner = nil
        serverConnected = false
        capabilities = .legacy
        laneTail = [:]
        laneAction = [:]
        clearBusyKeys()
    }

    func runLane(_ key: String, action: String, _ work: @escaping () async -> Void) async {
        if let tail = laneTail[key], laneAction[key] == action {
            await tail.value
            return
        }
        let previous = laneTail[key]
        let task = Task { @MainActor in
            await previous?.value
            self.markBusy(key, true)
            await work()
            self.markBusy(key, false)
        }
        laneTail[key] = task
        laneAction[key] = action
        await task.value
        if laneTail[key] == task {
            laneTail[key] = nil
            laneAction[key] = nil
        }
    }

    @discardableResult
    func runReview(_ id: String, _ work: @escaping () async throws -> Void) async -> Bool {
        var accepted = false
        await runLane("review:\(id)", action: "review") {
            do { try await work(); accepted = true }
            catch { self.error = error.localizedDescription }
        }
        return accepted
    }

    func checkTask(_ id: String) async {
        if capabilities.workspaceSnapshot, let snapshot: WorkspaceSnapshot = try? await api.request("/workspace/snapshot") {
            await applySnapshot(snapshot, rebase: false)
            return
        }
        _ = await fetchTask(id)
    }

    func deleteUnsent(_ clientMessageId: String) {
        guard let message = outbound.first(where: { $0.clientMessageId == clientMessageId }), OutboundQueue.canDeleteLocally(message) else { return }
        outbound.removeAll { $0.clientMessageId == clientMessageId }
        saveOutbound()
    }

    func editOutboundAsNew(_ clientMessageId: String) {
        guard let message = outbound.first(where: { $0.clientMessageId == clientMessageId }) else { return }
        assistantDraft = message.text
    }

    func confirmOutbound(_ clientMessageId: String) async {
        await reconcile(clientMessageId, generation: scopeGeneration)
    }

    func refresh() async {
        await runLane("sync", action: "refresh") {
            do { try await self.performRefresh() }
            catch { if self.syncNote == nil { self.syncNote = "同步失败，已保留已加载内容" } }
        }
    }

    @discardableResult
    func sendMessage(_ text: String, taskId: String? = nil, scope: MemoryScopeDraft = MemoryScopeDraft()) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isDemo else { return false }
        let refs = tasks.map { FastTaskRef(id: $0.id, title: $0.title, status: $0.status) }
        if case .choose(let action, let choices) = FastPath.gate(text: trimmed, tasks: refs) {
            fastChoice = FastChoice(action: action, choices: choices, original: text)
            return false
        }
        fastChoice = nil
        let scopeValue: JSONValue
        do { scopeValue = try RequestBodies.memoryScope(scope) }
        catch { self.error = error.localizedDescription; return false }
        let preference: [String: JSONValue]? = selectedDevice.isEmpty ? nil : ["engine": .string(selectedEngine.rawValue), "device_id": .string(selectedDevice), "selection_mode": .string("pinned")]
        guard await ensureScope() != nil else { return false }
        let message = OutboundQueue.prepare(text: text, clientMessageId: UUID().uuidString, createdAt: Self.isoNow(), memoryScope: scopeValue, taskId: taskId, executionPreference: preference)
        outbound.append(message)
        saveOutbound()
        let generation = scopeGeneration
        Task { [weak self] in
            await self?.runLane("message:\(message.clientMessageId)", action: "send") {
                await self?.transmit(message, generation: generation)
            }
        }
        return true
    }

    func createTask(_ goal: String, scope: MemoryScopeDraft = MemoryScopeDraft()) async {
        await runLane("task:create", action: "create") {
            do {
                guard !self.selectedDevice.isEmpty else { throw APIError(status: 0, code: "device_required", message: "先选择执行电脑；可以在电脑页认领已安装的节点") }
                guard self.devices.first(where: { $0.id == self.selectedDevice })?.revoked != true else { throw APIError(status: 0, code: "device_revoked", message: "此电脑已撤销，请手动选择其他电脑") }
                var body: [String: JSONValue] = ["goal": .string(goal), "engine": .string(self.selectedEngine.rawValue), "device_id": .string(self.selectedDevice), "memory_scope": try RequestBodies.memoryScope(scope)]
                if !self.selectedModelId.isEmpty { body["model_id"] = .string(self.selectedModelId) }
                let created: AgentTask = try await self.api.request("/tasks", method: "POST", body: body)
                self.mergeTask(created)
                self.error = nil
                Task { await self.refresh() }
            } catch { self.error = error.localizedDescription }
        }
    }

    func raiseLimitAndRetry(task: AgentTask, reason: String, raw: String) async {
        await runLane("task:\(task.id):control", action: "retry") {
            do {
                guard let value = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw APIError(status: 0, code: "invalid_budget", message: "请输入整数上限") }
                let updated: AgentTask = try await self.api.request("/tasks/\(task.id)/budget", method: "PUT", body: try RequestBodies.taskBudgetMerge(reason: reason, value: value), version: task.version)
                self.mergeTask(updated)
                await self.performAction("retry", task: updated, targetEngine: nil, targetDevice: nil)
            } catch { self.error = error.localizedDescription }
        }
    }

    func action(_ action: String, task: AgentTask, targetEngine: Engine? = nil, targetDevice: String? = nil) async {
        await runLane("task:\(task.id):control", action: action) {
            await self.performAction(action, task: task, targetEngine: targetEngine, targetDevice: targetDevice)
        }
    }

    func answer(_ question: Question, text: String) async {
        await runLane("question:\(question.id)", action: "answer") {
            do {
                let _: JSONValue = try await self.api.request("/questions/\(question.id)/answers", method: "POST", body: ["answer": .string(text), "version": .number(Double(question.version))], version: question.version)
                self.error = nil
                Task { await self.refresh() }
            } catch { self.error = error.localizedDescription }
        }
    }

    func restoreCursor() async {
        seenSeqs = []
        guard let scope = await interactionScope() else {
            cursor = "0"; projection = ProjectionJournal(); outbound = []; loadedScope = nil
            return
        }
        var journal = interactionStore.loadProjection(scope)
        if journal.projectedCursor == "0" || journal.projectedCursor.isEmpty {
            let legacy = UserDefaults.standard.string(forKey: "event-cursor.\(scope.userId)") ?? ""
            if legacy.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil, legacy != "0" {
                journal.projectedCursor = legacy
                journal.receivedCursor = legacy
                try? interactionStore.saveProjection(scope, journal)
            }
        }
        if journal.projectedCursor.range(of: #"^\d{1,20}$"#, options: .regularExpression) == nil { journal.projectedCursor = "0" }
        if journal.receivedCursor.range(of: #"^\d{1,20}$"#, options: .regularExpression) == nil { journal.receivedCursor = journal.projectedCursor }
        projection = journal
        cursor = journal.projectedCursor
        loadedScope = scope
        outbound = interactionStore.loadMessages(scope)
    }

    func recoverOutbound(generation: Int) async {
        guard generation == scopeGeneration, await ensureScope() != nil else { return }
        for message in outbound where message.phase != .confirmed {
            if generation != scopeGeneration { return }
            await reconcile(message.clientMessageId, generation: generation)
        }
    }

    func runEventStream() async {
        var failureDelay = 0.0
        var nextReconcile = Date().addingTimeInterval(45)
        while !Task.isCancelled {
            if session == nil || isDemo || authRequired { return }
            if Date() >= nextReconcile {
                await refresh()
                nextReconcile = Date().addingTimeInterval(45)
                if Task.isCancelled || session == nil || authRequired { return }
            }
            await retryDirty()
            if failureDelay > 0 {
                noteDisconnect()
                do { try await Task.sleep(for: .seconds(failureDelay)) } catch { return }
            }
            if Task.isCancelled || session == nil || isDemo || authRequired { return }
            do {
                let stream = try await api.events(after: cursor)
                noteConnected()
                var remainder = ""
                var held = false
                for try await line in stream {
                    if Task.isCancelled { return }
                    let consumed = EventStreamDecoder.consume(line + "\n", cursor: projection.receivedCursor, seen: seenSeqs, remainder: remainder)
                    remainder = consumed.remainder
                    seenSeqs = consumed.seen
                    if !consumed.applied.isEmpty, await project(consumed.applied) == false {
                        projection.receivedCursor = cursor
                        seenSeqs = []
                        held = true
                        break
                    }
                    if EventStreamDecoder.compareStreamSeq(consumed.cursor, projection.receivedCursor) > 0 {
                        projection.receivedCursor = consumed.cursor
                    }
                }
                if !held, !remainder.isEmpty {
                    let consumed = EventStreamDecoder.consume("\n", cursor: projection.receivedCursor, seen: seenSeqs, remainder: remainder)
                    seenSeqs = consumed.seen
                    if !consumed.applied.isEmpty, await project(consumed.applied) == false {
                        projection.receivedCursor = cursor
                        seenSeqs = []
                        held = true
                    }
                }
                if held {
                    noteDisconnect()
                    failureDelay = failureDelay == 0 ? 1 : min(failureDelay * 2, 30)
                } else {
                    failureDelay = 0
                    noteConnected()
                }
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch let error as APIError where error.status == 401 {
                do {
                    let _: User = try await api.request("/me")
                    failureDelay = 0
                    noteConnected()
                } catch {
                    authRequired = true
                    serverConnected = false
                    connectionBanner = "登录已失效，请重新登录"
                    self.error = "登录已失效，请重新登录"
                    if await api.currentSession() == nil { session = nil }
                    return
                }
            } catch let error as APIError where error.status == 422 || error.status == 410 || error.code == "invalid_cursor" {
                switch await realignCursor() {
                case .applied:
                    failureDelay = 0
                    noteConnected()
                case .unavailable:
                    try? await performRefresh()
                    if cursor != "0" {
                        cursor = "0"
                        seenSeqs = []
                        projection = ProjectionJournal()
                        await persistProjection()
                    }
                    failureDelay = 0
                case .retry:
                    noteDisconnect()
                    failureDelay = failureDelay == 0 ? 1 : min(failureDelay * 2, 30)
                }
            } catch {
                if await api.currentSession() == nil { session = nil; return }
                noteDisconnect()
                failureDelay = failureDelay == 0 ? 1 : min(failureDelay * 2, 30)
            }
        }
    }

    private func project(_ events: [AppliedStreamEvent]) async -> Bool {
        for event in events {
            noteFacts(event)
            let fetched = await fetchForProjection(event)
            let dirty = fetched ? nil : DirtyProjection(seq: event.streamSeq, type: event.type, taskId: event.taskId, eventId: event.eventId)
            guard let next = ProjectionJournal.reduce(journal: projection, seq: event.streamSeq, fetchSucceeded: fetched, dirty: dirty) else { return false }
            guard let scope = await interactionScope(), scope == loadedScope else { return false }
            do {
                try interactionStore.saveProjection(scope, next)
                projection = next
                cursor = next.projectedCursor
            } catch {
                return false
            }
        }
        return true
    }

    private func fetchForProjection(_ event: AppliedStreamEvent) async -> Bool {
        switch event.type {
        case "cursor", "":
            return true
        case "device.changed":
            return await fetchDevices()
        case "notification.created", "question.created", "question.resolved":
            return await fetchQuestions()
        case "message.created", "assistant.replied", "message.processing.changed":
            let messagesReady = await fetchMessages()
            guard messagesReady else { return false }
            guard event.type == "message.processing.changed", capabilities.messageProcessing, let sourceId = event.facts.sourceMessageId else { return true }
            return await fetchProcessing(sourceId)
        case "action.changed":
            if capabilities.actionReceipts, let actionId = event.facts.actionId { return await fetchAction(actionId) }
            if let taskId = event.taskId { return await fetchTask(taskId) }
            return !capabilities.actionReceipts
        default:
            if event.type.hasPrefix("plan.") { return await fetchMessages() }
            if let taskId = event.taskId { return await fetchTask(taskId) }
            return true
        }
    }

    private func noteFacts(_ event: AppliedStreamEvent) {
        guard let taskId = event.taskId else { return }
        var record = stageRecords[taskId] ?? TaskStageRecord()
        if !EntityMerge.accept(incoming: event.facts.version, current: record.version), event.facts.version != nil || record.version != nil {
            if !EntityMerge.accept(incoming: event.facts.version, current: record.version) { return }
        }
        let previousState = record.runState
        let previousPhase = record.phase
        let previousVersion = record.version
        if let state = event.facts.state { record.runState = state }
        if let phase = event.facts.phase { record.phase = phase }
        if let summary = event.facts.summary { record.summary = summary }
        if let reason = event.facts.waitingReason { record.waitingReason = reason }
        if event.facts.completedCount != nil { record.completedCount = event.facts.completedCount }
        if event.facts.totalCount != nil { record.totalCount = event.facts.totalCount }
        let changed = previousState != record.runState || previousPhase != record.phase || previousVersion != event.facts.version && event.facts.version != nil
        if changed || event.type == "task.progress.changed" || event.type == "run.started" {
            if let stamp = event.facts.lastProgressAt, let date = Self.parseISO(stamp) { record.lastProgressAt = date }
            else if changed { record.lastProgressAt = Date() }
        }
        if let version = event.facts.version { record.version = version }
        stageRecords[taskId] = record
    }

    func performRefresh() async throws {
        guard !isDemo else { lastSync = Date(); syncNote = nil; return }
        syncing = true
        defer { syncing = false }
        do {
            await loadCapabilities()
            let taskList: Items<AgentTask> = try await api.request("/tasks")
            mergeTaskList(taskList.items)
            let deviceList: Items<Device> = try await api.request("/devices")
            mergeDeviceList(deviceList.items)
            let messageList: Items<Message> = try await api.request("/messages")
            mergeMessageList(messageList.items)
            let questionList: Items<Question> = try await api.request("/questions?status=open")
            mergeQuestionList(questionList.items)
            memorySettings = try await api.request("/settings/memory")
            if memorySettings?.configured == true {
                let memoryList: Items<Memory> = try await api.request("/memories")
                memories = memoryList.items
            } else { memories = [] }
            let loadedSettings: ExecutionSettings = try await api.request("/settings/execution")
            if EntityMerge.accept(incoming: loadedSettings.version, current: settings?.version) { settings = loadedSettings }
            if selectedDevice.isEmpty { selectedDevice = settings?.defaultDeviceId ?? devices.first(where: { $0.revoked != true })?.id ?? ""; selectedEngine = settings?.defaultEngine ?? .codex }
            lastSync = Date()
            syncNote = nil
            if !authRequired, connectionBanner == nil { serverConnected = true }
        } catch {
            syncNote = lastSync.map { "同步失败，最近成功 \($0.formatted(date: .omitted, time: .shortened))" } ?? "同步失败，已保留已加载内容"
            throw error
        }
    }

    private func loadCapabilities() async {
        do { capabilities = try await api.request("/capabilities") }
        catch let error as APIError where error.status == 404 { capabilities = .legacy }
        catch { }
    }

    private func transmit(_ message: OutboundMessage, generation: Int) async {
        guard generation == scopeGeneration, var current = outbound.first(where: { $0.clientMessageId == message.clientMessageId }) else { return }
        current.phase = .inFlight
        replaceOutbound(current)
        do {
            let saved: Message = try await api.request("/messages", method: "POST", body: current.body, idempotencyKey: current.idempotencyKey)
            guard generation == scopeGeneration else { return }
            mergeMessage(saved, clientMessageId: current.clientMessageId)
        } catch {
            guard generation == scopeGeneration, let latest = outbound.first(where: { $0.clientMessageId == current.clientMessageId }) else { return }
            applySubmit(latest, outcome: classify(error))
        }
    }

    private func reconcile(_ id: String, generation: Int) async {
        await runLane("message:\(id)", action: "reconcile") {
            guard generation == self.scopeGeneration, let message = self.outbound.first(where: { $0.clientMessageId == id }), message.phase != .confirmed else { return }
            do {
                let found: MessageLookup = try await self.api.request("/messages/by-client-id/\(id)")
                guard generation == self.scopeGeneration else { return }
                if let processing = found.processing { self.mergeProcessing(processing) }
                self.mergeMessage(found.message, clientMessageId: id)
            } catch {
                guard generation == self.scopeGeneration else { return }
                let outcome = self.classify(error)
                if OutboundRecovery.step(for: outcome) == .retransmitOriginal {
                    await self.transmit(message, generation: generation)
                } else {
                    self.applySubmit(message, outcome: outcome)
                }
            }
        }
    }

    private func performAction(_ name: String, task: AgentTask, targetEngine: Engine?, targetDevice: String?) async {
        let generation = scopeGeneration
        do {
            var body: [String: JSONValue] = ["action": .string(name)]
            if name == "switch", let device = targetDevice, devices.first(where: { $0.id == device })?.revoked == true {
                throw APIError(status: 0, code: "device_revoked", message: "此电脑已撤销，请手动选择其他电脑")
            }
            if name == "switch", let engine = targetEngine, let device = targetDevice {
                body["target"] = .object(["engine": .string(engine.rawValue), "device_id": .string(device)])
            }
            guard let scope = await interactionScope(), generation == scopeGeneration else { return }
            if loadedScope != scope { loadedScope = scope }
            var controls = interactionStore.loadControls(scope)
            let existing = controls.first { $0.taskId == task.id && $0.action == name && $0.phase == "pendingConfirmation" }
            let key = existing?.idempotencyKey ?? UUID().uuidString
            let version = existing?.version ?? task.version
            let storedBody = existing?.body ?? body
            controls.removeAll { $0.idempotencyKey == key }
            controls.append(PendingControl(idempotencyKey: key, taskId: task.id, action: name, version: version, body: storedBody, phase: "inFlight", notice: "请求已收到"))
            try interactionStore.saveControls(scope, controls)
            let response: ActionAcceptResponse = try await api.request("/tasks/\(task.id)/actions", method: "POST", body: storedBody, version: version, idempotencyKey: key)
            guard generation == scopeGeneration else { return }
            controlNotices[task.id] = ActionDisplay.label(action: name, receiptStatus: response.receipt?.status, receiptsEnabled: capabilities.actionReceipts)
            if capabilities.actionReceipts, let receipt = response.receipt { mergeReceipt(receipt) }
            var settled = interactionStore.loadControls(scope)
            settled.removeAll { $0.idempotencyKey == key }
            try? interactionStore.saveControls(scope, settled)
            Task { _ = await self.fetchTask(task.id) }
        } catch {
            guard generation == scopeGeneration else { return }
            if error is DecodingError {
                controlNotices[task.id] = "请求已收到"
                return
            }
            let outcome = classify(error)
            if outcome == .timeout || outcome == .transport {
                controlNotices[task.id] = "请求结果待确认"
                if let scope = loadedScope {
                    var controls = interactionStore.loadControls(scope)
                    if let index = controls.lastIndex(where: { $0.taskId == task.id && $0.action == name }) {
                        controls[index].phase = "pendingConfirmation"
                        controls[index].notice = "请求结果待确认"
                        try? interactionStore.saveControls(scope, controls)
                    }
                }
            } else if outcome == .conflict {
                controlNotices[task.id] = "操作冲突，没有覆盖"
            } else if outcome == .unauthorized {
                authRequired = true
                connectionBanner = "登录已失效，请重新登录"
                self.error = "登录已失效，请重新登录"
            } else {
                self.error = error.localizedDescription
                controlNotices[task.id] = "操作失败"
            }
        }
    }

    private func applySubmit(_ message: OutboundMessage, outcome: SubmitOutcome) {
        switch OutboundRecovery.step(for: outcome) {
        case .pendingConfirmation:
            replaceOutbound(OutboundQueue.keepingIdentity(message, phase: .pendingConfirmation))
        case .conflict:
            replaceOutbound(OutboundQueue.keepingIdentity(message, phase: .conflict))
        case .failed:
            replaceOutbound(OutboundQueue.keepingIdentity(message, phase: .failed))
        case .needsLogin:
            authRequired = true
            connectionBanner = "登录已失效，请重新登录"
            error = "登录已失效，请重新登录"
        case .merge, .retransmitOriginal:
            break
        }
    }

    private func classify(_ error: Error) -> SubmitOutcome {
        if let error = error as? APIError {
            if error.status == 404 { return .notFound }
            if error.status == 409 || error.status == 412 { return .conflict }
            if error.status == 401 { return .unauthorized }
            if error.status == 408 || (500...599).contains(error.status) || error.status == 0 { return .timeout }
            return .rejected
        }
        if let error = error as? URLError {
            switch error.code {
            case .cancelled: return .transport
            default: return .timeout
            }
        }
        return .timeout
    }

    @discardableResult
    private func fetchTask(_ id: String) async -> Bool {
        do {
            let task: AgentTask = try await api.request("/tasks/\(id)")
            mergeTask(task)
            return true
        } catch { return false }
    }

    private func fetchMessages() async -> Bool {
        do {
            let list: Items<Message> = try await api.request("/messages")
            mergeMessageList(list.items)
            return true
        } catch { return false }
    }

    private func fetchDevices() async -> Bool {
        do {
            let list: Items<Device> = try await api.request("/devices")
            mergeDeviceList(list.items)
            return true
        } catch { return false }
    }

    private func fetchQuestions() async -> Bool {
        do {
            let list: Items<Question> = try await api.request("/questions?status=open")
            mergeQuestionList(list.items)
            return true
        } catch { return false }
    }

    private func fetchProcessing(_ id: String) async -> Bool {
        do {
            let record: MessageProcessing = try await api.request("/messages/\(id)/processing")
            mergeProcessing(record)
            return true
        } catch let error as APIError where error.status == 404 {
            return true
        } catch { return false }
    }

    private func fetchAction(_ id: String) async -> Bool {
        do {
            let receipt: ActionReceipt = try await api.request("/actions/\(id)")
            mergeReceipt(receipt)
            return true
        } catch let error as APIError where error.status == 404 {
            return !capabilities.actionReceipts
        } catch { return false }
    }

    private func retryDirty() async {
        guard !projection.dirty.isEmpty, let scope = await interactionScope(), scope == loadedScope else { return }
        var kept: [DirtyProjection] = []
        for item in projection.dirty {
            let event = AppliedStreamEvent(streamSeq: item.seq, eventId: item.eventId, type: item.type, taskId: item.taskId)
            if await fetchForProjection(event) == false { kept.append(item) }
        }
        if kept.count != projection.dirty.count {
            projection.dirty = kept
            try? interactionStore.saveProjection(scope, projection)
        }
    }

    private enum Realign { case applied, unavailable, retry }

    private func realignCursor() async -> Realign {
        do {
            let snapshot: WorkspaceSnapshot = try await api.request("/workspace/snapshot")
            await applySnapshot(snapshot, rebase: true)
            return .applied
        } catch let error as APIError where error.status == 404 {
            return .unavailable
        } catch { return .retry }
    }

    private func applySnapshot(_ snapshot: WorkspaceSnapshot, rebase: Bool) async {
        mergeTaskList(snapshot.tasks)
        mergeMessageList(snapshot.messages)
        mergeDeviceList(snapshot.devices)
        mergeQuestionList(snapshot.questions)
        for record in snapshot.processing { mergeProcessing(record) }
        for action in snapshot.actions { mergeReceipt(action) }
        guard snapshot.cursor.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil else { return }
        let newer = EventStreamDecoder.compareStreamSeq(snapshot.cursor, cursor) > 0
        guard rebase || newer else { return }
        cursor = snapshot.cursor
        projection.projectedCursor = snapshot.cursor
        if EventStreamDecoder.compareStreamSeq(snapshot.cursor, projection.receivedCursor) > 0 {
            projection.receivedCursor = snapshot.cursor
        }
        if rebase {
            projection.dirty = []
            seenSeqs = []
        } else {
            projection.dirty.removeAll { EventStreamDecoder.compareStreamSeq($0.seq, snapshot.cursor) <= 0 }
        }
        await persistProjection()
    }

    private func noteDisconnect() {
        if disconnectStarted == nil { disconnectStarted = Date() }
        serverConnected = false
        guard !authRequired else { return }
        connectionBanner = ConnectionPresentation.banner(downSince: disconnectStarted, now: Date(), unauthorized: false)
    }

    private func noteConnected() {
        disconnectStarted = nil
        serverConnected = true
        if !authRequired { connectionBanner = nil }
    }

    private func interactionScope() async -> InteractionScope? {
        guard let userId = session?.user.id else { return nil }
        return InteractionScope(server: await api.baseURL.absoluteString, userId: userId)
    }

    private func ensureScope() async -> InteractionScope? {
        if let loadedScope { return loadedScope }
        await restoreCursor()
        return loadedScope
    }

    private func persistProjection() async {
        guard let scope = await interactionScope(), scope == loadedScope else { return }
        try? interactionStore.saveProjection(scope, projection)
    }

    private func saveOutbound() {
        guard let scope = loadedScope else { return }
        try? interactionStore.saveMessages(scope, outbound)
    }

    private func replaceOutbound(_ message: OutboundMessage) {
        if let index = outbound.firstIndex(where: { $0.clientMessageId == message.clientMessageId }) { outbound[index] = message }
        else { outbound.append(message) }
        saveOutbound()
    }

    private func mergeTask(_ task: AgentTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = EntityMerge.choose(task, current: tasks[index], incomingVersion: task.version, currentVersion: tasks[index].version)
        } else { tasks.insert(task, at: 0) }
    }

    private func mergeTaskList(_ incoming: [AgentTask]) {
        let previous = tasks
        tasks = incoming.map { item in
            guard let current = previous.first(where: { $0.id == item.id }) else { return item }
            return EntityMerge.choose(item, current: current, incomingVersion: item.version, currentVersion: current.version)
        }
    }

    private func mergeMessage(_ message: Message, clientMessageId: String?) {
        if let index = messages.firstIndex(where: { $0.id == message.id || ($0.clientMessageId != nil && $0.clientMessageId == message.clientMessageId) }) {
            messages[index] = EntityMerge.choose(message, current: messages[index], incomingVersion: message.version, currentVersion: messages[index].version)
        } else { messages.append(message) }
        let clientId = message.clientMessageId ?? clientMessageId
        outbound.removeAll { $0.clientMessageId == clientId || $0.serverMessageId == message.id || $0.clientMessageId == message.id }
        saveOutbound()
    }

    private func mergeMessageList(_ incoming: [Message]) {
        let previous = messages
        messages = incoming.map { item in
            guard let current = previous.first(where: { $0.id == item.id }) else { return item }
            return EntityMerge.choose(item, current: current, incomingVersion: item.version, currentVersion: current.version)
        }
        let serverIds = Set(messages.map(\.id))
        let clientIds = Set(messages.compactMap(\.clientMessageId))
        let before = outbound.count
        outbound.removeAll { clientIds.contains($0.clientMessageId) || serverIds.contains($0.clientMessageId) || ($0.serverMessageId.map { serverIds.contains($0) } ?? false) }
        if outbound.count != before { saveOutbound() }
    }

    private func mergeDeviceList(_ incoming: [Device]) {
        let previous = devices
        devices = incoming.map { item in
            guard let current = previous.first(where: { $0.id == item.id }) else { return item }
            return EntityMerge.choose(item, current: current, incomingVersion: item.version, currentVersion: current.version)
        }
    }

    private func mergeQuestionList(_ incoming: [Question]) {
        let previous = questions
        let merged = incoming.map { item in
            guard let current = previous.first(where: { $0.id == item.id }) else { return item }
            return EntityMerge.choose(item, current: current, incomingVersion: item.version, currentVersion: current.version)
        }
        if lastSync != nil {
            let known = Set(previous.map(\.id))
            NativeNotifications.announceNewQuestions(merged.filter { !known.contains($0.id) })
        }
        questions = merged
    }

    private func mergeProcessing(_ record: MessageProcessing) {
        let key = record.sourceMessageId.isEmpty ? record.id : record.sourceMessageId
        guard !key.isEmpty else { return }
        if let current = processingRecords[key] {
            processingRecords[key] = EntityMerge.choose(record, current: current, incomingVersion: record.version, currentVersion: current.version)
        } else { processingRecords[key] = record }
    }

    private func mergeReceipt(_ receipt: ActionReceipt) {
        guard capabilities.actionReceipts else { return }
        let current = receiptById[receipt.actionId]
        guard EntityMerge.accept(incoming: receipt.version, current: current?.version) else { return }
        receiptById[receipt.actionId] = receipt
        controlNotices[receipt.taskId] = ActionDisplay.label(action: receipt.action, receiptStatus: receipt.status, receiptsEnabled: true)
    }

    private static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func parseISO(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
