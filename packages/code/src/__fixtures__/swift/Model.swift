import Foundation

/// A point in the plane.
struct Point {
    let x: Int
    let y: Int
}

/// Anything with an area.
protocol Shape {
    func area() -> Int
}

/// A colour axis.
enum Axis {
    case x
    case y
}
