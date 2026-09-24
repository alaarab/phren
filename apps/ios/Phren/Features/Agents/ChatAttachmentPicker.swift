import ImageIO
import PhrenKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// How many files one message may carry. Each is uploaded on its own over
/// SSH, so the cap is about the phone's memory, not the transport.
enum ChatAttachmentLimit { static let maximum = 20 }

/// Downsample before rendering; newly encoded images omit source metadata.
enum ChatAttachmentPreparation {
    static func preparedImage(_ data: Data, name: String = "Image") async throws -> AgentAttachment {
        try await Task.detached(priority: .userInitiated) { try image(data, name: name) }.value
    }
    static func preview(_ attachment: AgentAttachment) -> AgentAttachment? {
        guard let source = CGImageSourceCreateWithData(attachment.data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 768,
              ] as CFDictionary),
              let data = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.8) else { return nil }
        ImageViewerOriginals.remember(attachment.data, for: attachment.id)
        return try? AgentAttachment(id: attachment.id, name: attachment.name, data: data, isImage: true)
    }

    static func image(_ data: Data, name: String = "Image") throws -> AgentAttachment {
        guard data.count <= 32 * 1_024 * 1_024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2_048,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { throw PhrenKitError.validation("This image couldn't be opened. Choose another image.") }
        let image = UIImage(cgImage: thumbnail)
        let png = image.pngData()
        let keepPNG = (png?.count ?? Int.max) <= 4 * 1_024 * 1_024
        guard let encoded = keepPNG ? png : image.jpegData(compressionQuality: 0.85) else {
            throw PhrenKitError.validation("This image couldn't be prepared for the agent.")
        }
        let attachment = try AgentAttachment(name: (name as NSString).deletingPathExtension + (keepPNG ? ".png" : ".jpg"), data: encoded, isImage: true)
        ImageViewerOriginals.remember(data, for: attachment.id)
        return attachment
    }
    /// An image from the clipboard or a paste: the same preparation as Photos.
    static func pasted(_ provider: NSItemProvider) async throws -> AgentAttachment {
        guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else {
            throw PhrenKitError.validation("No image was found on the clipboard.")
        }
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, failure in
                if let data { continuation.resume(returning: data) } else {
                    continuation.resume(throwing: failure ?? PhrenKitError.validation("No image was found on the clipboard."))
                }
            }
        }
        return try await preparedImage(data, name: "Clipboard")
    }
    /// The clipboard's first image as an attachment, or nil when the
    /// clipboard holds none.
    static func pasteFromClipboard() async throws -> AgentAttachment? {
        guard UIPasteboard.general.hasImages,
              let provider = UIPasteboard.general.itemProviders.first(where: ChatSelectionTextView.isImage) else { return nil }
        return try await pasted(provider)
    }
    static func file(_ url: URL) throws -> AgentAttachment {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        // A file another app provides in Files (its own folder, iCloud Drive,
        // a cloud drive) is read through the file provider: a plain read of
        // the picked URL is refused as "you don't have permission". The
        // coordinated read hands over a readable copy, downloading it first.
        var coordinationError: NSError?
        var result: Result<AgentAttachment, Error> = .failure(CocoaError(.fileReadNoPermission))
        NSFileCoordinator().coordinate(readingItemAt: url, options: .forUploading, error: &coordinationError) { readable in
            result = Result { try attachment(at: readable, name: url.lastPathComponent) }
        }
        if let coordinationError { throw coordinationError }
        return try result.get()
    }

    private static func attachment(at url: URL, name: String) throws -> AgentAttachment {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
        guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= AgentAttachment.maximumBytes else {
            throw PhrenKitError.validation("Choose a file smaller than 8 MB.")
        }
        let data = try Data(contentsOf: url)
        let type = values.contentType ?? UTType(filenameExtension: (name as NSString).pathExtension)
        if type?.conforms(to: .image) == true { return try image(data, name: name) }
        return try AgentAttachment(name: name, data: data)
    }
}

enum ChatAttachmentSource: String, Identifiable {
    case photos, camera, files
    var id: String { rawValue }
}

/// The system pickers and their preparation, driven by one optional source.
/// Setting `source` to `.photos`, `.files` or `.camera` opens the matching
/// picker; it resets to nil when the picker finishes or is cancelled, after
/// running the same preparation the sheet used. One code path for the chat
/// (direct) and the terminal's attachment sheet.
private struct ChatAttachmentSourceModifier: ViewModifier {
    @Binding var source: ChatAttachmentSource?
    let canAdd: Bool
    let add: (AgentAttachment) -> Void
    @Binding var error: String?

