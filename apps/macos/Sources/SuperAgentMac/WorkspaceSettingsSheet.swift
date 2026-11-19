import SwiftUI

struct WorkspaceSettingsSheet: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: "sparkles")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .frame(width: 38, height: 38)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 4) {
                    Text("工作台设置").font(.headline)
                    Text("通知与当前账户").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 25)
            .padding(.top, 22)
            .padding(.bottom, 20)

            VStack(alignment: .leading, spacing: 17) {
                Text("通知").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Text("有问题或交付时提醒我").font(.callout)
                    Spacer()
                    Button("开启系统提醒") { Task { await model.enableNotifications() } }
                        .controlSize(.small)
                }
                if let status = model.notificationStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let time = model.lastSync {
                    Text("最近同步：\(time.formatted(date: .omitted, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Divider()

                HStack(spacing: 8) {
                    Image(systemName: "person.circle")
                        .font(.system(size: 20))
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.session?.user.name ?? "当前账户").font(.callout)
                        Text(model.session?.user.email ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 25)
            .padding(.bottom, 22)

            Divider()
            HStack {
                Button("退出登录", role: .destructive) {
                    Task {
                        await model.signOut()
                        dismiss()
                    }
                }
                Spacer()
                Button("完成") { dismiss() }.buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 25)
            .padding(.vertical, 16)
        }
        .frame(width: 480)
    }
}
