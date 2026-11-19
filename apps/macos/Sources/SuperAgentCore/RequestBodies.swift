import Foundation

public struct MemoryScopeDraft: Equatable, Sendable {
    public var project: String
    public var sites: String
    public var globalPreference: Bool
    public var statuses: String
    public var maxVersion: String
    public init(project: String = "", sites: String = "", globalPreference: Bool = false, statuses: String = "verified", maxVersion: String = "") {
        self.project = project
        self.sites = sites
        self.globalPreference = globalPreference
        self.statuses = statuses
        self.maxVersion = maxVersion
    }
}

public struct BudgetLimitSpec: Sendable, Equatable {
    public let reason: String
    public let key: String
    public let label: String
    public let ceiling: Int
    public let recovery: String
    public let placeholder: String

    public init(reason: String, key: String, label: String, ceiling: Int, recovery: String, placeholder: String) {
        self.reason = reason
        self.key = key
        self.label = label
        self.ceiling = ceiling
        self.recovery = recovery
        self.placeholder = placeholder
    }

    public init?(reasonCode: String) {
        guard let match = BudgetCatalog.stops.first(where: { $0.reason == reasonCode }) else { return nil }
        self = match
    }

    public func currentText(_ budget: RuntimeBudgetOverride?) -> String {
        let shown = budget?.stored(key).map(String.init) ?? "未设置（沿用账号活动默认）"
        let unit = key == "max_runtime_ms" ? " 毫秒（8 小时）" : ""
        return "当前任务覆盖：\(shown) · 产品上限 \(ceiling)\(unit)"
    }
}

public enum BudgetCatalog {
    public struct Category: Sendable { public let id: String; public let label: String }
    public struct Limit: Sendable { public let key: String; public let label: String; public let ceiling: Int }
    public static let categories: [Category] = [
        Category(id: "worker", label: "执行"),
        Category(id: "assistant", label: "助理"),
        Category(id: "review", label: "验收"),
        Category(id: "proactive", label: "主动规划"),
    ]
    public static let limits: [Limit] = [
        Limit(key: "max_total_tokens", label: "Token", ceiling: 5_000_000),
        Limit(key: "max_model_calls", label: "模型调用", ceiling: 2_000),
        Limit(key: "max_tool_steps", label: "工具步骤", ceiling: 5_000),
        Limit(key: "max_runtime_ms", label: "单次时长（毫秒）", ceiling: 28_800_000),
    ]
    public static let stops: [BudgetLimitSpec] = [
        BudgetLimitSpec(reason: "token_limit", key: "max_total_tokens", label: "Token", ceiling: 5_000_000, recovery: "这个任务的 Token 已用到当前上限。提高对应活动的 Token 上限后可以继续。", placeholder: "新的 Token 上限"),
        BudgetLimitSpec(reason: "model_call_limit", key: "max_model_calls", label: "模型调用次数", ceiling: 2_000, recovery: "这个任务的模型调用次数已用到当前上限。提高上限后可以继续。", placeholder: "新的模型调用次数"),
        BudgetLimitSpec(reason: "tool_step_limit", key: "max_tool_steps", label: "工具步骤", ceiling: 5_000, recovery: "这个任务的工具步骤已用到当前上限。提高上限后可以继续。", placeholder: "新的工具步骤上限"),
        BudgetLimitSpec(reason: "time_limit", key: "max_runtime_ms", label: "单次时长（毫秒）", ceiling: 28_800_000, recovery: "这一次活动的运行时间已到上限。提高单次时长后可以再开始一次。", placeholder: "新的单次时长（毫秒）"),
    ]
}

public enum RequestBodies {
    public static func taskBudgetMerge(reason: String, value: Int) throws -> [String: JSONValue] {
        guard let spec = BudgetLimitSpec(reasonCode: reason) else {
            throw APIError(status: 0, code: "invalid_budget", message: "这个状态不能通过提高用量上限继续")
        }
        guard value >= 1, value <= spec.ceiling else {
            throw APIError(status: 0, code: "invalid_budget", message: "\(spec.label)需为 1–\(spec.ceiling) 的整数")
        }
        return ["mode": .string("merge"), "limits": .object([spec.key: .number(Double(value))])]
    }

    public static func memoryScope(_ draft: MemoryScopeDraft) throws -> JSONValue {
        let project = draft.project.trimmingCharacters(in: .whitespacesAndNewlines)
        let maxRaw = draft.maxVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        let maxVersion: JSONValue
        if maxRaw.isEmpty { maxVersion = .null }
        else if let parsed = Int(maxRaw), parsed >= 1 { maxVersion = .number(Double(parsed)) }
        else { throw APIError(status: 0, code: "invalid_memory_scope", message: "记忆最大版本需为大于 0 的整数") }
        let statuses = splitList(draft.statuses)
        return .object([
            "project": project.isEmpty ? .null : .string(project),
            "sites": .array(splitList(draft.sites).map { .string($0) }),
            "global_preference": .bool(draft.globalPreference),
            "statuses": .array((statuses.isEmpty ? ["verified"] : statuses).map { .string($0) }),
            "max_version": maxVersion,
        ])
    }

