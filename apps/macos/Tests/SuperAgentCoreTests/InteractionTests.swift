import XCTest
@testable import SuperAgentCore

final class InteractionTests: XCTestCase {
    private func message(_ id: String, content: String, clientMessageId: String? = nil, createdAt: String = "2026-11-20T00:00:00Z", role: String = "user", processingStatus: String? = nil, reasonCode: String? = nil, version: Int? = nil) -> Message {
        Message(id: id, role: role, content: content, taskId: nil, createdAt: createdAt, clientMessageId: clientMessageId, processingStatus: processingStatus, reasonCode: reasonCode, version: version)
    }

    private func outbound(_ id: String, text: String, phase: OutboundPhase, createdAt: String = "2026-11-20T00:00:01Z") -> OutboundMessage {
        var item = OutboundQueue.prepare(text: text, clientMessageId: id, createdAt: createdAt, memoryScope: .object([:]), taskId: nil, executionPreference: nil)
        item.phase = phase
        return item
    }

    private func task(_ id: String, status: String) -> FastTaskRef {
        FastTaskRef(id: id, title: "任务", status: status)
    }

    func testTranscriptMergesByClientMessageId() {
        let server = message("server-1", content: "服务端正文", clientMessageId: "same-client")
        let pending = outbound("same-client", text: "本地正文", phase: .inFlight)
        let other = outbound("other-client", text: "另一条", phase: .pendingConfirmation, createdAt: "2026-11-20T00:00:02Z")
        let items = TranscriptMerge.merge(messages: [server], outbound: [pending, other], processing: [], processingEnabled: false)
        XCTAssertEqual(items.map(\.id), ["same-client", "other-client"])
        XCTAssertEqual(items[0].content, "服务端正文")
        XCTAssertEqual(items[1].content, "另一条")
        XCTAssertEqual(items[1].statusText, "发送结果待确认")
    }

    func testRetransmitKeepsOriginalIdentity() {
        let id = "11111111-1111-1111-1111-111111111111"
        let prepared = OutboundQueue.prepare(
            text: "原来的正文",
            clientMessageId: id,
            createdAt: "2026-11-20T00:00:00Z",
            memoryScope: .object(["project": .string("demo")]),
            taskId: "task-1",
            executionPreference: ["engine": .string("codex")]
        )
        XCTAssertEqual(prepared.idempotencyKey, id)
        XCTAssertEqual(prepared.body["client_message_id"], .string(id))
        XCTAssertEqual(prepared.body["text"], .string("原来的正文"))
        XCTAssertEqual(prepared.body["task_id"], .string("task-1"))
        XCTAssertEqual(prepared.phase, .held)
        XCTAssertEqual(OutboundRecovery.step(for: .notFound), .retransmitOriginal)
        let again = OutboundQueue.keepingIdentity(prepared, phase: .inFlight)
        XCTAssertEqual(again.clientMessageId, id)
        XCTAssertEqual(again.idempotencyKey, id)
        XCTAssertEqual(again.body, prepared.body)
        XCTAssertEqual(OutboundRecovery.phase(for: .notFound, current: .pendingConfirmation), .inFlight)
        XCTAssertEqual(OutboundRecovery.phase(for: .timeout, current: .inFlight), .pendingConfirmation)
        XCTAssertEqual(OutboundRecovery.phase(for: .conflict, current: .inFlight), .conflict)
        XCTAssertEqual(OutboundQueue.removalLabel(prepared), "删除")
        XCTAssertNil(OutboundQueue.removalLabel(OutboundQueue.keepingIdentity(prepared, phase: .pendingConfirmation)))
        XCTAssertFalse(OutboundQueue.canDeleteLocally(OutboundQueue.keepingIdentity(prepared, phase: .pendingConfirmation)))
        XCTAssertEqual(OutboundQueue.statusText(.pendingConfirmation), "发送结果待确认")
        XCTAssertNotEqual(OutboundQueue.statusText(.pendingConfirmation), "未发送成功")
        XCTAssertEqual(OutboundQueue.statusText(.held), "发送中")
    }

