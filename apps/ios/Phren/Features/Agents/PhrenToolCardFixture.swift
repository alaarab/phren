#if DEBUG && targetEnvironment(simulator)
enum PhrenToolCardFixture {
    static let task = "Verify pasted images in chat. "
        + String(repeating: "Keep the original attachment, check the upload receipt, and confirm the reply uses the image. ", count: 18)
        + "Final task check: the complete instruction remains readable."
}
#endif
