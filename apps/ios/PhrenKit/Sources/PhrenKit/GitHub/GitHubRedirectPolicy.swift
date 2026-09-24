import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Repository renames can redirect within GitHub's API. Credentials and
/// contents-write bodies must stay on the authenticated HTTPS origin.
final class GitHubRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = GitHubRedirectPolicy()

    static func allows(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == "api.github.com"
            && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(Self.allows) == true ? request : nil)
    }
}
