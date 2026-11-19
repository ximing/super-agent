import AppKit

/// The .icns remains the Finder/launch fallback; the running Dock tile follows AppKit.
@MainActor final class AppIconController {
    private var appearanceObservation: NSKeyValueObservation?
    private var currentVariant: String?

    func start() {
        guard appearanceObservation == nil else { return }
        update()
        appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.update() }
        }
    }

    private func update() {
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let variant = dark ? "dark" : "light"
        guard variant != currentVariant,
              let url = Bundle.main.url(forResource: "AppIcon-\(variant)", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return }
        NSApp.applicationIconImage = image
        currentVariant = variant
    }
}
