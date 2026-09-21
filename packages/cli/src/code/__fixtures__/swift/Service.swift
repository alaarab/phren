/// Computes the area of a rectangle.
public func computeArea(width: Int, height: Int) -> Int {
    return width * height
}

/// A rectangle built from a point.
public class Rectangle {
    let corner: Point

    init(corner: Point) {
        self.corner = corner
    }

    /// The rectangle's area, using computeArea.
    public func area() -> Int {
        return computeArea(width: corner.x, height: corner.y)
    }
}