    /// Page rules keep the URL host inside `sites`. An empty project is null, not omitted.
    public static func observationRule(title: String, goal: String, deviceId: String, engine: String, sites: String, project: String, cooldownMinutes: Int, source: String, taskId: String = "", match: String = "", value: String = "", url: String = "", condition: String = "") throws -> [String: JSONValue] {
        let hosts = sites.split { $0 == "," || $0 == " " || $0 == "，" }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
        guard !hosts.isEmpty else { throw APIError(status: 0, code: "invalid_observation", message: "观察规则至少需要一个网站") }
        var body: [String: JSONValue] = [
            "title": .string(title), "goal": .string(goal), "device_id": .string(deviceId), "engine": .string(engine),
            "sites": .array(hosts.map { .string($0) }), "project": project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string(project.trimmingCharacters(in: .whitespacesAndNewlines)),
            "cooldown_minutes": .number(Double(cooldownMinutes)), "source": .string(source),
        ]
        if source == "page" {
            guard let parsed = URL(string: url), parsed.scheme == "https", let host = parsed.host?.lowercased(), hosts.contains(host) else {
                throw APIError(status: 0, code: "invalid_observation", message: "网页地址必须是授权网站上的 https 地址")
            }
            body["url"] = .string(url)
            body["condition"] = .string(condition)
        } else {
            body["task_id"] = .string(taskId)
            body["match"] = .string(match)
            body["value"] = .string(value)
        }
        return body
    }

    /// Always includes `project`. Empty text is null so a visible edit cannot omit the field.
    public static func memoryBinding(url: String, token: String, project: String) -> [String: JSONValue] {
        let trimmed = project.trimmingCharacters(in: .whitespacesAndNewlines)
        return [
            "url": .string(url),
            "token": .string(token),
            "project": trimmed.isEmpty ? .null : .string(trimmed),
        ]
    }

    public static func memorySettingsConflictMessage(status: Int, code: String) -> String? {
        guard code == "version_conflict", status == 412 else { return nil }
        return "记忆连接已变化，请刷新后重试。"
    }

    public static func executionSettings(engine: String, device: String, assistant: String, memoryGlobalRead: Bool) -> [String: JSONValue] {
        [
            "default_engine": .string(engine),
            "default_device_id": device.isEmpty ? .null : .string(device),
            "assistant_device_id": assistant.isEmpty ? .null : .string(assistant),
            "memory_global_read": .bool(memoryGlobalRead),
        ]
    }

    public static func moneyBudgetMerge(monthly: String, task: String) -> [String: JSONValue] {
        [
            "mode": .string("merge"),
            "monthly_limit_usd": monthly.isEmpty ? .null : .string(monthly),
            "task_limit_usd": task.isEmpty ? .null : .string(task),
        ]
    }

    /// Omits monthly and task USD. Empty draft cells are omitted so merge keeps them.
    public static func categoryLimitsMerge(_ categories: [String: [String: Int]]) -> [String: JSONValue] {
        var encoded: [String: JSONValue] = [:]
        for (category, limits) in categories {
            var row: [String: JSONValue] = [:]
            for (key, value) in limits { row[key] = .number(Double(value)) }
            if !row.isEmpty { encoded[category] = .object(row) }
        }
        return ["mode": .string("merge"), "category_limits": .object(encoded)]
    }

    public static func categoryLimits(fromDraft draft: [String: [String: String]]) throws -> [String: JSONValue] {
        var parsed: [String: [String: Int]] = [:]
        for category in BudgetCatalog.categories {
            var limits: [String: Int] = [:]
            for limit in BudgetCatalog.limits {
                let raw = draft[category.id]?[limit.key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if raw.isEmpty { continue }
                guard let value = Int(raw), value >= 1, value <= limit.ceiling else {
                    throw APIError(status: 0, code: "invalid_budget", message: "\(category.label)的\(limit.label)需为 1–\(limit.ceiling) 的整数")
                }
                limits[limit.key] = value
            }
            if !limits.isEmpty { parsed[category.id] = limits }
        }
        if parsed.isEmpty { throw APIError(status: 0, code: "invalid_budget", message: "请填写要保存的活动上限") }
        return categoryLimitsMerge(parsed)
    }

    public static func memoryRelation(relation: String, otherId: String, validUntil: String, governanceVersion: Int, operationKey: String) throws -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "relation": .string(relation),
            "operation_key": .string(operationKey),
            "governance_version": .number(Double(governanceVersion)),
        ]
        switch relation {
        case "conflicts", "supersedes":
            let other = otherId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !other.isEmpty else { throw APIError(status: 0, code: "invalid_memory_relation", message: "请填写另一条记忆的标识") }
            body["other_id"] = .string(other)
        case "expires":
            body["valid_until"] = .string(try normalizeValidUntil(validUntil))
        default:
            throw APIError(status: 0, code: "invalid_memory_relation", message: "记忆关系无效")
        }
        return body
    }

    public static func relationConflictMessage(status: Int, code: String) -> String? {
        guard code == "version_conflict", status == 409 || status == 412 else { return nil }
        return "记忆关系已变化，请刷新后重试。不会用旧版本重复提交。"
    }

    public static func splitList(_ value: String) -> [String] {
        value.split { $0 == "," || $0 == "，" || $0.isWhitespace }.map(String.init).filter { !$0.isEmpty }
    }

    public static func normalizeValidUntil(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let dated = trimmed.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? "\(trimmed)T00:00:00Z" : trimmed
        guard dated.range(of: #"^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil else {
            throw APIError(status: 0, code: "invalid_memory_relation", message: "有效期需要带时区的 ISO 时间，例如 2026-12-01T00:00:00+08:00")
        }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        guard let date = parser.date(from: dated) else {
            throw APIError(status: 0, code: "invalid_memory_relation", message: "有效期需要带时区的 ISO 时间，例如 2026-12-01T00:00:00+08:00")
        }
        return parser.string(from: date)
    }
}