    func testCursorAdvancesOnlyAfterSuccessfulProjection() {
        let current = ProjectionJournal(projectedCursor: "9", receivedCursor: "9")
        XCTAssertNil(ProjectionJournal.reduce(journal: current, seq: "10", fetchSucceeded: false, dirty: nil))
        XCTAssertEqual(current.projectedCursor, "9")
        let dirty = DirtyProjection(seq: "10", type: "task.changed", taskId: "task-1")
        let marked = ProjectionJournal.reduce(journal: current, seq: "10", fetchSucceeded: false, dirty: dirty)
        XCTAssertEqual(marked?.projectedCursor, "10")
        XCTAssertEqual(marked?.dirty.map(\.seq), ["10"])
        let projected = ProjectionJournal.reduce(journal: current, seq: "10", fetchSucceeded: true, dirty: nil)
        XCTAssertEqual(projected?.projectedCursor, "10")
        XCTAssertEqual(projected?.receivedCursor, "10")
        XCTAssertEqual(projected?.dirty, [])
        XCTAssertEqual(
            CursorProjection.nextCursor(current: "9", events: [
                (seq: "10", fetchSucceeded: false, dirtySaved: false),
                (seq: "11", fetchSucceeded: true, dirtySaved: false),
            ]),
            "9"
        )
        XCTAssertGreaterThan(EventStreamDecoder.compareStreamSeq("10", "9"), 0)
        XCTAssertLessThan(EventStreamDecoder.compareStreamSeq("9", "10"), 0)
        XCTAssertEqual(EventStreamDecoder.compareStreamSeq("10", "10"), 0)
    }

    func testOlderVersionDoesNotOverwrite() {
        XCTAssertFalse(EntityMerge.accept(incoming: nil, current: 5))
        XCTAssertFalse(EntityMerge.accept(incoming: 4, current: 5))
        XCTAssertTrue(EntityMerge.accept(incoming: 5, current: 5))
        XCTAssertTrue(EntityMerge.accept(incoming: 6, current: 5))
        XCTAssertTrue(EntityMerge.accept(incoming: nil, current: nil))
        XCTAssertEqual(EntityMerge.choose("旧响应", current: "已有", incomingVersion: nil, currentVersion: 5), "已有")
        XCTAssertEqual(EntityMerge.choose("更新", current: "已有", incomingVersion: 6, currentVersion: 5), "更新")
        let older = message("m", content: "旧", version: 4)
        let newer = message("m", content: "新", version: 5)
        XCTAssertEqual(EntityMerge.choose(older, current: newer, incomingVersion: older.version, currentVersion: newer.version).content, "新")
    }

    func testFastPathDoesNotSendAmbiguousCommand() {
        let tasks = [task("abcdef12-0000-0000-0000-000000000001", status: "running"), task("1234abcd-0000-0000-0000-000000000002", status: "running")]
        if case .choose(let action, let choices) = FastPath.gate(text: "暂停", tasks: tasks) {
            XCTAssertEqual(action, "pause")
            XCTAssertEqual(choices.count, 2)
        } else {
            XCTFail("多个可暂停任务不能直接发出")
        }
        if case .choose(let action, _) = FastPath.gate(text: "进度呢", tasks: tasks) {
            XCTAssertEqual(action, "status")
        } else {
            XCTFail("多个任务的进度询问需要先选择")
        }
        XCTAssertEqual(FastPath.gate(text: "如果完成了就暂停", tasks: tasks), .send("如果完成了就暂停"))
        XCTAssertEqual(FastPath.gate(text: "先讨论一下要不要暂停", tasks: tasks), .send("先讨论一下要不要暂停"))
        XCTAssertEqual(FastPath.gate(text: "暂停 abc", tasks: tasks), .send("暂停 abc"))
        XCTAssertEqual(FastPath.gate(text: "暂停", tasks: [tasks[0]]), .send("暂停"))
        let command = FastPath.explicitCommand(action: "pause", taskId: "ABCDEF12-0000-0000-0000-000000000001")
        XCTAssertEqual(command, "暂停 abcdef12")
        guard case .control(.pause, let ref) = FastPath.parse(command) else {
            return XCTFail("明确指令应能再次解析")
        }
        XCTAssertEqual(ref, "abcdef12")
        XCTAssertEqual(FastPath.gate(text: command, tasks: tasks), .send(command))
        XCTAssertEqual(FastPath.explicitCommand(action: "status", taskId: tasks[0].id), "选择 abcdef12")
    }

