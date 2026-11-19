import Foundation

public enum Engine: String, Codable, CaseIterable, Sendable { case codex, grok }
public struct Items<T: Decodable & Sendable>: Decodable, Sendable { public let items: [T] }
public struct User: Codable, Sendable { public let id: String; public let email: String; public let name: String; public let tenantId: String }
public struct Session: Codable, Sendable { public let accessToken: String; public let refreshToken: String; public let expiresIn: Int; public let user: User }
public struct AuthConfig: Decodable, Sendable {
    public let mode: String
    public let issuer: String?
    public let clientId: String?
    public let authorizationEndpoint: String?
    public let tokenEndpoint: String?
    public let redirectUri: String?
}
public struct EngineCapability: Codable, Sendable {
    public let engine: Engine
    public let ready: Bool
    public let models: [String]
    public let localProfileId: String?
    public let reason: String?
}
public struct Slots: Codable, Sendable { public let browser: Int; public let worker: Int }
public struct Capabilities: Codable, Sendable { public let generation: Int; public let engines: [EngineCapability]; public let tools: [String]; public let slots: Slots }
public struct Device: Codable, Identifiable, Sendable {
    public let id: String; public let name: String; public let status: String
    public let lastSeenAt: String?; public let capabilities: Capabilities; public let version: Int; public let revoked: Bool?
    public func supports(_ engine: Engine) -> Bool { revoked != true && capabilities.engines.contains { $0.engine == engine && $0.ready } }
}
public struct ExecutionSettings: Codable, Sendable {
    public let defaultEngine: Engine; public let defaultDeviceId: String?; public let assistantDeviceId: String?; public let version: Int
}
public struct AgentTask: Codable, Identifiable, Sendable {
    public let id: String; public let title: String; public let goal: String; public let status: String
    public let reasonCode: String?; public let engine: Engine; public let modelId: String?; public let deviceId: String?
    public let deviceName: String?; public let currentRunId: String?; public let createdAt: String; public let updatedAt: String; public let version: Int
}
public struct Run: Codable, Identifiable, Sendable {
    public let id: String; public let taskId: String; public let state: String; public let engine: Engine
    public let deviceId: String; public let modelId: String; public let leaseEpoch: String; public let summary: String; public let resultText: String?; public let createdAt: String
}
public struct Message: Codable, Identifiable, Sendable { public let id: String; public let role: String; public let content: String; public let taskId: String?; public let createdAt: String }
public struct Question: Codable, Identifiable, Sendable { public let id: String; public let taskId: String; public let runId: String; public let text: String; public let options: [String]; public let status: String; public let version: Int; public let createdAt: String }
public struct Memory: Codable, Identifiable, Sendable { public let id: String; public let title: String; public let content: String; public let type: String; public let site: String?; public let status: String; public let version: Int; public let updatedAt: String }
public struct CostTotal: Codable, Sendable { public let currency: String; public let amount: String; public let source: String }
public struct CostSummary: Codable, Sendable {
    public let totals: [CostTotal]; public let inputTokens: Int; public let outputTokens: Int; public let unknownCount: Int
    public let requestCount: Int; public let coverage: Double; public let asOf: String
}
public struct CostPoint: Codable, Sendable { public let date: String; public let currency: String; public let amount: String; public let source: String; public let inputTokens: Int; public let outputTokens: Int }
public struct CostBreakdown: Codable, Sendable { public let key: String; public let label: String; public let currency: String; public let amount: String; public let requestCount: Int; public let unknownCount: Int }
public struct Budget: Codable, Sendable { public let monthlyLimitUsd: String?; public let taskLimitUsd: String?; public let usedUsd: String; public let version: Int }
public struct Frame: Codable, Sendable {
    public let frameId: String; public let imageBase64: String; public let width: Int; public let height: Int
    public let capturedAt: String; public let viewportVersion: String; public let tabId: String?
}
public struct ServerEvent: Codable, Sendable { public let eventId: String; public let streamSeq: String; public let type: String; public let occurredAt: String }
public struct EventBatch: Decodable, Sendable { public let items: [ServerEvent]; public let cursor: String }
public struct EmptyResponse: Decodable, Sendable { public init() {} }
public struct ViewSession: Decodable, Sendable { public let id: String; public let state: String?; public let pollUrl: String? }
public struct MemorySettings: Decodable, Sendable { public let configured: Bool; public let url: String?; public let version: Int? }
public struct Schedule: Codable, Identifiable, Sendable {
    public let id: String; public let title: String; public let goal: String; public let engine: Engine; public let deviceId: String; public let intervalMinutes: Int; public let enabled: Bool; public let nextDueAt: String?; public let version: Int
}
public struct Artifact: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let mime: String; public let taskId: String?; public let runId: String?; public let status: String?; public let createdAt: String? }
public struct UploadDescriptor: Decodable, Sendable { public let artifactId: String; public let uploadUrl: String; public let uploadHeaders: [String: String]; public let expiresAt: String; public let maxSize: Int }
public struct DownloadDescriptor: Decodable, Sendable { public let url: String; public let expiresAt: String; public let name: String; public let mime: String }

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}
public enum AgentStatus {
    public static func title(_ value: String) -> String {
        ["queued":"排队中", "running":"正在执行", "waiting_input":"待你回答", "waiting_device":"等待电脑", "awaiting_approval":"待你确认", "pausing":"正在暂停", "paused":"已暂停", "switching":"正在切换", "awaiting_review":"待验收", "succeeded":"已完成", "failed":"失败", "cancelled":"已取消", "online":"在线", "offline":"离线", "busy":"忙碌", "result_unknown":"结果待核对", "starting":"正在启动", "dispatched":"已派发", "lost":"失联待核对", "stopping":"正在停止", "verified":"已验证", "candidate":"待验证", "stale":"待复核"][value] ?? value
    }
}
