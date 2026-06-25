import Foundation

/// Shared currency formatting helpers used across the views.
enum CurrencyFormat {
    /// Whole-dollar formatting for headline figures, e.g. `$1,234,567`.
    static func whole(_ value: Double, code: String = "USD") -> String {
        value.formatted(.currency(code: code).precision(.fractionLength(0)))
    }

    /// Two-decimal formatting for individual account balances.
    static func precise(_ value: Double, code: String = "USD") -> String {
        value.formatted(.currency(code: code))
    }

    /// A signed delta with an explicit `+`/`−`, e.g. `+$4,200`.
    static func signedWhole(_ value: Double, code: String = "USD") -> String {
        let formatted = whole(abs(value), code: code)
        return (value < 0 ? "−" : "+") + formatted
    }
}
