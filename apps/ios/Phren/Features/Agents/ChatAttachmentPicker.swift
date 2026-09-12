import ImageIO
import PhrenKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
        return try AgentAttachment(name: (name as NSString).deletingPathExtension + (keepPNG ? ".png" : ".jpg"), data: encoded, isImage: true)
    }
    static func file(_ url: URL) throws -> AgentAttachment {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
        guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= AgentAttachment.maximumBytes else {
            throw PhrenKitError.validation("Choose a file smaller than 8 MB.")
        }
        let data = try Data(contentsOf: url)
        if values.contentType?.conforms(to: .image) == true { return try image(data, name: url.lastPathComponent) }
        return try AgentAttachment(name: url.lastPathComponent, data: data)
    }
}

enum ChatAttachmentSource: String, Identifiable {
    case photos, camera, files
    var id: String { rawValue }
}

struct ChatAttachmentPicker: View {
    var initialSource: ChatAttachmentSource? = nil
    let canAdd: Bool
    let add: (AgentAttachment) -> Void
    let context: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var openedInitialSource = false
    @State private var files = false
    @State private var camera = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                        .disabled(!canAdd || busy)
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Camera", systemImage: "camera") { camera = true }.disabled(!canAdd || busy)
                    }
                    Button("Files", systemImage: "doc") { files = true }.disabled(!canAdd || busy)
                    PasteButton(supportedContentTypes: [.image]) { providers in
                        guard let provider = providers.first,
                              let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else { return }
                        busy = true
                        provider.loadDataRepresentation(forTypeIdentifier: type) { data, failure in
                            Task { @MainActor in
                                defer { busy = false }
                                do {
                                    if let failure { throw failure }
                                    guard let data else { throw PhrenKitError.validation("No image was found on the clipboard.") }
                                    add(try await ChatAttachmentPreparation.preparedImage(data, name: "Clipboard")); dismiss()
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                    }.disabled(!canAdd || busy).accessibilityLabel("Paste image")
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
            .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 4, matching: .images)
            .task {
                guard !openedInitialSource, let initialSource, canAdd else { return }
                openedInitialSource = true
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled && ProcessInfo.processInfo.arguments.contains("--terminal-uploads-fixture") { return }
                #endif
                // Finish presenting this sheet before opening the system picker.
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                switch initialSource {
                case .photos: showPhotos = true
                case .camera: camera = UIImagePickerController.isSourceTypeAvailable(.camera)
                case .files: files = true
                }
            }
            .fileImporter(isPresented: $files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                busy = true
                Task {
                    defer { busy = false }
                    do {
                        let urls = try result.get()
                        for url in urls.prefix(4) {
                            add(try await Task.detached(priority: .userInitiated) { try ChatAttachmentPreparation.file(url) }.value)
                        }
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }
            }
            .fullScreenCover(isPresented: $camera) {
                ChatCamera { image in
                    camera = false
                    guard let image else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        do {
                            let attachment = try await Task.detached(priority: .userInitiated) {
                                guard let data = image.jpegData(compressionQuality: 0.9) else {
                                    throw PhrenKitError.validation("The photo couldn't be prepared. Try another photo.")
                                }
                                return try ChatAttachmentPreparation.image(data, name: "Camera")
                            }.value
                            add(attachment); dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                }.ignoresSafeArea()
            }
            .onChange(of: photos) { _, items in
                busy = true
                Task {
                    defer { busy = false }
                    do {
                        for item in items {
                            if let data = try await item.loadTransferable(type: Data.self) { add(try await ChatAttachmentPreparation.preparedImage(data)) }
                        }
                        if !items.isEmpty { dismiss() }
                    } catch { self.error = error.localizedDescription }
                }
            }
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
