import SwiftUI

/// Shown when there's no server URL yet — points the user at Settings.
struct NotConfiguredView: View {
    var body: some View {
        ContentUnavailableView {
            Label("No Server Configured", systemImage: "server.rack")
        } description: {
            Text("Add your KevFin server's address in Settings — tap the gear icon on the Net Worth tab — to see your data.")
        }
    }
}

/// Shown when a request fails, with a retry affordance.
struct ErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't Load", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: retry)
                .buttonStyle(.borderedProminent)
        }
    }
}
