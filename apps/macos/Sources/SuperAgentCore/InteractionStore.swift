import Foundation

public final class InteractionFileStore: @unchecked Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }

    public static func applicationSupport() -> InteractionFileStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return InteractionFileStore(root: base.appendingPathComponent("SuperAgent", isDirectory: true).appendingPathComponent("interaction", isDirectory: true))
    }

    public func loadMessages(_ scope: InteractionScope) -> [OutboundMessage] {
        load([OutboundMessage].self, scope: scope, name: "outbox.json") ?? []
    }

    public func saveMessages(_ scope: InteractionScope, _ messages: [OutboundMessage]) throws {
        try write(messages, scope: scope, name: "outbox.json")
    }

    public func loadProjection(_ scope: InteractionScope) -> ProjectionJournal {
        load(ProjectionJournal.self, scope: scope, name: "projection.json") ?? ProjectionJournal()
    }

    public func saveProjection(_ scope: InteractionScope, _ journal: ProjectionJournal) throws {
        try write(journal, scope: scope, name: "projection.json")
    }

    public func loadControls(_ scope: InteractionScope) -> [PendingControl] {
        load([PendingControl].self, scope: scope, name: "controls.json") ?? []
    }

    public func saveControls(_ scope: InteractionScope, _ controls: [PendingControl]) throws {
        try write(controls, scope: scope, name: "controls.json")
    }

    private func directory(_ scope: InteractionScope) -> URL {
        root.appendingPathComponent(scope.storageKey, isDirectory: true)
    }

    private func load<T: Decodable>(_ type: T.Type, scope: InteractionScope, name: String) -> T? {
        let url = directory(scope).appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, scope: InteractionScope, name: String) throws {
        let folder = directory(scope)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(value)
        let destination = folder.appendingPathComponent(name)
        let temporary = folder.appendingPathComponent(UUID().uuidString + ".tmp")
        try data.write(to: temporary, options: [.atomic])
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
    }
}
