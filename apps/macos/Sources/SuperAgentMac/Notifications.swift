import AppKit
import UserNotifications
import SuperAgentCore

@MainActor final class NativeNotifications: NSObject, NSApplicationDelegate {
    weak var model: WorkspaceModel?
    func enable() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else { model?.notificationStatus = "通知权限未开启，可在系统设置中修改"; return }
            model?.notificationStatus = "已允许系统提醒；远程通知需要应用签名与服务端 APNs 配置"
            NSApp.registerForRemoteNotifications()
        } catch { model?.notificationStatus = "通知设置失败：\(error.localizedDescription)" }
    }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let model, model.session != nil else { return }
        let value = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            do {
                let _: JSONValue = try await model.api.request("/clients/push-registrations", method: "POST", body: ["provider": .string("apns"), "platform": .string("macos"), "token": .string(value)])
                model.notificationStatus = "远程通知已登记"
            } catch { model.notificationStatus = "系统提醒可用，远程通知尚未登记：\(error.localizedDescription)" }
        }
    }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        model?.notificationStatus = "系统提醒已允许；此构建未配置远程推送签名"
    }
    static func announceNewQuestions(_ questions: [Question]) {
        guard !questions.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            let content = UNMutableNotificationContent()
            content.title = "助理需要你的判断"
            content.body = "有 \(questions.count) 件待处理事项，打开工作台查看。"
            content.sound = .default
            content.userInfo = ["task_id": questions[0].taskId]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "question-" + questions[0].id, content: content, trigger: nil), withCompletionHandler: nil)
        }
    }
}
