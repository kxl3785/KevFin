import Foundation

/// Portfolio allocation, matching `GET /api/allocation`. The endpoint returns
/// much more (per-holding rows, stock look-through, countries); we decode the
/// slices the mobile view shows and let the rest be ignored.
struct Allocation: Decodable {
    let total: Double
    let byAssetClass: [AllocationSlice]
    let bySector: [AllocationSlice]
}

/// One wedge of an allocation breakdown. `pct` is a fraction in `0...1`.
struct AllocationSlice: Decodable, Identifiable {
    let name: String
    let value: Double
    let pct: Double

    var id: String { name }
    var percentText: String { pct.formatted(.percent.precision(.fractionLength(0...1))) }
}
