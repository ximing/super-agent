import SwiftUI
import AppKit
import SuperAgentCore

struct BrowserFrameView: View {
    @EnvironmentObject var model: WorkspaceModel
    let runId: String
    @State private var viewId: String?
    @State private var frame: Frame?
    @State private var observing = false
    @State private var controlling = false
    @State private var status = "打开画面后才会连续采集"
    @State private var input = ""
    @State private var poll: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("浏览器画面", systemImage: "rectangle.on.rectangle")
                    .font(.callout.weight(.semibold))
                Spacer()
                if observing {
                    Button("关闭画面") { Task { await stop() } }
                } else {
                    Button("查看画面") { Task { await start() } }
                }
            }
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let frame, let data = Data(base64Encoded: frame.imageBase64), let image = NSImage(data: data) {
                GeometryReader { geometry in
                    let ratio = min(geometry.size.width / CGFloat(max(frame.width, 1)), geometry.size.height / CGFloat(max(frame.height, 1)))
                    Image(nsImage: image)
                        .resizable()
                        .frame(width: CGFloat(frame.width) * ratio, height: CGFloat(frame.height) * ratio)
                        .contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 0).onEnded { value in
                            guard controlling else { return }
                            Task {
                                await send([
                                    "type": .string("click"),
                                    "x": .number(Double(value.location.x / ratio)),
                                    "y": .number(Double(value.location.y / ratio))
                                ], frame: frame)
                            }
                        })
                        .accessibilityLabel("执行电脑浏览器画面")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(height: 340)
                .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 4))
                .clipped()
                Text("采集于 \(formatTime(frame.capturedAt))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if observing {
                ProgressView("等待执行电脑的画面")
                    .frame(maxWidth: .infinity, minHeight: 100)
            }
            if observing {
                HStack {
                    if controlling {
                        Button("结束接管") { Task { await release() } }
                    } else {
                        Button("暂停并接管") { Task { await takeControl() } }
                            .buttonStyle(.borderedProminent)
                    }
                    if controlling {
                        TextField("输入到页面", text: $input)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("输入到浏览器页面")
                        Button("输入") {
                            let value = input
                            input = ""
                            if let frame {
                                Task { await send(["type": .string("text"), "text": .string(value)], frame: frame) }
                            }
                        }
                        .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("Enter") {
                            if let frame {
                                Task { await send(["type": .string("keys"), "keys": .string("Enter")], frame: frame) }
                            }
                        }
                        .accessibilityLabel("在浏览器页面按下回车")
                    }
                }
                if controlling {
                    Text("页面输入由你独占。结束接管后，任务保持暂停；请通过任务操作继续执行。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .onDisappear {
            poll?.cancel()
            if let id = viewId {
                let api = model.api
                Task { let _: JSONValue? = try? await api.request("/views/\(id)", method: "DELETE") }
            }
        }
    }

    private func start() async {
        do {
            let view: ViewSession = try await model.api.request("/runs/\(runId)/views", method: "POST", body: [:])
            viewId = view.id
            observing = true
            status = "只显示当前网页内容；原生系统弹窗可能不可见"
            poll?.cancel()
            poll = Task {
                while !Task.isCancelled {
                    do {
                        frame = try await model.api.request("/runs/\(runId)/frame")
                        status = "画面按需刷新"
                    } catch let error as APIError where error.status == 404 {
                        status = "等待执行电脑的最新画面"
                    } catch {
                        status = "画面连接中断：\(error.localizedDescription)"
                    }
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        } catch {
            status = error.localizedDescription
        }
    }

    private func stop() async {
        poll?.cancel()
        if let id = viewId {
            let _: JSONValue? = try? await model.api.request("/views/\(id)", method: "DELETE")
        }
        observing = false
        controlling = false
        viewId = nil
        frame = nil
        status = "连续采集已关闭"
    }

    private func takeControl() async {
        guard let id = viewId else { return }
        do {
            let _: JSONValue = try await model.api.request("/views/\(id)/control", method: "POST", body: [:])
            controlling = true
            status = "接管请求已接受；服务器仅在任务静止后放行输入"
        } catch {
            status = error.localizedDescription
        }
    }

    private func release() async {
        guard let id = viewId else { return }
        do {
            let _: JSONValue = try await model.api.request("/views/\(id)/control", method: "DELETE")
            controlling = false
            status = "接管已结束，任务保持暂停"
        } catch {
            status = error.localizedDescription
        }
    }

    private func send(_ payload: [String: JSONValue], frame: Frame) async {
        guard let id = viewId else { return }
        do {
            var body = payload
            body["frame_id"] = .string(frame.frameId)
            body["viewport_version"] = .string(frame.viewportVersion)
            let _: JSONValue = try await model.api.request("/views/\(id)/inputs", method: "POST", body: body)
        } catch {
            status = error.localizedDescription
        }
    }
}
