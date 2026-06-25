import SwiftUI

/// Top-level tab shell. If no server is configured yet, nudge the user straight
/// to Settings so the app has somewhere to fetch from.
struct RootView: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "chart.line.uptrend.xyaxis") }

            AccountsView()
                .tabItem { Label("Accounts", systemImage: "building.columns") }

            InvestmentsView()
                .tabItem { Label("Investments", systemImage: "chart.pie") }

            BudgetView()
                .tabItem { Label("Budget", systemImage: "creditcard") }

            ForecastView()
                .tabItem { Label("Forecast", systemImage: "chart.xyaxis.line") }
        }
    }
}

#Preview {
    RootView()
        .environment(AppSettings())
}
