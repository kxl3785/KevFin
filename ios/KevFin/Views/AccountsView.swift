import SwiftUI

struct AccountsView: View {
    @Environment(AppSettings.self) private var settings
    @State private var model = DashboardViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if !settings.isConfigured {
                    NotConfiguredView()
                } else {
                    content
                }
            }
            .navigationTitle("Accounts")
        }
        .task(id: settings.serverURLString) { await reload() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle, .loading:
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorView(message: message) { Task { await reload() } }
        case .loaded:
            List {
                ForEach(model.accountsByInstitution, id: \.institution) { group in
                    Section(group.institution) {
                        ForEach(group.accounts) { account in
                            AccountRow(account: account)
                        }
                    }
                }
                if let properties = model.breakdown?.properties, !properties.isEmpty {
                    Section("Real Estate") {
                        ForEach(properties) { property in
                            PropertyRow(property: property)
                        }
                    }
                }
            }
            .refreshable { await reload() }
        }
    }

    private func reload() async {
        guard let url = settings.baseURL else { return }
        await model.load(using: url)
    }
}

private struct AccountRow: View {
    let account: Account
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                if let category = account.category {
                    Text(category.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(CurrencyFormat.precise(account.balance, code: account.currency ?? "USD"))
                .monospacedDigit()
                .foregroundStyle(account.balance < 0 ? .red : .primary)
        }
    }
}

private struct PropertyRow: View {
    let property: Property
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(property.address)
                if let equity = property.equity {
                    Text("Equity \(CurrencyFormat.whole(equity))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let zestimate = property.zestimate {
                Text(CurrencyFormat.whole(zestimate))
                    .monospacedDigit()
            }
        }
    }
}

#Preview {
    AccountsView()
        .environment(AppSettings())
}