    func testAcceptedActionIsNotShownAsPaused() {
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "accepted", receiptsEnabled: true), "请求已收到")
        XCTAssertNotEqual(ActionDisplay.label(action: "pause", receiptStatus: "accepted", receiptsEnabled: true), "已暂停")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "completed", receiptsEnabled: true), "已暂停")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: nil, receiptsEnabled: true), "请求已收到")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "completed", receiptsEnabled: false), "请求已收到")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "delivered", receiptsEnabled: true), "正在暂停")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "applying", receiptsEnabled: true), "正在暂停")
        XCTAssertEqual(ActionDisplay.label(action: "resume", receiptStatus: "delivered", receiptsEnabled: true), "等待电脑处理")
        XCTAssertEqual(ActionDisplay.label(action: "pause", receiptStatus: "result_unknown", receiptsEnabled: true), "结果待核对")
        XCTAssertEqual(ActionDisplay.label(action: "cancel", receiptStatus: "completed", receiptsEnabled: true), "已取消")
    }

    func testProcessingLabelsDistinguishOfflineAndQueue() {
        let offline = InteractionCopy.processingLabel(status: "queued", reason: "waiting_device_offline", historical: nil)
        let previous = InteractionCopy.processingLabel(status: "queued", reason: "waiting_previous_message", historical: nil)
        XCTAssertEqual(offline, "主助理电脑离线，消息已保存")
        XCTAssertEqual(previous, "主助理正在处理上一条消息")
        XCTAssertNotEqual(offline, previous)
        XCTAssertEqual(InteractionCopy.processingLabel(status: "unknown", reason: nil, historical: "unknown"), "历史处理状态未知")
        XCTAssertEqual(InteractionCopy.processingLabel(status: nil, reason: nil, historical: nil), "历史处理状态未知")
        XCTAssertEqual(InteractionCopy.processingLabel(status: "interrupted", reason: nil, historical: nil), "处理结果待核对")
    }

    func testStageUsesKnownFactsOnly() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let dispatched = StageProjection.present(StageFacts(runState: "dispatched", serverConnected: true, deviceOnline: true, now: now, taskProgressEnabled: true))
        XCTAssertEqual(dispatched.title, "等待电脑接受")
        XCTAssertFalse(dispatched.title.contains("已执行"))
        XCTAssertNil(dispatched.countText)
        XCTAssertFalse(dispatched.title.contains("%"))
        let counted = StageProjection.present(StageFacts(
            runState: "running",
            completedCount: 2,
            totalCount: 5,
            taskStatus: "running",
            lastProgressAt: now,
            serverConnected: true,
            deviceOnline: true,
            now: now,
            taskProgressEnabled: true
        ))
        XCTAssertEqual(counted.countText, "2/5")
        let checking = StageProjection.present(StageFacts(
            runState: "running",
            taskStatus: "running",
            lastProgressAt: now.addingTimeInterval(-16),
            serverConnected: true,
            deviceOnline: false,
            now: now,
            taskProgressEnabled: true
        ))
        XCTAssertTrue(checking.showCheck)
        XCTAssertFalse(checking.emphasize)
        let stale = StageProjection.present(StageFacts(
            runState: "running",
            progressPhase: "executing",
            taskStatus: "running",
            lastProgressAt: now.addingTimeInterval(-61),
            serverConnected: true,
            deviceOnline: false,
            now: now,
            taskProgressEnabled: true
        ))
        XCTAssertTrue(stale.emphasize)
        XCTAssertTrue(stale.detail.contains("与服务端"))
        XCTAssertTrue(stale.detail.contains("执行电脑"))
        XCTAssertFalse(stale.detail.contains("失败"))
        let legacy = StageProjection.present(StageFacts(runState: "starting", serverConnected: true, now: now, taskProgressEnabled: false))
        XCTAssertEqual(legacy.title, "正在启动")
        XCTAssertFalse(legacy.title.contains("电脑已接收"))
        let received = StageProjection.present(StageFacts(runState: "starting", serverConnected: true, now: now, taskProgressEnabled: true))
        XCTAssertEqual(received.title, "电脑已接收")
    }

    func testReconnectBannerWaitsAndStopsForLogin() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertNil(ConnectionPresentation.banner(downSince: now.addingTimeInterval(-4), now: now, unauthorized: false))
        XCTAssertEqual(ConnectionPresentation.banner(downSince: now.addingTimeInterval(-5), now: now, unauthorized: false), "与服务端的连接已中断，正在重连")
        XCTAssertEqual(ConnectionPresentation.banner(downSince: nil, now: now, unauthorized: true), "登录已失效，请重新登录")
        XCTAssertNil(ConnectionPresentation.banner(downSince: nil, now: now, unauthorized: false))
    }

    func testInteractionStoreIsolatesServerAndUser() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("super-agent-interaction-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = InteractionFileStore(root: root)
        let first = InteractionScope(server: "https://one.example", userId: "user-a")
        let second = InteractionScope(server: "https://two.example", userId: "user-a")
        let otherUser = InteractionScope(server: "https://one.example", userId: "user-b")
        XCTAssertNotEqual(first.storageKey, second.storageKey)
        XCTAssertNotEqual(first.storageKey, otherUser.storageKey)
        let prepared = outbound("client-1", text: "只属于第一个范围", phase: .held)
        try store.saveMessages(first, [prepared])
        var journal = ProjectionJournal(projectedCursor: "10", receivedCursor: "10", dirty: [DirtyProjection(seq: "10", type: "task.changed")])
        try store.saveProjection(first, journal)
        XCTAssertEqual(store.loadMessages(first).map(\.clientMessageId), ["client-1"])
        XCTAssertEqual(store.loadMessages(first).first?.idempotencyKey, "client-1")
        XCTAssertTrue(store.loadMessages(second).isEmpty)
        XCTAssertTrue(store.loadMessages(otherUser).isEmpty)
        XCTAssertEqual(store.loadProjection(first).projectedCursor, "10")
        XCTAssertEqual(store.loadProjection(second).projectedCursor, "0")
        journal.projectedCursor = "11"
        try store.saveProjection(second, journal)
        XCTAssertEqual(store.loadProjection(first).projectedCursor, "10")
        XCTAssertEqual(store.loadProjection(second).projectedCursor, "11")
    }

    func testMissingCapabilityFieldsStayLegacy() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let decoded = try decoder.decode(InteractionCapabilities.self, from: Data("{\"message_processing\":true}".utf8))
        XCTAssertTrue(decoded.messageProcessing)
        XCTAssertFalse(decoded.actionReceipts)
        XCTAssertFalse(decoded.workspaceSnapshot)
        XCTAssertFalse(decoded.chatFastPath)
        XCTAssertFalse(decoded.taskProgress)
        XCTAssertEqual(InteractionCapabilities.legacy, InteractionCapabilities(messageProcessing: false, actionReceipts: false, workspaceSnapshot: false, chatFastPath: false, taskProgress: false))
    }
}
