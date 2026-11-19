import AppKit
import SwiftUI
import SuperAgentCore

struct DemoLaunch {
    let isEnabled: Bool
    let section: WorkspaceSection
    let reviewTaskID: String?
    let screenshotPath: String?
    let minimumSize: Bool

    static let reviewID = "00000000-0000-4000-8000-000000000002"
    static var current: DemoLaunch {
        let arguments = CommandLine.arguments
        let screenshot = arguments.firstIndex(of: "--demo-screenshot").flatMap { index in
            arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        }
        let view = arguments.firstIndex(of: "--demo-view").flatMap { index in
            arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        } ?? "assistant"
        let sections: [String: WorkspaceSection] = [
            "assistant": .conversation, "tasks": .tasks, "review": .tasks,
            "questions": .questions, "devices": .devices, "memories": .memories,
            "schedules": .schedules, "costs": .costs
        ]
        return DemoLaunch(
            isEnabled: screenshot != nil || arguments.contains("--demo-workbench"),
            section: sections[view] ?? .conversation,
            reviewTaskID: view == "review" ? reviewID : nil,
            screenshotPath: screenshot,
            minimumSize: arguments.contains("--demo-minimum")
        )
    }
}

extension WorkspaceModel {
    func installDemoWorkspace() {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            session = try decoder.decode(Session.self, from: Data(DemoFixtures.session.utf8))
            devices = try decoder.decode([Device].self, from: Data(DemoFixtures.devices.utf8))
            tasks = try decoder.decode([AgentTask].self, from: Data(DemoFixtures.tasks.utf8))
            messages = try decoder.decode([Message].self, from: Data(DemoFixtures.messages.utf8))
            questions = try decoder.decode([Question].self, from: Data(DemoFixtures.questions.utf8))
            settings = try decoder.decode(ExecutionSettings.self, from: Data(DemoFixtures.settings.utf8))
            memorySettings = try decoder.decode(MemorySettings.self, from: Data(DemoFixtures.memorySettings.utf8))
            memories = try decoder.decode([Memory].self, from: Data(DemoFixtures.memories.utf8))
            demoRuns = try decoder.decode([Run].self, from: Data(DemoFixtures.runs.utf8))
            demoTaskMessages = try decoder.decode([Message].self, from: Data(DemoFixtures.taskMessages.utf8))
            demoSteps = try decoder.decode([ToolStep].self, from: Data(DemoFixtures.steps.utf8))
            demoArtifacts = try decoder.decode([Artifact].self, from: Data(DemoFixtures.artifacts.utf8))
            let evidence = try decoder.decode(TaskEvidence.self, from: Data(DemoFixtures.evidence.utf8))
            demoEvidence = [DemoLaunch.reviewID: evidence]
            selectedEngine = .grok
            selectedDevice = "10000000-0000-4000-8000-000000000001"
            selectedModelId = ""
            lastSync = Date()
            error = nil
            markAsDemo()
        } catch {
            assertionFailure("Invalid isolated demo fixture: \(error)")
        }
    }
}

enum DemoScreenshot {
    static func captureAfterDelay(path: String?, demo: Bool) {
        guard let path else { NSApp.terminate(nil); return }
        let launch = DemoLaunch.current
        DispatchQueue.main.async {
            if let window = NSApp.windows.first {
                let size = demo && launch.minimumSize ? NSSize(width: 1040, height: 680) : NSSize(width: 1260, height: 840)
                window.setContentSize(size)
                window.center()
                if demo { NSApp.appearance = NSAppearance(named: .aqua) }
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) {
            guard let window = NSApp.windows.first else { exit(1) }
            let url = URL(fileURLWithPath: path)
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let image = windowImageIncludingSheets(window),
               let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
                try? data.write(to: url)
            }
            exit(0)
        }
    }

    private static func windowImageIncludingSheets(_ window: NSWindow) -> CGImage? {
        let windowID = CGWindowID(window.windowNumber)
        guard let main = CGWindowListCreateImage(.null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming, .bestResolution]) else { return nil }
        guard let sheet = window.sheets.first,
              let sheetImage = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(sheet.windowNumber), [.boundsIgnoreFraming, .bestResolution]) else { return main }
        let scale = CGFloat(main.width) / window.frame.width
        let width = main.width
        let height = main.height
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return main }
        context.draw(main, in: CGRect(x: 0, y: 0, width: width, height: height))
        let rect = CGRect(
            x: (sheet.frame.minX - window.frame.minX) * scale,
            y: (sheet.frame.minY - window.frame.minY) * scale,
            width: CGFloat(sheetImage.width),
            height: CGFloat(sheetImage.height)
        )
        context.draw(sheetImage, in: rect)
        return context.makeImage()
    }
}

