import XCTest
@testable import SuperAgentCore

final class RequestBodiesTests: XCTestCase {
    func testBudgetMergeSendsOnlyTheStoppingDimension() throws {
        let cases: [(String, String, Int)] = [
            ("token_limit", "max_total_tokens", 100),
            ("model_call_limit", "max_model_calls", 80),
            ("tool_step_limit", "max_tool_steps", 40),
            ("time_limit", "max_runtime_ms", 3_600_000),
        ]
        let allKeys = ["max_total_tokens", "max_model_calls", "max_tool_steps", "max_runtime_ms"]
        for (reason, key, value) in cases {
            let body = try RequestBodies.taskBudgetMerge(reason: reason, value: value)
            let object = try jsonObject(body)
            XCTAssertEqual(object["mode"] as? String, "merge")
            let limits = try XCTUnwrap(object["limits"] as? [String: Any])
            XCTAssertEqual(limits.count, 1)
            XCTAssertEqual((limits[key] as? NSNumber)?.intValue, value)
            for other in allKeys where other != key {
                XCTAssertNil(limits[other])
            }
            XCTAssertNil(object["monthly_limit_usd"])
            XCTAssertNil(object["task_limit_usd"])
        }
    }

    func testEmptyMemoryScopeIsExplicit() throws {
        let value = try RequestBodies.memoryScope(MemoryScopeDraft(project: "  ", sites: "  ， ", globalPreference: false, statuses: "", maxVersion: ""))
        let data = try JSONEncoder().encode(value)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(object["project"] is NSNull)
        XCTAssertEqual(object["sites"] as? [String], [])
        XCTAssertEqual(object["global_preference"] as? Bool, false)
        XCTAssertEqual(object["statuses"] as? [String], ["verified"])
        XCTAssertTrue(object["max_version"] is NSNull)
        XCTAssertNotNil(object["sites"])
        XCTAssertNotNil(object["global_preference"])
    }

