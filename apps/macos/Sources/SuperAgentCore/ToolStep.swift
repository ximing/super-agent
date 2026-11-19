import Foundation

/// Intentionally contains no raw arguments, tool results, model text, URLs or paths.
public struct ToolStep: Decodable, Identifiable, Sendable {
    public let id: String
    public let runId: String
    public let tool: String
    public let status: String
    public let startedAt: String?
    public let completedAt: String?
    public let createdAt: String
    public let errorCode: String?
    public let version: Int
    public var displayTitle: String { Self.titles[tool] ?? "其他工具" }
    public var statusTitle: String { ["running":"执行中", "succeeded":"已完成", "failed":"失败", "cancelled":"已取消", "result_unknown":"结果待核对"][status] ?? "状态待确认" }
    public var errorMessage: String? {
        guard let errorCode else { return nil }
        return ["tool_failed":"工具未完成，请查看任务状态", "invalid_arguments":"工具输入未通过校验", "not_authorized":"当前任务未获授权", "cancelled":"此步骤已取消", "result_unknown":"执行结果尚未确认，请先核对业务回执"][errorCode] ?? "工具结果需要进一步确认"
    }
    public var startDate: Date? { Self.date(startedAt ?? createdAt) }
    public var completionDate: Date? { completedAt.flatMap(Self.date) }
    public static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    private static let titles = [
        "browser_navigate":"打开网页", "browser_snapshot":"读取网页", "browser_click":"点击页面", "browser_fill":"填写页面", "browser_keys":"发送页面按键", "browser_screenshot":"截取网页",
        "memory_search":"检索记忆", "memory_read":"读取记忆", "memory_propose":"整理候选记忆", "files_list":"列出工作文件", "files_read":"读取工作文件", "files_write":"写入工作文件",
        "artifacts_list":"查看任务附件", "artifacts_download":"下载任务附件", "artifacts_upload":"上传交付物", "question_ask":"请求你的判断", "shell_run":"执行本机命令",
        "tasks_list":"查看任务列表", "devices_list":"查看执行电脑", "task_start":"准备任务计划", "task_status":"读取任务状态"
    ]
}