private enum DemoFixtures {
    static let session = """
    {"access_token":"isolated-demo-token","refresh_token":"isolated-demo-refresh","expires_in":3600,"user":{"id":"demo-user","email":"demo@example.invalid","name":"席铭","tenant_id":"demo-tenant"}}
    """
    static let settings = """
    {"default_engine":"grok","default_device_id":"10000000-0000-4000-8000-000000000001","assistant_device_id":"10000000-0000-4000-8000-000000000001","version":1}
    """
    static let memorySettings = """
    {"configured":true,"url":"https://memory.example/recall","version":1}
    """
    static let memories = #"""
    [
      {"id":"sources","title":"调研结论附上原始来源","type":"preference","status":"verified","version":3,"site":"","origin":"user","access_count":12,"recall_project":"Super Agent","recall_tags":["产品调研","输出习惯"],"governance":{"verification":"verified","claim":"observed","valid_until":null},"created_at":"2026-11-12T02:30:00Z","updated_at":"2026-11-19T06:18:00Z","content":"产品调研输出时，优先使用官方原始资料。让结论与来源放在一起，方便我快速核对，也方便之后回看。\n\n## 具体约定\n- 优先采用产品官网、官方文档与正式更新公告。\n- 每个关键结论紧邻原始来源，并标明资料日期。\n- 无法核实的部分明确写为“待确认”，不要混入事实结论。\n\n## 输出方式\n先写结论，再列关键变化和依据。比较功能、价格或使用限制时，保留适用条件，避免把不同套餐的能力混在一起。"},
      {"id":"performance","title":"性能分析先对齐比较口径","type":"procedure","status":"verified","version":2,"site":"","origin":"agent","access_count":8,"recall_project":"性能分析","recall_tags":["性能","数据口径"],"governance":{"verification":"verified","claim":"observed","valid_until":null},"created_at":"2026-11-15T08:20:00Z","updated_at":"2026-11-19T03:06:00Z","content":"比较两段时间的页面表现前，先对齐页面、样本范围与指标定义。\n\n## 分析步骤\n- 使用相同页面与相同分位数进行比较。\n- 对异常变化检查样本量、时间范围和发布记录。\n- 把结论、对比数据与下一步建议放在一起。\n\n一次加载变慢不直接代表长期退化。证据不足时，先标明限制，再继续收集样本。"},
      {"id":"architecture","title":"服务在云端，执行保留在 Mac","type":"project","status":"verified","version":4,"site":"","origin":"import","access_count":6,"recall_project":"Super Agent","recall_tags":["架构","执行边界"],"governance":{"verification":"verified","claim":"observed","valid_until":null},"created_at":"2026-11-10T01:00:00Z","updated_at":"2026-11-18T10:42:00Z","content":"控制服务负责鉴权、调度与持久化。模型调用、浏览器操作和执行过程保留在用户自己的 Mac 上。\n\n## 项目约定\n- 模型凭据和网站登录态留在执行电脑。\n- 云端接收任务、传递状态并保留交付证据。\n- 指定电脑离线时，任务等待其重新连接。"},
      {"id":"weekly-outline","title":"周会材料先结论，再证据","type":"preference","status":"candidate","version":1,"site":"","origin":"agent","access_count":0,"recall_project":"Super Agent","recall_tags":["周会","表达习惯"],"governance":{"verification":"candidate","claim":"inference","valid_until":null},"created_at":"2026-11-19T05:50:00Z","updated_at":"2026-11-19T05:50:00Z","content":"周会材料采用“结论、证据、下一步”的结构，让讨论先聚焦判断，再展开需要核对的细节。\n\n## 建议表达\n- 先用一段话说明本周最重要的变化。\n- 保留支撑判断的来源和关键数据。\n- 最后列出待讨论的问题和下一步行动。\n\n这是助理从反馈中归纳的偏好，需要你确认是否准确。"},
      {"id":"receipts","title":"提交后以回执核对实际结果","type":"experience","status":"candidate","version":1,"site":"","origin":"agent","access_count":0,"recall_project":"Super Agent","recall_tags":["交付","结果核对"],"governance":{"verification":"candidate","claim":"observed","valid_until":null},"created_at":"2026-11-19T02:32:00Z","updated_at":"2026-11-19T02:32:00Z","content":"完成一次提交操作后，先核对目标系统的回执与实际状态，再汇报业务结果。\n\n## 核对要点\n- 页面交互结束不等同于业务已生效。\n- 记录可核对的结果与证据。\n- 结果未知时，先核对再决定后续操作，避免重复提交。"},
      {"id":"weekly-conflict","title":"周会材料是否包含全部明细","type":"preference","status":"verified","version":2,"site":"","origin":"agent","access_count":0,"recall_project":"Super Agent","recall_tags":["周会","待澄清"],"governance":{"verification":"conflict","claim":"inference","valid_until":null},"created_at":"2026-11-13T07:20:00Z","updated_at":"2026-11-18T08:05:00Z","content":"旧记录倾向于在周会材料中直接列出全部原始明细。近期反馈则倾向于先写结论，再按需展开证据。\n\n两种表达是否适用于不同会议场景，仍需要进一步澄清。当前内容不能作为统一的汇报偏好。"},
      {"id":"old-pricing","title":"产品套餐的旧版对比口径","type":"website","status":"expired","version":1,"site":"product.example","origin":"web","access_count":3,"recall_project":"产品调研","recall_tags":["定价","需更新"],"expires_at":"2026-11-15T00:00:00Z","governance":{"verification":"expired","claim":"observed","valid_until":"2026-11-15T00:00:00Z"},"created_at":"2026-10-18T01:25:00Z","updated_at":"2026-11-01T09:10:00Z","content":"这条资料基于旧版产品页面整理，适用期已经结束。\n\n再次比较套餐价格与限制时，应重新查阅当前官方页面，不沿用此条记录作为现行依据。"}
    ]
    """#
    static let devices = """
    [
      {"id":"10000000-0000-4000-8000-000000000001","name":"Mac Studio","status":"online","last_seen_at":"2026-11-19T06:24:00Z","version":3,"revoked":false,"capabilities":{"generation":2,"engines":[{"engine":"grok","ready":true,"models":["grok-4","grok-code-fast-1"],"local_profile_id":null,"reason":null},{"engine":"codex","ready":true,"models":["gpt-5.2-codex"],"local_profile_id":null,"reason":null}],"tools":["browser","files"],"slots":{"browser":2,"worker":2}}},
      {"id":"10000000-0000-4000-8000-000000000002","name":"MacBook Pro","status":"offline","last_seen_at":"2026-11-19T04:10:00Z","version":2,"revoked":false,"capabilities":{"generation":1,"engines":[{"engine":"codex","ready":true,"models":["gpt-5.2-codex"],"local_profile_id":null,"reason":null}],"tools":["files"],"slots":{"browser":1,"worker":1}}}
    ]
    """
    static let tasks = """
    [
      {"id":"00000000-0000-4000-8000-000000000001","title":"整理本周 AI 产品动态","goal":"比较本周 AI 编程工具的功能与定价变化，产出一份适合周会讨论、附有原始来源的调研简报。","status":"running","reason_code":null,"engine":"grok","model_id":null,"device_id":"10000000-0000-4000-8000-000000000001","device_name":"Mac Studio","current_run_id":"20000000-0000-4000-8000-000000000001","parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000001","plan_id":"plan-demo","depends_on_task_ids":[],"deliverables":["覆盖主要产品的官方更新","整理功能与定价对比","形成附有来源的调研简报"],"delivery_status":"not_submitted","created_at":"2026-11-19T06:20:00Z","updated_at":"2026-11-19T06:25:00Z","version":4},
      {"id":"00000000-0000-4000-8000-000000000002","title":"上周网站性能分析","goal":"分析主要页面的性能变化，给出定位依据和优化建议。","status":"awaiting_review","reason_code":null,"engine":"codex","model_id":"gpt-5.2-codex","device_id":"10000000-0000-4000-8000-000000000002","device_name":"MacBook Pro","current_run_id":"20000000-0000-4000-8000-000000000002","parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000002","plan_id":null,"depends_on_task_ids":[],"deliverables":["覆盖两周主要页面的加载指标对比","定位退化页面并提供有数据依据的优化建议"],"delivery_status":"pending","created_at":"2026-11-18T09:00:00Z","updated_at":"2026-11-19T05:50:00Z","version":8},
      {"id":"00000000-0000-4000-8000-000000000003","title":"准备周会材料","goal":"基于产品调研结果准备周会讨论材料。","status":"blocked","reason_code":"dependency_pending","engine":"grok","model_id":null,"device_id":"10000000-0000-4000-8000-000000000001","device_name":"Mac Studio","current_run_id":null,"parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000003","plan_id":null,"depends_on_task_ids":["00000000-0000-4000-8000-000000000001"],"deliverables":["周会讨论提纲"],"delivery_status":"not_submitted","created_at":"2026-11-19T05:30:00Z","updated_at":"2026-11-19T05:30:00Z","version":1},
      {"id":"00000000-0000-4000-8000-000000000004","title":"汇总用户反馈","goal":"按确认后的统计范围汇总本周用户反馈。","status":"waiting_input","reason_code":"question_open","engine":"codex","model_id":"gpt-5.2-codex","device_id":"10000000-0000-4000-8000-000000000002","device_name":"MacBook Pro","current_run_id":"20000000-0000-4000-8000-000000000004","parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000004","plan_id":null,"depends_on_task_ids":[],"deliverables":["反馈主题汇总"],"delivery_status":"not_submitted","created_at":"2026-11-19T04:00:00Z","updated_at":"2026-11-19T05:00:00Z","version":3},
      {"id":"00000000-0000-4000-8000-000000000005","title":"整理项目知识库","goal":"整理项目资料并形成可检索的知识库。","status":"succeeded","reason_code":null,"engine":"grok","model_id":"grok-4","device_id":"10000000-0000-4000-8000-000000000001","device_name":"Mac Studio","current_run_id":"20000000-0000-4000-8000-000000000005","parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000005","plan_id":null,"depends_on_task_ids":[],"deliverables":["知识库目录与使用说明"],"delivery_status":"accepted","created_at":"2026-11-17T03:00:00Z","updated_at":"2026-11-18T08:00:00Z","version":7}
    ]
    """
    static let messages = """
    [
      {"id":"30000000-0000-4000-8000-000000000001","role":"user","content":"帮我整理本周 AI 编程工具的产品动态，重点看看功能和定价的变化。整理成一份简报，周会要用。","task_id":null,"created_at":"2026-11-19T06:20:00Z"},
      {"id":"30000000-0000-4000-8000-000000000002","role":"assistant","content":"我会先查阅官方更新，再对比功能与定价，最后整理成附有来源的简报。已按你确认的方案开始执行。","task_id":null,"created_at":"2026-11-19T06:21:00Z"}
    ]
    """
    static let questions = """
    [{"id":"40000000-0000-4000-8000-000000000001","task_id":"00000000-0000-4000-8000-000000000004","run_id":"20000000-0000-4000-8000-000000000004","text":"用户反馈统计需要包含企业内部测试反馈吗？","options":["仅正式用户","包含内测反馈"],"status":"open","version":1,"created_at":"2026-11-19T05:00:00Z"}]
    """
    static let runs = """
    [
      {"id":"20000000-0000-4000-8000-000000000001","task_id":"00000000-0000-4000-8000-000000000001","state":"running","engine":"grok","device_id":"10000000-0000-4000-8000-000000000001","model_id":"grok-4","lease_epoch":"1","summary":"正在对比产品功能与定价","result_text":null,"created_at":"2026-11-19T06:20:00Z"},
      {"id":"20000000-0000-4000-8000-000000000002","task_id":"00000000-0000-4000-8000-000000000002","state":"succeeded","engine":"codex","device_id":"10000000-0000-4000-8000-000000000002","model_id":"gpt-5.2-codex","lease_epoch":"3","summary":"执行已结束，交付待验收","result_text":"性能分析报告已生成。两周核心页面 LCP 中位数对比、退化页面定位和优化建议均已写入交付材料。","created_at":"2026-11-19T04:50:00Z"},
      {"id":"20000000-0000-4000-8000-000000000005","task_id":"00000000-0000-4000-8000-000000000005","state":"succeeded","engine":"grok","device_id":"10000000-0000-4000-8000-000000000001","model_id":"grok-4","lease_epoch":"2","summary":"交付已验收","result_text":"项目知识库已整理并验收。","created_at":"2026-11-17T03:00:00Z"}
    ]
    """
    static let taskMessages = """
    [{"id":"30000000-0000-4000-8000-000000000003","role":"user","content":"请特别标出加载指标退化的页面。","task_id":"00000000-0000-4000-8000-000000000002","created_at":"2026-11-19T04:55:00Z"}]
    """
    static let steps = """
    [
      {"id":"50000000-0000-4000-8000-000000000001","run_id":"20000000-0000-4000-8000-000000000002","tool":"browser_snapshot","title":"读取网页","status":"succeeded","started_at":"2026-11-19T05:20:00Z","completed_at":"2026-11-19T05:25:00Z","created_at":"2026-11-19T05:20:00Z","error_code":null,"version":2},
      {"id":"50000000-0000-4000-8000-000000000002","run_id":"20000000-0000-4000-8000-000000000002","tool":"files_write","title":"写入工作文件","status":"succeeded","started_at":"2026-11-19T05:30:00Z","completed_at":"2026-11-19T05:40:00Z","created_at":"2026-11-19T05:30:00Z","error_code":null,"version":2}
    ]
    """
    static let artifacts = """
    [{"id":"60000000-0000-4000-8000-000000000001","name":"网站性能分析.pdf","mime":"application/pdf","task_id":"00000000-0000-4000-8000-000000000002","run_id":"20000000-0000-4000-8000-000000000002","status":"ready","created_at":"2026-11-19T05:45:00Z"}]
    """
    static let evidence = """
    {"task":{"id":"00000000-0000-4000-8000-000000000002","title":"上周网站性能分析","goal":"分析主要页面的性能变化，给出定位依据和优化建议。","status":"awaiting_review","reason_code":null,"engine":"codex","model_id":"gpt-5.2-codex","device_id":"10000000-0000-4000-8000-000000000002","device_name":"MacBook Pro","current_run_id":"20000000-0000-4000-8000-000000000002","parent_task_id":null,"root_task_id":"00000000-0000-4000-8000-000000000002","plan_id":null,"depends_on_task_ids":[],"deliverables":["覆盖两周主要页面的加载指标对比","定位退化页面并提供有数据依据的优化建议"],"delivery_status":"pending","created_at":"2026-11-18T09:00:00Z","updated_at":"2026-11-19T05:50:00Z","version":8},"run":{"id":"20000000-0000-4000-8000-000000000002","task_id":"00000000-0000-4000-8000-000000000002","state":"succeeded","engine":"codex","device_id":"10000000-0000-4000-8000-000000000002","model_id":"gpt-5.2-codex","lease_epoch":"3","summary":"执行已结束，交付待验收","result_text":"性能分析报告已生成。两周核心页面 LCP 中位数对比、退化页面定位和优化建议均已写入交付材料。","created_at":"2026-11-19T04:50:00Z"},"delivery":{"id":"70000000-0000-4000-8000-000000000001","run_id":"20000000-0000-4000-8000-000000000002","status":"pending","deliverables":["覆盖两周主要页面的加载指标对比","定位退化页面并提供有数据依据的优化建议"],"artifact_ids":["60000000-0000-4000-8000-000000000001"],"version":1},"deliverables":["覆盖两周主要页面的加载指标对比","定位退化页面并提供有数据依据的优化建议"],"checkpoint":{"id":"80000000-0000-4000-8000-000000000001","created_at":"2026-11-19T05:45:00Z"},"steps":[{"id":"50000000-0000-4000-8000-000000000001","run_id":"20000000-0000-4000-8000-000000000002","tool":"browser_snapshot","title":"读取网页","status":"succeeded","started_at":"2026-11-19T05:20:00Z","completed_at":"2026-11-19T05:25:00Z","created_at":"2026-11-19T05:20:00Z","error_code":null,"version":2}],"artifacts":[{"id":"60000000-0000-4000-8000-000000000001","name":"网站性能分析.pdf","mime":"application/pdf","task_id":"00000000-0000-4000-8000-000000000002","run_id":"20000000-0000-4000-8000-000000000002","status":"ready","created_at":"2026-11-19T05:45:00Z"}]}
    """
}