    @State private var photos: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: present(.photos), selection: $photos,
                          maxSelectionCount: ChatAttachmentLimit.maximum, matching: .images)
            .fileImporter(isPresented: present(.files), allowedContentTypes: [.item],
                          allowsMultipleSelection: true) { result in
                handleFiles(result)
            }
            .fullScreenCover(isPresented: present(.camera)) {
                ChatCamera { image in cameraFinished(image) }.ignoresSafeArea()
            }
            .onChange(of: photos) { _, items in handlePhotos(items) }
    }

    /// The picker's presentation: present while `source` names it, and clear
    /// `source` once the system dismisses it, so cancel resets the flow.
    private func present(_ value: ChatAttachmentSource) -> Binding<Bool> {
        Binding(
            get: { source == value && canAdd },
            set: { if !$0 && source == value { source = nil } }
        )
    }

    private func handlePhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        // Each picker session starts empty: a selection left bound here would
        // show preselected next time and hand the same photos back again.
        photos = []
        Task { @MainActor in
            do {
                for item in items {
                    if let data = try await item.loadTransferable(type: Data.self) {
                        add(try await ChatAttachmentPreparation.preparedImage(data))
                    }
                }
                source = nil
            } catch { self.error = error.localizedDescription; source = nil }
        }
    }

    private func handleFiles(_ result: Result<[URL], Error>) {
        Task { @MainActor in
            defer { source = nil }
            do {
                let urls = try result.get()
                for url in urls.prefix(ChatAttachmentLimit.maximum) {
                    add(try await Task.detached(priority: .userInitiated) { try ChatAttachmentPreparation.file(url) }.value)
                }
            } catch {
                if (error as? CocoaError)?.code != .userCancelled { self.error = error.localizedDescription }
            }
        }
    }

    private func cameraFinished(_ image: UIImage?) {
        source = nil
        guard let image else { return }
        Task { @MainActor in
            do {
                let attachment = try await Task.detached(priority: .userInitiated) {
                    guard let data = image.jpegData(compressionQuality: 0.9) else {
                        throw PhrenKitError.validation("The photo couldn't be prepared. Try another photo.")
                    }
                    return try ChatAttachmentPreparation.image(data, name: "Camera")
                }.value
                add(attachment)
            } catch { self.error = error.localizedDescription }
        }
    }
}

extension View {
    func chatAttachmentSources(source: Binding<ChatAttachmentSource?>, canAdd: Bool,
                               add: @escaping (AgentAttachment) -> Void,
                               error: Binding<String?>) -> some View {
        modifier(ChatAttachmentSourceModifier(source: source, canAdd: canAdd, add: add, error: error))
    }
}

struct ChatAttachmentPicker: View {
    var initialSource: ChatAttachmentSource? = nil
    let canAdd: Bool
    let add: (AgentAttachment) -> Void
    let context: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var source: ChatAttachmentSource?
    @State private var openedInitialSource = false
    @State private var busy = false
    @State private var error: String?
    @State private var clipboardHasImage = UIPasteboard.general.hasImages
    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    Button("Photos", systemImage: "photo.on.rectangle") { begin(.photos) }
                        .disabled(!canAdd || busy)
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Camera", systemImage: "camera") { begin(.camera) }.disabled(!canAdd || busy)
                    }
                    Button("Files", systemImage: "doc") { begin(.files) }.disabled(!canAdd || busy)
                    Button(action: pasteImage) {
                        PhrenRow(icon: "clipboard", title: "Paste image", chevron: false)
                    }
                    .buttonStyle(.plain).disabled(!canAdd || busy || !clipboardHasImage)
                    .accessibilityLabel("Paste image").phrenIdentifier("attachment-paste-image")
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled {
                        Button("Add test image") { add(AgentChatFixture.image); dismiss() }
                    }
                    #endif
                } footer: {
                    Text("Up to four files, 8 MB each. Photos are resized and location metadata removed. Attachments upload to this computer when you send.")
                }
                if let context {
                    Section {
                        Button("Project memory and skills", systemImage: "brain") { dismiss(); context() }
                    }
                }
                if busy { ProgressView("Preparing attachment…") }
                if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            }
            .navigationTitle("Add attachment").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .chatAttachmentSources(source: $source, canAdd: canAdd, add: { item in add(item); dismiss() }, error: $error)
            .onChange(of: source) { _, value in if value == nil { busy = false } }
            .task {
                guard !openedInitialSource, let initialSource, canAdd else { return }
                openedInitialSource = true
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled && ProcessInfo.processInfo.arguments.contains("--terminal-uploads-fixture") { return }
                #endif
                // Finish presenting this sheet before opening the system picker.
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                switch initialSource {
                case .photos: begin(.photos)
                case .camera where UIImagePickerController.isSourceTypeAvailable(.camera): begin(.camera)
                case .files: begin(.files)
                default: break
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            clipboardHasImage = UIPasteboard.general.hasImages
        }
    }

    private func begin(_ newSource: ChatAttachmentSource) {
        busy = true
        source = newSource
    }

    private func pasteImage() {
        guard canAdd, !busy else { return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                if let attachment = try await ChatAttachmentPreparation.pasteFromClipboard() {
                    add(attachment)
                    dismiss()
                }
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct ChatCamera: UIViewControllerRepresentable {
    let finish: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(finish: finish) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let finish: (UIImage?) -> Void
        init(finish: @escaping (UIImage?) -> Void) { self.finish = finish }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { finish(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            finish(info[.originalImage] as? UIImage)
        }
    }
}
