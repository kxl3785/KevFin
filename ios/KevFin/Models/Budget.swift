import Foundation

/// Current-month budget summary, matching `GET /api/budget`. The endpoint
/// returns many more fields (transactions, daily cumulative, etc.); we decode
/// only what the mobile summary needs — unknown keys are ignored.
struct BudgetSummary: Decodable {
    let month: String
    let months: [String]
    let income: Double
    let spending: Double
    let mortgage: Double
    let totalBudget: Double
    let byCategory: [BudgetCategory]

    /// Spending minus income for the month (negative means you saved).
    var net: Double { income - spending - mortgage }
}

struct BudgetCategory: Decodable, Identifiable {
    let category: String
    let spent: Double
    let count: Int
    let target: Double
    let period: String?
    let ytdSpent: Double?
    let excluded: Bool?

    var id: String { category }
    var isAnnual: Bool { period == "annual" }
    var hasTarget: Bool { target > 0 }

    /// Spend measured against the relevant period's target (year-to-date for
    /// annual budgets, this month's spend for monthly ones).
    var effectiveSpent: Double { isAnnual ? (ytdSpent ?? spent) : spent }

    /// Fraction of target used, clamped to `0...1` for the progress bar.
    var progress: Double {
        guard target > 0 else { return 0 }
        return min(max(effectiveSpent / target, 0), 1)
    }

    var isOverBudget: Bool { hasTarget && effectiveSpent > target }
}
