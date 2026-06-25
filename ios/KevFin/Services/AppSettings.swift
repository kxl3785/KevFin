import Foundation
import Observation

/// User-configurable app settings, persisted in `UserDefaults`. The only thing
/// the app needs to know is where the self-hosted KevFin server lives.
@Observable
final class AppSettings {
    /// The base URL of the KevFin server, e.g. `http://192.168.1.50:3001`.
    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.serverURLKey) }
    }

    init() {
        serverURLString = UserDefaults.standard.string(forKey: Self.serverURLKey) ?? ""
    }

    /// A validated base URL, or `nil` if the user hasn't entered a usable one.
    var baseURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.scheme != nil else { return nil }
        return url
    }

    var isConfigured: Bool { baseURL != nil }

    private static let serverURLKey = "kevfin.serverURL"
}