    func testMemoryBindingKeepsChangesOrClearsProjectWithoutOmittingIt() throws {
        let rule = try RequestBodies.observationRule(title: "验收后", goal: "整理差异", deviceId: "device-1", engine: "grok", sites: "A.Example", project: "alpha", cooldownMinutes: 30, source: "task_result", taskId: "task-1", match: "status", value: "awaiting_review")
        XCTAssertEqual(rule["project"], .string("alpha"))
        XCTAssertEqual(rule["sites"], .array([.string("a.example")]))
        XCTAssertThrowsError(try RequestBodies.observationRule(title: "越权", goal: "看别的站", deviceId: "device-1", engine: "grok", sites: "a.example", project: "", cooldownMinutes: 15, source: "page", url: "https://b.example/item", condition: "变化"))
        let kept = RequestBodies.memoryBinding(url: "https://recall.example", token: "updated-token", project: "alpha")
        let keptObject = try jsonObject(kept)
        XCTAssertEqual(keptObject["url"] as? String, "https://recall.example")
        XCTAssertEqual(keptObject["token"] as? String, "updated-token")
        XCTAssertEqual(keptObject["project"] as? String, "alpha")
        XCTAssertTrue(keptObject.keys.contains("project"))
        XCTAssertTrue(keptObject.keys.contains("token"))

        let cleared = RequestBodies.memoryBinding(url: "https://recall.example", token: "updated-token", project: "  ")
        let clearedData = try JSONEncoder().encode(cleared)
        let clearedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: clearedData) as? [String: Any])
        XCTAssertTrue(clearedObject["project"] is NSNull)
        XCTAssertTrue(clearedObject.keys.contains("project"))
        XCTAssertEqual(clearedObject["token"] as? String, "updated-token")
        let clearedText = String(decoding: clearedData, as: UTF8.self)
        XCTAssertTrue(clearedText.contains("\"project\""))
        XCTAssertFalse(clearedText.contains("\"project\":\""))

        let changed = RequestBodies.memoryBinding(url: "https://recall.example", token: "updated-token", project: " beta ")
        let changedObject = try jsonObject(changed)
        XCTAssertEqual(changedObject["project"] as? String, "beta")
        XCTAssertEqual(changedObject["token"] as? String, "updated-token")
        XCTAssertTrue(changedObject.keys.contains("project"))
        XCTAssertEqual(RequestBodies.memorySettingsConflictMessage(status: 412, code: "version_conflict"), "记忆连接已变化，请刷新后重试。")
        XCTAssertNil(RequestBodies.memorySettingsConflictMessage(status: 409, code: "version_conflict"))
    }

    func testCategoryMergeOmitsMoneyFields() throws {
        let body = RequestBodies.categoryLimitsMerge(["worker": ["max_model_calls": 20]])
        let object = try jsonObject(body)
        XCTAssertEqual(object["mode"] as? String, "merge")
        XCTAssertNil(object["monthly_limit_usd"])
        XCTAssertNil(object["task_limit_usd"])
        let text = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        XCTAssertFalse(text.contains("monthly_limit_usd"))
        XCTAssertFalse(text.contains("task_limit_usd"))
        let categories = try XCTUnwrap(object["category_limits"] as? [String: Any])
        let worker = try XCTUnwrap(categories["worker"] as? [String: Any])
        XCTAssertEqual((worker["max_model_calls"] as? NSNumber)?.intValue, 20)
    }

    func testTurningGlobalReadOffSendsFalse() {
        let body = RequestBodies.executionSettings(engine: "codex", device: "", assistant: "mac", memoryGlobalRead: false)
        XCTAssertEqual(body["memory_global_read"], .bool(false))
        XCTAssertEqual(body["default_device_id"], .null)
        XCTAssertEqual(body["assistant_device_id"], .string("mac"))
    }

    func testMissingFieldsStillDecode() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let task = try decoder.decode(AgentTask.self, from: Data(#"{"id":"t","title":"t","goal":"g","status":"queued","reason_code":null,"engine":"codex","model_id":null,"device_id":null,"current_run_id":null,"created_at":"2026-11-19T00:00:00Z","updated_at":"2026-11-19T00:00:00Z","version":1}"#.utf8))
        XCTAssertNil(task.budget)
        XCTAssertNil(task.memoryScope)
        let settings = try decoder.decode(ExecutionSettings.self, from: Data(#"{"default_engine":"grok","default_device_id":null,"assistant_device_id":null,"version":1}"#.utf8))
        XCTAssertNil(settings.memoryGlobalRead)
        let legacyMemory = try decoder.decode(MemorySettings.self, from: Data(#"{"configured":true,"url":"https://memory.example/recall","version":1}"#.utf8))
        XCTAssertNil(legacyMemory.project)
        XCTAssertEqual(legacyMemory.url, "https://memory.example/recall")
        let savedMemory = try decoder.decode(MemorySettings.self, from: Data(#"{"provider":"agent-recall","configured":true,"url":"https://memory.example/recall","project":"alpha","account":null,"version":2}"#.utf8))
        XCTAssertEqual(savedMemory.project, "alpha")
        let clearedMemory = try decoder.decode(MemorySettings.self, from: Data(#"{"configured":false,"url":null,"project":null,"version":0}"#.utf8))
        XCTAssertNil(clearedMemory.project)
        XCTAssertNil(clearedMemory.url)
        let summary = try decoder.decode(CostSummary.self, from: Data(#"{"totals":[],"input_tokens":0,"output_tokens":0,"unknown_count":1,"request_count":1,"coverage":0,"as_of":"2026-11-19T00:00:00Z","reserved_hold_usd":null,"reserved_unknown_count":null}"#.utf8))
        XCTAssertNil(summary.reservedHoldUsd)
        XCTAssertNil(summary.reservedUnknownCount)
        XCTAssertEqual(summary.unknownCount, 1)
        let budget = try decoder.decode(Budget.self, from: Data(#"{"monthly_limit_usd":null,"task_limit_usd":null,"used_usd":"0","version":2}"#.utf8))
        XCTAssertNil(budget.categoryLimits)
        XCTAssertNil(budget.reservedHoldUsd)
        let memory = try decoder.decode(Memory.self, from: Data(#"{"id":"m","title":"t","content":"c","type":"preference","status":"verified","version":1,"updated_at":"2026-11-19T00:00:00Z","governance":{"verification":"verified","claim":"observed","valid_until":null}}"#.utf8))
        XCTAssertNil(memory.governance?.version)
        XCTAssertNil(memory.governance?.conflictsWith)
        XCTAssertNil(memory.governance?.supersedes)
        XCTAssertNil(memory.source)
    }

    private func jsonObject(_ value: [String: JSONValue]) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
