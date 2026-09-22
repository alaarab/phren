import PDFKit
import SwiftUI

struct FilePDFView: View {
    let url: URL
    @State private var page = 0
    @State private var count = 0
    @State private var failed = false
    var body: some View {
        VStack(spacing: 0) {
            PDFSurface(url: url, page: $page, count: $count, failed: $failed)
            if failed { Text("This PDF could not be opened. Save or share the file to open it elsewhere.").foregroundStyle(PhrenTheme.warning).padding() }
            HStack {
                PhrenIconButton(icon: "chevron.left", label: "Previous page") { page -= 1 }
                    .disabled(page <= 0).phrenIdentifier("file-pdf-previous")
                Spacer()
                Text("Page \(count == 0 ? 0 : page + 1) of \(count)").font(PhrenTypography.monoSubheadline)
                    .phrenIdentifier("file-pdf-page")
                Spacer()
                PhrenIconButton(icon: "chevron.right", label: "Next page") { page += 1 }
                    .disabled(page + 1 >= count).phrenIdentifier("file-pdf-next")
            }.padding(.horizontal, 12).background(PhrenTheme.surface)
        }.phrenIdentifier("file-viewer-pdf")
    }
}
private struct PDFSurface: UIViewRepresentable {
    let url: URL
    @Binding var page: Int
    @Binding var count: Int
    @Binding var failed: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true; view.displayMode = .singlePageContinuous
        view.backgroundColor = UIColor(PhrenTheme.bg)
        view.document = PDFDocument(url: url)
        context.coordinator.observe(view)
        DispatchQueue.main.async { count = view.document?.pageCount ?? 0; failed = view.document == nil }
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        context.coordinator.parent = self
        if let document = view.document, let selected = document.page(at: page), view.currentPage != selected { view.go(to: selected) }
    }
    final class Coordinator {
        var parent: PDFSurface
        var observer: NSObjectProtocol?
        init(_ parent: PDFSurface) { self.parent = parent }
        func observe(_ view: PDFView) {
            observer = NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                guard let self, let view, let page = view.currentPage, let document = view.document else { return }
                let index = document.index(for: page)
                DispatchQueue.main.async { self.parent.page = index }
            }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}
