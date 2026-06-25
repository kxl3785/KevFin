import Foundation

/// Portfolio allocation, matching `GET /api/allocation`. The endpoint returns
/// much more (per-holding rows, stock look-through, countries); we decode the
/// slices the mobile view shows and let the rest be ignored.
struct Allocation: Decodable {
    let total: Double
    let holdings: [Holding]
    let byAssetClass: [AllocationSlice]
    let bySector: [AllocationSlice]
}

/// One de-aggregated position, matching an entry of `holdings` in the
/// `/api/allocation` response.
struct Holding: Decodable, Identifiable {
    let symbol: String
    let name: String
    let value: Double
    let pct: Double
    let assetClass: String

    /// Symbols are unique per de-aggregated row; fall back to the name for
    /// holdings that have no ticker (e.g. a described-only position).
    var id: String { symbol.isEmpty ? name : symbol }
    var percentText: String { pct.formatted(.percent.precision(.fractionLength(0...1))) }
}

/// One wedge of an allocation breakdown. `pct` is a fraction in `0...1`.
struct AllocationSlice: Decodable, Identifiable {
    let name: String
    let value: Double
    let pct: Double

    var id: String { name }
    var percentText: String { pct.formatted(.percent.precision(.fractionLength(0...1))) }
}
