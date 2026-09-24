import Foundation
import XCTest
@testable import PhrenLive

final class SpeechTranscribeRequestTests: XCTestCase {
    func testRequestCarriesLanguageAndVocabularyAndDecodesFrames() {
        let request = PhrenConnection.speechTranscriptionRequest(language: "en", keyterms: ["phren", "Herdr CLI"], socket: SpeechStreamSocket())
        XCTAssertTrue(request.webSocket); XCTAssertTrue(request.streaming); XCTAssertNotNil(request.speechSocket)
        XCTAssertEqual(request.path, "/v1/speech/transcribe?language=en&keyterm=phren&keyterm=Herdr%20CLI")
        XCTAssertEqual(PhrenConnection.speechTranscriptEvent(Data(#"{"type":"partial","text":"rebase"}"#.utf8)), .partial("rebase"))
        XCTAssertEqual(PhrenConnection.speechTranscriptEvent(Data(#"{"type":"committed","text":"Rebase onto main."}"#.utf8)), .committed("Rebase onto main."))
        XCTAssertEqual(PhrenConnection.speechTranscriptEvent(Data(#"{"type":"error","code":"transcribe-quota","error":"Used up."}"#.utf8)),
                       .failed(code: "transcribe-quota", message: "Used up."))
        XCTAssertNil(PhrenConnection.speechTranscriptEvent(Data("noise".utf8)))
    }
}
